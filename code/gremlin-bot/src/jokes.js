// Joke tuning: how its jokes land in a server (laughs, or being shushed or talked
// over) sets how often it tries one there. A joke that gets a laugh shortens the
// wait before the next one; one that gets "shut up" makes it wait longer and be
// pickier. Only its own unprompted jokes count, and only clear reactions: a whole
// line of laughing or of telling it off (or praise or a "shut up" said to it by
// name), not a laugh or a "boo" about the game. The score is saved with the
// server's memory (data/memory.json) and fades over a week or two.
//
// Callbacks (JOKE_CALLBACKS): jokes that got a laugh are kept too (the last dozen per
// server), and a few from earlier calls are shown to it when it thinks about chiming
// in, to call back to when something sets one up. One it used rests for a week.

import { longestCommonRun, normalizeWords } from './wakeword.js';

// Reactions count while the joke plays and for this long after it ends.
export const JOKE_WINDOW_MS = 8000;
// How far one joke's reaction moves the score (about the last five jokes count).
const RATE = 0.25;
const POINTS = { laughed: 1, 'no reaction': 0, 'talked over': -0.25, shushed: -1 };
// At or below this score its jokes aren't landing: it waits longer and is pickier.
const CHOOSY_BELOW = -0.4;
// It starts tuning once it has told this many jokes in a server.
export const MIN_JOKES = 5;
// A saved score fades by half every week, so one bad night doesn't stick.
const HALF_LIFE_DAYS = 7;

// A whole line of laughing: "hahaha", "ha ha", "lmao", "heh".
const LAUGH_WORD = /^(?:a?(?:ha)+h?|ha+|(?:he)+h?|heh+|hehe+|lol+|lmf?ao+|rofl|lul+|kek)$/;
// Liking it, said to it by name ("good one, Gremlin").
const PRAISE = /\b(?:good one|nice one|that'?s (?:so |pretty |actually |kinda )?funny|you'?re (?:so |pretty )?funny|so funny|hilarious|lol|lmao|haha\w*)\b/i;
// A whole line telling it off: "shut up", "boo", "not funny".
const BOO_LINE =
  /^(?:(?:oh |bro |dude |man |dang )?(?:shut up|shut it|be quiet|stop talking|boo+|not funny|so unfunny|unfunny|nobody asked|no one asked|cringe)(?: (?:bro|dude|man|please|already))?)$/;
// ...or said to it by name ("Gremlin, nobody asked").
const BOO = /\b(?:shut up|shut it|be quiet|stop talking|nobody asked|no one asked|not funny|unfunny|cringe|boo+)\b/i;

const plain = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * What a line said right after one of its jokes was: 'laugh', 'boo', or null.
 * toMe: the line said its name (then praise or a telling-off in it counts too).
 */
export function reactionTo(text, { toMe = false } = {}) {
  const t = plain(text);
  if (!t) return null;
  if (BOO_LINE.test(t) || (toMe && BOO.test(t))) return 'boo';
  if (t.split(' ').every((w) => LAUGH_WORD.test(w)) || (toMe && PRAISE.test(t))) return 'laugh';
  return null;
}

// Jokes that got a laugh, kept per server to call back to later.
export const MAX_LANDED = 12;
// How many of them it's shown at a time, and how long one rests after it's used.
export const CALLBACKS_OFFERED = 3;
export const CALLBACK_REST_MS = 7 * 86400000;
// Longer words too common to say that one joke calls back to another.
const COMMON_LONG = new Set(
  'about after again always another anything because before being better could doing every everyone getting going gonna gotta haven little maybe might never nothing other people really right should something still their there these thing things think those through today tonight where which while would yeah your youre'.split(' '),
);

/** Whether a new joke calls back to an old one: a run of three words in common, or two of their longer words. */
export function callsBackTo(said, joke) {
  if (longestCommonRun(said, joke) >= 3) return true;
  const longer = (text) => new Set(normalizeWords(text).filter((w) => w.length >= 5 && !COMMON_LONG.has(w.replace(/'/g, ''))));
  const mine = longer(said);
  let shared = 0;
  for (const w of longer(joke)) if (mine.has(w)) shared++;
  return shared >= 2;
}

/**
 * Jokes to show it as possible callbacks now: from before this call (since), not used
 * in the last week, and not naming anyone who opted out; the newest first.
 * landed: [{ text, at, usedAt }].
 */
export function callbacksToOffer(landed = [], { since = 0, now = Date.now(), avoidNames = [], max = CALLBACKS_OFFERED } = {}) {
  const time = (v) => {
    const t = Date.parse(v ?? '');
    return Number.isFinite(t) ? t : 0;
  };
  return landed
    .filter((j) => j && typeof j.text === 'string' && j.text.trim())
    .filter((j) => time(j.at) < since && now - time(j.usedAt) >= CALLBACK_REST_MS)
    .filter((j) => !mentionsAny(j.text, avoidNames))
    .sort((a, b) => time(b.at) - time(a.at))
    .slice(0, max)
    .map((j) => j.text);
}

// "Jess's" is about Jess.
const bare = (w) => w.replace(/'s$/, '');

// Words in a display name that aren't the person's name ("Jess (she/her)", "[TTV] Mike").
const NOT_A_NAME = new Set('the and she her hers him his they them their you your are not for with from its any all real official ttv twitch yt tv gg'.split(' '));

/**
 * The runs of words that pick a person out: their whole name, and each word of three
 * letters or more in it ("Jess (she/her)" and "xX_Jess_Xx" give "jess", "[TTV] Mike"
 * gives "mike"). Better to skip a joke that wasn't about them than keep one that was.
 */
function nameKeys(name) {
  const keys = [normalizeWords(name ?? '').map(bare)];
  for (const w of String(name ?? '').toLowerCase().split(/[^\p{L}]+/u)) if (w.length >= 3 && !NOT_A_NAME.has(w)) keys.push([w]);
  return keys.filter((k) => k.length > 0);
}

/** Whether the text has any of these names in it, as whole words ("Al" isn't in "really"). */
export function mentionsAny(text, names = []) {
  const words = normalizeWords(text).map(bare);
  return names.some((n) => nameKeys(n).some((key) => words.some((_, i) => key.every((w, k) => words[i + k] === w))));
}

/** How a joke went, from what people did while it played and right after. */
export function jokeOutcome({ laughs = 0, boos = 0, talkedOver = 0 }) {
  if (boos) return 'shushed';
  if (laughs) return 'laughed';
  if (talkedOver) return 'talked over';
  return 'no reaction';
}

export class JokeTuning {
  /** @param {{ score?: number, told?: number, laughed?: number, shushed?: number, talkedOver?: number, at?: string }} [saved] */
  constructor(saved = null, { now = Date.now() } = {}) {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    let score = Math.max(-1, Math.min(1, num(saved?.score)));
    const at = Date.parse(saved?.at ?? '');
    if (Number.isFinite(at)) score *= 0.5 ** (Math.max(0, now - at) / (HALF_LIFE_DAYS * 86400000));
    this.score = score;
    this.told = num(saved?.told);
    this.laughed = num(saved?.laughed);
    this.shushed = num(saved?.shushed);
    this.talkedOver = num(saved?.talkedOver);
  }

  /** Counts one joke's outcome ('laughed', 'shushed', 'talked over', 'no reaction'). */
  record(outcome) {
    const points = POINTS[outcome] ?? 0;
    this.score = Math.max(-1, Math.min(1, this.score + RATE * (points - this.score)));
    this.told++;
    if (outcome === 'laughed') this.laughed++;
    if (outcome === 'shushed') this.shushed++;
    if (outcome === 'talked over') this.talkedOver++;
  }

  /** Enough jokes told here to go by. */
  get ready() {
    return this.told >= MIN_JOKES;
  }

  /**
   * What the waits between jokes are multiplied by: down to 0.6 when they keep
   * landing, up to 2 when they keep getting shushed (1 until it has told a few).
   */
  factor() {
    if (!this.ready) return 1;
    return this.score >= 0 ? 1 - 0.4 * this.score : 1 - this.score;
  }

  /** Its jokes haven't been landing: it should only try a really good one. */
  choosy() {
    return this.ready && this.score <= CHOOSY_BELOW;
  }

  toJSON() {
    return { score: Math.round(this.score * 1000) / 1000, told: this.told, laughed: this.laughed, shushed: this.shushed, talkedOver: this.talkedOver, at: new Date().toISOString() };
  }
}
