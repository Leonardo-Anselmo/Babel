// Learned words: names of things in their games that the speech-to-text gets
// wrong. When it answers with a word spelled differently from one it just heard
// ("Malenia" for "melania", "Jett" for "jet"), that word is learned. Once it has
// been heard wrong in two answers, it goes to the speech-to-text as a hint: to
// Whisper only on sentences long enough that a hint can't be "heard" in noise or in
// a one-word reply, and to Deepgram as a keyterm. Everyday English words are never
// learned (Whisper spells those right; one capitalized in an answer just starts a
// sentence). Saved per server in memory.json: the word, how often, and when.
//
// src/common-words.txt holds the 10,000 most common English words, from wordfreq
// (https://github.com/rspeer/wordfreq), whose word lists are licensed CC BY-SA 4.0.

import fs from 'node:fs';

export const MAX_WORDS = 50; // learned words kept per server
export const HINT_WORDS = 6; // given to the speech-to-text at a time
export const MIN_HINT_CLIP_MS = 1500; // shorter sentences get only its own name as a hint
export const MIN_COUNT = 2; // heard wrong in this many answers before it's a hint (once could be chance)
// A word not heard again fades: its count halves every two weeks.
const HALF_LIFE_DAYS = 14;

let commonWords = null;
function everydayWords() {
  if (!commonWords) {
    try {
      const text = fs.readFileSync(new URL('./common-words.txt', import.meta.url), 'utf8');
      commonWords = new Set(text.split(/\r?\n/).filter(Boolean));
    } catch {
      commonWords = new Set();
    }
  }
  return commonWords;
}
// Chat words that aren't in a dictionary list ("Aight", "Welp", "Yeahhh").
const INTERJECTIONS = new Set('aight ight welp yeah yea yep yup nope nah naw lol lmao lmfao rofl haha hehe ahaha bruh bro dude oof yikes ayy ooh ahh uhh hmm mhm sheesh gg ggs wp ez'.split(' '));
// "yeahhh" -> "yeah", "lmaooo" -> "lmao": a letter said three or more times counts once.
const unstretch = (w) => w.replace(/(\p{L})\1{2,}/gu, '$1');
/** An everyday word ("they", "skill", "haha"): never a misheard name. */
export function everyday(word) {
  const w = String(word).toLowerCase();
  const u = unstretch(w);
  const known = everydayWords();
  return known.has(w) || known.has(u) || INTERJECTIONS.has(w) || INTERJECTIONS.has(u);
}
// Letters only, accents off: "Spider-Man" and "spiderman", "Pokémon" and "pokemon" match.
const flat = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
// Endings that make the same word ("tacos" and "Taco"): not a mishearing.
const ENDINGS = ['s', 'es', "'s", '’s', 'd', 'ed', 'ing', 'er', 'ers', 'ly'];

/** Characters two words have in common, in order (Ratcliff/Obershelp, like Python's difflib). */
function common(a, b) {
  let best = 0;
  let ai = 0;
  let bi = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) {
        best = k;
        ai = i;
        bi = j;
      }
    }
  }
  if (!best) return 0;
  return best + common(a.slice(0, ai), b.slice(0, bi)) + common(a.slice(ai + best), b.slice(bi + best));
}

/** How alike two words are, 0 to 1. */
export function similarity(a, b) {
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x.length + y.length ? (2 * common(x, y)) / (x.length + y.length) : 1;
}

const sameWord = (a, b) => a === b || ENDINGS.some((e) => a === b + e || b === a + e);
const wordsOf = (text) => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu) || [];

/** Lowercase name keys to leave alone: "Big Mike" gives "big mike", "big" and "mike". */
function keys(names) {
  const out = new Set();
  for (const n of names || []) {
    const k = String(n ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').replace(/_/g, ' ').trim();
    if (!k) continue;
    out.add(k);
    for (const w of k.split(/\s+/)) if (w.length >= 3) out.add(w);
  }
  return out;
}

/** A word that can be learned at all: four letters or more, no digits, no contraction, not everyday. */
function learnable(term) {
  const t = String(term ?? '').toLowerCase();
  return t.length >= 4 && !/[\d'’]/.test(t) && !everyday(t);
}

/**
 * Words it said that it had heard spelled differently in what it was answering:
 * [{ term, heard }]. said: its reply. heard: the lines it was answering.
 * skip: names to leave alone (people in the server, its own name).
 */
export function corrections(said, heard, { skip = [], own = [] } = {}) {
  const leave = keys(skip);
  // Words it brought up itself just before: its spelling may be the one that's off ("adobo" for "Adolfo").
  const mine = new Set(own.map((w) => String(w).toLowerCase()));
  const heardWords = heard.flatMap(wordsOf);
  // A word heard split in two ("zom boid") counts as one too.
  const candidates = [
    ...heardWords.map((w) => ({ word: w, form: w, halves: [w] })),
    ...heardWords.slice(1).map((w, i) => ({ word: heardWords[i] + w, form: `${heardWords[i]} ${w}`, halves: [heardWords[i], w] })),
  ];
  const out = [];
  const seen = new Set();
  for (const raw of String(said ?? '').match(/[\p{L}][\p{L}\p{N}'’-]*/gu) || []) {
    if (!/^\p{Lu}/u.test(raw)) continue; // only words it capitalized: names of things
    const term = raw.replace(/['’]s$/i, '').replace(/[-'’]+$/, '');
    const t = term.toLowerCase();
    if (seen.has(t) || leave.has(t) || mine.has(t) || !learnable(term)) continue;
    seen.add(t);
    if (heardWords.some((h) => sameWord(t, h))) continue; // heard right
    // The same letters written differently ("spider man", "head shot") were heard right,
    // unless half of a split isn't a word ("zom boid").
    if (candidates.some((c) => flat(c.word) === flat(t) && (c.halves.length === 1 || c.halves.every(everyday)))) continue;
    let best = null;
    let bestScore = 0;
    for (const { word: h, form, halves } of candidates) {
      const split = halves.length > 1;
      if (h.length < 3 || halves.some((x) => leave.has(x)) || (sameWord(t, h) && !split)) continue;
      const score = similarity(t, h);
      const close = score >= 0.85 || (score >= 0.7 && h[0] === t[0]);
      if (close && score > bestScore) {
        best = form;
        bestScore = score;
      }
    }
    if (best) out.push({ term, heard: best });
  }
  return out;
}

export class Vocabulary {
  /**
   * @param {Array<{term: string, count?: number, at?: string}>} [entries]  saved words
   * @param {{ onChange?: (entries: object[]) => void }} [o]
   */
  constructor(entries = [], { onChange } = {}) {
    this.entries = (Array.isArray(entries) ? entries : [])
      .filter((e) => e && typeof e.term === 'string' && learnable(e.term.trim()))
      .map((e) => ({
        term: e.term.trim(),
        count: Number.isFinite(e.count) && e.count > 0 ? e.count : 1,
        at: typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)) ? e.at : new Date(0).toISOString(),
      }))
      .slice(-MAX_WORDS);
    this.onChange = onChange || (() => {});
  }

  /** Learns from one answer. Returns the words it learned or saw again: [{ term, heard }]. */
  learn(said, heard, { skip = [], own = [], now = Date.now() } = {}) {
    const found = corrections(said, heard, { skip, own });
    if (!found.length) return [];
    const at = new Date(now).toISOString();
    for (const { term } of found) {
      let e = this.entries.find((x) => x.term.toLowerCase() === term.toLowerCase());
      if (!e) {
        e = { term, count: 0, at };
        this.entries.push(e);
      }
      e.count++;
      e.at = at;
    }
    if (this.entries.length > MAX_WORDS) {
      this.entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      this.entries.length = MAX_WORDS;
    }
    this.onChange(this.toJSON());
    return found;
  }

  /** The words to give the speech-to-text now: heard wrong at least twice, learned most and most recently. */
  hints({ now = Date.now() } = {}) {
    const weight = (e) => e.count * 0.5 ** (Math.max(0, now - Date.parse(e.at)) / (HALF_LIFE_DAYS * 86400000));
    return this.entries
      .filter((e) => e.count >= MIN_COUNT)
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, HINT_WORDS)
      .map((e) => e.term);
  }

  /** What's saved: the word, how often it was heard wrong, and when last (never what was said). */
  toJSON() {
    return this.entries.map((e) => ({ term: e.term, count: e.count, at: e.at }));
  }
}
