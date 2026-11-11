// Deciding whether someone is talking TO the bot, telling it to shut up,
// or whether a transcript is just the bot's own voice leaking through a mic.

export function normalizeWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Common words one letter away from a name it has used (Gremlin, Babel): never a
// mishearing of it. (Found by checking the 60,000 most common English words.)
const NOT_A_MISHEARING = new Set([
  'kremlin', 'grammy',
  'label', 'babe', 'babes', 'bagel', 'mabel', 'abel', 'basel',
]);

function wordMatches(word, alias) {
  if (word === alias) return true;
  const stem = word.replace(/'s$/, '').replace(/s$/, '');
  if (stem === alias) return true;
  if (NOT_A_MISHEARING.has(word)) return false;
  // Tolerate one misheard letter on longer names ("gremblin", "grimlin").
  return alias.length >= 5 && Math.abs(word.length - alias.length) <= 1 && levenshtein(word, alias) <= 1;
}

/** True if any alias (single or multi-word) appears in the text. */
export function isAddressed(text, aliases) {
  const words = normalizeWords(text);
  if (!words.length) return false;
  const joined = ` ${words.join(' ')} `;
  for (const raw of aliases) {
    const aliasWords = normalizeWords(raw);
    if (!aliasWords.length) continue;
    if (aliasWords.length > 1) {
      if (joined.includes(` ${aliasWords.join(' ')} `)) return true;
      continue;
    }
    const alias = aliasWords[0];
    if (words.some((w) => wordMatches(w, alias))) return true;
  }
  return false;
}

const STOP_PHRASES = [
  'shut up', 'stop', 'stop talking', 'be quiet', 'quiet', 'enough', 'shush', 'shh', 'zip it',
  'silence', 'pipe down', 'knock it off', 'cut it out', 'hush',
];

// Words that can pad a short command without changing it ("okay Gremlin, shut up already").
const PADDING = new Set([
  'hey', 'yo', 'oi', 'ok', 'okay', 'dude', 'bro', 'man', 'bud', 'buddy', 'um', 'uh', 'so', 'oh', 'my', 'god',
  'please', 'pls', 'just', 'now', 'already', 'seriously', 'no',
]);

// Words that turn a stop phrase into a question or its opposite ("don't stop", "had enough?").
const NOT_A_COMMAND = new Set([
  'why', "why'd", 'how', 'what', "what's", 'when', 'where', "where's", 'who', 'which', 'do', 'does', 'did',
  'is', 'are', 'was', 'were', 'can', 'could', 'would', 'should', 'will', 'have', 'has', 'had',
  'dont', "don't", 'never', 'not', 'cant', "can't", 'wont', "won't", 'didnt', "didn't", 'keep',
]);

// Ways of asking it to stop that come before the stop phrase.
const LEAD_INS = [
  ['can', 'you'], ['could', 'you'], ['will', 'you'], ['would', 'you'], ['i', 'said'], ['i', 'told', 'you', 'to'],
  ['you', 'need', 'to'], ['you', 'gotta'], ['you', 'have', 'to'],
];

/**
 * "Gremlin, shut up" style commands: short, opening with the stop phrase
 * ("stop talking about my mom") or ending with it after at most one word
 * ("you shut up"). Questions and negations don't count ("why so quiet?",
 * "don't stop", "how do I stop bleeding").
 */
export function isStopCommand(text, aliases) {
  const words = normalizeWords(text);
  if (!words.length || words.length > 8) return false;
  const aliasSet = new Set(aliases.flatMap((a) => normalizeWords(a)));
  let rest = words.filter((w) => !aliasSet.has(w) && !PADDING.has(w));
  // "Can you shut up?", "will you be quiet", "I said shut up", "you need to stop": still a command.
  const lead = LEAD_INS.find((l) => l.every((w, i) => rest[i] === w));
  if (lead) rest = rest.slice(lead.length);
  else if (String(text).includes('?')) return false; // other questions aren't commands
  return STOP_PHRASES.some((phrase) => {
    const pw = phrase.split(' ');
    const n = pw.length;
    if (rest.length < n) return false;
    if (pw.every((w, i) => rest[i] === w)) return rest.length - n <= 3;
    if (pw.every((w, i) => rest[rest.length - n + i] === w)) {
      const lead = rest.slice(0, rest.length - n);
      return lead.length <= 1 && !lead.some((w) => NOT_A_COMMAND.has(w));
    }
    return false;
  });
}

// Words that can sit around its name when someone is only getting its attention.
const CALLING_WORDS = new Set([
  ...PADDING, 'hello', 'hi', 'whoa', 'woah',
  'wait', 'hold', 'hang', 'on', 'up', 'a', 'one', 'sec', 'secs', 'second', 'seconds', 'minute', 'min',
  'moment', 'real', 'quick', 'listen', 'excuse', 'me',
  // "Gremlin, you there?", "are you still listening?", "you awake?"
  'you', 'u', 'are', 'r', 'there', 'around', 'awake', 'alive', 'listening', 'still', 'with', 'us',
  // Nudges while waiting: "Gremlin, come on", "answer me", "anybody home?"
  'come', 'answer', 'hurry', 'anyone', 'anybody', 'home',
]);
const HOLD_PHRASES = [
  'wait', 'hold on', 'hang on', 'hold up', 'one sec', 'one second', 'one moment', 'a moment', 'one minute', 'listen',
];

/** "Gremlin!", "hey Gremlin", "Gremlin, wait": its name and nothing else of substance. */
export function isJustCallingIt(text, aliases) {
  const words = normalizeWords(text);
  if (!words.length || words.length > 8) return false;
  let joined = ` ${words.join(' ')} `;
  const single = [];
  for (const raw of aliases) {
    const aliasWords = normalizeWords(raw);
    if (aliasWords.length > 1) joined = joined.split(` ${aliasWords.join(' ')} `).join(' ');
    else if (aliasWords.length === 1) single.push(aliasWords[0]);
  }
  const rest = joined.trim().split(/\s+/).filter(Boolean);
  return rest.every((w) => CALLING_WORDS.has(w) || single.some((a) => wordMatches(w, a)));
}

/** "wait", "hold on": they want it to stop and let them talk. */
export function isHoldOn(text) {
  const joined = ` ${normalizeWords(text).join(' ')} `;
  return HOLD_PHRASES.some((p) => joined.includes(` ${p} `));
}

/** Length of the longest run of consecutive words two texts share. */
export function longestCommonRun(a, b) {
  const A = normalizeWords(a);
  const B = normalizeWords(b);
  let best = 0;
  let prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    const cur = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * True when what someone "said" is really the bot's own line picked up by
 * their mic: at least 4 words, and 80% of them appear in a row in the bot's line.
 */
export function isEchoOf(heard, botLine) {
  const n = normalizeWords(heard).length;
  if (n < 4) return false;
  return longestCommonRun(heard, botLine) >= Math.ceil(n * 0.8);
}

/** Word-overlap similarity (0..1). */
export function similarity(a, b) {
  const A = new Set(normalizeWords(a));
  const B = new Set(normalizeWords(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}
