// Keeps count of what the bot spends: characters sent to ElevenLabs, minutes of
// audio sent to speech-to-text, and Claude tokens. Totals for today and this
// month are saved to data/usage.json so /usage can show them.
//
// Dollar figures are estimates from list prices (October 2026). The providers'
// own dashboards are the exact numbers; /usage also asks ElevenLabs and Deepgram
// directly for your real remaining credit when the keys allow it.

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';
import { readJsonFile } from './memory.js';

const log = logger('usage');

// Claude list prices in dollars per million tokens (prompts under 100K tokens).
// Sonnet 5.5 cache hits are billed at 0.05x input, Haiku 5.5 at 0.1x (Anthropic pricing page, Oct 2026).
export const CLAUDE_PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

// ElevenLabs API: Flash/Turbo models cost $0.04 per 1,000 characters, the others $0.08.
export function ttsDollarsPerChar(model = '') {
  return /flash|turbo/i.test(model) ? 0.04 / 1000 : 0.08 / 1000;
}
// On Starter, $6 buys 30,000 credits, so a credit is worth $0.0002 (Flash: 0.2 credits a character).
export const STARTER_DOLLARS_PER_CREDIT = 6 / 30000;

// Claude web search: $10 per 1,000 searches (the results also count as input tokens).
export const SEARCH_DOLLARS = 0.01;

// ElevenLabs Music (songs on request): about $0.15 a minute of song (paid plans include some minutes).
export const MUSIC_DOLLARS_PER_MINUTE = 0.15;

// Pictures (Gemini): the cost comes with each one (about $0.034 for a 1K picture).

// Speech-to-text, dollars per minute of audio.
const STT_PRICES = {
  deepgram: { base: 0.0043, keyterms: 0.0013 }, // Nova-3, pay as you go
  elevenlabs: { base: 0.22 / 60, keyterms: 0 }, // Scribe
  whisper: { base: 0, keyterms: 0 }, // on your own graphics card
};

const DAYS_KEPT = 62;
const MONTHS_KEPT = 24;
// Saved at most once a minute (the folder may be synced by OneDrive), and when a call ends.
const SAVE_EVERY_MS = 60000;

export function emptyBucket() {
  return {
    ttsChars: 0,
    ttsRequests: 0,
    ttsDollars: 0,
    sttSeconds: 0,
    sttRequests: 0,
    sttDollars: 0,
    claudeRequests: 0,
    claudeInput: 0,
    claudeOutput: 0,
    claudeCacheRead: 0,
    claudeCacheWrite: 0,
    claudeSearches: 0,
    claudeDollars: 0,
    musicSeconds: 0,
    musicRequests: 0,
    musicDollars: 0,
    imageCount: 0,
    imageDollars: 0,
    veniceRequests: 0,
    veniceInput: 0,
    veniceOutput: 0,
    veniceDollars: 0,
  };
}

function addInto(target, delta) {
  for (const k of Object.keys(delta)) target[k] = (target[k] || 0) + delta[k];
  return target;
}

/** What one event adds to the totals. */
export function costOf(event) {
  const d = emptyBucket();
  if (event.type === 'tts') {
    d.ttsChars = event.chars;
    d.ttsRequests = 1;
    d.ttsDollars = event.chars * ttsDollarsPerChar(event.model);
  } else if (event.type === 'stt') {
    d.sttSeconds = event.seconds;
    d.sttRequests = 1;
    const p = STT_PRICES[event.provider] || STT_PRICES.deepgram;
    d.sttDollars = (event.seconds / 60) * (p.base + (event.keyterms ? p.keyterms : 0));
  } else if (event.type === 'music') {
    d.musicSeconds = event.seconds;
    d.musicRequests = 1;
    d.musicDollars = (event.seconds / 60) * MUSIC_DOLLARS_PER_MINUTE;
  } else if (event.type === 'image') {
    // (count 0: one Google refused to draw, whose tokens may still cost a little.)
    d.imageCount = event.count ?? 1;
    d.imageDollars = Number(event.dollars) || 0;
  } else if (event.type === 'venice') {
    // Venice's models writing some of its lines (VENICE_FOR); priced in venice.js.
    const u = event.usage || {};
    d.veniceRequests = 1;
    d.veniceInput = u.prompt_tokens || 0;
    d.veniceOutput = u.completion_tokens || 0;
    d.veniceDollars = Number(event.dollars) || 0;
  } else if (event.type === 'claude') {
    const u = event.usage || {};
    d.claudeRequests = 1;
    d.claudeInput = u.input_tokens || 0;
    d.claudeOutput = u.output_tokens || 0;
    d.claudeCacheRead = u.cache_read_input_tokens || 0;
    d.claudeCacheWrite = u.cache_creation_input_tokens || 0;
    d.claudeSearches = u.server_tool_use?.web_search_requests || 0;
    d.claudeDollars = d.claudeSearches * SEARCH_DOLLARS;
    const p = CLAUDE_PRICES[event.model];
    if (p) {
      d.claudeDollars +=
        (d.claudeInput * p.input + d.claudeOutput * p.output + d.claudeCacheRead * p.cacheRead + d.claudeCacheWrite * p.cacheWrite) /
        1e6;
    }
  }
  return d;
}

/** "2026-10-22" in the given time zone (falls back to UTC if the zone is unknown). */
export function dayKey(ms, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The days and months from a saved usage.json, ignoring anything else in it. */
function savedTotals(parsed) {
  return { days: isObject(parsed?.days) ? parsed.days : {}, months: isObject(parsed?.months) ? parsed.months : {} };
}

export class Usage {
  /**
   * @param {object} o
   * @param {string} [o.dataDir]  where usage.json lives (omit to keep counts in memory only)
   * @param {string} [o.timezone] for deciding when "today" and "this month" start
   */
  constructor({ dataDir, timezone = 'UTC', clock = Date.now } = {}) {
    this.file = dataDir ? path.join(dataDir, 'usage.json') : null;
    this.timezone = timezone;
    this.clock = clock;
    this.running = emptyBucket(); // since the bot started
    this.data = { days: {}, months: {} };
    this.saveTimer = null;
    this.warnedSave = false;
    this.dirty = false; // counted since the last save
    // Set while usage.json is there but can't be read. This run is counted on its own
    // and added to the file once it reads, instead of being saved over it.
    this.unreadable = null;
    if (this.file) {
      const r = readJsonFile(this.file);
      if (r.status === 'ok') this.data = savedTotals(r.data);
      else if (r.status === 'corrupt') {
        log.error(`${this.file} was damaged (${r.error.message}), so it was moved to ${path.basename(r.movedTo)} and the counts start from zero`);
      } else if (r.status === 'unreadable') {
        this.unreadable = r.error.code || r.error.message;
        log.error(`could not read ${this.file} (${this.unreadable}). Counting this run on its own; it's added to the file once the file can be read.`);
      }
    }
  }

  /** Tries usage.json again after it couldn't be read. True once it has been (or it's gone). */
  retryRead() {
    if (!this.unreadable) return true;
    const r = readJsonFile(this.file, { tries: 1 });
    if (r.status === 'unreadable') return false;
    if (r.status === 'corrupt') log.error(`${this.file} was damaged (${r.error.message}), so it was moved to ${path.basename(r.movedTo)}`);
    const saved = savedTotals(r.status === 'ok' ? r.data : null);
    // Everything counted so far this run goes on top of what was saved.
    for (const [k, b] of Object.entries(this.data.days)) saved.days[k] = addInto(isObject(saved.days[k]) ? saved.days[k] : emptyBucket(), b);
    for (const [k, b] of Object.entries(this.data.months)) saved.months[k] = addInto(isObject(saved.months[k]) ? saved.months[k] : emptyBucket(), b);
    this.data = saved;
    this.unreadable = null;
    log.info(`read ${this.file} after all; this run's counts were added to it`);
    return true;
  }

  /** Called by the API clients after each request that costs something. Never throws. */
  record(event) {
    try {
      const d = costOf(event);
      addInto(this.running, d);
      const day = dayKey(this.clock(), this.timezone);
      const month = day.slice(0, 7);
      this.data.days[day] = addInto(this.data.days[day] || emptyBucket(), d);
      this.data.months[month] = addInto(this.data.months[month] || emptyBucket(), d);
      this.save();
    } catch (err) {
      log.debug(`could not record usage: ${err.message}`);
    }
  }

  /** A copy of the running totals, to measure one call from start to end. */
  snapshot() {
    return { ...this.running };
  }

  /** What was used since a snapshot. */
  since(snap) {
    const out = emptyBucket();
    for (const k of Object.keys(out)) out[k] = (this.running[k] || 0) - (snap?.[k] || 0);
    return out;
  }

  today() {
    return { ...emptyBucket(), ...this.data.days[dayKey(this.clock(), this.timezone)] };
  }

  thisMonth() {
    return { ...emptyBucket(), ...this.data.months[dayKey(this.clock(), this.timezone).slice(0, 7)] };
  }

  save() {
    this.dirty = true;
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), SAVE_EVERY_MS);
    this.saveTimer.unref?.();
  }

  /** Writes usage.json now, if anything was counted since the last save. */
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file || !this.dirty) return;
    // Never save over a file it couldn't read: that would wipe the totals in it.
    if (this.unreadable && !this.retryRead()) return;
    this.prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...this.data }, null, 1));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      this.warnedSave = false;
    } catch (err) {
      // Say it once, not every minute (a sync app can briefly lock the file).
      if (!this.warnedSave) log.warn(`could not save ${this.file}: ${err.message}`);
      this.warnedSave = true;
    }
  }

  prune() {
    const days = Object.keys(this.data.days).sort();
    for (const k of days.slice(0, Math.max(0, days.length - DAYS_KEPT))) delete this.data.days[k];
    const months = Object.keys(this.data.months).sort();
    for (const k of months.slice(0, Math.max(0, months.length - MONTHS_KEPT))) delete this.data.months[k];
  }
}

// ---- Formatting -------------------------------------------------------------

export function money(dollars) {
  if (!dollars) return '$0.00';
  if (dollars < 0.01) return '<$0.01';
  return `$${dollars.toFixed(2)}`;
}

const num = (n) => Math.round(n).toLocaleString('en-US');

function minutes(seconds) {
  const m = seconds / 60;
  if (m < 1) return `${Math.round(seconds)} s`;
  if (m < 60) return `${Math.round(m)} min`;
  return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
}

export function totalDollars(b) {
  return b.ttsDollars + b.sttDollars + b.claudeDollars + (b.musicDollars || 0) + (b.imageDollars || 0) + (b.veniceDollars || 0);
}

/** One line per service for a period, e.g. for /usage and the end-of-call log. */
export function describeBucket(b) {
  const credits = b.ttsDollars / STARTER_DOLLARS_PER_CREDIT;
  return [
    `Voice: ${num(b.ttsChars)} characters spoken (about ${num(credits)} ElevenLabs credits on Starter, ${money(b.ttsDollars)})`,
    `Hearing: ${minutes(b.sttSeconds)} of audio transcribed (${money(b.sttDollars)})`,
    `Brain: ${num(b.claudeRequests)} Claude replies and checks${b.claudeSearches ? `, ${num(b.claudeSearches)} web searches` : ''} (${money(b.claudeDollars)})`,
    // (Only once Venice has written something.)
    ...(b.veniceRequests ? [`Venice: ${num(b.veniceRequests)} replies and checks (${money(b.veniceDollars || 0)})`] : []),
    // (Only once it has made a song.)
    ...(b.musicRequests ? [`Songs: ${num(b.musicRequests)} made, ${minutes(b.musicSeconds)} of music (${money(b.musicDollars)})`] : []),
    // (Only once it has drawn a picture.)
    ...(b.imageCount || b.imageDollars ? [`Pictures: ${num(b.imageCount || 0)} drawn (${money(b.imageDollars)})`] : []),
    `Total: about ${money(totalDollars(b))}`,
  ];
}

/** Short one-line version for the log. */
export function oneLine(b) {
  const songs = b.musicRequests ? `, ${num(b.musicRequests)} ${b.musicRequests === 1 ? 'song' : 'songs'}` : '';
  const pictures = b.imageCount ? `, ${num(b.imageCount)} ${b.imageCount === 1 ? 'picture' : 'pictures'}` : '';
  const venice = b.veniceRequests ? `, ${num(b.veniceRequests)} Venice calls` : '';
  return `${num(b.ttsChars)} characters spoken, ${minutes(b.sttSeconds)} of audio transcribed, ${num(b.claudeRequests)} Claude calls${venice}${songs}${pictures}, about ${money(totalDollars(b))}`;
}

// ---- Real balances, straight from the providers ------------------------------

/**
 * ElevenLabs credits used and included this month. Needs the key's "User" read
 * permission. Returns null when unavailable.
 */
export async function elevenLabsQuota(config, { fetchImpl = globalThis.fetch } = {}) {
  if (!config.tts?.elevenKey) return null;
  try {
    const res = await fetchImpl('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': config.tts.elevenKey },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const s = await res.json();
    if (typeof s.character_count !== 'number' || typeof s.character_limit !== 'number') return null;
    return {
      used: s.character_count,
      limit: s.character_limit,
      tier: s.tier || null,
      resetsAt: typeof s.next_character_count_reset_unix === 'number' ? s.next_character_count_reset_unix * 1000 : null,
    };
  } catch {
    return null;
  }
}

/**
 * Deepgram credit left on the account (the free $200 starts here). Needs a key
 * allowed to read project balances. Returns null when unavailable.
 */
export async function deepgramBalance(config, { fetchImpl = globalThis.fetch } = {}) {
  // Also shown with local Whisper, since Deepgram covers whenever Whisper isn't running.
  if (config.stt?.provider === 'elevenlabs' || !config.stt?.deepgramKey) return null;
  const headers = { Authorization: `Token ${config.stt.deepgramKey}` };
  try {
    const projectsRes = await fetchImpl('https://api.deepgram.com/v1/projects', { headers, signal: AbortSignal.timeout(6000) });
    if (!projectsRes.ok) return null;
    const projectId = (await projectsRes.json())?.projects?.[0]?.project_id;
    if (!projectId) return null;
    const res = await fetchImpl(`https://api.deepgram.com/v1/projects/${encodeURIComponent(projectId)}/balances`, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const balances = (await res.json())?.balances;
    if (!Array.isArray(balances) || !balances.length) return null;
    const usd = balances.filter((b) => !b.units || /usd/i.test(b.units));
    if (!usd.length) return null;
    return { dollars: usd.reduce((sum, b) => sum + (Number(b.amount) || 0), 0) };
  } catch {
    return null;
  }
}

/** Formats a reset time like "Nov 21". */
export function shortDate(ms, timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric' }).format(ms);
  } catch {
    return new Date(ms).toDateString().slice(4, 10);
  }
}
