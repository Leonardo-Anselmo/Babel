// Pictures on request: when someone asks for one, Claude describes it in an <image> tag
// after its line (never said out loud); this draws it with Google's Gemini image model
// ("Nano Banana 2.1") and posts it in the text chat.
//
// Gemini API (docs and @google/genai 2.31 types, Oct 2026): POST /v1beta/interactions with
// x-goog-api-key and { model, input: [{ type: 'text', text }], response_format: { type:
// 'image', aspect_ratio, image_size: '1K', mime_type: 'image/jpeg' } }. The picture comes
// back in steps[] (type 'model_output') as content { type: 'image', data (base64),
// mime_type }. A 1K picture is 1,120 image tokens at $30 a million: about $0.034, plus a
// little for the model's thinking. No free tier for pictures: the key's project needs billing.

import { PermissionFlagsBits } from 'discord.js';
import { logger } from './log.js';
import { fetchWithReconnect } from './net.js';

const log = logger('images');
const API = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1';
export const ASPECTS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const MAX_PROMPT_CHARS = 2000;
// Every try at one picture together (generation time isn't documented; usually seconds).
const MAKE_TIMEOUT_MS = 120000;
// Pictures being drawn at once (in every server together).
export const MAX_AT_ONCE = 3;
// Its last picture in each server can be changed ("make it blue") for this long.
const LAST_KEPT_MS = 30 * 60000;
// A key, billing or model problem stops new tries for this long (or until a restart).
const BLOCK_MS = 30 * 60000;
// Dollars per million tokens (Gemini API pricing page, Oct 2026).
export const IMAGE_PRICES = {
  'gemini-nano-banana-2.1': { input: 1.5, text: 7.5, image: 30 },
  'gemini-3.1-flash-lite-image': { input: 0.25, text: 1.5, image: 30 },
};
// A 1K picture: 1,120 image tokens at $30 a million (used when Google doesn't say how many).
export const DOLLARS_PER_PICTURE = 0.0336;

const IMAGE_TAG = /<image\b([^>]*)>([\s\S]*?)<\/image\s*>/gi;
const OPEN_IMAGE = /<image\b/i;

/** The text with picture tags taken out (and anything after one that hasn't been closed yet). */
export function withoutImageTags(text) {
  let t = String(text ?? '').replace(IMAGE_TAG, ' ').replace(/<\/image\s*>/gi, ' ');
  const open = t.search(OPEN_IMAGE);
  if (open !== -1) t = t.slice(0, open);
  return t;
}

/** It started a picture tag and never finished it (the reply ran out of room). */
export function cutOffInImage(text) {
  return OPEN_IMAGE.test(String(text ?? '').replace(IMAGE_TAG, ' '));
}

function attr(attrs, name) {
  const m = new RegExp(String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
}

/** "16:9", "16x9", "wide", "tall", "square" -> one of ASPECTS (null when it gave none or an odd one). */
export function normalizeAspect(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  const words = { square: '1:1', wide: '16:9', widescreen: '16:9', landscape: '16:9', tall: '9:16', portrait: '9:16', phone: '9:16' };
  if (words[v]) return words[v];
  const m = /^(\d{1,2})\s*[:x/]\s*(\d{1,2})$/.exec(v);
  const ratio = m ? `${Number(m[1])}:${Number(m[2])}` : '';
  return ASPECTS.includes(ratio) ? ratio : null;
}

/** The pictures a reply asks for: [{ prompt, aspect, edit }] (edit: change its last picture). */
export function imageTags(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(IMAGE_TAG)) {
    const prompt = m[2]
      .replace(/<\/?[a-z_]+[^>]*>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PROMPT_CHARS);
    if (!prompt) continue;
    out.push({ prompt, aspect: normalizeAspect(attr(m[1], 'aspect')), edit: /^(?:last|yes|true)$/i.test(attr(m[1], 'edit')) });
  }
  return out;
}

export class ImageError extends Error {
  constructor(message, { status = 0, code = '', userText = '', blocks = false, refused = false, retryWithoutStore = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.userText = userText || message;
    // The key, the billing or the model can't make pictures: stop offering them for a while.
    this.blocks = blocks;
    // Google wouldn't draw that one (its safety rules): nothing wrong with the setup.
    this.refused = refused;
    this.retryWithoutStore = retryWithoutStore;
  }
}

const REFUSED = /image_safety|image_prohibited|image_recitation|image_other|prohibited|safety|blocklist|recitation|blocked|responsible ai|usage polic|not allowed to generate/;
const FREE_TIER = /free[_ ]?tier|limit: ?0\b/;
const NO_BILLING_WORDS = /billing (?:is )?(?:not enabled|not set up|disabled)|disabled billing|enable billing|set up billing|requires? billing|billing to be enabled|no billing account|billing account (?:is )?(?:closed|disabled|not)/;
const NO_BILLING =
  "the Gemini key's Google project needs billing turned on (pictures aren't free on Google's API): in Google AI Studio open Get API key, then Set up billing for that project";

/**
 * Turns a Gemini API error into an ImageError with a reason people can act on. Handles both
 * error shapes: { error: { code: 'invalid_request', message } } (Interactions) and
 * { error: { code: 400, status: 'INVALID_ARGUMENT', message, details: [{ reason }] } }.
 */
export function imageError(status, bodyText, { model = DEFAULT_IMAGE_MODEL } = {}) {
  let code = '';
  let message = String(bodyText ?? '').slice(0, 300);
  let reasons = '';
  try {
    const json = JSON.parse(bodyText);
    const e = json?.error ?? json;
    if (e && typeof e === 'object') {
      code = String(e.status || (typeof e.code === 'string' ? e.code : '') || '');
      message = String(e.message || message);
      reasons = (Array.isArray(e.details) ? e.details : []).map((d) => d?.reason || '').join(' ');
    }
  } catch {
    // not JSON
  }
  const lower = `${code} ${reasons} ${message}`.toLowerCase();
  let userText = '';
  let blocks = false;
  let refused = false;
  let retryWithoutStore = false;
  if (/api_key_invalid|api key not valid|api key expired|invalid api key|authentication|unauthenticated/.test(lower) || status === 401) {
    userText = 'Google rejected the Gemini key (paste a new one in the app under Settings > Keys)';
    blocks = true;
  } else if (status === 402 || /payment_required|prepay|credit balance|out of credit/.test(lower)) {
    userText = 'the Google account is out of prepaid credit for the Gemini API';
  } else if (status === 429) {
    // A free-tier quota of 0 means no billing; anything else is a limit that passes
    // (Google's usual quota message mentions "plan and billing details" even on paid keys).
    if (FREE_TIER.test(lower)) {
      userText = NO_BILLING;
      blocks = true;
    } else {
      userText = 'Google is busy or the key hit its limit for now; ask again in a minute';
    }
  } else if (FREE_TIER.test(lower) || NO_BILLING_WORDS.test(lower)) {
    userText = NO_BILLING;
    blocks = true;
  } else if (status === 403 || /permission_denied|permission denied|api_key_service_blocked|_blocked\b|service_disabled|has not been used in project|is disabled/.test(lower)) {
    // (A key limited to other APIs comes back as "...blocked": a setup problem, not a refusal.)
    userText = "Google won't let this key make pictures (in Google AI Studio, check the key isn't restricted to other APIs)";
    blocks = true;
  } else if (REFUSED.test(lower)) {
    userText = "Google wouldn't draw that one";
    refused = true;
  } else if (status === 404 || /not_found|not found/.test(lower)) {
    userText = `Google doesn't have the picture model ${model} (check IMAGE_MODEL)`;
    blocks = true;
  } else if (status === 400 && /\bstore\b/.test(lower)) {
    retryWithoutStore = true;
  } else if (status >= 500) {
    userText = "Google's picture service had a problem; try again in a bit";
  }
  return new ImageError(`Gemini ${status}${code ? ` (${code})` : ''}: ${message}`.slice(0, 300), {
    status,
    code,
    userText: userText || "Google couldn't make that picture",
    blocks,
    refused,
    retryWithoutStore,
  });
}

/**
 * The picture in a Gemini reply: the last image its answer holds (Interactions steps, the
 * older outputs list, or generateContent parts). Thought images are skipped. Null if none.
 */
export function findImage(res) {
  const blocks = [];
  for (const step of Array.isArray(res?.steps) ? res.steps : []) {
    if (step?.type === 'model_output' && Array.isArray(step.content)) blocks.push(...step.content);
  }
  if (Array.isArray(res?.outputs)) blocks.push(...res.outputs);
  if (res?.output_image) blocks.push(res.output_image);
  for (const c of Array.isArray(res?.candidates) ? res.candidates : []) {
    for (const p of Array.isArray(c?.content?.parts) ? c.content.parts : []) {
      const inline = p?.inlineData ?? p?.inline_data;
      if (inline?.data) blocks.push({ type: 'image', data: inline.data, mime_type: inline.mimeType ?? inline.mime_type, thought: p.thought });
    }
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.type === 'image' && typeof b.data === 'string' && b.data && !b.thought) return { data: b.data, mimeType: String(b.mime_type || '') };
  }
  return null;
}

/** Why a reply came back without a picture, from whatever it says (errors, statuses, its text). */
export function whyNoImage(res) {
  const said = [];
  if (res?.status) said.push(`status ${res.status}`);
  for (const e of Array.isArray(res?.errors) ? res.errors : []) said.push(`${e?.code || ''} ${e?.message || ''}`);
  for (const step of Array.isArray(res?.steps) ? res.steps : []) {
    if (step?.error) said.push(`${step.error.code || ''} ${step.error.message || ''}`);
    if (step?.type === 'model_output') for (const c of step.content ?? []) if (c?.type === 'text' && c.text) said.push(c.text);
  }
  for (const c of Array.isArray(res?.candidates) ? res.candidates : []) {
    if (c?.finishReason) said.push(`finish ${c.finishReason}`);
    for (const p of c?.content?.parts ?? []) if (p?.text && !p.thought) said.push(p.text);
  }
  if (res?.promptFeedback?.blockReason) said.push(`blocked ${res.promptFeedback.blockReason}`);
  const text = said.join(' | ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { text, refused: REFUSED.test(text.toLowerCase()) || /\bcan(?:'|no)t (?:create|generate|make|draw)\b|\bunable to (?:create|generate)\b/i.test(text) };
}

/** What a picture cost, from the token counts Google sent back (or the list price of a 1K picture). */
export function pictureDollars(res, model = DEFAULT_IMAGE_MODEL) {
  const p = IMAGE_PRICES[model] ?? IMAGE_PRICES[DEFAULT_IMAGE_MODEL];
  const u = res?.usage;
  if (u && typeof u === 'object') {
    const imageTokens = (Array.isArray(u.output_tokens_by_modality) ? u.output_tokens_by_modality : [])
      .filter((x) => String(x?.modality || '').toLowerCase() === 'image')
      .reduce((a, x) => a + (Number(x?.tokens) || 0), 0);
    const out = Number(u.total_output_tokens) || 0;
    const thought = Number(u.total_thought_tokens) || 0;
    const input = Number(u.total_input_tokens) || 0;
    if (imageTokens || out) {
      // (Thinking counted on its own, unless the total shows it's already in the output count.)
      const separate = !u.total_tokens || Number(u.total_tokens) >= input + out + thought;
      const textTokens = Math.max(0, out - imageTokens) + (separate ? thought : 0);
      return (input * p.input + imageTokens * p.image + textTokens * p.text) / 1e6;
    }
  }
  const m = res?.usageMetadata;
  if (m && typeof m === 'object') {
    const details = Array.isArray(m.candidatesTokensDetails) ? m.candidatesTokensDetails : [];
    const imageTokens = details.filter((d) => String(d?.modality || '').toUpperCase() === 'IMAGE').reduce((a, d) => a + (Number(d?.tokenCount) || 0), 0);
    const out = Number(m.candidatesTokenCount) || 0;
    if (imageTokens || out) {
      const textTokens = Math.max(0, out - imageTokens) + (Number(m.thoughtsTokenCount) || 0);
      return ((Number(m.promptTokenCount) || 0) * p.input + imageTokens * p.image + textTokens * p.text) / 1e6;
    }
  }
  return DOLLARS_PER_PICTURE;
}

/** The picture's file type from its first bytes (Google says JPEG; PNG and WebP are handled too). */
export function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mimeType: 'image/jpeg' };
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return { ext: 'png', mimeType: 'image/png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mimeType: 'image/webp' };
  return null;
}

export class Images {
  /**
   * @param {object} config  the loaded config (uses config.images)
   * @param {object} [o]
   * @param {Function} [o.fetchImpl]
   * @param {object} [o.usage]  the Usage tracker: pictures count against the month's cap
   * @param {number} [o.timeoutMs]  how long one picture may take, every try together
   */
  constructor(config, { fetchImpl = globalThis.fetch, usage = null, clock = Date.now, timeoutMs = MAKE_TIMEOUT_MS } = {}) {
    this.cfg = config.images || {};
    this.key = this.cfg.key || '';
    this.model = this.cfg.model || DEFAULT_IMAGE_MODEL;
    this.fetchImpl = fetchImpl;
    this.usage = usage;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.blocked = null; // { reason, until }: the key, billing or model can't make pictures
    this.inFlight = 0; // being drawn now (counted against the month before they're paid for)
    this.sendStore = true; // ask Google not to keep the request (dropped if it won't take the field)
    // Its last picture in each place (a server's calls, or one text channel), to change it:
    // key -> { data, mimeType, prompt, forName, at }. (Text chat can't reach a call's picture.)
    this.last = new Map();
  }

  /** Pictures are switched on and there's a Gemini key to make them with. */
  get enabled() {
    return this.cfg.enabled !== false && Boolean(this.key);
  }

  /** IMAGES_PER_MONTH (the cap). */
  perMonth() {
    return Number.isFinite(this.cfg.perMonth) ? this.cfg.perMonth : 100;
  }

  /** Pictures left this month (counted in usage.json, less any being drawn). */
  left() {
    const used = this.usage?.thisMonth?.().imageCount ?? 0;
    return Math.max(0, this.perMonth() - used - this.inFlight);
  }

  /** { ok, reason, left, busy }: whether a picture can be drawn right now, and why not. */
  status() {
    const left = this.left();
    if (this.cfg.enabled === false) return { ok: false, reason: 'pictures are turned off', left };
    if (!this.key) return { ok: false, reason: "there's no Gemini API key yet (the app, Settings > Keys)", left };
    if (this.blocked && this.clock() < this.blocked.until) return { ok: false, reason: this.blocked.reason, left };
    if (this.inFlight >= MAX_AT_ONCE) return { ok: false, reason: `it's already drawing ${MAX_AT_ONCE} pictures`, left, busy: true };
    if (left < 1) return { ok: false, reason: "this month's pictures are used up", left };
    return { ok: true, reason: '', left };
  }

  /** Its last picture in this place (see lastKey), while it can still be changed. */
  lastFor(key) {
    const l = this.last.get(key);
    return l && this.clock() - l.at < LAST_KEPT_MS ? l : null;
  }

  async request(body, { signal }) {
    const res = await fetchWithReconnect(this.fetchImpl, `${API}/interactions`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw imageError(res.status, text, { model: this.model });
    try {
      return JSON.parse(text);
    } catch {
      throw new ImageError(`Gemini sent back something that isn't JSON: ${text.slice(0, 120)}`, { userText: "Google's answer came back garbled; try again" });
    }
  }

  /**
   * Draws a picture. Resolves to { data (Buffer), mimeType, ext, prompt, edited, dollars },
   * or throws an ImageError (userText says why in plain words). edit: change its last
   * picture in this place (lastKey) instead of starting over.
   */
  async make({ prompt, aspect = null, edit = false }, { lastKey = '', forName = '', signal } = {}) {
    const st = this.status();
    if (!st.ok) throw new ImageError(st.reason, { userText: st.reason });
    const text = String(prompt ?? '').trim().slice(0, MAX_PROMPT_CHARS);
    if (!text) throw new ImageError('the picture had no description', { userText: 'there was nothing to draw' });
    const base = edit ? this.lastFor(lastKey) : null;
    // Only the change ("make it blue") and nothing to change: that would be a random picture.
    if (edit && !base) {
      throw new ImageError('no recent picture to change', { userText: "there's no recent picture of mine here to change; ask for the whole picture" });
    }
    const input = [];
    if (base) input.push({ type: 'image', data: base.data.toString('base64'), mime_type: base.mimeType });
    input.push({ type: 'text', text: base ? `Change this picture: ${text}` : text });
    const format = { type: 'image', image_size: '1K', mime_type: 'image/jpeg' };
    // (A change keeps the last picture's shape unless it asks for another.)
    const ratio = aspect && ASPECTS.includes(aspect) ? aspect : base ? null : '1:1';
    if (ratio) format.aspect_ratio = ratio;
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const started = this.clock();
    this.inFlight++;
    try {
      let res = null;
      for (let attempt = 0; ; attempt++) {
        const body = { model: this.model, input, response_format: format };
        if (this.sendStore) body.store = false;
        try {
          res = await this.request(body, { signal: sig });
          break;
        } catch (err) {
          if (sig.aborted) throw err;
          if (err instanceof ImageError && err.retryWithoutStore && this.sendStore) {
            log.info("Google didn't take the store setting; sending the picture request without it");
            this.sendStore = false;
            continue;
          }
          // A hiccup on Google's side: one more try.
          if (err instanceof ImageError && err.status >= 500 && attempt === 0) {
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          throw err;
        }
      }
      const found = findImage(res);
      if (!found) {
        const why = whyNoImage(res);
        // (A refusal's tokens may still cost a little.)
        if (res?.usage || res?.usageMetadata) this.usage?.record?.({ type: 'image', count: 0, dollars: pictureDollars(res, this.model), model: this.model });
        log.info(`no picture came back${why.text ? `: ${why.text}` : ''}`);
        throw new ImageError(`no picture in Google's answer${why.text ? ` (${why.text})` : ''}`, {
          userText: why.refused ? "Google wouldn't draw that one" : 'no picture came back; try asking again',
          refused: why.refused,
        });
      }
      // (Paid for once it's here, even if it turns out unreadable.)
      const dollars = pictureDollars(res, this.model);
      this.usage?.record?.({ type: 'image', count: 1, dollars, model: this.model });
      const data = Buffer.from(found.data, 'base64');
      const kind = sniffImage(data);
      if (!kind) throw new ImageError("the picture came back in a form it couldn't read", { userText: 'the picture came back broken; try again' });
      if (lastKey) this.last.set(lastKey, { data, mimeType: kind.mimeType, prompt: text, forName, at: this.clock() });
      log.info(`drew a picture in ${Math.round((this.clock() - started) / 100) / 10} s (${this.model}${base ? ', changing the last one' : ''}, ${Math.round(data.length / 1024)} KB, about $${dollars.toFixed(3)})`);
      return { data, mimeType: kind.mimeType, ext: kind.ext, prompt: text, edited: Boolean(base), dollars };
    } catch (err) {
      if (deadline.aborted && !signal?.aborted) {
        throw new ImageError('Google took too long to draw it', { userText: 'Google took too long drawing it; ask again in a bit' });
      }
      if (err instanceof ImageError && err.blocks) this.blocked = { reason: err.userText, until: this.clock() + BLOCK_MS };
      throw err;
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }
}

export function createImages(config, opts = {}) {
  return new Images(config, opts);
}

/** It may post files in this channel (unknown counts as yes: posting says so if not). */
export function canPostPictures(channel, me) {
  try {
    const perms = channel?.permissionsFor?.(me);
    if (!perms) return true;
    return perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]);
  } catch {
    return true;
  }
}

const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'just now' : m === 1 ? 'a minute ago' : `${m} minutes ago`;
};

/** Where its last picture is kept: a server's calls, or one text channel. */
export function lastKey(guildId, channelId = null) {
  return channelId ? `${guildId}:text:${channelId}` : `${guildId}:voice`;
}

/** For its prompt: whether it can draw a picture right now (and if not, why), and its last one. */
export function imagesNowFor({ images, lastKey: key = '', canPost = true }) {
  if (!images?.enabled) return '';
  if (!canPost) {
    return "You can't post pictures in this chat yet: your Discord role needs the Attach Files permission (Server Settings > Roles). If someone asks for one, tell them that in a few words.";
  }
  const st = images.status();
  const last = images.lastFor(key);
  const lastLine = last
    ? ` Your last picture (${ago(images.clock() - last.at)}${last.forName ? `, for ${last.forName}` : ''}) was: "${last.prompt.slice(0, 300)}". To change it, add edit="last".`
    : '';
  if (!st.ok) {
    return st.busy
      ? `You're already drawing ${MAX_AT_ONCE} pictures: if someone asks for another, tell them to ask again in a moment.${lastLine}`
      : `You can't draw a picture right now: ${st.reason}. If someone asks for one, tell them in a few words.${lastLine}`;
  }
  return `You can draw a picture if someone asks for one (${st.left} left this month).${lastLine}`;
}

/**
 * Draws the picture a reply agreed to and posts it: in the call's text chat, or as a reply
 * to the message that asked. Problems go in a small note instead. onPosted runs once it's up.
 * Resolves to 'posted', 'failed' or 'skipped'.
 */
export async function drawAndPost({ images, tag, channel, lastKey: key = '', forName = '', me = null, replyTo = null, signal, onPosted, onNote }) {
  const note = (text) => {
    const msg = { content: `-# (${text})`, allowedMentions: { parse: [], repliedUser: false } };
    const p = replyTo ? replyTo.reply(msg) : channel?.send?.(msg);
    Promise.resolve(p).catch(() => {});
    onNote?.(text);
  };
  if (!tag?.image) {
    if (tag?.cutOff) {
      log.warn("couldn't draw a picture: the answer ran out of room in the middle of describing it");
      note('I ran out of room describing that picture. Ask me again.');
    }
    return 'skipped';
  }
  if (!images || !channel) return 'skipped';
  if (!canPostPictures(channel, me)) {
    log.warn("couldn't post a picture: no Attach Files permission in that channel");
    note("I can't post pictures here: my role needs the Attach Files permission (Server Settings > Roles).");
    return 'failed';
  }
  let made;
  try {
    log.info(`drawing a picture${forName ? ` for ${forName}` : ''}${tag.image.edit ? ' (changing the last one)' : ''}`);
    made = await images.make(tag.image, { lastKey: key, forName, signal });
  } catch (err) {
    if (signal?.aborted) return 'skipped';
    log.warn(`couldn't draw a picture: ${err.message}`);
    note(`I couldn't draw that: ${err.userText || err.message}.`);
    return 'failed';
  }
  if (signal?.aborted) return 'skipped';
  const content = `-# ${forName ? `For ${forName}` : 'Here you go'}${made.edited ? ' (changed the last one)' : ''}`;
  const msg = { content, files: [{ attachment: made.data, name: `picture.${made.ext}` }], allowedMentions: { parse: [], repliedUser: false } };
  try {
    await (replyTo ? replyTo.reply(msg) : channel.send(msg));
  } catch (err) {
    log.warn(`couldn't post the picture: ${err.message}`);
    // 50013: missing a permission (Attach Files).
    note(err.code === 50013 ? "I drew it but can't post it here: my role needs the Attach Files permission (Server Settings > Roles)." : `I drew it but couldn't post it: ${err.message}.`);
    return 'failed';
  }
  onPosted?.(made);
  return 'posted';
}
