// Reminders and timers people ask for in voice ("Babel, remind me in ten minutes to
// queue", "set a timer for five minutes", "tell us at nine thirty"). The answer carries
// a <reminder> tag that is never spoken: when it should go off, for whom, and the line
// to say then. They're saved in data/memory.json, so they still go off after a
// restart, and said in the call when due (or posted in the text chat when it isn't in
// a call with that person then). REMINDERS=false turns this off.

import { logger } from './log.js';

const log = logger('reminders');

export const MAX_REMINDERS = 20; // per server
export const MAX_AHEAD_MS = 24 * 3600000; // up to a day ahead
const MIN_AHEAD_MS = 5000;
// One that came due while the bot was off is still delivered if it's at most this late.
export const LATE_OK_MS = 60 * 60000;
const MAX_LINE_CHARS = 300;

const REMINDER_TAG = /<reminder\b([^>]*)>([\s\S]*?)<\/reminder\s*>/gi;
// <cancel_reminder id="2"/>, or written with a closing tag (and maybe words) after it.
const CANCEL_TAG = /<cancel_reminder\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cancel_reminder\s*>)/gi;
// One still being written (or never closed): everything from it on isn't words.
const OPEN_TAG = /<reminder\b|<cancel_reminder\b(?![^>]*\/>)/i;

/** The name="value" pairs in a tag. */
function attributes(text) {
  const out = {};
  for (const m of String(text ?? '').matchAll(/([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
  return out;
}

/**
 * The reminder tags in a reply: { set: [{ in, at, for, say }], cancel: [{ id, all }] }.
 * in: how long from now ("10 minutes"); at: a clock time ("21:30"); for: a name, or
 * "everyone"; say: the line to say when it goes off.
 */
export function reminderTags(text) {
  const set = [];
  const cancel = [];
  const t = String(text ?? '');
  for (const m of t.matchAll(REMINDER_TAG)) {
    const a = attributes(m[1]);
    set.push({ in: a.in || null, at: a.at || null, for: a.for || null, say: m[2].replace(/<\/?say\s*>/gi, ' ').replace(/\s+/g, ' ').trim() });
  }
  for (const m of t.matchAll(CANCEL_TAG)) {
    const a = attributes(m[1]);
    const id = Number.parseInt(String(a.id ?? '').replace(/^#/, ''), 10);
    cancel.push({ id: Number.isFinite(id) ? id : null, all: /^(?:yes|true|all|1)$/i.test(a.all || '') });
  }
  return { set, cancel };
}

/**
 * A reply without its reminder tags (they're never spoken), including any <say> written
 * inside one, cut at one still being written. A stray closing tag is dropped too.
 */
export function withoutReminderTags(text) {
  let t = String(text ?? '')
    .replace(REMINDER_TAG, ' ')
    .replace(CANCEL_TAG, ' ')
    .replace(/<\/(?:reminder|cancel_reminder)\s*>/gi, ' ');
  const open = t.search(OPEN_TAG);
  if (open !== -1) t = t.slice(0, open);
  return t;
}

/** A reply that ran out of room in the middle of a reminder tag (the reminder it agreed to can't be set). */
export function cutOffInReminder(text) {
  const t = String(text ?? '').replace(REMINDER_TAG, ' ');
  return /<reminder\b/i.test(t);
}

const UNIT_MS = { s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000, h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000 };
const NUMBER_WORDS = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  'forty-five': 45,
  fortyfive: 45,
  'thirty-five': 35,
  forty: 40,
  fifty: 50,
  sixty: 60,
  ninety: 90,
};
// "twenty-five", "forty five": a tens word and a ones word.
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };
const ONES = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

/**
 * "10 minutes", "1h30m", "1h30", "an hour and a half", "one and a half hours", "a quarter
 * of an hour", "twenty-five minutes", "90 seconds", "10" (minutes) -> ms, or null.
 */
export function parseDuration(text) {
  let t = String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/\b(?:a\s+)?quarter\s+(?:of\s+an\s+)?hour\b/g, '15 minutes')
    .replace(/\bhalf\s+(?:an\s+)?hour\b/g, '30 minutes')
    .replace(/\b(twenty|thirty|forty|fifty)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, a, b) => String(TENS[a] + ONES[b]))
    // "one and a half hours" -> "1.5 hours"
    .replace(/(\d+|[a-z]+)\s+and\s+a\s+half\s+(hours?|hrs?|minutes?|mins?)\b/g, (m, n, unit) => {
      const v = /^\d/.test(n) ? Number(n) : NUMBER_WORDS[n];
      return Number.isFinite(v) ? `${v + 0.5} ${unit}` : m;
    })
    // "1h30", "2 hours 15" -> minutes after the hours
    .replace(/(\d+)\s*(h|hrs?|hours?)\s*(\d{1,2})(?!\s*[a-z\d])/g, '$1 $2 $3 minutes');
  if (!t) return null;
  if (/^\d+(?:\.\d+)?$/.test(t)) t = `${t} minutes`; // a bare number means minutes
  let total = 0;
  let found = false;
  const re = /(\d+(?:\.\d+)?|[a-z]+(?:-[a-z]+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?![a-z])(\s+and\s+a\s+half)?/g;
  for (const m of t.matchAll(re)) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
    if (!Number.isFinite(n)) continue;
    const unit = UNIT_MS[m[2]];
    total += (n + (m[3] ? 0.5 : 0)) * unit;
    found = true;
  }
  return found && total > 0 ? Math.round(total) : null;
}

/** "21:30", "9:30 pm", "9pm", "noon", "midnight" -> { h, m } (24-hour), or null. */
export function parseClock(text) {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .trim();
  if (t === 'noon') return { h: 12, m: 0 };
  if (t === 'midnight') return { h: 0, m: 0 };
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59 || h > 23 || (m[3] && (h < 1 || h > 12))) return null;
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return { h, m: min };
}

/** How far the time zone's clock is ahead of UTC at this moment, in ms. */
function zoneOffsetMs(ts, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** The next time after now that the clock in the time zone shows h:m. */
export function nextClockTime({ h, m }, timezone, now = Date.now()) {
  const local = new Date(now + zoneOffsetMs(now, timezone)); // the zone's wall clock, read as UTC
  for (let day = 0; day <= 2; day++) {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, h, m);
    // Wall-clock time to a real moment (twice, so a daylight saving change in between is right).
    let t = wall - zoneOffsetMs(wall, timezone);
    t = wall - zoneOffsetMs(t, timezone);
    if (t > now + MIN_AHEAD_MS) return t;
  }
  return null;
}

/** "9:30 PM" in the time zone. */
export function formatTime(ts, timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(11, 16);
  }
}

/** "in 12 min", "in 1 h 5 min", "in under a minute". */
export function formatIn(ms) {
  if (ms < 60000) return 'in under a minute';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  return mins % 60 ? `in ${h} h ${mins % 60} min` : `in ${h} h`;
}

/** The reminders still to go off, for its prompt: "- #1 for Mike at 9:30 PM (in 12 min): "Mike, time to queue."" */
export function formatReminders(list = [], timezone, now = Date.now()) {
  return list
    .map((r) => {
      const at = Date.parse(r.at);
      const who = r.for ? ` for ${r.for}` : ' for everyone';
      return `- #${r.id}${who} at ${formatTime(at, timezone)} (${formatIn(Math.max(0, at - now))}): "${r.say}"`;
    })
    .join('\n');
}

/**
 * Posts a reminder in text (it isn't in a call with whoever it's for): in the channel
 * it was set from, or else the server's system channel, mentioning them so they see it.
 */
export async function postReminder(client, guildId, r, { late = false, timezone = 'UTC' } = {}) {
  const guild = client.guilds?.cache?.get(guildId);
  let channel = r.channelId ? await client.channels.fetch(r.channelId).catch(() => null) : null;
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') channel = guild?.systemChannel ?? null;
  if (!channel) {
    log.warn(`couldn't post reminder #${r.id}: no channel to post it in`);
    return false;
  }
  const who = r.userId ? `<@${r.userId}> ` : '';
  const when = late ? ` (It was due at ${formatTime(Date.parse(r.at), timezone)}, while I was offline.)` : '';
  await channel.send({ content: `${who}Reminder: ${r.say}${when}`, allowedMentions: { users: r.userId ? [r.userId] : [] } });
  log.info(`posted reminder #${r.id} in text (not in a call with ${r.for || 'anyone'})`);
  return true;
}

/**
 * The reminders of every server: saved in memory.json, each armed with a timer, and
 * handed to onDue when it goes off (or right away after a restart, if it came due
 * while the bot was off less than an hour ago).
 */
export class Reminders {
  /**
   * @param {object} o
   * @param {{ reminders(id: string): object[], setReminders(id: string, list: object[]): void, guildIds(): string[] }} o.memory
   * @param {string} o.timezone
   * @param {(guildId: string, reminder: object, o: { late: boolean }) => void} o.onDue
   */
  constructor({ memory, timezone, onDue, clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.memory = memory;
    this.timezone = timezone;
    this.onDue = onDue || (() => {});
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timers = new Map(); // reminder key -> timer
    this.started = false;
  }

  /** Arms every saved reminder (once logged in). Ones far past due (the bot was off) are dropped. */
  start() {
    if (this.started) return;
    this.started = true;
    this.armSaved();
    // memory.json couldn't be read at start-up and now could: arm what was in it.
    this.memory.onReload?.(() => this.armSaved());
  }

  /** Arms the saved reminders that have no timer yet. */
  armSaved() {
    for (const guildId of this.memory.guildIds?.() ?? []) {
      for (const r of this.list(guildId)) {
        if (this.timers.has(r.key)) continue;
        const late = this.clock() - Date.parse(r.at);
        if (late > LATE_OK_MS) {
          this.drop(guildId, r.key);
          log.info(`dropped reminder #${r.id}: it was due ${formatIn(late).replace(/^in /, '')} ago, while I was off`);
          continue;
        }
        this.arm(guildId, r);
      }
    }
  }

  stop() {
    for (const t of this.timers.values()) this.clearTimer(t);
    this.timers.clear();
  }

  /** This server's reminders still to go off, soonest first. */
  list(guildId) {
    const saved = this.memory.reminders?.(guildId) ?? [];
    return saved
      .filter((r) => r && typeof r.key === 'string' && Number.isFinite(Date.parse(r.at)) && Number.isFinite(r.id))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  /**
   * Sets one. when: { in } ("10 minutes") or { at } ("21:30", in the bot's time zone).
   * Returns { reminder } or { error } (a reason in a few words).
   */
  add(guildId, { in: inText = null, at: atText = null, forName = null, userId = null, channelId = null, say = '' } = {}) {
    const now = this.clock();
    let at = null;
    if (inText) {
      const ms = parseDuration(inText);
      if (ms !== null) at = now + Math.max(ms, MIN_AHEAD_MS);
    } else if (atText) {
      const c = parseClock(atText);
      if (c) at = nextClockTime(c, this.timezone, now);
    }
    if (at === null) return { error: `couldn't tell when ("${String(inText || atText || '').slice(0, 40)}")` };
    if (at - now > MAX_AHEAD_MS) return { error: 'that is more than a day ahead' };
    const list = this.list(guildId);
    if (list.length >= MAX_REMINDERS) return { error: `${MAX_REMINDERS} reminders are already set` };
    const line = String(say ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS);
    const reminder = {
      key: `r${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      id: list.reduce((n, r) => Math.max(n, r.id), 0) + 1, // what it's called in voice ("reminder two")
      at: new Date(at).toISOString(),
      for: forName ? String(forName).slice(0, 64) : null,
      userId: userId || null,
      channelId: channelId || null,
      say: line,
      setAt: new Date(now).toISOString(),
    };
    this.memory.setReminders(guildId, [...list, reminder]);
    this.arm(guildId, reminder);
    return { reminder };
  }

  /** Cancels one by its number, all of them, or (neither) the newest one. Returns the ones cancelled. */
  cancel(guildId, { id = null, all = false } = {}) {
    const list = this.list(guildId);
    let gone;
    if (all) gone = list;
    else if (id !== null) gone = list.filter((r) => r.id === id).slice(0, 1);
    else {
      // The newest one (the last set; the higher number if set at the same moment).
      const newer = (a, b) => Date.parse(b.setAt) > Date.parse(a.setAt) || (Date.parse(b.setAt) === Date.parse(a.setAt) && b.id > a.id);
      gone = list.length ? [list.reduce((a, b) => (newer(a, b) ? b : a))] : [];
    }
    for (const r of gone) this.drop(guildId, r.key);
    return gone;
  }

  arm(guildId, r) {
    this.clearTimer(this.timers.get(r.key));
    const wait = Math.max(0, Date.parse(r.at) - this.clock());
    const timer = this.setTimer(() => this.fire(guildId, r.key), wait);
    timer?.unref?.();
    this.timers.set(r.key, timer);
  }

  /** Takes one out (and stops its timer). */
  drop(guildId, key) {
    this.clearTimer(this.timers.get(key));
    this.timers.delete(key);
    const saved = this.memory.reminders?.(guildId) ?? [];
    if (saved.some((r) => r?.key === key)) this.memory.setReminders(guildId, saved.filter((r) => r?.key !== key));
  }

  fire(guildId, key) {
    const r = this.list(guildId).find((x) => x.key === key);
    this.timers.delete(key);
    if (!r) return;
    this.drop(guildId, key);
    const late = this.clock() - Date.parse(r.at) > 60000;
    try {
      this.onDue(guildId, r, { late });
    } catch (err) {
      log.warn(`a reminder couldn't be delivered: ${err.message}`);
    }
  }
}
