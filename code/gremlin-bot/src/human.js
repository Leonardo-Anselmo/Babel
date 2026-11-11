// Small touches that make it sound like a person in the call rather than a bot:
// a quick "hmm" when a question takes a moment, laughing along with the group,
// saying hi and bye, and not opening line after line the same way.

// A quick sound while a question's answer is on its way (cached after first use).
export const THINKING_SOUNDS = ['Hmm.', 'Hmm, okay.', 'Ooh.', 'Oh.', 'Huh.', 'Okay, so.', 'Let me think.', 'Ooh, okay.'];
// Laughing along with the group (the words are what's left for a voice model without tags).
export const LAUGHS = ['[laughs] Haha.', '[laughs] Ha!', '[laughs] Hahaha.', '[laughs] Heh.', '[starts laughing] Ha!'];
// Said right before a song plays.
export const SONG_INTROS = ['Alright, here it is.', 'Okay, here we go.', 'Fresh off the press.', 'Here it comes.'];
// Said once a picture someone asked for is up in the text chat.
export const PICTURE_POSTED = ["It's in the chat.", 'Check the chat.', 'Posted it.', "Okay, it's up in the chat."];

// Delivery tags that are a laugh.
const LAUGH_TAG = /\[(?:laughs?(?: harder)?|laughing|starts laughing|chuckles?|giggles?|cackles?|wheezing|snorts?)\]/gi;
const LAUGH_TAG_ONE = new RegExp(LAUGH_TAG.source, 'i');
// A laughing word: "ha", "haha", "hahaha", "heh", "hehehe", "lol" (not "aha": that's getting it).
const LAUGH_WORD = /^(?:(?:ha)+h?|heh+|he(?:he)+|lol|lmao)$/;
// A laugh at the start of a line: "Ha,", "Haha!", "Hahaha..." (with what follows it).
const LAUGH_OPENER = /^\s*(?:(?:ha)+h?|heh+|he(?:he)+|lol|lmao)\s*[,.!…-]*\s+/i;
// What it may open with after a "hmm", dropped so it doesn't say it twice: only a word set
// off by punctuation ("Hmm,", "Oh.", "Well,"), so "So far...", "Oh no," and "Well done" keep their words.
const INTERJECTION_OPENER = /^\s*(?:(?:hm+|mm+|oh+|ooh+|huh|okay|ok|well|so|alright)\s*[,.!…]+|(?:okay|ok|alright),?\s+so\s*,?)\s+/i;

/** Opening the line with a laugh tag, or a laughing word. */
export function hasLaughTag(text) {
  return LAUGH_TAG_ONE.test(String(text ?? ''));
}

/**
 * How a line opens, to notice it opening the same way again: "laugh" for a laugh
 * tag or a laughing word, "[sighs]" for another tag, otherwise its first word.
 */
export function openerKey(text) {
  const t = String(text ?? '').trim();
  const tag = /^\[([^\]]{1,40})\]/.exec(t);
  if (tag) return LAUGH_TAG_ONE.test(tag[0]) ? 'laugh' : `[${tag[1].toLowerCase().trim()}]`;
  const w = (/^[a-z']+/i.exec(t)?.[0] ?? '').toLowerCase();
  return LAUGH_WORD.test(w) ? 'laugh' : w;
}

const wordCount = (s) => (String(s).match(/[\p{L}\p{N}']+/gu) || []).length;
const capitalize = (s) => s.replace(/^(\s*(?:\[[^\]]*\]\s*)*)([a-z])/, (_m, lead, c) => lead + c.toUpperCase());

/**
 * Takes the bot-like habits out of the start of a line before it's said:
 * - laughing again ("[laughs]" or "Ha," to open) right after it laughed: dropped;
 * - more than one laugh tag in a line: only the first is kept;
 * - after a "hmm" it already said: a "Hmm," or "Oh," opening is dropped.
 * Never leaves a line without words.
 * @param {string} text
 * @param {object} o
 * @param {boolean} [o.laughedLately]  its last line or two opened with a laugh, or it laughed moments ago
 * @param {boolean} [o.afterSound]  it just said a "hmm" for this reply
 * @param {boolean} [o.opening]  this is the start of the reply (not a later sentence)
 */
export function varyOpening(text, { laughedLately = false, afterSound = false, opening = true } = {}) {
  const original = String(text ?? '');
  let t = original;
  let openerGone = false;
  if (laughedLately) {
    t = t.replace(LAUGH_TAG, ' ');
    if (opening) {
      const rest = t.replace(LAUGH_OPENER, '');
      if (rest !== t && wordCount(rest) >= 2) {
        t = rest;
        openerGone = true;
      }
    }
  } else {
    // At most one laugh in a line.
    let seen = false;
    t = t.replace(LAUGH_TAG, (m) => {
      if (seen) return ' ';
      seen = true;
      return m;
    });
  }
  if (afterSound && opening) {
    const lead = /^\s*(?:\[[^\]]{1,40}\]\s*)*/.exec(t)[0];
    const rest = t.slice(lead.length).replace(INTERJECTION_OPENER, '');
    if (rest !== t.slice(lead.length) && wordCount(rest) >= 2) {
      t = lead + rest;
      openerGone = true;
    }
  }
  // Nothing taken out: the line stays exactly as written.
  if (t === original) return original;
  t = t.replace(/\s+/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  if (openerGone) t = capitalize(t);
  // Nothing left to say (it was only a laugh): keep it as it was.
  return /[\p{L}\p{N}]/u.test(t.replace(/\[[^\]]*\]/g, '')) ? t : original.trim();
}

const plainWords = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

// Words that often lead into a goodbye or a question ("alright guys, I'm out").
const LEAD_WORDS = new Set(['alright', 'aight', 'alrighty', 'okay', 'ok', 'well', 'yeah', 'yea', 'anyway', 'anyways', 'so', 'hey', 'yo', 'guys', 'fellas', 'boys', 'yall', "y'all", 'everyone', 'everybody', 'all', 'right', 'um', 'uh', 'oh', 'man', 'dude', 'bro', 'lol', 'haha']);
// ...and that often trail it ("night guys", "I'm out for tonight"). Not "tomorrow" or "later"
// on their own: "I'm off tomorrow" is about work, not leaving.
const WHO = String.raw`(?:guys|y'?all|everyone|everybody|all|fellas|boys|dude|bro|man)`;
const TRAIL = String.raw`(?:\s+(?:${WHO}|then|now|lol|haha|for real|fr|for (?:tonight|today|now|the night)|tonight))*`;
const GOODBYE = new RegExp(
  String.raw`^(?:` +
    // "see you guys tomorrow", "talk to you guys later", "catch ya later"
    String.raw`(?:see|catch|talk to) (?:ya|you|yall|y'all)(?: ${WHO})?(?: (?:later|tomorrow|tmrw|soon|next time|around))?|ttyl|` +
    // (A bare "later" is too often something else: "later guys" counts.)
    String.raw`good ?night|gn|night|night night|nighty night|bye|bye bye|byee+|goodbye|good bye|peace|peace out|later ${WHO}|laters|` +
    String.raw`(?:i'?m|i am|imma|ima) (?:out|off|off to bed|off to sleep|heading out|heading to bed|head out|gonna head out|gonna go|gonna get going|gonna hop off|gonna get off|gonna log off|going to bed|going to sleep|gonna go to bed|gonna go to sleep|gonna sleep|gonna crash|hopping off|logging off|done for (?:tonight|today|the night))|` +
    String.raw`heading out|gonna head out|gonna get going|gonna hop off|hopping off|logging off|signing off|going to bed|` +
    String.raw`(?:i )?(?:gotta|got to|have to|need to) (?:go|run|dip|bounce|head out|hop off|get off|get going|sleep|go to bed|go to sleep))${TRAIL}$`,
);

/** "Alright guys, I'm heading out", "gn", "bye y'all": someone saying they're leaving the call. */
export function isGoodbye(text) {
  const raw = String(text ?? '').toLowerCase();
  // "I'm out of ammo" isn't leaving.
  if (/\bout of\b/.test(raw)) return false;
  let words = plainWords(text);
  if (!words.length || words.length > 10) return false;
  while (words.length > 1 && LEAD_WORDS.has(words[0])) words = words.slice(1);
  return GOODBYE.test(words.join(' '));
}

// Words that start a question even without a "?" (speech-to-text usually adds one; "is" or
// "do" alone too often start a statement or a command: "Babel, do it").
const QUESTION_WORDS = new Set([
  'what', "what's", 'whats', 'whatcha', 'how', "how's", 'hows', 'howd', "how'd", 'why', "why'd", 'who', "who's", 'whos', "who'd", 'whod', 'where', "where's", 'wheres', 'when', "when's", 'which',
]);

// "is that true", "do you know", "did you see that": a yes-or-no question even without a "?",
// when a person or thing comes right after ("do it" is a command, "is the best" isn't asking).
const YES_NO = new Set([
  'is', 'are', 'was', 'were', 'am', 'do', 'does', 'did', 'can', 'could', 'would', 'will', 'should', 'have', 'has',
  "isn't", "aren't", "wasn't", "don't", "doesn't", "didn't", "can't", "won't", "wouldn't", "shouldn't", "haven't", "hasn't",
]);
const PEOPLE = new Set(['i', 'you', 'u', 'ya', 'we', 'they', 'yall', "y'all", 'he', 'she', 'anyone', 'anybody', 'someone', 'somebody', 'everyone', 'everybody']);
const THINGS = new Set(['it', 'that', 'this', 'there', 'those', 'these']);

/** Where what they said starts, past its name and fillers ("hey Gremlin, quick question, ..."). */
function startOf(words, aliases) {
  const names = new Set(aliases.flatMap((a) => plainWords(a)));
  let i = 0;
  while (i < words.length && (names.has(words[i]) || LEAD_WORDS.has(words[i]) || words[i] === 'quick' || words[i] === 'question')) i++;
  return i;
}

/**
 * A question (to it or anyone): ends with "?", or starts with a question word past its
 * name and fillers. Without a "." or "!" at the end (Whisper left "is that true" bare),
 * "is that", "do you" and the like count too ("Don't you dare." doesn't).
 */
export function isQuestion(text, aliases = []) {
  const t = String(text ?? '').trim();
  if (/\?["'”’)\]]*$/.test(t)) return true;
  const words = plainWords(t);
  const i = startOf(words, aliases);
  if (QUESTION_WORDS.has(words[i])) return true;
  if (/[.!]["'”’)\]]*$/.test(t)) return false;
  const [aux, next] = [words[i], words[i + 1]];
  const thingsToo = !['do', "don't", 'have', 'has', "haven't", "hasn't"].includes(aux);
  return YES_NO.has(aux) && (PEOPLE.has(next) || (thingsToo && THINGS.has(next)));
}

// Asking it for something without a question: "look up when worlds starts", "tell me why",
// "explain that", "say that again", "I didn't catch that". (Not callouts in a game: "check
// mid", "keep going, push!", "tell him to group".)
const ASK_START = new RegExp(
  String.raw`^(?:(?:can|could|would|will) you |please |pls |just |now |ok |okay |so |wait |hold on |sorry |hey )*` +
    String.raw`(?:look (?:it|that|this) up|look up \S+|look into \S+|google \S+|tell (?:me|us)\b|explain (?:that|this|it|why|how|what|the)\b|remind (?:me|us) (?:what|who|when|where|how|why)\b|walk (?:me|us) through|say (?:that|it) again|repeat (?:that|it)|come again|(?:i |we )?(?:didn'?t|did not|couldn'?t|could not) (?:catch|hear|get) (?:that|it|you|what you said)|you cut out|(?:i|we) wonder (?:what|who|when|where|how|why|if|whether))`,
);
// ...or this and nothing more: "go on", "keep going".
const ASK_WHOLE = /^(?:(?:ok|okay|so|wait|please|go ahead and) )*(?:go on|keep going|continue|elaborate|and then|then what|more)(?: (?:please|then))?$/;

/** They asked it something: a question, or a request like "look up when worlds starts" or "tell me why". */
export function asksSomething(text, aliases = []) {
  if (isQuestion(text, aliases)) return true;
  const words = plainWords(text);
  const rest = words.slice(startOf(words, aliases)).join(' ');
  return ASK_START.test(rest) || ASK_WHOLE.test(rest);
}

// "Babel, skip it", "stop the song", "that's enough", "skip it, never mind": a short line that's only that.
const SKIP_ONE = String.raw`(?:skip|skip (?:it|that|this|the song)|stop|stop it|stop the (?:song|music)|enough|enough of (?:it|that|this)|that'?s enough|turn (?:it|that|this) off|cut (?:it|the music|the song)|kill (?:it|the music|the song)|no more|cancel (?:it|that|the song)|never ?mind(?: the song)?)(?: (?:please|now|already|man|dude|bro))*`;
const SKIP_PHRASE = new RegExp(String.raw`^${SKIP_ONE}(?: ${SKIP_ONE})?$`);
const SKIP_LEAD = new Set(['ok', 'okay', 'alright', 'aight', 'yo', 'hey', 'please', 'dude', 'bro', 'man', 'uh', 'um', 'oh']);

/** Asking it to stop (or cancel) the song: short, a command, no "don't", no question. */
export function isSkipSong(text, aliases = []) {
  if (String(text ?? '').includes('?')) return false;
  const names = new Set(aliases.flatMap((a) => plainWords(a)));
  let words = plainWords(text).filter((w) => !names.has(w));
  while (words.length > 1 && SKIP_LEAD.has(words[0])) words = words.slice(1);
  if (!words.length || words.length > 8) return false;
  return SKIP_PHRASE.test(words.join(' '));
}

// "Babel, cancel the song", "never mind", "nah, forget it", "skip it, never mind the song":
// calling off a song it's still making.
const CANCEL_ONE = String.raw`(?:cancel(?: (?:it|that|the song|the music))?|call (?:it|that) off|never ?mind(?: (?:the song|about the song|on the song|that))?|forget (?:it|that|the song|about (?:it|that|the song))|skip (?:it|that|the song)|scrap (?:it|that|the song)|no song|stop the song|don'?t (?:make|do) (?:it|that|the song)|don'?t bother)(?: (?:please|then|now|man|dude|bro|actually))*`;
const CANCEL_PHRASE = new RegExp(String.raw`^${CANCEL_ONE}(?: ${CANCEL_ONE})?$`);
const CANCEL_LEAD = new Set([...SKIP_LEAD, 'actually', 'wait', 'nah', 'no', 'nope']);

/** Calling off a song it's still making: short, nothing else asked, no question. */
export function isCancelSong(text, aliases = []) {
  if (String(text ?? '').includes('?')) return false;
  const names = new Set(aliases.flatMap((a) => plainWords(a)));
  let words = plainWords(text).filter((w) => !names.has(w));
  while (words.length > 1 && CANCEL_LEAD.has(words[0])) words = words.slice(1);
  if (!words.length || words.length > 8) return false;
  return CANCEL_PHRASE.test(words.join(' '));
}

/** One of the choices, not one of the last few it used. */
export function pickFresh(choices, recent = [], random = Math.random) {
  const fresh = choices.filter((c) => !recent.includes(c));
  const pool = fresh.length ? fresh : choices;
  return pool[Math.floor(random() * pool.length)] ?? choices[0];
}

// Only hesitating ("Errm.", "Uh...", "Hmm"): they haven't said anything yet. ("Mhm" and "mm"
// are a yes, and "ah", "eh" or "oh" can be a whole answer: those aren't this.)
const HESITATION_WORD = /^(?:e+r+m*|u+h+m*|u+m+|h+m+)$/;

/** "Errm", "uh", "um", "hmm" and nothing else: still thinking, not a reply yet. */
export function isJustHesitation(text) {
  const words = plainWords(text);
  return words.length > 0 && words.length <= 3 && words.every((w) => HESITATION_WORD.test(w));
}

// Being told to butt in less: "you don't have to respond to everything", "nobody asked you",
// "stop butting in". ("Shut up" is different: that stops what it's saying now.) These are
// clear enough right after its line, even without its name...
const RETORT_LEAD = String.raw`(?:(?:oh|bro|bruh|dude|man|like|but|yo|ok|okay|um|uh|lol|my god|oh my god|omg|god|jesus|seriously|dawg|mate|literally) )*`;
const RETORT_TRAIL = String.raw`(?: (?:bro|bruh|dude|man|lol|though|tho|mate|dawg|anyway|okay|ok))*`;
const TALK_LESS = new RegExp(
  [
    String.raw`(?:^|\byou )(?:do not|don'?t|dont) (?:have to|need to|got to|gotta|hafta) (?:respond|reply|answer|comment|react|chime in|weigh in|talk|say something)(?: to| on| about)? (?:everything|every single thing|every little thing|every line|every word|every time|every question|every comment|all of (?:it|that|this)|everyone|everybody)\b`,
    String.raw`^${RETORT_LEAD}(?:no ?one|nobody) (?:even )?(?:asked|was asking)(?: (?:you|for (?:that|this|it|your (?:opinion|input))|your (?:opinion|input)))?(?: to)?${RETORT_TRAIL}$`,
    String.raw`^${RETORT_LEAD}who (?:even )?asked(?: you)?${RETORT_TRAIL}$`,
    String.raw`\b(?:no ?one|nobody)(?:'s| is| was|s) (?:even )?(?:talking|speaking) to you\b`,
    String.raw`\b(?:i|we) (?:wasn'?t|was not|weren'?t|were not|wasnt|werent) (?:even )?(?:talking|speaking) to you\b`,
    String.raw`\b(?:stop|quit) (?:butting in|chiming in|jumping in|interjecting|commenting on everything|responding to everything|replying to everything|answering everything)\b`,
    String.raw`\b(?:only|just) (?:talk|speak|respond|answer|reply|chime in) (?:when|if) (?:someone|somebody|we|people|anyone|anybody) (?:call|calls|called|say|says|said|ask|asks|asked|talk|talks|need|needs)\b`,
    String.raw`^${RETORT_LEAD}stay out of (?:it|this|our conversation|the conversation)${RETORT_TRAIL}$`,
  ].join('|'),
);
// ...and these only with its name in the line (said to a friend, they're about the friend).
const TALK_LESS_TO_IT = new RegExp(
  [
    String.raw`\b(?:talk|speak) (?:a (?:little|bit) )?less\b`,
    String.raw`\byou (?:talk|speak|respond|reply) (?:too|way too|so) much\b`,
    String.raw`\b(?:stop|quit) interrupting\b`,
  ].join('|'),
);
// ...but not the opposite: "don't stop chiming in", "never stop interrupting".
const TALK_MORE = /\b(?:do not|don'?t|dont|never|can'?t) (?:stop|quit)\b/;

/**
 * Someone telling it to butt in less ("you don't have to respond to everything", "nobody
 * asked you"). Not a line turned to someone else in the call by name ("Mike, you talk
 * too much"), unless it names it too. aliases: its names; people: the others in the call.
 */
export function asksToTalkLess(text, { aliases = [], people = [] } = {}) {
  const mine = new Set(aliases.flatMap((a) => plainWords(a)));
  const theirs = new Set(people.flatMap((p) => plainWords(p)).filter((w) => w.length >= 3 && !mine.has(w)));
  const words = plainWords(text);
  const named = words.some((w) => mine.has(w));
  const rest = words.filter((w) => !mine.has(w));
  // Someone's name at the start or the end: said to them.
  if (!named && rest.length && (theirs.has(rest[0]) || theirs.has(rest[1]) || theirs.has(rest.at(-1)))) return false;
  const t = rest.join(' ');
  if (TALK_MORE.test(t)) return false;
  return TALK_LESS.test(t) || (named && TALK_LESS_TO_IT.test(t));
}

/**
 * Its new line nearly repeats one it just said: it opens with the same five words or
 * more ("I asked because I'm nosy..."), or it's nearly the same words.
 */
export function nearlyRepeats(line, earlier = []) {
  const mine = plainWords(withoutTags(line));
  if (mine.length < 3) return false;
  return earlier.some((e) => {
    const theirs = plainWords(withoutTags(e));
    if (theirs.length < 3) return false;
    // (Or one of them a word in, past a name: "Leonardo, I asked..." and "I asked...". Not
    // both a word in: "Darius is the best pick for top" and "Ahri is the best pick for mid"
    // answer two questions.)
    for (const [i, j] of [[0, 0], [1, 0], [0, 1]]) if (runFrom(mine, i, theirs, j) >= 5) return true;
    const a = new Set(mine);
    const b = new Set(theirs);
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / new Set([...a, ...b]).size >= 0.7;
  });
}

const withoutTags = (text) => String(text ?? '').replace(/\[[^\]]{0,40}\]/g, ' ');

/** How many words in a row two lines share from these places on. */
function runFrom(A, i, B, j) {
  let n = 0;
  while (i + n < A.length && j + n < B.length && A[i + n] === B[j + n]) n++;
  return n;
}

/**
 * "Kneeheel, did you just ask..." becomes "Did you just ask...": a line that opens with the
 * name of someone in the call, when at least three words are left. (Its follow-ups had
 * taken to opening that way.)
 */
export function withoutLeadingName(text, names = []) {
  const t = String(text ?? '');
  const m = /^(\s*(?:\[[^\]]{1,40}\]\s*)*)([^,.!?[\]]{1,40}?)\s*,\s+/.exec(t);
  if (!m) return t;
  const who = plainWords(m[2]).join(' ');
  if (!who) return t;
  const known = names.some((n) => {
    const w = plainWords(n);
    return w.length > 0 && (w.join(' ') === who || w[0] === who);
  });
  if (!known) return t;
  const rest = t.slice(m[0].length);
  if (wordCount(rest) < 3) return t;
  // "Mike, Jess and Leo all lost", "Mike, and you too", "Mike, Darius is broken": the name
  // is part of what it's saying (anything capitalized after it but "I").
  const next = /^[^\p{L}]*([\p{L}'’]+)/u.exec(rest)?.[1] ?? '';
  if (/^and$/i.test(next) || (/^\p{Lu}/u.test(next) && !/^I(?:['’](?:m|d|ll|ve))?$/.test(next))) return t;
  return capitalize(m[1] + rest);
}

// Words too common to make a phrase its own habit ("I don't", "you know", "the whole").
const COMMON = new Set(
  (
    "a an the and or but so to of in on at for with from by as is are was were be been being am do does did done have has had " +
    "i you he she it we they me him her us them my your his its our their mine yours i'm you're he's she's it's we're they're " +
    "i've you've we've they've i'll you'll he'll she'll it'll we'll they'll i'd you'd he'd she'd we'd they'd " +
    "that this these those that's there here there's what's what how why who when where which if then than not no yes yeah yep " +
    "don't doesn't didn't can't won't isn't aren't wasn't ain't just like oh all up out get got go going gonna wanna gotta about " +
    "one some more really too now will would can could should right well okay ok sure it'll let let's me know think thing still " +
    "even way any much very also back over off into want wants wanted whole sounds sound asking ask asked said say says tell " +
    "need make take give look feel mean try keep guess lot little big good bad best man dude bro guys hey wait sorry thanks"
  ).split(' '),
);

/** For each phrase of two to four words (not all common words), which of these lines say it. */
export function phraseLines(lines = []) {
  const found = new Map();
  lines.forEach((line, n) => {
    const words = plainWords(withoutTags(line));
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i + len <= words.length; i++) {
        const gram = words.slice(i, i + len);
        if (gram.every((w) => COMMON.has(w))) continue;
        const g = gram.join(' ');
        if (!found.has(g)) found.set(g, new Set());
        found.get(g).add(n);
      }
    }
  });
  return found;
}

/**
 * Phrases it has leaned on: said in at least `min` of its lines, the most used first,
 * at most `max`, one per habit (a phrase said mostly in the same lines as one already
 * chosen, like "a pile" and "of text" next to "pile of", is the same habit). Not phrases
 * with a name in them (names: words to leave out), nor ones the others said lately
 * (others: their lines): that's the topic, not a habit. found: from phraseLines.
 */
export function pickOverused(found, { min = 3, max = 5, names = [], others = [] } = {}) {
  const skip = new Set(names.flatMap((n) => plainWords(n)));
  const theirs = ` ${others.map((l) => plainWords(l).join(' ')).join(' | ')} `;
  const often = [...found]
    .filter(([g, at]) => at.size >= min && !g.split(' ').some((w) => skip.has(w)) && !theirs.includes(` ${g} `))
    .sort((a, b) => b[1].size - a[1].size || b[0].split(' ').length - a[0].split(' ').length);
  const chosen = [];
  for (const [g, at] of often) {
    const same = chosen.some(([, pat]) => {
      let both = 0;
      for (const n of at) if (pat.has(n)) both++;
      return both >= 0.6 * at.size;
    });
    if (same) continue;
    chosen.push([g, at]);
    if (chosen.length >= max) break;
  }
  return chosen.map(([g]) => g);
}

/** Phrases these lines lean on (see pickOverused). */
export function overusedPhrases(lines = [], opts = {}) {
  return pickOverused(phraseLines(lines), opts);
}
