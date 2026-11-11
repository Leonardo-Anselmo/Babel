// Call memory (CALL_MEMORY): short notes on the call as it goes, so the bot still
// knows what was said earlier in a long call (past what its transcript window
// holds), and a summary when the call ends, saved for next time. Written by the
// fast model from what was said; audio is never kept, and the notes can be read and
// deleted in the desktop app (Personality > Call memory) or with /forgetcalls.

import { logger } from './log.js';
import { formatTranscript, splitSentences } from './prompts.js';

const log = logger('notes');

// New lines are folded into the notes every this many lines from people, or once
// there are a few and this long has passed (checked every minute, talk or not).
export const NOTE_EVERY_LINES = 25;
const NOTE_EVERY_MS = 10 * 60000;
const NOTE_MIN_LINES = 5;
const CHECK_EVERY_MS = 60000;
// A call with fewer lines than this from people isn't worth remembering.
export const MIN_LINES_TO_REMEMBER = 6;
// Lines waiting to be folded in are capped (if updates keep failing, the oldest go).
const MAX_WAITING = 300;
// After an update that failed, the next try waits this long (it costs a request each time).
const RETRY_AFTER_MS = 2 * 60000;
const NOTES_WORDS = 150;
const SUMMARY_WORDS = 90;
// The model often runs past those: notes longer than this lose their older middle (the
// first sentence, who was there and what they did, and the newest ones are kept).
const NOTES_KEEP_WORDS = 220;
const SUMMARY_KEEP_WORDS = 140;
// Room for a few words of thinking before the notes: only what's inside <notes> is kept,
// and notes cut off by this limit are never kept (they'd be missing their newest part).
const NOTES_MAX_TOKENS = 700;
const SUMMARY_MAX_TOKENS = 450;
// The longest notes kept (the running notes go into every reply's prompt; the summary is saved).
export const MAX_NOTE_CHARS = 2000;
export const MAX_SUMMARY_CHARS = 1200;

/**
 * The notes in a reply: what's inside <notes></notes> (anything around the tags is the
 * model thinking, not notes), or the whole reply if it used no tags. null when it was
 * cut off by the length limit before the notes were finished.
 */
export function notesFrom(raw, stopReason) {
  const text = String(raw ?? '');
  const cutOff = stopReason === 'max_tokens';
  const open = text.search(/<notes>/i);
  if (open === -1) return cutOff ? null : text;
  const rest = text.slice(open + '<notes>'.length);
  const close = rest.search(/<\/notes>/i);
  if (close === -1) return cutOff ? null : rest;
  return rest.slice(0, close);
}

/**
 * Plain sentences only: no markdown, quotes around the whole thing, or a "Notes:" label.
 * maxWords: longer notes lose sentences from their older middle (see keepNewest).
 */
export function cleanNotes(raw, { maxChars = MAX_NOTE_CHARS, maxWords = 0 } = {}) {
  let t = String(raw ?? '')
    .replace(/<\/?notes>/gi, ' ')
    .trim();
  if (!t || /^\[?\s*pass\s*\]?\.?$/i.test(t)) return '';
  t = t.replace(/^\s*(?:notes?|summary|memory)\s*:\s*/i, '');
  t = t.replace(/^["“](.*)["”]$/s, '$1');
  t = t.replace(/^\s*[-*•]\s+/gm, '').replace(/[*_`#>]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  if (maxWords) t = keepNewest(t, maxWords);
  if (t.length > maxChars) {
    // Too long anyway: end at the last whole sentence that fits.
    const cut = t.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), /[.!?]$/.test(cut) ? cut.length - 1 : -1);
    t = end >= maxChars / 2 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}...`;
  }
  return t;
}

const wordsIn = (s) => s.split(/\s+/).filter(Boolean).length;

/**
 * Notes over the word limit: the first sentence (who was there, what they were doing)
 * and the newest ones are kept; sentences go from the older middle until it fits.
 */
export function keepNewest(text, maxWords) {
  if (wordsIn(text) <= maxWords) return text;
  // (Split only where a sentence really ends: "patch 25.21" and "Dr. Mundo" stay whole.)
  const sentences = splitSentences(text);
  if (sentences.length < 3) return text;
  let total = sentences.reduce((n, x) => n + wordsIn(x), 0);
  while (total > maxWords && sentences.length > 2) total -= wordsIn(sentences.splice(1, 1)[0]);
  return sentences.join(' ');
}

export class CallNotes {
  /**
   * @param {object} o
   * @param {{ createMessage: Function }} o.claude   the fast model
   * @param {string} o.botName
   * @param {string} o.timezone
   */
  constructor({ claude, botName, timezone, clock = Date.now, checkEveryMs = CHECK_EVERY_MS }) {
    this.claude = claude;
    this.botName = botName;
    this.timezone = timezone;
    this.clock = clock;
    this.notes = '';
    this.waiting = []; // transcript lines (people's and its own) not in the notes yet, in the order they came
    this.newLines = 0; // lines from people among them
    this.heard = 0; // lines from people in the whole call
    this.lastFoldAt = clock();
    this.retryAt = 0; // after a failed update, no new try before this
    this.busy = null; // the update in progress
    this.closed = false;
    // Bumped when someone opts out or the notes are cleared: an update that was already
    // being written (from what they said) is thrown away when it comes back.
    this.generation = 0;
    this.forgotten = new Set(); // people who opted out mid-call
    this.timer = setInterval(() => this.maybeUpdate(), checkEveryMs);
    this.timer.unref?.();
  }

  /** The notes so far ('' until the first update). */
  get text() {
    return this.notes;
  }

  /** Whether the call had enough in it to remember. */
  get worthKeeping() {
    return this.heard >= MIN_LINES_TO_REMEMBER;
  }

  /** A line went into the transcript (a person's or its own; its own may still change as it's said). */
  add(line) {
    if (this.closed || !line) return;
    this.waiting.push(line);
    if (this.waiting.length > MAX_WAITING) this.waiting.splice(0, this.waiting.length - MAX_WAITING);
    if (line.isBot) return;
    this.newLines++;
    this.heard++;
    this.maybeUpdate();
  }

  maybeUpdate() {
    if (this.closed || this.busy || this.clock() < this.retryAt) return;
    const due = this.newLines >= NOTE_EVERY_LINES || (this.newLines >= NOTE_MIN_LINES && this.clock() - this.lastFoldAt >= NOTE_EVERY_MS);
    if (due) this.busy = this.update().finally(() => (this.busy = null));
  }

  /**
   * Someone opted out: their lines and its answers to them are dropped, and the notes
   * (which may hold what they said) start over.
   */
  forgetSpeaker(userId) {
    this.forgotten.add(userId);
    this.generation++;
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((l) => this.keeps(l));
    this.heard = Math.max(0, this.heard - (before - this.waiting.length));
    if (this.notes) {
      this.notes = '';
      log.debug('started the call notes over (someone opted out)');
    }
  }

  /** Whether a line may go into the notes (not from, or an answer to, someone who opted out). */
  keeps(line) {
    if (line.userId && this.forgotten.has(line.userId)) return false;
    return !line.info?.userIds?.some((u) => this.forgotten.has(u));
  }

  /** Forget everything so far (/forgetcalls): this call's notes start over from here. */
  clear() {
    this.generation++;
    this.clearedAt = this.generation;
    this.notes = '';
    this.waiting = [];
    this.newLines = 0;
    this.heard = 0;
  }

  /** Brings the notes up to date with the lines they don't cover yet. */
  async update({ final = false } = {}) {
    const batch = this.waiting.splice(0);
    const lines = batch.filter((l) => !l.dropped && String(l.text || '').trim() && this.keeps(l));
    if (!lines.some((l) => !l.isBot)) {
      if (!final) this.newLines = 0;
      return this.notes;
    }
    const pending = this.newLines;
    this.newLines = 0;
    this.lastFoldAt = this.clock();
    const generation = this.generation;
    const transcript = formatTranscript(lines, { botName: this.botName, timezone: this.timezone });
    try {
      const ask = (again) =>
        this.claude.createMessage({
          system: this.system(),
          user: this.request(transcript, { final, again }),
          maxTokens: final ? SUMMARY_MAX_TOKENS : NOTES_MAX_TOKENS,
          retries: 1,
          important: false,
        });
      let res = await ask(false);
      let body = res.refusal ? '' : notesFrom(res.text, res.stopReason);
      if (body === null && generation === this.generation) {
        // Ran out of room before the end: those notes would be missing the newest part.
        log.debug(`the call ${final ? 'summary' : 'notes'} ran out of room; asking for a shorter version`);
        res = await ask(true);
        body = res.refusal ? '' : notesFrom(res.text, res.stopReason);
      }
      if (body === null && generation === this.generation) throw new Error('they ran out of room twice');
      const cleaned = cleanNotes(body, { maxChars: final ? MAX_SUMMARY_CHARS : MAX_NOTE_CHARS, maxWords: final ? SUMMARY_KEEP_WORDS : NOTES_KEEP_WORDS });
      if (generation !== this.generation) {
        // Someone opted out (or the notes were cleared) while this was being written: it may hold them.
        const again = this.clearedSince(generation) ? [] : batch.filter((l) => this.keeps(l));
        this.waiting.unshift(...again);
        this.newLines += again.filter((l) => !l.isBot).length;
        return this.notes;
      }
      if (!cleaned) throw new Error('the notes came back empty');
      const text = cleaned;
      this.notes = text;
      const trimmed = wordsIn(cleaned) < wordsIn(cleanNotes(body, { maxChars: Infinity })) ? ', trimmed: they ran long' : '';
      log.debug(`${final ? 'summed up the call' : 'brought the call notes up to date'} (${lines.length} lines, ${wordsIn(text)} words${trimmed})`);
    } catch (err) {
      // Try again with the next ones (these go first), except anything forgotten meanwhile,
      // and not right away: each try is a request.
      if (!this.clearedSince(generation)) {
        this.waiting.unshift(...batch.filter((l) => this.keeps(l)));
        this.newLines += pending;
      }
      if (!final) this.retryAt = this.clock() + RETRY_AFTER_MS;
      log.debug(`couldn't update the call notes: ${err.message}${final ? '' : ' (trying again in 2 minutes at the earliest)'}`);
    }
    return this.notes;
  }

  /** Whether the notes were cleared (/forgetcalls) since that generation. */
  clearedSince(generation) {
    return this.clearedAt !== undefined && this.clearedAt > generation;
  }

  /**
   * The call is over: the summary to keep for next time, or '' if the call had too
   * little in it (if the summary can't be written, the notes so far).
   */
  async finish() {
    this.close();
    if (!this.worthKeeping) return '';
    await this.busy?.catch(() => {});
    return cleanNotes(await this.update({ final: true }), { maxChars: MAX_SUMMARY_CHARS, maxWords: SUMMARY_KEEP_WORDS });
  }

  /** The notes so far, short enough to save as the call's memory (until the summary replaces them). */
  get savable() {
    return cleanNotes(this.notes, { maxChars: MAX_SUMMARY_CHARS, maxWords: SUMMARY_KEEP_WORDS });
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
  }

  system() {
    return [
      `You keep short notes on a Discord voice call for ${this.botName}, an AI who hangs out in the call with a group of friends and talks through a voice.`,
      `${this.botName} reads these notes later to remember what happened, the way a friend would. Write plain sentences: no headings, lists, or markdown.`,
      'The transcript comes from speech recognition, so expect misheard words. Lines are labeled with who said them.',
    ].join(' ');
  }

  request(transcript, { final, again = false }) {
    const bot = this.botName;
    const words = final ? SUMMARY_WORDS : NOTES_WORDS;
    const keep =
      `Keep what's worth remembering: who was there, what they played or did, what they talked about, running jokes, plans, ` +
      `things people said they'd do or want to be reminded of, and anything ${bot} promised. Skip small talk and anything that won't matter later. ` +
      `Only what the lines say, no guesses. Leave out sensitive personal details (health, money, family or relationship trouble) and anything someone asked to keep private. ` +
      `Lines labeled "${bot} (you)" are ${bot}'s own.`;
    const tags =
      ` Write the ${final ? 'memory' : 'notes'} inside <notes></notes>: only what's inside the tags is kept, so start with <notes> right away.` +
      ` Stay under ${words} words; if there's too much, shorten the older parts, never the newest.` +
      (again ? ` Your last try ran past the length limit and was cut off, so this time keep it well under ${words} words.` : '');
    const task = final
      ? `The call just ended. Write ${bot}'s memory of the whole call in at most ${words} words, starting with what they were doing. ${keep}${tags}`
      : `Rewrite the notes so they cover the whole call so far, in at most ${words} words. ${keep}${tags}`;
    return [
      '<notes_so_far>',
      this.notes || '(none yet)',
      '</notes_so_far>',
      '',
      '<new_lines>',
      transcript,
      '</new_lines>',
      '',
      '<task>',
      task,
      '</task>',
    ].join('\n');
  }
}
