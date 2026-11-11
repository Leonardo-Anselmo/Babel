// Songs on request: when someone asks for one, Claude writes the words and the
// sound in a <song> tag after its line (never said out loud); this makes the song
// with ElevenLabs Music and hands back audio for the call.
//
// ElevenLabs Music (docs, Oct 2026): POST /v1/music with a composition plan
// ({ chunks: [{ text, duration_ms, positive_styles, negative_styles, context_adherence }] },
// 3-120 s a chunk, up to 30 lines of up to 200 characters) or a plain prompt with
// music_length_ms; output_format pcm_48000 gives raw 16-bit audio at Discord's rate.
// Paid plans only, about $0.15 a minute; the key needs access to Music.

import { logger } from './log.js';
import { fetchWithReconnect } from './net.js';

const log = logger('songs');
const MUSIC_URL = 'https://api.elevenlabs.io/v1/music';
export const SONG_RATE = 48000;
export const MIN_SONG_SECONDS = 15;
export const DEFAULT_SONG_SECONDS = 30;
const SECTION_MIN_MS = 3000;
const SECTION_MAX_MS = 120000;
const MAX_LINES = 24;
const MAX_LINE_CHARS = 200;
const MAX_SECTIONS = 8;
const MAX_STYLES = 12;
const MAX_PROMPT_CHARS = 4000;
// Generation time isn't documented: give a song (every try at it together) three minutes.
const MAKE_TIMEOUT_MS = 180000;
// The song is brought to about the loudness of its voice (16-bit RMS), with peaks kept below this.
const TARGET_RMS = 3200;
const PEAK_MAX = 26000;
const MAX_GAIN = 4;
const DEFAULT_STYLES = ['upbeat pop', 'catchy melody', 'clear lead vocals'];

const SONG_TAG = /<song\b([^>]*)>([\s\S]*?)<\/song\s*>/gi;
const OPEN_SONG = /<song\b/i;

/** The text with song tags taken out (and anything after one that hasn't been closed yet). */
export function withoutSongTags(text) {
  let t = String(text ?? '').replace(SONG_TAG, ' ').replace(/<\/song\s*>/gi, ' ');
  const open = t.search(OPEN_SONG);
  if (open !== -1) t = t.slice(0, open);
  return t;
}

/** It started a song tag and never finished it (the reply ran out of room). */
export function cutOffInSong(text) {
  return OPEN_SONG.test(String(text ?? '').replace(SONG_TAG, ' '));
}

function attr(attrs, name) {
  const m = new RegExp(String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
}

/** The songs a reply asks for: [{ style, seconds, lyrics }]. */
export function songTags(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(SONG_TAG)) {
    // (A picture, reminder or list tag written into the words is dropped whole, not sung.)
    const lyrics = m[2]
      .replace(/<(image|reminder|list_[a-z]+)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<\/?[a-z_]+[^>]*>/gi, ' ')
      .trim();
    const seconds = Number.parseFloat(attr(m[1], 'seconds'));
    out.push({ style: attr(m[1], 'style'), seconds: Number.isFinite(seconds) ? seconds : null, lyrics });
  }
  return out;
}

const SECTION_WORDS = /^(?:verse|chorus|pre-?chorus|bridge|intro|outro|hook|refrain|breakdown|post-?chorus)(?:\s*\d+)?$/i;

function tidyName(name) {
  const n = String(name).replace(/[:\s]+$/g, '').replace(/\s+/g, ' ').trim();
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Verse';
}

/**
 * Lyrics as sections: "[Chorus]" (or "Chorus:" on its own line) starts one. Lines
 * before any heading are a verse. Tidied, capped at MAX_LINES lines in all.
 */
export function parseLyrics(lyrics) {
  const sections = [];
  let cur = null;
  let total = 0;
  for (const raw of String(lyrics ?? '').split(/\r?\n/)) {
    const line = raw.replace(/[*_`#>~|]/g, '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    // "[Chorus]" always; "(Chorus)" or "Chorus:" only when it's a section's name ("(oh oh oh)" is a line).
    const paren = /^\(\s*([^)]{1,40}?)\s*\)$/.exec(line);
    const head =
      /^\[\s*([^\]]{1,40}?)\s*\]$/.exec(line) ??
      (paren && SECTION_WORDS.test(paren[1]) ? paren : null) ??
      (SECTION_WORDS.test(line.replace(/:$/, '')) ? [line, line.replace(/:$/, '')] : null);
    if (head) {
      if (sections.length >= MAX_SECTIONS) break;
      cur = { name: tidyName(head[1]), lines: [] };
      sections.push(cur);
      continue;
    }
    if (total >= MAX_LINES) continue;
    if (!cur) {
      cur = { name: 'Verse', lines: [] };
      sections.push(cur);
    }
    cur.lines.push(line.slice(0, MAX_LINE_CHARS));
    total++;
  }
  return sections.filter((s) => s.lines.length > 0);
}

/** "upbeat pop punk, fast drums; male vocals" -> its parts (a few defaults when it gave none). */
export function splitStyles(style) {
  const parts = String(style ?? '')
    .split(/[,;\n]+/)
    .map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(Boolean);
  const unique = [...new Set(parts.map((p) => p.toLowerCase()))].map((k) => parts.find((p) => p.toLowerCase() === k));
  return unique.length ? unique.slice(0, MAX_STYLES) : [...DEFAULT_STYLES];
}

/**
 * A composition plan for the song: one chunk per section, each at least 3 s, with the
 * time shared out by how many lines each has. Sections are merged when the song is too
 * short for all of them.
 */
export function buildPlan({ style, seconds, sections }) {
  const styles = splitStyles(style);
  const totalMs = Math.round(seconds * 1000);
  let secs = sections.map((s) => ({ name: s.name, lines: [...s.lines] }));
  while (secs.length > 1 && secs.length * SECTION_MIN_MS > totalMs) {
    const last = secs.pop();
    secs[secs.length - 1].lines.push(...last.lines);
  }
  const weights = secs.map((s) => Math.max(1, s.lines.length));
  const sum = weights.reduce((a, b) => a + b, 0);
  const extra = Math.max(0, totalMs - secs.length * SECTION_MIN_MS);
  let given = 0;
  const chunks = secs.map((s, i) => {
    const last = i === secs.length - 1;
    const share = last ? extra - given : Math.floor((extra * weights[i]) / sum);
    given += share;
    return {
      text: `[${s.name}]\n${s.lines.slice(0, 30).join('\n')}`,
      duration_ms: Math.min(SECTION_MAX_MS, SECTION_MIN_MS + share),
      positive_styles: styles,
      negative_styles: ['a cappella'],
      context_adherence: 'high',
    };
  });
  return { chunks };
}

const clampChunk = (ms) => Math.min(SECTION_MAX_MS, Math.max(SECTION_MIN_MS, Math.round(ms)));

/** How long a plan's chunks add up to, in ms. */
export function planMs(plan) {
  return (plan?.chunks ?? []).reduce((a, c) => a + (Number(c?.duration_ms) || 0), 0);
}

/**
 * A plan ElevenLabs suggested, with its chunks fitted to the song's length (so it can't
 * run longer than the song that was allowed). Null when it isn't a plan.
 */
export function fitPlan(plan, totalMs) {
  const chunks = (Array.isArray(plan?.chunks) ? plan.chunks : [])
    .filter((c) => c && typeof c === 'object' && typeof c.text === 'string')
    .map((c) => ({ ...c, duration_ms: Number(c.duration_ms) > 0 ? Number(c.duration_ms) : SECTION_MIN_MS }));
  if (!chunks.length) return null;
  // Too many chunks for the length: the last ones join the one before.
  while (chunks.length > 1 && chunks.length * SECTION_MIN_MS > totalMs) {
    const last = chunks.pop();
    const prev = chunks[chunks.length - 1];
    prev.text = `${prev.text}\n${last.text}`;
    prev.duration_ms += last.duration_ms;
  }
  const sum = chunks.reduce((a, c) => a + c.duration_ms, 0);
  const ms = chunks.map((c) => clampChunk((c.duration_ms * totalMs) / sum));
  // Rounding and the 3-120 s limits: the difference comes off (or goes onto) the last chunks.
  let diff = totalMs - ms.reduce((a, b) => a + b, 0);
  for (let i = ms.length - 1; i >= 0 && diff !== 0; i--) {
    const next = clampChunk(ms[i] + diff);
    diff -= next - ms[i];
    ms[i] = next;
  }
  return { ...plan, chunks: chunks.map((c, i) => ({ ...c, duration_ms: ms[i] })) };
}

/** The same song as a plain prompt (when a plan isn't accepted). */
export function promptFor({ style, sections }) {
  const words = sections.map((s) => `[${s.name}]\n${s.lines.join('\n')}`).join('\n');
  return `${splitStyles(style).join(', ')}. A short, funny song with these lyrics:\n${words}`.slice(0, MAX_PROMPT_CHARS);
}

export class SongError extends Error {
  constructor(message, { status = 0, code = '', suggestion = null, userText = '', blocks = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.suggestion = suggestion;
    this.userText = userText || message;
    // The key or the plan can't make songs at all: stop offering them until a restart.
    this.blocks = blocks;
  }
}

const NO_MUSIC_ACCESS =
  "the ElevenLabs key isn't allowed to make music. In ElevenLabs open Developers > API Keys and turn on Music for the key (or make a new key with it and paste it in the app under Settings > Keys)";

/** Turns an ElevenLabs Music error into a SongError with a reason people can act on. */
export function musicError(status, bodyText) {
  let code = '';
  let message = String(bodyText ?? '').slice(0, 300);
  let suggestion = null;
  try {
    const json = JSON.parse(bodyText);
    const d = json?.detail ?? json;
    if (Array.isArray(d)) {
      message = d.map((e) => e?.msg).filter(Boolean).join('; ') || message;
      code = 'validation_error';
    } else if (d && typeof d === 'object') {
      code = String(d.status || d.code || '');
      message = String(d.message || message);
      suggestion = d.data?.composition_plan_suggestion ?? d.data?.prompt_suggestion ?? null;
    } else if (typeof d === 'string') {
      message = d;
    }
  } catch {
    // not JSON
  }
  const lower = `${code} ${message}`.toLowerCase();
  let userText = '';
  let blocks = false;
  // What it says comes first: ElevenLabs answers a missing permission and an empty
  // balance with 401 too, not only a bad key.
  if (/missing_permissions|insufficient_permissions|missing the permission|not have (?:the )?permission/.test(lower)) {
    userText = NO_MUSIC_ACCESS;
    blocks = true;
  } else if (status === 402 || /quota_exceeded|insufficient_credits|quota|credits/.test(lower)) {
    userText = "there aren't enough ElevenLabs credits left for a song";
  } else if (/feature_not_available|subscription_required|upgrade|paid plan|not available (?:on|for|with) your/.test(lower) || (status === 403 && /plan|subscription/.test(lower))) {
    userText = "your ElevenLabs plan can't make music through the API";
    blocks = true;
  } else if (status === 401) {
    userText = 'ElevenLabs rejected the API key';
    blocks = true;
  } else if (status === 403) {
    userText = NO_MUSIC_ACCESS;
    blocks = true;
  } else if (status === 429) {
    userText = 'ElevenLabs is busy right now; ask again in a minute';
  } else if (/bad_prompt|bad_composition_plan/.test(lower)) {
    userText = "ElevenLabs turned that one down (it won't copy real artists or songs)";
  }
  return new SongError(`ElevenLabs Music ${status}${code ? ` (${code})` : ''}: ${message}`.slice(0, 300), { status, code, suggestion, userText, blocks });
}

// 16-bit samples as numbers (little-endian, like every PC this runs on): a view of the
// buffer when it's aligned, otherwise a copy. Typed arrays keep a minute of audio quick.
function samples(buf) {
  const n = Math.floor(buf.length / 2);
  if (buf.byteOffset % 2 === 0) return new Int16Array(buf.buffer, buf.byteOffset, n);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}
const asBuffer = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);

/** Interleaved 16-bit stereo -> mono (the call plays one channel to everyone anyway). */
export function downmix(stereo) {
  const s = samples(stereo);
  const frames = Math.floor(s.length / 2);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) out[i] = Math.round((s[2 * i] + s[2 * i + 1]) / 2);
  return asBuffer(out);
}

// How loud 16-bit audio is, added to acc: { sum of squares, samples, peak }.
function measure(buf, acc = { sum: 0, n: 0, peak: 0 }) {
  const s = samples(buf);
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    acc.sum += v * v;
    const a = v < 0 ? -v : v;
    if (a > acc.peak) acc.peak = a;
  }
  acc.n += s.length;
  return acc;
}

// The gain that brings it to its voice's loudness, peaks kept in range (null: it's silent).
function gainFor({ sum, n, peak }) {
  const rms = n ? Math.sqrt(sum / n) : 0;
  if (rms < 20 || peak < 200) return null;
  return Math.min(MAX_GAIN, TARGET_RMS / rms, PEAK_MAX / peak);
}

function applyGain(buf, gain) {
  const s = samples(buf);
  const out = new Int16Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const v = Math.round(s[i] * gain);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return asBuffer(out);
}

/** Brings 16-bit mono audio to about the loudness of its voice. Returns null for silence. */
export function normalize(mono) {
  const gain = gainFor(measure(mono));
  if (gain === null) return null;
  return Math.abs(gain - 1) < 0.02 ? mono : applyGain(mono, gain);
}

// A second of audio at a time, with a breather in between: a minute of song worked through
// in one go would hold up the call's audio (it plays every 20 ms) for a noticeable moment.
const PIECE_FRAMES = SONG_RATE;
const breather = () => new Promise((r) => setImmediate(r));

/** downmix (for stereo) and normalize, a piece at a time. Null for silence. */
export async function prepareSong(raw, channels) {
  let mono = raw;
  if (channels === 2) {
    const parts = [];
    for (let i = 0; i < raw.length; i += PIECE_FRAMES * 4) {
      parts.push(downmix(raw.subarray(i, i + PIECE_FRAMES * 4)));
      await breather();
    }
    mono = Buffer.concat(parts);
  }
  const step = PIECE_FRAMES * 2;
  const acc = { sum: 0, n: 0, peak: 0 };
  for (let i = 0; i < mono.length; i += step) {
    measure(mono.subarray(i, i + step), acc);
    await breather();
  }
  const gain = gainFor(acc);
  if (gain === null) return null;
  if (Math.abs(gain - 1) < 0.02) return mono;
  const parts = [];
  for (let i = 0; i < mono.length; i += step) {
    parts.push(applyGain(mono.subarray(i, i + step), gain));
    await breather();
  }
  return Buffer.concat(parts);
}

/**
 * Raw PCM doesn't say how many channels it has: judged from its length against the
 * length asked for (and the content type, when it says).
 */
export function guessChannels(bytes, seconds, contentType = '') {
  if (/channels\s*=\s*2|stereo/i.test(contentType)) return 2;
  if (/channels\s*=\s*1|mono/i.test(contentType)) return 1;
  const ratio = bytes / 2 / (seconds * SONG_RATE);
  return Math.abs(ratio - 2) < Math.abs(ratio - 1) ? 2 : 1;
}

export class Songs {
  /**
   * @param {object} config  the loaded config (uses config.songs and config.tts.elevenKey)
   * @param {object} [o]
   * @param {Function} [o.fetchImpl]
   * @param {object} [o.usage]  the Usage tracker: songs count against the month's minutes
   * @param {number} [o.timeoutMs]  how long a song may take to make, every try at it together
   */
  constructor(config, { fetchImpl = globalThis.fetch, usage = null, clock = Date.now, timeoutMs = MAKE_TIMEOUT_MS } = {}) {
    this.cfg = config.songs || {};
    this.key = config.tts?.elevenKey || '';
    this.fetchImpl = fetchImpl;
    this.usage = usage;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.blocked = ''; // why songs can't be made at all (the key or the plan), until a restart
    this.reservedSeconds = 0; // songs being made right now, counted before they're paid for
  }

  /** Songs are switched on and there's a key to make them with. */
  get enabled() {
    return this.cfg.enabled !== false && Boolean(this.key);
  }

  get maxSeconds() {
    return Math.max(MIN_SONG_SECONDS, Number(this.cfg.maxSeconds) || 60);
  }

  /** Minutes of songs left this month (SONG_MINUTES_PER_MONTH, counted in usage.json, less any being made). */
  minutesLeft() {
    const cap = Number.isFinite(this.cfg.minutesPerMonth) ? this.cfg.minutesPerMonth : 10;
    const used = ((this.usage?.thisMonth?.().musicSeconds ?? 0) + this.reservedSeconds) / 60;
    return Math.max(0, cap - used);
  }

  /** { ok, reason, minutesLeft }: whether a song can be made right now, and why not. */
  status() {
    const minutesLeft = this.minutesLeft();
    if (!this.enabled) return { ok: false, reason: 'songs are turned off', minutesLeft };
    if (this.blocked) return { ok: false, reason: this.blocked, minutesLeft };
    if (minutesLeft * 60 < MIN_SONG_SECONDS) return { ok: false, reason: "this month's song minutes are used up", minutesLeft };
    return { ok: true, reason: '', minutesLeft };
  }

  async request(body, { signal } = {}) {
    const res = await fetchWithReconnect(this.fetchImpl, `${MUSIC_URL}?output_format=pcm_${SONG_RATE}`, {
      method: 'POST',
      headers: { 'xi-api-key': this.key, 'content-type': 'application/json', accept: 'audio/*, application/octet-stream' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw musicError(res.status, text);
    }
    // (Buffer.from on an ArrayBuffer is a view of it, not a copy.)
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers?.get?.('content-type') || '' };
  }

  /**
   * Makes the song. Resolves to { pcm (16-bit mono), sampleRate, seconds, lyricsText, model, how },
   * or throws a SongError (userText says why in plain words).
   */
  async make({ style, seconds, lyrics }, { signal } = {}) {
    const st = this.status();
    if (!st.ok) throw new SongError(st.reason, { userText: st.reason });
    const sections = parseLyrics(lyrics);
    if (!sections.length) throw new SongError('the song had no words to sing', { userText: 'the song had no words to sing' });
    const asked = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SONG_SECONDS;
    const secs = Math.round(Math.max(MIN_SONG_SECONDS, Math.min(asked, this.maxSeconds, Math.floor(st.minutesLeft * 60))));
    const model = this.cfg.model || 'music_v2_5';
    const plan = buildPlan({ style, seconds: secs, sections });
    const started = this.clock();
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
    // Counted against the month while it's made, so two at once can't go past the cap.
    this.reservedSeconds += secs;
    try {
      let got = null;
      let how = 'plan';
      let sentSeconds = secs;
      try {
        try {
          got = await this.request({ composition_plan: plan, model_id: model }, { signal: sig });
        } catch (err) {
          if (sig.aborted || !(err instanceof SongError) || err.blocks || [401, 402, 429].includes(err.status) || err.status >= 500) throw err;
          const suggested = err.code === 'bad_composition_plan' ? fitPlan(err.suggestion, secs * 1000) : null;
          if (suggested) {
            // ElevenLabs rewrote the plan itself (its own rules, on its servers). Nothing here
            // can lift that, so the rewrite is logged as a warning instead of passing as the
            // original song: if a song comes back different from what was written, this is why.
            log.warn('ElevenLabs rewrote the song plan itself; the song is its version, not the one written here');
            how = 'plan rewritten by ElevenLabs';
            sentSeconds = planMs(suggested) / 1000;
            got = await this.request({ composition_plan: suggested, model_id: model }, { signal: sig });
          } else if (err.status === 400 || err.status === 422) {
            // The plan wasn't taken (a format this model doesn't know): the same song as a prompt.
            log.info(`the song plan wasn't accepted (${err.message}); trying it as a prompt`);
            how = 'prompt';
            got = await this.promptSong({ style, sections, secs, model }, { signal: sig });
          } else {
            throw err;
          }
        }
      } catch (err) {
        if (deadline.aborted && !signal?.aborted) {
          throw new SongError('ElevenLabs took too long to make the song', { userText: 'ElevenLabs took too long making it; ask again in a bit' });
        }
        throw this.noteBlock(err);
      }
      // ElevenLabs charges for the length asked for once it's made, whether or not it plays.
      this.usage?.record?.({ type: 'music', seconds: sentSeconds });
      const tookMs = this.clock() - started;
      const channels = guessChannels(got.audio.length, sentSeconds, got.contentType);
      // (Neither one nor two channels fits its length: worth a line in the log if it sounds wrong.)
      const fit = got.audio.length / 2 / (sentSeconds * SONG_RATE) / channels;
      if (Math.abs(fit - 1) > 0.15) log.warn(`the song came back an unexpected length (${got.audio.length} bytes for ${sentSeconds} s, taken as ${channels === 2 ? 'stereo' : 'mono'}); it may not sound right`);
      const raw = got.audio.subarray(0, got.audio.length - (got.audio.length % (channels * 2)));
      const pcm = await prepareSong(raw, channels);
      if (!pcm) throw new SongError('the song came back silent', { userText: 'the song came back silent' });
      const madeSeconds = pcm.length / 2 / SONG_RATE;
      log.info(`made a ${Math.round(madeSeconds)} s song in ${Math.round(tookMs / 1000)} s (${model}, ${how}, ${channels === 2 ? 'stereo' : 'mono'})`);
      return {
        pcm,
        sampleRate: SONG_RATE,
        seconds: madeSeconds,
        lyricsText: sections.map((sec) => sec.lines.join(' / ')).join(' / '),
        model,
        how,
      };
    } finally {
      this.reservedSeconds = Math.max(0, this.reservedSeconds - secs);
    }
  }

  /** The song as a plain prompt, once more with ElevenLabs' suggested wording if it names something it shouldn't. */
  async promptSong({ style, sections, secs, model }, { signal }) {
    const body = { prompt: promptFor({ style, sections }), music_length_ms: secs * 1000, model_id: model };
    try {
      return await this.request(body, { signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof SongError && err.code === 'bad_prompt' && typeof err.suggestion === 'string' && err.suggestion.trim()) {
        // Same as the plan above: ElevenLabs' own rewrite, on its servers, logged rather than hidden.
        log.warn('ElevenLabs rewrote the song prompt itself; the song is its version, not the one written here');
        return this.request({ ...body, prompt: err.suggestion.slice(0, MAX_PROMPT_CHARS) }, { signal });
      }
      throw err;
    }
  }

  /** An error that means songs can't work at all (the key, the plan): remember it so it isn't offered again. */
  noteBlock(err) {
    if (err instanceof SongError && err.blocks) this.blocked = err.userText;
    return err;
  }
}

export function createSongs(config, opts = {}) {
  return new Songs(config, opts);
}
