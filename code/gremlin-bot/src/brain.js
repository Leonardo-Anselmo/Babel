// The bot's judgment for one voice call: keeps the rolling transcript, decides
// when to answer, when to chime in unprompted, and when to keep its mouth shut.

import { Readable } from 'node:stream';
import { logger } from './log.js';
import { looksLikeSoftRefusal } from './refusals.js';
import {
  LONG_RE,
  LOOKUP,
  LOOKUP_RE,
  TASKS,
  buildSystem,
  buildUserMessage,
  cleanSpoken,
  deflection,
  followupCheck,
  followupCheckSaysYes,
  formatCallInfo,
  formatTranscript,
  isLeadIn,
  nextSentenceEnd,
  passesAfterLine,
  sayContent,
  withoutHiddenTags,
} from './prompts.js';
import { isAddressed, isEchoOf, isHoldOn, isJustCallingIt, isStopCommand, longestCommonRun, normalizeWords } from './wakeword.js';
import { JOKE_WINDOW_MS, JokeTuning, callsBackTo, jokeOutcome, reactionTo } from './jokes.js';
import { cutOffInReminder, reminderTags, withoutReminderTags } from './reminders.js';
import { cutOffInImage, imageTags, withoutImageTags } from './images.js';
import { listTags } from './lists.js';
import { cutOffInSong, songTags, withoutSongTags } from './songs.js';
import {
  LAUGHS,
  PICTURE_POSTED,
  SONG_INTROS,
  THINKING_SOUNDS,
  asksSomething,
  asksToTalkLess,
  hasLaughTag,
  isCancelSong,
  isGoodbye,
  isJustHesitation,
  isQuestion,
  isSkipSong,
  nearlyRepeats,
  openerKey,
  phraseLines,
  pickFresh,
  pickOverused,
  varyOpening,
  withoutLeadingName,
} from './human.js';

const log = logger('brain');
// A joke that laughs itself ("[laughs]", "haha"): a laugh heard while it plays may be its own voice in a mic.
const LAUGHS_ITSELF = /\[(?:laughs?|laughing|chuckles?|giggles?|cackles?)\]|\b(?:ha){2,}h?\b|\b(?:lol|lmao)\b/i;
// Talking over its joke for at least this long (while it played) counts against the joke.
const TALKED_OVER_MS = 1000;
// Words are learned only from what they said this long before asking (older lines are about something else).
const LEARN_FROM_MS = 30000;
// ...and not words it said itself this long before they asked.
const OWN_WORDS_MS = 60000;

// Unprompted chime-ins. cooldown: quiet time after the bot last spoke.
// checkEvery: min time between "anything funny?" checks. minLines: new lines needed.
// After it answers someone, people often reply without its name: engagedMs is how
// long after its line that still counts, and followups how many such replies in a
// row it answers before it needs to hear its name again.
// jokeGapMs: the least time between two jokes of its own (it passed on every joke check
// until 2026-10-29; now that it jumps in, this keeps it from joking at every pause).
export const CHATTINESS = {
  off: null,
  low: { cooldownMs: 300000, checkEveryMs: 60000, minLines: 5, engagedMs: 12000, followups: 2, jokeGapMs: 600000 },
  medium: { cooldownMs: 150000, checkEveryMs: 40000, minLines: 4, engagedMs: 20000, followups: 5, jokeGapMs: 300000 },
  high: { cooldownMs: 60000, checkEveryMs: 20000, minLines: 3, engagedMs: 20000, followups: 5, jokeGapMs: 120000 },
};

// Requests people made (direct, roast) outrank anything it came up with itself.
const PRIORITY = { greet: 1, quip: 1, welcome: 1, farewell: 1, followup: 2, roast: 4, direct: 4 };
// Lines it may decide not to say (judged whole before any of it is said), dropped when someone wants an answer.
const UNPROMPTED = new Set(['quip', 'followup', 'welcome', 'farewell']);
const ROAST_QUEUE_MAX = 2;
const ROAST_STALE_MS = 60000;
// If an answer takes longer than this (usually a web search), say "one sec" first.
const FILLER_AFTER_MS = 3500;
export const FILLERS = ['One sec.', 'Hang on.', 'Gimme a second.', 'Hold on, checking.', 'Lemme look that up.'];
// ...the ones that don't say it's looking something up (for an answer that's only slow).
const WAIT_FILLERS = FILLERS.slice(0, 3);
export const SEARCH_CAME_UP_EMPTY = 'Sorry, I came up empty on that one.';
const LULL_MS = 800; // wait for this much quiet before an unprompted line
const ECHO_WINDOW_MS = 15000;
// After "Gremlin!" or "Gremlin, wait", their next sentence counts as talking to
// it if they start it within this long.
const LISTEN_MS = 10000;
// What it says when someone only calls its name while it's quiet: a quick sign it
// heard, then it listens for the rest (nothing is written by Claude for it).
export const ACKS = ['Yeah?', "What's up?", "I'm here.", 'Go ahead.', 'Talk to me.'];
// Two people calling it at once (or one mic picking up another) get one of those.
const ACK_GAP_MS = 3000;
// Safety limit for a cut-in waiting on the sentence it was caught in.
const CUT_IN_MAX_MS = 60000;
// "Gremlin, best build for... a support main": a sentence from the same person that
// starts within this long after their question ended is the rest of the question.
const CONTINUE_MS = 2000;
// A reply to it said in pieces: more from them within this long, before its reply
// to them has been heard, gets that reply written again to cover all of it.
const MORE_OF_A_REPLY_MS = 8000;
// ...and an answer starts over for that at most this many times.
const MAX_RESTARTS = 2;
// Asking again by name restarts their own answer only if it's still this fresh
// (an older one is nearly done, or busy looking something up: let it finish).
const RETHINK_MAX_MS = 2000;
// Laughing, "um" or a quick reaction after a question isn't more of it.
const NOT_MORE_OF_IT = /^(?:(?:ha)+h?|(?:he)+h?|lol|lmao|um+|uh+m*|hm+|mm+|e+r+m*|ah+|oh+|eh|huh|yeah|yea|yep|yup|yes|ok|okay|k|right|true|sure|cool|nice|alright|no|nah|nope|what|wow|damn|dude|bro|man|so|like|well|anyway|please)$/;
// A quick "Hmm." when a question's answer hasn't started this long after they stopped
// talking: now and then (this share of the time, at most this often), never as a habit.
// (THINKING_SOUNDS, LAUGH_ALONG and HELLO_GOODBYE are on by default in config.js; a config
// that doesn't mention them, like the tests', has them off.)
const THINK_AT_MS = 1400;
const THINK_GAP_MS = 120000;
const THINK_CHANCE = 0.5;
// Laughing along when the group cracks up: never at its own line (this soon after it),
// at most this often, more likely when several people laugh at once.
const LAUGH_AFTER_OWN_LINE_MS = 10000;
const LAUGH_GAP_MS = 240000;
const LAUGH_GROUP_MS = 5000;
const LAUGH_CHANCE_ONE = 0.25;
const LAUGH_CHANCE_GROUP = 0.6;
// It laughed this recently (a laugh in its own line, or laughing along): no laughing to open the next one.
const LAUGHED_LATELY_MS = 45000;
// Its short sounds ("Hmm.", a laugh) count as its own voice in someone's mic for this long after they end.
const SOUND_ECHO_MS = 5000;
// ...and only for someone who started talking while it played or just after (a "haha"
// a few seconds later is a person laughing, maybe at its next joke).
const SOUND_ECHO_SLACK_MS = 1500;
// A song that's ready waits for a quiet moment (nobody talking, nothing of its own on the way) up to this long.
const SONG_QUIET_WAIT_MS = 45000;
// Hi to people who join once it has been in the call this long (its own hello covers
// the ones there when it joined), once per person per half hour; joins close together get one hi.
const WELCOME_AFTER_JOIN_MS = 60000;
const WELCOME_AGAIN_MS = 30 * 60000;
const WELCOME_GATHER_MS = 4000;
// Bye to someone heading out who has been in the call this long, once per half hour, one bye at a time.
const BYE_AFTER_MS = 5 * 60000;
const BYE_AGAIN_MS = 30 * 60000;
const BYE_GAP_MS = 15000;
// Told to butt in less ("you don't have to respond to everything"): for this long it only
// answers when someone says its name (or the person it's answering asks it something).
const TALK_LESS_MS = 20 * 60000;
// Phrases it has said in this many of its lines this call are pointed out as worn out (up to OVERUSED_MAX).
const OVERUSED_MIN = 3;
const OVERUSED_MAX = 5;
// ...looking back over this many of its lines (about the last hour or two), of these kinds.
const SAID_KEPT = 80;
const SAID_KINDS = new Set(['direct', 'followup', 'quip', 'roast', 'greet', 'welcome', 'farewell']);
// How long an answer someone lost (another person took the floor) is still owed.
const OWED_MAX_MS = 30000;
// Someone who's the only one that has talked for this long (or the only one in the
// call) is in a one-on-one with it: what they say right after it is almost surely for it.
const ONE_ON_ONE_MS = 180000;
// ...and the back-and-forth can go this many replies in a row without its name (a cap,
// so a mic picking up a TV or a video can't keep it going forever).
const ONE_ON_ONE_FOLLOWUPS = 12;
// The name detector's default threshold (NAME_DETECTOR_THRESHOLD): how sure it must be
// that its name was said, from the sound alone (the words can come out wrong, like
// "Table, what time is it?"). Such a sentence gets a reply that may still pass.
const NAME_THRESHOLD = 0.7;
// ...and for a word or two heard only by it (answered with a "Yeah?" that can't pass), this much more.
const DETECTOR_ONLY_MARGIN = 0.15;
// When the person it's answering talks over it for this long, it pauses to listen;
// a laugh or "yeah" lets it carry on, anything else gets an answer instead.
const TALK_OVER_MS = 600;
// VENICE_FOR=all: how long a follow-up waits for Claude's yes/no after Venice's line is written.
const GATE_WAIT_MS = 1500;
const TALK_OVER_KINDS = new Set(['direct', 'followup']);
// How long into their sentence it keeps checking whether they're talking over it.
const TALK_OVER_WATCH_MS = 4000;
// A paused answer is dropped after this long (they're saying something long: it answers that instead).
const PAUSED_MAX_MS = 8000;
// They went quiet and nothing they said is on its way (too short to count): carry on after this long.
const RESUME_AFTER_QUIET_MS = 1200;
// Pausing for someone whose mic turned out to be playing its own voice back: after
// this many times, it stops pausing for them.
const ECHO_PAUSES_MAX = 2;
// After a paused answer was dropped because they kept talking, their sentence still
// gets answered if it arrives within this long.
const CUT_SHORT_MS = 30000;
// What counts as only reacting to it (it carries on): laughing, "yeah", "nice", "oh wow".
const REACTION_WORD =
  /^(?:(?:ha)+h?|(?:he)+h?|(?:ah)+h?|lol|lmao|lmfao|rofl|um+|uh+|hm+|mm+|oh+|ooh+|eh|yeah|yea|ya|yep|yup|yes|ok|okay|k|right|true|sure|cool|nice|alright|wow|damn|dang|dude|bro|bruh|man|facts|exactly|totally|gotcha|word)$/;
// "Gremlin, look at this": the owner asking it to look at their screen. Only clear asks:
// "look at this/that" said to it as a request (not "I'll look at this later"), or a
// question that names the screen ("did you see that goal last night?" isn't one).
const LOOK_LEAD_WORDS = new Set(['hey', 'yo', 'ok', 'okay', 'so', 'oh', 'dude', 'bro', 'man', 'real', 'quick', 'now', 'please', 'here']);
const LOOK_REQUEST_RE =
  /^(?:(?:can|could|would|will) you )?(?:please )?(?:quick(?:ly)? )?(?:take a |have a |quick )?look at (?:this|that|my screen|the screen|my monitor|my game|what(?:'s| is) on (?:my|the) screen|what i(?:'m| am) (?:doing|playing|looking at|seeing))(?: |$)/;
const SCREEN_QUESTION_RE = /\b(?:what(?:'s| is) on (?:my|the) screen|what am i looking at|(?:can|do) you see (?:my|the) (?:screen|monitor|game)|check out my (?:screen|monitor))\b/;

/** The owner asking it to look at their screen ("Gremlin, look at this", "what's on my screen?"). */
export function asksToLook(text, aliases = []) {
  const words = normalizeWords(text);
  const names = new Set(aliases.flatMap((a) => normalizeWords(a)));
  // Past its name and filler at the start ("hey Gremlin, quick, look at this").
  let i = 0;
  while (i < words.length && (names.has(words[i]) || LOOK_LEAD_WORDS.has(words[i]))) i++;
  return LOOK_REQUEST_RE.test(words.slice(i).join(' ')) || SCREEN_QUESTION_RE.test(words.join(' '));
}

/** Only a laugh or a quick reaction ("haha", "yeah true", "oh nice"), nothing to answer. */
export function isJustAReaction(text) {
  const words = normalizeWords(text);
  return words.length > 0 && words.length <= 4 && words.every((w) => REACTION_WORD.test(w));
}

// Talked over by a short comment, it carries on. Not for a question, a request or a
// correction: those get their answer instead.
const ASIDE_FILLER = new Set(['oh', 'ooh', 'okay', 'ok', 'yo', 'dude', 'bro', 'man', 'so', 'now', 'well', 'like', 'um', 'uh', 'yeah', 'yes', 'yep', 'lol', 'lmao']);
const ASIDE_NOT_FIRST =
  /^(?:and|but|or|then|actually|what|whats|who|whos|where|when|why|how|which|can|could|would|will|should|do|does|did|is|are|was|were|have|has|you|u|louder|quieter|pause|volume|add|put|take|remove|delete|strike|skip|play|tell|say|repeat|give|make|draw|sing|show|look|check|read|explain|stop|wait|hold|hang|go|let|lets|try|pick|find|turn|please|remind|roast|slow|speak|talk|keep|continue|finish|spell|define|search|google|post|list|write|send|answer|choose|rate|compare|recommend|suggest|name|guess|one)$/;
const ASIDE_NOT_ANYWHERE = /\b(?:no|nope|nah|not|never|wrong|already|seen|heard|watched|said|asked|meant|i mean|instead|again|same joke|same one|same thing|other one|shut|quiet|hush|nobody|dont|didnt|isnt|wasnt|cant|wont|aint)\b/;

/**
 * A short comment while it talks ("that's so crazy", "thing is awesome", "I think like last
 * year"): up to six words, not to it, not a question, a request or a correction. When the
 * person it's answering says one over it, it carries on instead of dropping its line
 * (2026-10-29: about a third of the 24 lines it dropped were for comments like these).
 */
export function isAside(text, aliases = []) {
  const words = normalizeWords(text);
  if (!words.length || words.length > 6 || /\?/.test(String(text)) || isAddressed(text, aliases) || asksSomething(text, aliases)) return false;
  let i = 0;
  while (i < words.length - 1 && ASIDE_FILLER.has(words[i])) i++;
  if (ASIDE_NOT_FIRST.test(words[i].replace(/['’]/g, ''))) return false;
  return !ASIDE_NOT_ANYWHERE.test(words.join(' ').replace(/['’]/g, ''));
}

/** 1234 ms as "1.2" (seconds, one decimal, never below zero). */
const seconds = (ms) => (Math.max(0, ms) / 1000).toFixed(1);

/**
 * The end-of-call line about how long people waited for answers to start (ms each):
 * "answers started 1.8 s after people stopped talking (median of 12; slowest 4.2 s)", or ''.
 */
export function replyTimeSummary(times = []) {
  const t = times.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!t.length) return '';
  const mid = t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2;
  return `answers started ${seconds(mid)} s after people stopped talking (median of ${t.length}; slowest ${seconds(t.at(-1))} s)`;
}

/** A real laugh: three "ha"s or more ("hahaha", "ha ha ha"), or "lol", "lmao". Not a polite "ha ha". */
export function isBigLaugh(text) {
  const words = normalizeWords(text);
  if (words.some((w) => /^(?:lol+|lmf?ao+|rofl)$/.test(w))) return true;
  return (words.join('').match(/h[ae]/g)?.length ?? 0) >= 3;
}

/** One request covering two people's (or two halves of one person's) asks. */
function mergeAsks(a, b) {
  if (!a || !b) return a || b;
  return {
    ...b,
    names: [...new Set([...(a.names || [a.name]), ...(b.names || [b.name])].filter(Boolean))],
    userIds: [...new Set([...(a.userIds || []), ...(b.userIds || [])])],
    afterCall: Boolean(a.afterCall && b.afterCall), // may pass only if every one of them may
    unsureCall: Boolean(a.unsureCall && b.unsureCall),
    look: Boolean(a.look || b.look), // either of them asked it to look at the screen
  };
}

export class Transcript {
  constructor({ maxLines, maxMinutes, clock = Date.now, onAdd = null }) {
    this.maxLines = maxLines;
    this.maxMs = maxMinutes * 60000;
    this.clock = clock;
    this.onAdd = onAdd; // told about every line (the call's notes keep their own copy)
    this.lines = [];
    this.count = 0; // total human lines ever added (for staleness checks)
  }

  add({ name, text, isBot = false, at, userId }) {
    const line = { name, text, isBot, at: at ?? this.clock() };
    if (userId) line.userId = userId;
    this.lines.push(line);
    if (!isBot) this.count++;
    this.trim();
    this.onAdd?.(line);
    return line;
  }

  remove(line) {
    line.dropped = true; // (the call's notes may hold it too: it was never said)
    const i = this.lines.indexOf(line);
    if (i >= 0) this.lines.splice(i, 1);
  }

  trim() {
    const cutoff = this.clock() - this.maxMs;
    while (this.lines.length && (this.lines.length > this.maxLines || this.lines[0].at < cutoff)) this.lines.shift();
  }

  recent() {
    this.trim();
    return [...this.lines];
  }

  /** Its own lines that are still playing or ended within the window (a mic may still be echoing them). */
  recentBotLines(withinMs) {
    const since = this.clock() - withinMs;
    return this.lines.filter((l) => l.isBot && (l.open || (l.until ?? l.at) >= since));
  }
}

export class Brain {
  /**
   * @param {object} o
   * @param {object} o.config            loaded config
   * @param {object} o.claude            claude client
   * @param {object} o.speaker           { say(text,{kind,onStart}), stop(), speaking, wasAudibleBetween(a,b) }
   * @param {() => object} o.getCallInfo  { channelName, people, activities }
   * @param {() => Array} o.getFacts      saved /remember facts
   * @param {() => boolean} o.isAnyoneSpeaking
   * @param {(userId: string) => boolean} [o.isSpeaking]  one person is mid-sentence
   * @param {() => boolean} [o.isHearingSomething]  a finished sentence is still being transcribed
   * @param {(userId: string) => boolean} [o.isHearingFrom]  one person's finished sentence is still being transcribed
   * @param {(kind: string, err: Error) => void} [o.onReplyFailure]  a reply someone asked for couldn't be written
   * @param {(citations: Array<{url: string, title: string}>) => void} [o.onSources]  a spoken answer came from web results
   * @param {object} [o.jokes]  how its jokes have landed in this server (saved JokeTuning state)
   * @param {(state: object) => void} [o.onJokes]  the joke score changed (to save it)
   * @param {(said: string, heard: string[]) => void} [o.learnWords]  an answer was heard: what it said and what it was answering
   * @param {() => string[]} [o.getCallbacks]  its jokes that got a laugh in earlier calls, to maybe call back to
   * @param {(text: string) => void} [o.onJokeLanded]  one of its jokes got a laugh (to keep it)
   * @param {(text: string) => void} [o.onCallbackUsed]  it called back to one of those (it rests a while)
   * @param {() => string} [o.getReminders]  the reminders still to go off here, for its prompt
   * @param {(tags: { set: object[], cancel: object[] }, info: object) => void} [o.onReminders]  an answer that sets or cancels reminders was heard
   * @param {() => (string|{ text: string, shown: object[] })} [o.getLists]  this server's shared lists, for its prompt (and the copy its item numbers refer to)
   * @param {(tags: { ops: object[], cutOff: boolean }, info: object) => void} [o.onLists]  an answer that changes or posts lists was heard
   */
  constructor({
    config,
    claude,
    claudeFast,
    claudeJokes = null,
    venice = null,
    speaker,
    getCallInfo,
    getFacts,
    isAnyoneSpeaking,
    isSpeaking,
    isHearingSomething,
    isHearingFrom,
    chattiness,
    onReplyFailure,
    onSources,
    getScreenshot,
    isOwner,
    callNotes,
    getEarlierCalls,
    voicedMs,
    jokes = null,
    onJokes,
    learnWords,
    getCallbacks,
    onJokeLanded,
    onCallbackUsed,
    getReminders,
    onReminders,
    getJoinedAt,
    onSong,
    getSongsNow,
    isMakingSong,
    onCancelSong,
    onImage,
    getImagesNow,
    getLists,
    onLists,
    fillerAfterMs = FILLER_AFTER_MS,
    clock = Date.now,
    random = Math.random,
  }) {
    this.config = config;
    this.fillerAfterMs = fillerAfterMs;
    this.onReplyFailure = onReplyFailure || (() => {});
    // A spoken answer used web results: show where they came from (in text).
    this.onSources = onSources || (() => {});
    this.claude = claude;
    this.claudeFast = claudeFast || claude;
    // Its own jokes (CLAUDE_JOKE_MODEL; the main model by default: its jokes were much better).
    this.claudeJokes = claudeJokes || this.claudeFast;
    // Venice's models for some kinds of line instead of Claude (VENICE_FOR; see venice.js).
    this.venice = venice;
    this.veniceKinds = new Set(venice ? config.venice?.kinds || [] : []);
    this.speaker = speaker;
    this.getCallInfo = getCallInfo;
    this.getFacts = getFacts || (() => []);
    this.isAnyoneSpeaking = isAnyoneSpeaking || (() => false);
    // Whether one particular person is mid-sentence (a "Yeah?" waits only for the caller).
    this.isSpeaking = isSpeaking || (() => false);
    // A sentence someone just finished may still be on its way (being transcribed),
    // and it may be addressed to the bot: no unprompted line until it arrives.
    this.isHearingSomething = isHearingSomething || (() => false);
    this.isHearingFrom = isHearingFrom || (() => false);
    // A picture of the owner's screen, when they ask it to look ({ jpeg } or { error }).
    this.getScreenshot = getScreenshot || (async () => ({ error: "it can only see the screen when it's started from the desktop app" }));
    this.isOwner = isOwner || (() => false);
    // Notes on this call so far, kept as it goes (CALL_MEMORY), and summaries of earlier calls.
    this.callNotes = callNotes || null;
    this.getEarlierCalls = getEarlierCalls || (() => '');
    // How much of one person's current sentence was actual talking, in ms.
    this.voicedMs = voicedMs || null;
    this.nameThreshold = config.listen?.nameThreshold ?? NAME_THRESHOLD;
    this.clock = clock;
    this.random = random;
    this.chattiness = chattiness || config.defaultChattiness;
    // How its jokes have landed here (laughs vs being shushed) sets how often it tries one.
    this.jokeTuning = new JokeTuning(jokes);
    this.onJokes = onJokes || (() => {});
    this.joke = null; // the joke being told now (or just told): { line, startedAt, endedAt, laughs, boos, talkedOver }
    // Jokes that got a laugh: kept, and a few from earlier calls offered as callbacks.
    this.getCallbacks = getCallbacks || (() => []);
    this.onJokeLanded = onJokeLanded || null;
    this.onCallbackUsed = onCallbackUsed || null;
    // Reminders people asked for: the ones set (for its prompt), and setting or cancelling them.
    this.getReminders = getReminders || (() => '');
    this.onReminders = onReminders || null;
    // When someone joined the call (for saying bye only to people who've been around a while).
    this.getJoinedAt = getJoinedAt || null;
    // Songs people ask for: making one (once the answer agreeing to it is heard), and whether it can now.
    this.onSong = onSong || null;
    this.getSongsNow = getSongsNow || (() => '');
    // A song still being made: whether there is one, and calling it off ('stop': it was
    // shushed; 'asked': they asked it to cancel the song).
    this.isMakingSong = isMakingSong || (() => false);
    this.onCancelSong = onCancelSong || null;
    // Pictures people ask for: drawing one (once the answer agreeing to it is heard), and whether it can now.
    this.onImage = onImage || null;
    this.getImagesNow = getImagesNow || (() => '');
    // Shared lists people keep with it: what's on them (for its prompt), and changing or posting them once the answer is heard.
    this.getLists = getLists || (() => '');
    this.onLists = onLists || null;
    this.lastPosted = [];
    this.songCancels = 0; // goes up when songs are called off (one waiting to play then isn't played)
    // Not sounding like a bot: how its last lines opened, when it last laughed, said "hmm",
    // laughed along, said hi or bye; and short sounds of its own a mic may play back.
    this.recentOpeners = [];
    this.lastLaughTagAt = -Infinity;
    this.lastThinkAt = -Infinity;
    this.lastThinks = [];
    this.lastLaughAlongAt = -Infinity;
    this.lastLaughRollAt = -Infinity;
    this.lastGroupLaughRollAt = -Infinity;
    this.songWaiting = false; // a song is ready and waiting for a quiet moment
    this.recentLaughs = []; // { userId, at }: people laughing just now
    this.lastLaughs = [];
    this.lastIntros = [];
    this.soundEchoes = []; // { text, until }: its own short sounds (not in the transcript)
    this.welcomed = new Map(); // userId -> when it said hi
    this.welcomeQueue = new Map();
    this.welcomeTimer = null;
    this.byes = new Map(); // userId -> when it said bye
    this.lastFarewellAt = -Infinity;
    this.talkLessUntil = 0; // asked to butt in less: only answers to its name until then
    this.saidThisCall = []; // what it said (and was heard) in this call, for its overused phrases
    this.saidCount = 0;
    // Words it spelled differently from what it heard, for the speech-to-text.
    this.learnWords = learnWords || null;
    this.transcript = new Transcript({ ...config.transcript, clock, onAdd: (line) => this.callNotes?.add?.(line) });

    // How long people waited for each answer to start, in ms (for the log's end-of-call line).
    this.replyTimes = [];
    this.lastBotLineAt = 0;
    this.lastAckAt = -Infinity;
    this.lastAck = null;
    this.lastQuipCheckAt = clock();
    this.lastJokeAt = -Infinity; // when its last joke of its own started
    this.listeningSince = clock(); // a one-on-one is judged on what it has actually heard
    this.linesSinceCheck = 0;
    this.engagedUntil = 0;
    this.talkingWith = new Set(); // who its latest answer or reply was for
    this.followupsInARow = 0;
    this.spokeSeq = 0; // bumped by every markSpoke
    this.inflight = null;
    this.pending = null;
    this.queuedRoasts = []; // /roast requests waiting behind an answer
    this.lullTimer = null;
    this.closed = false;
    this.epoch = 0; // bumped whenever it gives up the floor: older replies are thrown away
    this.asks = new Map(); // userId -> { at, until, restarts, kind }: their latest question by name, or reply to it
    this.owed = null; // { names, userIds, at }: people whose answers were dropped when someone took the floor
    this.paused = null; // { userId, fromId, at }: an answer paused while the person it's for talks over it
    this.cutShort = null; // { userId, fromId, at }: a paused answer dropped because they kept talking
    this.talkOverTimer = null;
    this.pauseWatch = null;
    this.echoPauses = new Map(); // userId -> pauses that turned out to be its own voice in their mic
    this.echoes = new Map(); // userId -> times their mic played its own voice back
    // userId -> { at, fromId, exact }: they said its name over it, so their
    // sentence (exact) or their next one (after "Gremlin, wait") is for it.
    this.cutIns = new Map();
  }

  close() {
    this.finishJoke({ cutShort: true });
    this.closed = true;
    clearTimeout(this.lullTimer);
    clearTimeout(this.welcomeTimer);
    this.clearPause();
    this.inflight?.ac.abort();
    this.pending = null;
    this.queuedRoasts = [];
  }

  /**
   * A finished, transcribed sentence from someone in the call.
   * id: the listener's sentence number. startedAt/spokeUntil: when they were
   * actually talking, used to tell whether they talked over the bot.
   */
  hear({ userId, id, name, text, at, startedAt, spokeUntil, wake, unsureName = false }) {
    if (this.closed) return 'closed';
    const now = this.clock();
    const theirs = (mark) => Boolean(mark && userId && mark.userId === userId && (id ?? Infinity) >= mark.fromId);
    const pausedForThem = theirs(this.paused);
    const cutShortByThem = !pausedForThem && theirs(this.cutShort) && now - this.cutShort.at < CUT_SHORT_MS;

    // Their speakers played our voice back into their mic: ignore it. While it's paused
    // for them, a few words of what it was just saying count too (it paused after half a second).
    const echo = Math.max(this.ownEchoStrength(text, { spokeAt: typeof startedAt === 'number' ? startedAt : undefined }), pausedForThem ? this.pausedEchoStrength(text) : 0);
    if (echo) {
      // Only a clear echo marks their mic as one that plays its voice back (a short
      // match, like "hang on" right after its "Hang on.", could be them).
      const clear = echo >= 2;
      if (userId && clear) this.echoes.set(userId, (this.echoes.get(userId) ?? 0) + 1);
      log.debug(`ignored echo of my own line from ${name}`);
      if (pausedForThem) {
        // It paused for its own voice: carry on, and stop pausing for their mic if it keeps happening.
        if (clear) this.echoPauses.set(userId, (this.echoPauses.get(userId) ?? 0) + 1);
        this.resumePaused('it was my own voice in their mic');
      }
      this.dropCutIn(userId, id);
      return 'echo';
    }

    this.transcript.add({ name, text, at: at ?? now, userId });
    this.linesSinceCheck++;
    const aliases = this.config.botAliases;
    // The person it was answering talked over it and it paused: a laugh or "yeah" lets
    // it carry on; anything else is what they want answered now.
    let interrupted = false;
    if (pausedForThem) {
      if (isJustAReaction(text)) {
        this.resumePaused('they were only reacting');
        return 'carried-on';
      }
      const stopping = isStopCommand(text, aliases) || asksToTalkLess(text, { aliases, people: this.peopleNames() });
      if (!stopping && isAside(text, aliases)) {
        this.resumePaused('it was only a comment');
        return 'carried-on';
      }
      this.stopPaused('they said something');
      interrupted = true;
    } else if (cutShortByThem) {
      // It already gave up its answer while they kept talking: this is what they said.
      this.cutShort = null;
      interrupted = !isJustAReaction(text);
    }
    // If they cut in by saying its name, the rest of what they said is for it too.
    // 'exact': this is the sentence they cut in with; 'next': the one after "Gremlin!".
    const cut = this.takeCutIn(userId, id, startedAt);
    const exactCut = cut === 'exact' || cut === 'exact-unsure';
    const heardName = isAddressed(text, aliases);
    // The name detector heard its name even though the words came out different.
    const detectorHeard = !heardName && typeof wake === 'number' && wake >= this.nameThreshold;
    if (detectorHeard) log.debug(`${name}: the name detector heard my name (${wake.toFixed(2)}) though the words didn't show it`);
    const addressed = Boolean(cut) || interrupted || heardName || detectorHeard;
    // Judged by when they spoke, not by now: a line that started after they
    // finished wasn't talked over.
    const spokeAt = typeof startedAt === 'number' ? startedAt : now;
    // When they stopped talking, when the sentence was closed, and when its words came
    // back: for timing how long they wait for an answer to start.
    const timing = { spokeUntil: typeof spokeUntil === 'number' ? spokeUntil : null, endedAt: typeof at === 'number' ? at : null, heardAt: now };
    const overIt = typeof startedAt === 'number' && Boolean(this.speaker.wasAudibleBetween?.(startedAt, spokeUntil ?? at ?? now));
    this.noteJokeReaction({ userId, text, spokeAt, until: spokeUntil ?? at ?? now, addressed, toMe: heardName });

    if (addressed && isStopCommand(text, aliases)) {
      log.info(`${name} told me to stop`);
      this.shush();
      return 'stop';
    }
    // Singing a song someone asked for: only "skip it" or "stop" (with its name) stops it.
    if (this.singing()) {
      if (addressed && isSkipSong(text, aliases)) {
        log.info(`${name} wanted the song stopped`);
        this.shush({ fromThem: false });
        return 'stop';
      }
      return 'singing';
    }
    // A song it's still making (or about to play): "cancel the song", "never mind" call it
    // off. The answer to them goes ahead (it says okay).
    if (addressed && (this.songWaiting || this.isMakingSong()) && isCancelSong(text, aliases)) {
      log.info(`${name} called off the song`);
      this.cancelSong('asked');
    }
    // The group cracking up at something: now and then it laughs along.
    if (!addressed && reactionTo(text) === 'laugh') this.noteLaugh({ userId, name, text });
    // Only its name, and Whisper was far from sure of it (often noise): this changes nothing yet.
    const maybeNoise = unsureName && heardName && !cut && !interrupted && isJustCallingIt(text, aliases);
    // Someone wants an answer: no unprompted jokes first.
    if (addressed && !maybeNoise) this.dropUnprompted();
    // (Only the detector heard its name in a word or two: a "Yeah?" can't be taken back, so it must be surer.)
    const detectorSure = detectorHeard && wake >= Math.min(0.97, this.nameThreshold + DETECTOR_ONLY_MARGIN);
    const justCalling = isJustCallingIt(text, aliases) || (detectorSure && normalizeWords(text).length <= 2);
    // Paused for them and they said "wait" or just its name: stop and listen for the rest.
    if (interrupted && justCalling && (isHoldOn(text) || heardName)) {
      log.info(`${name} wants to say more, so I'm listening`);
      this.listenFor(userId, id, { stopTalking: false }); // (it already stopped)
      this.engagedUntil = 0;
      return 'listening';
    }
    if (addressed && justCalling && !interrupted) {
      // Only its name, and Whisper was far from sure of it: in live calls that was
      // mostly noise coming out as its name. No "Yeah?" and no stopping: if they
      // really called, what they say next is for it, and a second call gets the "Yeah?".
      if (maybeNoise) {
        log.info(`${name} may have called me (not sure), so I'm listening without a reply`);
        this.listenFor(userId, id, { stopTalking: false, unsure: true });
        return 'listening-quietly';
      }
      // Only its name ("Gremlin!", "hey Gremlin", "Gremlin, wait"): whatever they
      // say next is for it too, even without the name.
      if (overIt || exactCut || isHoldOn(text)) {
        // Said over it, or "wait": stop and let them say the rest.
        log.info(`${name} called me, so I'm listening`);
        this.listenFor(userId, id, { stopTalking: true });
        return 'listening';
      }
      // It was quiet (or they're calling again): a quick "Yeah?", then it listens.
      // Their next sentence gets the real answer. Anyone else's answer still goes ahead.
      this.listenFor(userId, id, { stopTalking: false });
      this.acknowledge(name, userId, timing);
      return 'acknowledged';
    }
    if (addressed) {
      // Saying its name over it takes the floor: stop talking, drop whatever was
      // about to be said, and answer this. The reply sees everything said so far,
      // and also covers anyone whose answer got dropped.
      if (exactCut || (overIt && !cut)) this.yieldFloor({ carry: true });
      // The rest of what they said after a bare "Gremlin!" (finished by now): only the
      // "Yeah?" gives way. Anyone else's answer still plays.
      else if (cut === 'next') this.speaker.stopKind?.('ack');
      // "Gremlin, you don't have to respond to everything": from now on only when called (this still gets its answer).
      if (asksToTalkLess(text, { aliases, people: this.peopleNames() })) this.talkLess(name);
      let info = { name, userIds: userId ? [userId] : [], timing };
      // The sentence after a bare "Gremlin!" is almost always for it, but if the call
      // was misheard it may not be: then the reply may pass on a line clearly for someone else.
      // The same goes for one only the name detector caught, and for whatever the person
      // it was answering said over that answer.
      if (cut === 'next' || cut === 'next-unsure' || interrupted || (detectorHeard && !cut) || (cut === 'exact-unsure' && !heardName)) info.afterCall = true;
      // After a call it wasn't sure of, they may not have been calling it at all.
      if (cut === 'next-unsure' && !heardName && !detectorHeard) info.unsureCall = true;
      // The owner asking it to look at their screen.
      if (userId && this.config.screenLooks !== false && this.isOwner(userId) && asksToLook(text, aliases)) info.look = true;
      // Asking again before hearing the answer to their last question: one answer for both.
      const earlier = this.takeBackAnswerFor(userId, { onlyCheap: true });
      if (earlier) info = mergeAsks(earlier, info);
      if (userId) this.asks.set(userId, { userId, at: now, until: spokeUntil ?? at ?? now, restarts: 0 });
      this.request('direct', info);
      return 'direct';
    }
    // They paused mid-question (or mid-reply to it) and kept going: answer all of it.
    if (this.continuesAsk({ userId, text, startedAt, until: spokeUntil ?? at ?? now, timing })) return 'continued';
    // "Alright guys, I'm heading out": a quick bye (even mid-conversation with someone else;
    // from the one it's talking with, it's their reply, and the reply covers it).
    const replyingToIt = Boolean(userId && this.talkingWith.has(userId)) && this.mightBeReplyTo(spokeAt);
    if (!replyingToIt && isGoodbye(text) && this.maybeSayBye({ userId, name })) return 'farewell';
    // They started talking while it's in a conversation (after it spoke, before the window closed).
    if (this.mightBeReplyTo(spokeAt)) {
      // "Nobody asked you" right after its line: it takes the hint, without a word.
      if (asksToTalkLess(text, { aliases, people: this.peopleNames() })) {
        this.talkLess(name);
        return 'talk-less';
      }
      // "Errm." on its own isn't a reply yet: what they say next is.
      if (isJustHesitation(text)) return 'hesitating';
      const partner = Boolean(userId && this.talkingWith.has(userId));
      const onlyOne = this.onlyOneTalking(userId);
      const asked = asksSomething(text, aliases);
      // Asked to butt in less: only the person it was answering, asking it something, still gets a reply.
      if (this.talkingLess() && !(partner && asked)) return 'talking-less';
      const info = {
        name,
        spokeAt,
        timing,
        userIds: userId ? [userId] : [],
        // Clues for the quick check: the person it was just talking with, or the only one talking,
        // and whether they asked it something.
        partner,
        onlyOne,
        asked,
      };
      // If they keep going right after this sentence, that's more of the same reply.
      const prev = userId ? this.asks.get(userId) : null;
      const questionOpen = prev && (prev.kind || 'direct') === 'direct' && this.answerUnheardFor(userId);
      if (userId && !questionOpen) this.asks.set(userId, { userId, at: now, until: spokeUntil ?? at ?? now, restarts: 0, kind: 'followup' });
      this.request('followup', info);
      return 'followup';
    }
    this.maybeScheduleQuip();
    return 'heard';
  }

  /**
   * Go quiet right now and throw away anything that was about to be said.
   * carry: someone else took the floor, so whoever was still waiting on an answer
   * gets it in the next reply (instead of never).
   */
  yieldFloor({ carry = false } = {}) {
    if (carry) this.keepOwed();
    else this.owed = null;
    this.epoch++;
    this.pending = null;
    this.queuedRoasts = [];
    clearTimeout(this.lullTimer);
    this.clearPause(); // whatever it paused is being stopped too
    // The transcript shows right away what was heard of anything cut off (the next reply is written now).
    for (const l of [...this.transcript.lines]) if (l.isBot && l.open) l.reply?.cutOff();
    if (this.inflight) {
      // Forget it now rather than when it finishes failing, so the next reply starts right away.
      this.inflight.ac.abort();
      this.inflight = null;
    }
    this.speaker.stop();
  }

  /**
   * Someone started a sentence. If it's the person it's answering, it watches whether
   * they're talking over it, and if they keep at it, pauses to listen.
   */
  speechStarted(userId, id) {
    if (this.closed || this.paused || !userId || this.config.listen?.talkOverPause === false) return;
    if ((this.echoPauses.get(userId) ?? 0) >= ECHO_PAUSES_MAX) return;
    const line = this.answeringNow(userId);
    if (!line) return;
    clearInterval(this.talkOverTimer);
    const since = this.clock();
    const stop = () => {
      clearInterval(this.talkOverTimer);
      this.talkOverTimer = null;
    };
    this.talkOverTimer = setInterval(() => {
      if (this.closed || this.paused || this.clock() - since > TALK_OVER_WATCH_MS) return stop();
      // A short sound that ended (a cough, "ha"), or the answer is over: nothing to do.
      if (!this.isSpeaking(userId) || !line.open) return stop();
      const talked = this.voicedMs ? this.voicedMs(userId) : this.clock() - since;
      if (talked < TALK_OVER_MS) return;
      // Only that answer is paused (between its sentences, it tries again on the next tick).
      if (this.speaker.nowPlaying?.()?.tag?.line !== line || !this.speaker.pause?.()) return;
      stop();
      this.paused = { userId, fromId: id ?? 0, at: this.clock(), quietSince: null, line };
      log.debug('the person I was answering started talking, so I paused to listen');
      clearInterval(this.pauseWatch);
      this.pauseWatch = setInterval(() => this.checkPaused(), 200);
    }, 100);
  }

  /** The answer to this person it has started saying and isn't done with (playing, paused or between sentences). */
  answeringNow(userId) {
    for (let i = this.transcript.lines.length - 1; i >= 0; i--) {
      const l = this.transcript.lines[i];
      if (l.isBot && l.open && l.heard && TALK_OVER_KINDS.has(l.kind) && l.info?.userIds?.includes(userId)) return l;
    }
    return null;
  }

  /**
   * Words of what it was saying when it paused for them, played back through their mic:
   * 0 (no), 1 (two words in a row from it), 2 (three or more). Only what had started
   * playing counts, never a single word ("what?", "no" are them).
   */
  pausedEchoStrength(text) {
    const parts = this.paused?.line?.reply?.parts;
    if (!parts || isJustAReaction(text)) return 0;
    const said = normalizeWords(text);
    if (said.length < 2 || said.length > 12) return 0;
    const heard = parts.filter((p) => p.started).slice(-2).map((p) => p.text).join(' ');
    if (!` ${normalizeWords(heard).join(' ')} `.includes(` ${said.join(' ')} `)) return 0;
    return said.length >= 3 ? 2 : 1;
  }

  /** How many times this person's mic has played its own voice back. */
  echoesFrom(userId) {
    return this.echoes.get(userId) ?? 0;
  }

  /**
   * They opted out mid-call: what they said so far, and its answers to them, leave the
   * transcript and the call's notes, and an answer to them that's on its way is dropped.
   */
  forgetSpeaker(userId) {
    if (!userId) return;
    const forThem = (info) => Boolean(info?.userIds?.includes(userId));
    if (forThem(this.inflight?.info) || forThem(this.pending?.info) || this.transcript.lines.some((l) => l.isBot && l.open && forThem(l.info))) {
      this.yieldFloor();
    }
    this.transcript.lines = this.transcript.lines.filter((l) => l.userId !== userId && !(l.isBot && forThem(l.info)));
    this.cutIns.delete(userId);
    this.asks.delete(userId);
    this.talkingWith.delete(userId);
    if (this.owed) this.owed.userIds = this.owed.userIds.filter((u) => u !== userId);
    this.callNotes?.forgetSpeaker?.(userId);
  }

  /** While paused: gives up after a while, and carries on if nothing they said is coming. */
  checkPaused() {
    const p = this.paused;
    if (!p) return this.clearPause();
    const now = this.clock();
    // The paused line ended some other way (stopped, or the speaker gave up on it).
    if (!this.speaker.nowPlaying?.()?.paused) return this.clearPause();
    if (now - p.at >= PAUSED_MAX_MS) {
      // They're saying something long: drop the answer, and answer what they said when it's in.
      this.stopPaused('they kept talking');
      this.cutShort = { userId: p.userId, fromId: p.fromId, at: now };
      return;
    }
    if (this.isSpeaking(p.userId) || this.isHearingFrom(p.userId)) {
      p.quietSince = null;
      return;
    }
    p.quietSince ??= now;
    if (now - p.quietSince >= RESUME_AFTER_QUIET_MS) this.resumePaused('nothing came of it');
  }

  /** Carries on with the paused answer. */
  resumePaused(reason) {
    if (!this.paused) return;
    this.clearPause();
    if (this.speaker.resume?.()) log.debug(`carried on with my answer (${reason})`);
  }

  /** Drops the paused answer (and anything else it was about to say): they want something else answered. */
  stopPaused(reason) {
    if (!this.paused) return;
    log.debug(`dropped the rest of my answer (${reason})`);
    this.yieldFloor({ carry: true });
  }

  clearPause() {
    this.paused = null;
    clearInterval(this.pauseWatch);
    clearInterval(this.talkOverTimer);
    this.pauseWatch = null;
    this.talkOverTimer = null;
  }

  /**
   * Someone said its name while it was mid-line (caught early, before they
   * finished talking): stop and listen. That sentence (id) gets answered.
   * unsure: only the name detector heard it (not the words), so the reply may pass
   * if their sentence turns out to be for someone else.
   */
  cutIn(userId, id, { unsure = false } = {}) {
    if (this.closed) return;
    this.yieldFloor({ carry: true });
    this.engagedUntil = 0; // someone has its attention: no follow-ups to anyone else meanwhile
    this.cutIns.set(userId, { at: this.clock(), fromId: id ?? 0, exact: true, unsure });
  }

  /**
   * A quick "Yeah?" when someone calls its name, so they know it's listening. One
   * at a time: a second call right after the first (another person, or the same
   * call through someone else's mic) doesn't get its own.
   */
  acknowledge(name, userId, timing = null) {
    const now = this.clock();
    // Already talking, or about to (an answer or its hello is being written): that's sign enough.
    if ((this.speaker.committed ?? this.speaker.speaking) || this.inflight || this.pending || this.queuedRoasts.length) {
      log.debug(`${name} called me while I had something to say; listening`);
      return;
    }
    if (now - this.lastAckAt < ACK_GAP_MS) {
      log.debug(`${name} called me right after someone else; listening`);
      return;
    }
    this.lastAckAt = now;
    const choices = ACKS.filter((a) => a !== this.lastAck);
    const text = choices[Math.floor(this.random() * choices.length)] ?? ACKS[0];
    this.lastAck = text;
    const line = this.transcript.add({ name: this.config.botName, text, isBot: true });
    line.open = true;
    this.markSpoke('ack'); // someone has its attention: no follow-ups to anyone else meanwhile
    log.debug(`said "${text}" to ${name} and listened`);
    const busy = () => this.isSpeaking(userId);
    const onStart = () => {
      line.heard = true;
      const stopped = timing ? (timing.spokeUntil ?? timing.endedAt ?? timing.heardAt) : null;
      if (stopped !== null) log.debug(`quick reply ${seconds(this.clock() - stopped)} s after ${name} called`);
    };
    this.speaker.say(text, { kind: 'ack', busy, onStart }).then((outcome) => {
      this.settleLine(line, outcome, 'ack');
    });
  }

  /**
   * Its answer to someone started playing: how long after they stopped talking, and
   * where the time went (the end-of-sentence wait, the speech-to-text, Claude or Venice
   * writing the first sentence, the voice). In the log for the weekly review; the end-of-call
   * line has the median.
   */
  noteReplyTime(reply) {
    const { kind, info, sentAt } = reply;
    const t = info?.timing;
    const soundAt = reply.line?.heardAt;
    if (!t || (kind !== 'direct' && kind !== 'followup') || typeof soundAt !== 'number') return;
    const stopped = t.spokeUntil ?? t.endedAt ?? t.heardAt;
    const total = soundAt - stopped;
    if (!Number.isFinite(total) || total < 0 || total > 120000) return;
    this.replyTimes.push(total);
    if (this.replyTimes.length > 500) this.replyTimes.shift();
    const parts = [];
    if (t.spokeUntil !== null && t.endedAt !== null) parts.push(`end of sentence ${seconds(t.endedAt - t.spokeUntil)}`);
    if (t.endedAt !== null) parts.push(`hearing ${seconds(t.heardAt - t.endedAt)}`);
    if (typeof sentAt === 'number') {
      // Time spent behind its own earlier line isn't the voice being slow.
      const turnAt = typeof reply.turnAt === 'number' ? Math.min(Math.max(reply.turnAt, sentAt), soundAt) : sentAt;
      parts.push(`${reply.writer || 'Claude'} ${seconds(sentAt - t.heardAt)}`);
      if (turnAt - sentAt >= 100) parts.push(`waiting for my own line ${seconds(turnAt - sentAt)}`);
      parts.push(`voice ${seconds(soundAt - turnAt)}`);
    }
    const think = reply.job?.thinkSaid && typeof reply.job.thinkAt === 'number' ? `after a "${reply.job.thinkSaid.replace(/[.!]$/, '')}" at ${seconds(reply.job.thinkAt - stopped)} s` : '';
    const extra = [reply.searched && 'looked it up', reply.job?.saidFiller && 'after a "one sec"', think].filter(Boolean);
    log.debug(`first sound ${seconds(total)} s after ${info.name || 'they'} stopped talking (${[kind, ...extra].join(', ')}: ${parts.join(', ')})`);
  }

  /**
   * After "Gremlin!" or "Gremlin, wait": treat their next sentence as for it (and stop talking, if asked).
   * unsure: the call itself may have been noise, so that sentence may turn out not to be for it.
   */
  listenFor(userId, id, { stopTalking = true, unsure = false } = {}) {
    if (stopTalking) {
      this.yieldFloor({ carry: true });
      this.engagedUntil = 0;
    }
    this.cutIns.set(userId, { at: this.clock(), fromId: (id ?? 0) + 1, exact: false, unsure });
  }

  /**
   * 'exact' (the sentence they cut in with), 'exact-unsure' (the same, when only the
   * name detector heard the name), 'next' (the one after "Gremlin!"), 'next-unsure'
   * (the one after a "Gremlin" Whisper wasn't sure of), or false.
   */
  takeCutIn(userId, id, startedAt) {
    const c = userId ? this.cutIns.get(userId) : null;
    if (!c) return false;
    // An earlier sentence of theirs that was still being transcribed: not this one.
    if ((id ?? Infinity) < c.fromId) return false;
    this.cutIns.delete(userId);
    if (c.exact) return this.clock() - c.at < CUT_IN_MAX_MS ? (c.unsure ? 'exact-unsure' : 'exact') : false;
    return (startedAt ?? this.clock()) - c.at < LISTEN_MS ? (c.unsure ? 'next-unsure' : 'next') : false;
  }

  /** Remembers who was still waiting on an answer that's about to be thrown away. */
  keepOwed() {
    const fresh = this.owed && this.clock() - this.owed.at < OWED_MAX_MS;
    const names = new Set(fresh ? this.owed.names : []);
    const userIds = new Set(fresh ? this.owed.userIds : []);
    const add = (info) => {
      for (const n of info?.names || [info?.name]) if (n) names.add(n);
      for (const u of info?.userIds || []) userIds.add(u);
    };
    // (An answer they've started hearing isn't owed again: what they heard is in the transcript.)
    if (this.inflight?.kind === 'direct' && !this.inflight.reply?.spoke) add(this.inflight.info);
    if (this.pending?.kind === 'direct') add(this.pending.info);
    // Answers written but not heard yet.
    for (const l of this.transcript.lines) if (l.isBot && l.open && !l.heard && l.kind === 'direct') add(l.info);
    this.owed = names.size ? { names: [...names], userIds: [...userIds], at: this.clock() } : null;
  }

  /** Adds the people still owed an answer to the next one it gives. */
  withOwed(info) {
    const owed = this.owed;
    this.owed = null;
    if (!owed || this.clock() - owed.at >= OWED_MAX_MS) return info;
    const names = [...new Set([...owed.names, ...(info.names || [info.name])].filter(Boolean))];
    const userIds = [...new Set([...owed.userIds, ...(info.userIds || [])])];
    // They asked by name, so this reply can't be passed on.
    const others = names.some((n) => n !== info.name);
    return { ...info, names, userIds, afterCall: others ? false : info.afterCall, unsureCall: others ? false : info.unsureCall };
  }

  /**
   * "Gremlin, best build for... [pause] ...a support main" arrives as two sentences.
   * If the second starts soon after the question and the answer to the first half
   * hasn't started playing, start the answer over so it covers both halves. The same
   * goes for a reply to it said in pieces ("Yeah, I'm good. [pause] What about you?").
   */
  continuesAsk({ userId, text, startedAt, until, timing = null }) {
    const ask = userId ? this.asks.get(userId) : null;
    if (!ask || !userId || ask.userId !== userId || typeof startedAt !== 'number') return false;
    const kind = ask.kind || 'direct';
    // The rest of a question comes within a couple of seconds. More of a reply to it can
    // come a bit later: the reply was written without it, so it's redone if not heard yet.
    if (startedAt < ask.until || startedAt - ask.until > (kind === 'followup' ? MORE_OF_A_REPLY_MS : CONTINUE_MS)) return false;
    const words = normalizeWords(text);
    if (!words.length || words.every((w) => NOT_MORE_OF_IT.test(w))) return false;
    // Still waiting its turn: once it's written, it sees both halves anyway.
    if (this.pending?.kind === kind && this.pending.info.userIds?.includes(userId)) {
      ask.until = Math.max(ask.until, until);
      // (The wait for the answer counts from the end of the latest piece.)
      if (timing) this.pending.info = { ...this.pending.info, timing };
      if (kind === 'followup') {
        const asked = this.pending.info.asked || asksSomething(text, this.config.botAliases);
        this.pending.info = { ...this.pending.info, spokeAt: Math.max(this.pending.info.spokeAt ?? 0, startedAt), asked };
      }
      return true;
    }
    if (ask.restarts >= MAX_RESTARTS) return false;
    let earlier = this.takeBackAnswerFor(userId, { since: ask.at, kind });
    if (!earlier) return false;
    log.debug(kind === 'followup' ? 'they kept going after a pause; replying to all of it' : 'they kept going after a pause; answering the whole question');
    ask.restarts++;
    ask.at = this.clock();
    ask.until = Math.max(ask.until, until);
    // The reply taken back may already have marked when it last spoke: what counts now is
    // when they said the latest piece (after that line, which nobody heard).
    if (kind === 'followup') earlier = { ...earlier, spokeAt: Math.max(earlier.spokeAt ?? 0, startedAt), asked: earlier.asked || asksSomething(text, this.config.botAliases) };
    if (timing) earlier = { ...earlier, timing };
    this.request(kind, earlier);
    return true;
  }

  /**
   * Drops the answer to this person's question if it isn't playing yet (being
   * written, or written and waiting), and returns who it was for, so one new answer
   * can cover it. since: only an answer started at or after this time. onlyCheap:
   * leave alone an answer that's been in the works a while or looked something up
   * (starting it over would cost another search and keep them waiting longer).
   */
  takeBackAnswerFor(userId, { since = -Infinity, onlyCheap = false, kind = 'direct' } = {}) {
    if (!userId) return null;
    const theirs = (info, at) => Boolean(info?.userIds?.includes(userId)) && at >= since;
    const line = this.transcript.lines.find((l) => l.isBot && l.open && l.kind === kind && theirs(l.info, l.askedAt));
    if (line?.heard) return null; // it's already answering out loud
    if (line && onlyCheap && line.searched) return null;
    let job = this.inflight?.kind === kind && theirs(this.inflight.info, this.inflight.startedAt) ? this.inflight : null;
    if (job && onlyCheap && this.clock() - job.startedAt >= RETHINK_MAX_MS) job = null;
    if (!line && !job) return null;
    if (job) {
      job.ac.abort();
      this.inflight = null;
    }
    line?.takeBack?.();
    // Off the transcript right away: the new answer is written now and mustn't see it as said.
    line?.reply?.cutOff();
    return mergeAsks(line?.info, job?.info);
  }

  /** An answer to their question is still on its way (being written, waiting, or written and not heard yet). */
  answerUnheardFor(userId) {
    const theirs = (info) => Boolean(info?.userIds?.includes(userId));
    if ((this.inflight?.kind === 'direct' && theirs(this.inflight.info)) || (this.pending?.kind === 'direct' && theirs(this.pending.info))) return true;
    return this.transcript.lines.some((l) => l.isBot && l.open && !l.heard && l.kind === 'direct' && theirs(l.info));
  }

  /**
   * Told to butt in less ("you don't have to respond to everything", "nobody asked you"):
   * for a while no jokes, no laughing along, and no replies to lines without its name
   * (except when the person it's answering asks it something).
   */
  talkLess(name) {
    const already = this.talkingLess();
    this.talkLessUntil = this.clock() + TALK_LESS_MS;
    // Whatever it was about to chime in with goes, except a reply to the person it was
    // answering who asked it something.
    const keep = (kind, info) => kind === 'followup' && Boolean(info?.partner && info?.asked);
    clearTimeout(this.lullTimer);
    if (this.pending && UNPROMPTED.has(this.pending.kind) && !keep(this.pending.kind, this.pending.info)) this.pending = null;
    if (this.inflight && UNPROMPTED.has(this.inflight.kind) && !keep(this.inflight.kind, this.inflight.info)) {
      this.inflight.ac.abort();
      this.inflight = null;
    }
    this.speaker.dropOptional?.((item) => keep(item.tag?.line?.kind, item.tag?.line?.info));
    if (!already) log.info(`${name} asked me to butt in less, so for ${TALK_LESS_MS / 60000} minutes I only answer when someone says my name`);
  }

  talkingLess() {
    return this.clock() < this.talkLessUntil;
  }

  /** Someone wants an answer: cancel jokes and follow-ups it was about to make. */
  dropUnprompted() {
    clearTimeout(this.lullTimer);
    if (this.pending && UNPROMPTED.has(this.pending.kind)) this.pending = null;
    if (this.inflight && UNPROMPTED.has(this.inflight.kind)) {
      this.inflight.ac.abort();
      this.inflight = null;
    }
    this.speaker.dropOptional?.();
  }

  /** True while an answer someone asked for is being written or waiting its turn. */
  answerOwed() {
    const asked = (k) => k === 'direct' || k === 'roast';
    return asked(this.inflight?.kind) || asked(this.pending?.kind) || this.queuedRoasts.length > 0;
  }

  /**
   * Whether an unprompted line still makes sense right now. Checked when it's
   * requested, again when it leaves the queue, and again just before speaking.
   */
  stillWanted(kind, info) {
    const p = this.quipPacing();
    if (kind === 'quip') return Boolean(p) && this.clock() - this.lastBotLineAt >= p.cooldownMs && this.clock() - this.lastJokeAt >= p.jokeGapMs && !this.answerOwed() && !this.singing() && !this.talkingLess();
    if (kind === 'welcome' || kind === 'farewell') return Boolean(CHATTINESS[this.chattiness]) && !this.answerOwed() && !this.singing() && !this.songWaiting;
    // Judged by when they started talking (their transcript can arrive after the window closes).
    if (kind === 'followup') return this.mightBeReplyTo(info?.spokeAt ?? this.clock());
    return true;
  }

  /**
   * Whether a line they started saying (at spokeAt) may be a reply to it: it began
   * after its latest line, while the conversation window was open. Lines from
   * before its latest line were already answered, or the moment has passed (more
   * from the person it's replying to, before that reply is heard, is handled by
   * continuesAsk).
   */
  mightBeReplyTo(spokeAt) {
    return Boolean(CHATTINESS[this.chattiness]) && spokeAt > this.lastBotLineAt && spokeAt < this.engagedUntil;
  }

  /** They're the only one who has talked lately (or the only one in the call): a one-on-one with it. */
  onlyOneTalking(userId) {
    if (!userId) return false;
    const people = this.getCallInfo?.()?.people;
    if (Array.isArray(people) && people.length === 1) return true;
    const since = this.clock() - ONE_ON_ONE_MS;
    const talkers = new Set();
    for (const l of this.transcript.lines) if (!l.isBot && l.userId && l.at >= since) talkers.add(l.userId);
    // (Just after it joined, nobody else talking yet proves little: they must be the one it's talking with.)
    return talkers.size === 1 && talkers.has(userId) && (this.talkingWith.has(userId) || this.clock() - this.listeningSince >= ONE_ON_ONE_MS);
  }

  /** The sentence a cut-in (or a pause) was waiting for came back empty or as an echo: forget it. */
  dropCutIn(userId, id) {
    const c = userId ? this.cutIns.get(userId) : null;
    if (c?.exact && (id ?? Infinity) >= c.fromId) this.cutIns.delete(userId);
    // It paused for them, and what they said came to nothing: carry on (unless more of theirs is on its way).
    const p = this.paused;
    if (userId && p?.userId === userId && (id ?? Infinity) >= p.fromId && (id === p.fromId || !this.isHearingFrom(userId))) {
      this.resumePaused('nothing came of it');
    }
  }

  /**
   * A sound from them too short to be a sentence. Only if it's the very sentence a
   * cut-in or a pause was waiting on does it end the wait (a later breath or click
   * mustn't, while the real sentence is still being transcribed).
   */
  soundIgnored(userId, id) {
    const c = userId ? this.cutIns.get(userId) : null;
    if (c?.exact && id === c.fromId) this.cutIns.delete(userId);
    if (userId && this.paused?.userId === userId && id === this.paused.fromId) this.resumePaused('it was only a short sound');
  }

  /** Its own lines from the last few seconds, which someone's mic might pick up (its short sounds too). */
  recentLines({ spokeAt } = {}) {
    const now = this.clock();
    this.soundEchoes = this.soundEchoes.filter((e) => e.until === null || now - e.until < SOUND_ECHO_MS);
    // (When it's known when they started talking: only the sounds playing then, or just before.)
    const sounds = typeof spokeAt === 'number' ? this.soundEchoes.filter((e) => spokeAt >= e.from - 300 && spokeAt <= (e.until ?? now) + SOUND_ECHO_SLACK_MS) : this.soundEchoes;
    return [...this.transcript.recentBotLines(ECHO_WINDOW_MS).map((l) => l.text), ...sounds.map((e) => e.text)];
  }

  /**
   * Says one of its short sounds ("Hmm.", a laugh), which isn't a line in the conversation.
   * Once it starts playing it counts as its own voice for a mic to pick up (briefly).
   */
  saySound(text, kind, onStart) {
    const e = { text: String(text).replace(/\[[^\]]{0,40}\]/g, ' ').replace(/\s+/g, ' ').trim(), from: null, until: null };
    return this.speaker
      .say(text, {
        kind,
        onStart: () => {
          e.from = this.clock();
          if (e.text) this.soundEchoes.push(e);
          onStart?.();
        },
      })
      .then((outcome) => {
        e.until = this.clock();
        return outcome;
      });
  }

  /** It's singing (or introducing) a song someone asked for. */
  singing() {
    const k = this.speaker.nowPlaying?.()?.kind;
    return k === 'song' || k === 'intro';
  }

  /** True when what someone "said" is really its own voice coming through their mic. */
  isOwnEcho(text) {
    return this.ownEchoStrength(text) > 0;
  }

  /** 0: not its own voice; 1: a short line of its own word for word ("Yeah?"); 2: a run of its words. */
  ownEchoStrength(text, { spokeAt } = {}) {
    const lines = this.recentLines({ spokeAt });
    if (!lines.length) return 0;
    // It hasn't said its own name lately, so a line with its name in it came from a person
    // (who may be quoting it back: "Gremlin, the shotgun is NOT the best gun").
    const aliases = this.config.botAliases;
    if (isAddressed(text, aliases) && !lines.some((l) => isAddressed(l, aliases))) return 0;
    // Joined too, for an echo that runs from the end of one line into the next.
    if (lines.some((l) => isEchoOf(text, l)) || isEchoOf(text, lines.join(' '))) return 2;
    // A short line of its own ("Yeah?") picked up word for word.
    const said = normalizeWords(text).join(' ');
    return said && lines.some((l) => normalizeWords(l).join(' ') === said) ? 1 : 0;
  }

  /** "Gremlin, shut up": stop now, and don't treat the next lines as replies to it. */
  shush({ fromThem = true } = {}) {
    // (/shush in the middle of a joke, or right after it, is a verdict on the joke. A channel
    // move isn't, and neither is a stop aimed at a line it said after the joke.)
    if (fromThem && this.jokeOpen() && this.joke.closedAt === null) this.joke.boos++;
    this.yieldFloor();
    this.engagedUntil = 0;
    this.cutIns.clear();
    this.queuedRoasts = [];
    // A hi that was about to be said, and a song still being made, are called off too.
    clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
    this.welcomeQueue.clear();
    this.cancelSong('stop');
  }

  /** Calls off a song that's being made, or is made and waiting for a quiet moment to play. */
  cancelSong(why) {
    this.songCancels++;
    this.onCancelSong?.(why);
  }

  setChattiness(level) {
    this.chattiness = level;
    this.talkLessUntil = 0; // someone set how chatty it should be: that's the word now
    if (!CHATTINESS[level]) clearTimeout(this.lullTimer);
  }

  greet() {
    this.request('greet', {});
  }

  roast({ target, requester }) {
    this.request('roast', { target, requester });
  }

  /** Make the bot say exact words (used by /say). */
  sayExactly(text) {
    const line = this.transcript.add({ name: this.config.botName, text, isBot: true });
    line.open = true;
    this.markSpoke('say');
    return this.speaker.say(text, { kind: 'say', onStart: () => (line.heard = true) }).then((outcome) => {
      this.settleLine(line, outcome, 'say');
      return outcome;
    });
  }

  /**
   * A reminder someone asked for went off: said at the next pause (it waits a few
   * seconds at most, then says it anyway). If the voice fails, it's posted in text.
   */
  sayReminder(text) {
    if (this.closed || !String(text ?? '').trim()) return Promise.resolve({ outcome: 'dropped', heard: false });
    const line = this.transcript.add({ name: this.config.botName, text, isBot: true });
    line.open = true;
    this.markSpoke('reminder');
    // (It often names what they wanted reminding of: the words only with transcripts on.)
    log.info(this.config.logTranscripts ? `reminder: "${text}"` : 'a reminder went off; saying it');
    // Resolves to how it went, and whether any of it was heard (if not, it's posted in text instead).
    return this.speaker.say(text, { kind: 'reminder', onStart: () => (line.heard = true) }).then((outcome) => {
      const heard = Boolean(line.heard);
      this.settleLine(line, outcome, 'reminder');
      return { outcome, heard };
    });
  }

  /** Keeps the transcript honest about lines that were cut off or never said. */
  settleLine(line, outcome, kind) {
    line.open = false;
    line.until = this.clock();
    // What people heard it say, for the phrases it leans on (not a "Yeah?", /say, a reminder or a song).
    if ((outcome === 'played' || outcome === 'failed' || line.heard) && SAID_KINDS.has(kind)) {
      this.saidCount++;
      this.saidThisCall.push(line.text);
      if (this.saidThisCall.length > SAID_KEPT) this.saidThisCall.shift();
    }
    if (kind === 'quip') this.jokeEnded(line, outcome);
    if (outcome === 'played' && (kind === 'direct' || kind === 'followup')) this.learnFromAnswer(line);
    if (outcome === 'played') {
      // The comeback window starts when people have actually heard the answer (or the hello).
      if ((kind === 'direct' || kind === 'roast' || kind === 'followup' || kind === 'greet' || kind === 'welcome' || kind === 'song') && this.engagedUntil > 0) {
        this.engagedUntil = Math.max(this.engagedUntil, this.clock() + (CHATTINESS[this.chattiness]?.engagedMs ?? 0));
      }
      return;
    }
    // 'failed' lines were posted in the text channel instead, so they were seen.
    if (outcome === 'failed') return;
    if (line.heard) line.text = `${line.text} (got cut off here)`;
    else {
      this.unmarkSpoke(line);
      // A joke nobody heard doesn't count toward the gap between jokes (unless another came since).
      if (kind === 'quip' && line.before && line.jokeAt === this.lastJokeAt) this.lastJokeAt = line.before.lastJokeAt;
      this.transcript.remove(line);
    }
  }

  /**
   * An answer was heard: what it said, and the lines from them it was answering (since
   * its previous line, and from just before they asked), go to learn words the
   * speech-to-text spelled differently.
   */
  learnFromAnswer(line) {
    const ids = new Set(line.info?.userIds || []);
    if (!this.learnWords || !ids.size) return;
    const lines = this.transcript.lines;
    const from = (line.askedAt ?? line.at) - LEARN_FROM_MS;
    const heard = [];
    for (let i = lines.indexOf(line) - 1; i >= 0 && heard.length < 4; i--) {
      if (lines[i].isBot || lines[i].at < from) break;
      if (ids.has(lines[i].userId)) heard.push(lines[i].text);
    }
    // Names of things it brought up itself just before ("adobo", when someone then said
    // "Adolfo"): its spelling may be the one that's off, so they aren't learned from this.
    const asked = line.askedAt ?? line.at;
    const own = lines.filter((l) => l.isBot && l !== line && l.at >= asked - OWN_WORDS_MS && l.at < asked).map((l) => l.text);
    const ownWords = [...new Set(own.flatMap((t) => normalizeWords(t).map((w) => w.replace(/'s$/, ''))).filter((w) => w.length >= 3))];
    if (heard.length) this.learnWords(line.text, heard.reverse(), ownWords.length ? { ownWords } : undefined);
  }

  /** A line nobody heard: if nothing was said after it, the conversation is back where it was. */
  unmarkSpoke(line) {
    const b = line.before;
    if (!b || b.seq !== this.spokeSeq || !TALK_OVER_KINDS.has(line.kind)) return;
    this.lastBotLineAt = b.lastBotLineAt;
    this.engagedUntil = b.engagedUntil > 0 ? Math.max(b.engagedUntil, this.engagedUntil) : 0;
    this.followupsInARow = b.followupsInARow;
    this.talkingWith = b.talkingWith;
  }

  markSpoke(kind, info = null) {
    const now = this.clock();
    // A bye to someone leaving changes nothing about the conversation (or the joke before it).
    if (kind === 'farewell') return;
    // A hi to someone who just joined changes nothing until it's heard (see welcomeHeard).
    if (kind === 'welcome') return;
    // Another line of its own: reactions from here on are about that line, not the joke.
    if (kind !== 'quip' && this.joke && this.joke.closedAt === null) this.joke.closedAt = now;
    this.spokeSeq++;
    this.lastBotLineAt = now;
    if (kind === 'quip') this.lastJokeAt = now;
    // Answering someone (or saying hi on joining, or to someone who joined, or a song
    // someone asked for) opens a window for replies without its name (extended once the
    // line has finished playing). Each follow-up keeps the conversation going, up to the
    // chattiness level's limit in a row (more in a one-on-one); jokes, /say and a "Yeah?" close it.
    // (A follow-up handed on to a full answer is still one of the replies in a row.)
    const handedOn = kind === 'direct' && Boolean(info?.fromFollowup);
    const opens = (kind === 'direct' && !handedOn) || kind === 'roast' || kind === 'greet' || kind === 'song';
    if (opens) this.followupsInARow = 0;
    else if (kind === 'followup' || handedOn) this.followupsInARow++;
    const level = CHATTINESS[this.chattiness];
    const limit = info?.onlyOne ? Math.max(ONE_ON_ONE_FOLLOWUPS, level?.followups ?? 0) : (level?.followups ?? 0);
    const keepsGoing = (kind === 'followup' || handedOn) && this.followupsInARow < limit;
    const talking = opens || keepsGoing;
    this.engagedUntil = talking && level ? now + level.engagedMs : 0;
    if (kind === 'direct' || kind === 'followup' || kind === 'song') this.talkingWith = new Set(info?.userIds || []);
    else if (kind === 'roast' || kind === 'greet' || kind === 'quip') this.talkingWith = new Set();
  }

  /**
   * Its hi to someone who just joined started playing: it brings them into the conversation
   * without ending the one going on (a reply already on its way from someone else still counts).
   */
  welcomeHeard(info) {
    const level = CHATTINESS[this.chattiness];
    if (level) this.engagedUntil = Math.max(this.engagedUntil, this.clock() + level.engagedMs);
    this.talkingWith = new Set([...this.talkingWith, ...(info?.userIds || [])]);
  }

  /** The chattiness level's waits between jokes, stretched or shortened by how its jokes have been landing. */
  quipPacing() {
    const p = CHATTINESS[this.chattiness];
    if (!p) return null;
    const f = this.config.jokeTuning === false ? 1 : this.jokeTuning.factor();
    return { ...p, cooldownMs: Math.round(p.cooldownMs * f), checkEveryMs: Math.round(p.checkEveryMs * f), jokeGapMs: Math.round(p.jokeGapMs * f) };
  }

  /** A joke of its own is on its way out: once it plays, what people do next is how it went. */
  jokeStarted(line) {
    this.finishJoke({ cutShort: true });
    this.joke = { line, endedAt: null, closedAt: null, laughs: 0, boos: 0, talkedOver: 0, timer: null };
  }

  /** The joke is over (played, or cut off): reactions still count for a few seconds. One nobody heard doesn't count. */
  jokeEnded(line, outcome = 'played') {
    const j = this.joke;
    if (!j || j.line !== line || j.endedAt !== null) return;
    if (!line.heard) {
      this.joke = null;
      return;
    }
    j.played = outcome === 'played'; // heard all the way through
    // It called back to a joke from an earlier call: that one rests a while.
    for (const old of line.callbacks || []) if (callsBackTo(line.text, old)) this.onCallbackUsed?.(old);
    j.endedAt = this.clock();
    j.timer = setTimeout(() => this.finishJoke(), JOKE_WINDOW_MS);
    j.timer.unref?.();
  }

  /** A joke is playing, or just ended. */
  jokeOpen() {
    const j = this.joke;
    return Boolean(j?.line.heard) && (j.endedAt === null || this.clock() - j.endedAt <= JOKE_WINDOW_MS);
  }

  /**
   * Someone said something while its joke played or right after: a laugh, a "shut up",
   * or talking over it. toMe: they said its name. addressed: it took the line as for it.
   */
  noteJokeReaction({ userId, text, spokeAt, until, addressed = false, toMe = false }) {
    const j = this.joke;
    if (!j || !this.jokeOpen() || spokeAt < (j.line.heardAt ?? Infinity)) return;
    // Started after it moved on to another line of its own: that's about that line.
    if (j.closedAt !== null && spokeAt >= j.closedAt) return;
    // Its own voice: a mic that has played it back before, or a run of the joke's own words.
    const words = normalizeWords(text);
    if ((userId && this.echoesFrom(userId) > 0) || (words.length >= 2 && longestCommonRun(text, j.line.text) === words.length)) return;
    const r = reactionTo(text, { toMe });
    const during = spokeAt < (j.endedAt ?? Infinity);
    if (r === 'laugh') {
      if (!(during && LAUGHS_ITSELF.test(j.line.text))) j.laughs++;
    } else if (r === 'boo') {
      j.boos++;
    } else if (!addressed) {
      // Talking over it for a while (judged by when they spoke, not when the words arrived).
      const overlap = Math.min(until, j.endedAt ?? this.clock()) - Math.max(spokeAt, j.line.heardAt);
      if (overlap >= TALKED_OVER_MS && this.speaker.wasAudibleBetween?.(spokeAt, until)) j.talkedOver++;
    }
  }

  /**
   * Counts how the last joke went, once its few seconds are up. cutShort: it left, or
   * another joke started, before then (a joke with no reaction yet then isn't counted).
   */
  finishJoke({ cutShort = false } = {}) {
    const j = this.joke;
    if (!j) return;
    clearTimeout(j.timer);
    this.joke = null;
    const tuning = this.config.jokeTuning !== false;
    const keepLaughs = this.config.jokeCallbacks !== false && Boolean(this.onJokeLanded);
    if ((!tuning && !keepLaughs) || !j.line.heard) return;
    if (cutShort && !j.laughs && !j.boos && !j.talkedOver) return;
    const outcome = jokeOutcome(j);
    // One that got a laugh (and was heard all the way through) is kept, to call back to in a later call.
    if (outcome === 'laughed' && keepLaughs && j.played) this.onJokeLanded(j.line.text);
    if (!tuning) return;
    const t = this.jokeTuning;
    const was = t.factor();
    t.record(outcome);
    const now = t.factor();
    const change = now < was - 0.005 ? 'jokes a bit more often now' : now > was + 0.005 ? 'jokes a bit less often now' : 'no change';
    log.info(`joke: ${outcome} (${change}; waits x${now.toFixed(2)}${t.choosy() ? ', only really good ones' : ''})`);
    this.onJokes(t.toJSON());
  }

  maybeScheduleQuip() {
    const p = this.quipPacing();
    if (!p || this.singing() || this.talkingLess()) return;
    const now = this.clock();
    if (now - this.lastBotLineAt < p.cooldownMs) return;
    if (now - this.lastJokeAt < p.jokeGapMs) return;
    if (now - this.lastQuipCheckAt < p.checkEveryMs) return;
    if (this.linesSinceCheck < p.minLines) return;
    clearTimeout(this.lullTimer);
    let retries = 0;
    const fire = () => {
      if (this.closed) return;
      if ((this.isAnyoneSpeaking() || this.isHearingSomething()) && retries++ < 6) {
        this.lullTimer = setTimeout(fire, LULL_MS);
        return;
      }
      this.lastQuipCheckAt = this.clock();
      this.linesSinceCheck = 0;
      this.request('quip', {});
    };
    this.lullTimer = setTimeout(fire, LULL_MS);
  }

  request(kind, info) {
    if (this.closed || !this.stillWanted(kind, info)) return;
    if (kind === 'direct' && this.owed) info = this.withOwed(info);
    if (this.inflight) {
      if (PRIORITY[kind] > PRIORITY[this.inflight.kind]) {
        // Something more important came in (someone said our name): drop the low-priority attempt.
        this.inflight.ac.abort();
      } else {
        this.enqueue(kind, info);
        return;
      }
    }
    this.run(kind, info);
  }

  /** Holds a request until the one being written is done. */
  enqueue(kind, info) {
    const p = this.pending;
    if (kind === 'direct' && p?.kind === 'direct') {
      // Several people asked while it was busy: one answer that handles all of them.
      this.pending = { kind, info: mergeAsks(p.info, info) };
      return;
    }
    if (kind === 'roast' && p && PRIORITY[p.kind] >= PRIORITY.roast) {
      if (this.queuedRoasts.length < ROAST_QUEUE_MAX) this.queuedRoasts.push({ info, at: this.clock() });
      return;
    }
    if (!p || PRIORITY[kind] >= PRIORITY[p.kind]) {
      // A /roast that was waiting goes after the answer instead of being lost.
      if (p?.kind === 'roast' && this.queuedRoasts.length < ROAST_QUEUE_MAX) {
        this.queuedRoasts.unshift({ info: p.info, at: this.clock() });
      }
      this.pending = { kind, info };
    }
  }

  /** The next request to run once nothing is being written. */
  takeNext() {
    if (this.pending) {
      const next = this.pending;
      this.pending = null;
      return next;
    }
    while (this.queuedRoasts.length) {
      const r = this.queuedRoasts.shift();
      if (this.clock() - r.at < ROAST_STALE_MS) return { kind: 'roast', info: r.info };
    }
    return null;
  }

  async run(kind, info) {
    const ac = new AbortController();
    const job = { kind, info, ac, startedAt: this.clock(), linesAtStart: this.transcript.count, epoch: this.epoch };
    this.inflight = job;
    // A "one sec" if a slow answer keeps them waiting. After a bare "Gremlin!" the answer
    // may turn out to be a pass, so there it comes only once a web search starts.
    const filler = kind === 'direct' && this.searchOn() && !info?.afterCall ? setTimeout(() => this.sayFiller(job), this.fillerAfterMs) : null;
    // Now and then a quick "Hmm." when a question's answer takes a moment (not after a bare
    // "Gremlin!": that answer may turn out to be a pass).
    const think = kind === 'direct' && !info?.afterCall ? this.planThinkingSound(job) : null;
    // Speaks the reply a sentence at a time while it's still being written.
    const reply = new SpokenReply(this, kind, info, job, {
      onFirst: () => {
        clearTimeout(filler);
        clearTimeout(think);
      },
    });
    job.reply = reply;
    try {
      const text = await this.generate(kind, info, ac.signal, job, reply);
      clearTimeout(filler);
      clearTimeout(think);
      if (ac.signal.aborted || this.closed || job.epoch !== this.epoch) return;

      if (text === LOOKUP) {
        // A follow-up that needs a proper answer (current facts, or something long): answer
        // it as a question by name (the main model, which can search) once this finishes.
        // (It still counts as a follow-up for how many it gives in a row.)
        this.enqueue('direct', { name: info.name, userIds: info.userIds || [], timing: info.timing, fromFollowup: true, onlyOne: info.onlyOne });
        return;
      }
      // Says whatever hasn't been said yet (all of it, when nothing came in early).
      reply.finish(text);
      if (reply.spoke && job.citations?.length) this.onSources(job.citations);
      // Reminders it agreed to are set once that answer is heard (never for one nobody heard).
      const tags = job.reminderTags;
      if (tags && reply.spoke) reply.whenHeard(() => this.onReminders?.(tags, info));
      // ...and a song someone asked for gets made once they've heard it agree to.
      const song = job.songTag;
      if (song && reply.spoke) reply.whenHeard(() => this.onSong?.(song, info));
      // ...and so does a picture.
      const image = job.imageTag;
      if (image && reply.spoke) reply.whenHeard(() => this.onImage?.(image, info));
      // ...and so are changes to the lists (and posting one).
      const lists = job.listTags;
      if (lists && reply.spoke) reply.whenHeard(() => this.onLists?.(lists, info));
    } catch (err) {
      if (ac.signal.aborted) {
        // cancelled on purpose
      } else if (err.type === 'local_rate_limit') {
        log.debug(`${kind} skipped: ${err.message}`);
      } else {
        log.warn(`${kind} reply failed: ${err.message}`);
        // Someone asked it something and it can't answer (e.g. Claude credit ran out): say so.
        if ((kind === 'direct' || kind === 'roast') && !reply.spoke) this.onReplyFailure(kind, err);
      }
    } finally {
      clearTimeout(filler);
      clearTimeout(think);
      reply.close();
      if (this.inflight === job) this.inflight = null;
      // Start the next waiting request (skipping any that no longer make sense).
      while (!this.inflight && !this.closed) {
        const next = this.takeNext();
        if (!next) break;
        this.request(next.kind, next.info);
      }
    }
  }

  /** Reminders and timers can be set (REMINDERS on, and the call can keep them). */
  remindersOn() {
    return this.config.reminders !== false && Boolean(this.onReminders);
  }

  /** Web search is on in the settings and still available (allowed for this model and account, under today's cap). */
  searchOn() {
    // (Answers written by Venice can't look things up.)
    if (this.veniceKinds.has('direct') && this.venice?.usable !== false) return false;
    return Boolean(this.config.anthropic?.webSearch?.enabled) && this.claude.canSearchNow !== false;
  }

  /**
   * Who writes this kind of line: Venice when VENICE_FOR covers it, otherwise Claude: the
   * joke model for its own jokes, the fast model for quick back-and-forth, the main one for answers.
   */
  clientFor(kind, info) {
    // (Not while Venice is turning requests down: out of credit or a bad key.)
    if (this.veniceKinds.has(kind) && this.venice?.usable !== false) return this.venice;
    return this.claudeFor(kind, info);
  }

  /** The Claude model for this kind of line. */
  claudeFor(kind, info) {
    if (kind === 'quip') return this.claudeJokes;
    // A question right after its line from the one it was talking with (or the only one
    // talking) is nearly always for it: the main model takes it. (The quick one passed on
    // "um, what was that?" and "out of those, which ones are in English?", 2026-10-29.)
    if (kind === 'followup' && info?.asked && (info.partner || info.onlyOne)) return this.claude;
    return UNPROMPTED.has(kind) ? this.claudeFast : this.claude;
  }

  /**
   * VENICE_FOR=all: Venice writes its follow-ups but replies to nearly every line after
   * its own, so Claude says first (alongside) whether this one calls for a reply at all.
   * Only a clear NO keeps it quiet; if Claude can't be asked, Venice decides.
   */
  async followupWanted(info, signal) {
    try {
      const { system, user } = followupCheck({
        botName: this.config.botName,
        name: info?.name,
        partner: info?.partner,
        onlyOne: info?.onlyOne,
        asked: info?.asked,
        transcript: formatTranscript(this.transcript.recent().slice(-12), { botName: this.config.botName, timezone: this.config.timezone }),
      });
      const res = await this.claudeFor('followup', info).createMessage({ system, user, kind: 'check', maxTokens: 5, signal, retries: 0, important: false });
      return followupCheckSaysYes(res.text);
    } catch (err) {
      if (!signal?.aborted) log.debug(`couldn't ask Claude whether to reply (${err.message}), so Venice decides`);
      return true;
    }
  }

  /**
   * A short "one sec" while a slow answer is on its way, if nobody is talking. After a
   * "Hmm." only when it starts looking something up (search), so it doesn't stack sounds.
   */
  sayFiller(job, { search = false, again = false } = {}) {
    if (this.closed || job.ac.signal.aborted || job.epoch !== this.epoch || this.inflight !== job) return;
    if (job.saidFiller || job.reply?.spoke) return;
    const searching = search || Boolean(job.reply?.searched);
    // (A "Hmm." that was said, or is about to be, stands in for it; one that was dropped doesn't.)
    if ((job.thinkSaid || job.thinkPending) && !searching) return;
    if (this.speaker.speaking || this.isAnyoneSpeaking()) {
      // Its "Hmm." is still playing: one more try once it's done.
      if (job.thinkQueued && searching && !again) {
        const t = setTimeout(() => this.sayFiller(job, { search: true, again: true }), 900);
        t.unref?.();
      }
      return;
    }
    // ("Came up empty" later only if the "one sec" was actually heard.) "Lemme look that up" only when it is.
    const choices = searching ? FILLERS : WAIT_FILLERS;
    this.speaker.say(choices[Math.floor(Math.random() * choices.length)], { kind: 'filler', onStart: () => (job.saidFiller = true) });
  }

  async buildPrompt(kind, info, job = null) {
    const cfg = this.config;
    // Only answers to people can search, so only they are told how.
    const systemOpts = {
      botName: cfg.botName,
      persona: cfg.persona,
      lore: cfg.lore,
      facts: this.getFacts(),
      earlierCalls: this.getEarlierCalls(),
      audioTags: cfg.tts.audioTags,
      webSearch: kind === 'direct' && this.searchOn(),
      // (The same for every kind of line, so they share the cached prompt.)
      reminders: this.remindersOn(),
      songs: this.songsOn(),
      maxSongSeconds: cfg.songs?.maxSeconds ?? 60,
      images: this.imagesOn(),
      lists: this.listsOn(),
    };
    const system = buildSystem(systemOpts);
    const callInfo = formatCallInfo({ ...this.getCallInfo(), now: this.clock() }, cfg.timezone);
    const transcript = formatTranscript(this.transcript.recent(), { botName: cfg.botName, timezone: cfg.timezone });
    // A look at the owner's screen, when they asked for one.
    let screen = null;
    let screenProblem = '';
    if (info?.look) {
      // Asked once more: the same look, not a new one.
      const shot = job?.shot ?? (await this.getScreenshot().catch((err) => ({ error: err.message })));
      if (job) job.shot = shot;
      if (shot?.jpeg) screen = shot;
      else screenProblem = shot?.error || "the screen couldn't be captured";
    }
    // Jokes of its own that got a laugh in earlier calls, to maybe call back to.
    const callbacks = kind === 'quip' && cfg.jokeCallbacks !== false ? (job?.callbacks ?? this.getCallbacks()) : [];
    if (job && kind === 'quip') job.callbacks = callbacks;
    const task =
      TASKS[kind]({
        ...info,
        callbacks,
        choosy: kind === 'quip' && cfg.jokeTuning !== false && this.jokeTuning.choosy(),
        botName: cfg.botName,
        lookup: this.searchOn(),
          screen: info?.look ? (screen ? 'attached' : screenProblem) : null,
      }) +
      this.openerHint() +
      this.overusedHint();
    const answering = kind === 'direct' || kind === 'followup';
    const reminders = answering && this.remindersOn() ? this.getReminders() : '';
    const songsNow = answering && this.songsOn() ? this.getSongsNow() : '';
    const imagesNow = answering && this.imagesOn() ? this.getImagesNow() : '';
    // (The lists come with the copy its item numbers refer to: kept with the job for when its changes are made.)
    const lists = answering && this.listsOn() ? this.getLists() : '';
    const listsNow = typeof lists === 'string' ? lists : (lists?.text ?? '');
    if (job && lists && typeof lists === 'object') job.listsShown = lists.shown ?? null;
    const text = buildUserMessage({ callInfo, transcript, task, earlierThisCall: this.callNotes?.text || '', reminders, songsNow, imagesNow, listsNow });
    const user = screen
      ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screen.jpeg } },
          { type: 'text', text },
        ]
      : text;
    return { system, user, looked: Boolean(screen) };
  }

  async generate(kind, info, signal, job = null, reply = null, { again = false } = {}) {
    const { system, user, looked } = await this.buildPrompt(kind, again ? { ...info, again: true } : info, job);
    if (looked && !again) log.info(`looked at ${info?.name || 'their'} screen (they asked)`);
    if (signal?.aborted) return null;
    const important = kind === 'direct' || kind === 'roast';
    // Quick checks and rapid back-and-forth use the fast model; direct asks get the funnier one.
    const client = this.clientFor(kind, info);
    // (Asked alongside: see followupWanted.)
    const gate = kind === 'followup' && client === this.venice ? this.followupWanted(info, signal) : null;
    const ask = (c, sys = system) =>
      c.createMessage({
      system: sys,
      user,
      kind, // (Venice adds worked examples for the kind of line; Claude ignores it)
      // (Room for a few words of notes before its line, which aren't said, and for a reminder tag after it.)
      // (And for a song's words, when it may write one.)
      maxTokens:
        (important ? 200 : kind === 'followup' ? 160 : 130) +
        ((kind === 'direct' || kind === 'followup') && this.remindersOn() ? 60 : 0) +
        ((kind === 'direct' || kind === 'followup') && this.songsOn() ? 320 : 0) +
        ((kind === 'direct' || kind === 'followup') && this.imagesOn() ? 150 : 0) +
        ((kind === 'direct' || kind === 'followup') && this.listsOn() ? 80 : 0),
      signal,
      retries: important ? 2 : 0,
      important,
      // Answers to people can look things up; jokes and quick checks never do (nor Venice).
      search: kind === 'direct' && c !== this.venice && this.searchOn(),
      onText: reply ? (piece) => reply.push(piece) : undefined,
      onToolStart: reply
        ? () => {
            reply.toolStarted();
            // A search takes a few seconds: "one sec" now (rather than on a timer that often
            // went off just before a quick answer arrived).
            if (kind === 'direct' && job && this.searchOn()) this.sayFiller(job, { search: true });
          }
        : undefined,
      // Overloaded mid-reply: start over only if none of it has been said.
      onRetry: reply ? () => reply.restartable() : undefined,
    });
    let res;
    let wrote = client;
    try {
      res = await ask(client);
    } catch (err) {
      // Fail over only for availability errors, never content or validation rejections.
      const unavailable = [401, 402, 429].includes(err?.status) || err?.status >= 500;
      if (client !== this.venice || !unavailable || signal?.aborted) throw err;
      log.warn(`Venice couldn't write that (${err.status}), so Claude did`);
      wrote = this.claudeFor(kind, info);
      res = await ask(wrote);
    }
    // A refusal, or the polite version of one written as an ordinary reply ("I'm sorry, but I
    // can't help with that"): neither is a line, so neither gets spoken in the assistant's voice.
    const softDecline = !res?.refusal && looksLikeSoftRefusal(res?.text);
    // Named in the log: a polite decline is easy to mistake for a line, and it is the one kind of
    // refusal that arrives looking like success. (Its words only with LOG_TRANSCRIPTS, like every
    // other thing a model wrote: bot.log is not a transcript by default.)
    if (softDecline) {
      const words = this.config.logTranscripts ? ` ("${String(res.text).trim().slice(0, 60)}")` : '';
      log.info(`${wrote === this.venice ? 'Venice' : 'Claude'} declined a ${kind} line politely${words}`);
    }
    // (Only for Venice's own line, and not waiting long: past that, Venice decides.)
    if (gate && wrote === this.venice) {
      let timer;
      const verdict = await Promise.race([gate, new Promise((r) => (timer = setTimeout(() => r('late'), GATE_WAIT_MS)))]);
      clearTimeout(timer);
      if (verdict === 'late') log.debug("Claude's check on whether to reply took too long, so Venice decides");
      else if (!verdict) {
        log.debug(`chose not to reply to ${info?.name || 'them'} (followup, Claude's check)`);
        return null;
      }
    }
    // (For the timing line in the log: which of them wrote it.)
    if (reply) reply.writer = wrote === this.venice ? 'Venice' : 'Claude';
    if (job) {
      job.citations = res.citations || [];
      job.searches = res.searches || 0;
    }
    if (res.refusal || looksLikeSoftRefusal(res.text)) {
      // Nothing could be salvaged: the polite "I can't help with that" is never spoken as if
      // it were one of its lines, and someone who asked gets an in-character line instead.
      if (reply) reply.refused = true;
      return important ? deflection() : null;
    }
    const optional = UNPROMPTED.has(kind);
    // Only the words inside <say></say> are said; a reply without the tags is taken whole,
    // unless it was cut off before getting to any (then all of it was notes).
    const words = sayContent(res.text);
    const cutOff = words === null && res.stopReason === 'max_tokens';
    // What it wrote to itself around its words (for the weekly look at the log; words only with transcripts on).
    if (this.config.logTranscripts) {
      const notes = words === null ? (cutOff ? res.text : '') : String(res.text || '').replace(/<say\s*>[\s\S]*?(?:<\/say\s*>|$)/gi, ' ');
      // (Not the tags nobody hears: a song's words, a reminder, a picture.)
      const clean = withoutHiddenTags(notes).replace(/\s+/g, ' ').trim();
      if (clean) log.info(`${kind} notes (not said): "${clean.slice(0, 400)}"`);
    }
    // A follow-up that wants a full answer: [LOOKUP] for facts, [LONG] for something long.
    if (kind === 'followup') {
      const handOff = this.followupHandOff(res.text, words, info);
      if (handOff !== undefined) return handOff;
    }
    let cleaned = cutOff ? { pass: true, text: '', thinking: true, cutOff: true } : cleanSpoken(words ?? withoutHiddenTags(res.text), {
      botName: this.config.botName,
      audioTags: this.config.tts.audioTags,
      optional,
      // After a bare "Gremlin!" the next line may turn out to be for someone else: "PASS - that was for Jess".
      passMarked: Boolean(info?.afterCall),
      maxChars: maxCharsFor(kind), // keep it to a line or two out loud
      // A joke cut off mid-sentence is worse than none.
      wholeSentences: optional,
      askers: askersOf(kind, info),
    });
    // It wrote a line and then passed after all ("<say>...</say> Actually that was for Jess. [PASS]"):
    // its last word stands, for a line it may leave unsaid.
    if (!cleaned.pass && (optional || info?.afterCall) && passesAfterLine(res.text)) {
      log.debug(`wrote a ${kind === 'quip' ? 'joke' : 'line'}, then passed after it; staying quiet`);
      cleaned = { pass: true, text: '' };
    }
    if (cleaned.thinking) this.noteThinking(kind, info, cleaned);
    if (cleaned.pass) {
      // Someone asked it something and all it wrote was about the conversation: ask
      // once more (nothing of it was said, so it can start over).
      if (cleaned.thinking && important && !again && !res.searches && !signal?.aborted && (!reply || reply.restartable())) {
        log.info(`asking again for just the ${kind === 'roast' ? 'roast' : 'answer'}`);
        return this.generate(kind, info, signal, job, reply, { again: true });
      }
      // A follow-up whose first sentence ran past the limit: they get a proper answer instead of silence.
      if (kind === 'followup' && cleaned.tooLong) {
        log.debug(`my follow-up to ${info?.name || 'them'} ran long; answering it properly`);
        return LOOKUP;
      }
      const context = info?.onlyOne ? ', the only one talking' : info?.partner ? ', who I was talking with' : '';
      if (kind === 'quip') log.debug(`joke check: passed${cleaned.tooLong ? ' (too long)' : ''}`);
      else if (!cleaned.thinking) log.debug(`chose not to reply to ${info?.name || 'them'} (${kind}${context})`);
      // It looked something up or said "one sec": don't leave them hanging.
      if (kind === 'direct' && (res.searches || job?.saidFiller)) return SEARCH_CAME_UP_EMPTY;
      return kind === 'roast' ? deflection() : null;
    }
    // Saying nearly the same thing it just said ("I asked because I'm nosy" twice): a
    // follow-up or a joke like that is better left unsaid.
    // (Not when they asked it something: "and for mid?" or "what did you say?" may need the same words.)
    const mayRepeat = kind === 'followup' && (info?.asked || this.askedSince(info?.userIds, this.lastBotLineAt));
    if ((kind === 'quip' || (kind === 'followup' && !mayRepeat)) && nearlyRepeats(cleaned.text, this.ownRecentLines(3))) {
      log.debug(`dropped a ${kind === 'quip' ? 'joke' : 'follow-up'} that nearly repeated one of my last lines`);
      return null;
    }
    // A follow-up that opens with the name of the person it's answering ("Kneeheel, did you..."):
    // it had become a habit. (Turning to someone else by name is kept.)
    if (kind === 'followup') cleaned.text = withoutLeadingName(cleaned.text, askersOf(kind, info));
    // A reminder or timer someone asked for (set once they hear the answer that agrees to it).
    if (job && (kind === 'direct' || kind === 'followup') && this.remindersOn()) {
      const tags = reminderTags(res.text);
      // It ran out of room in the middle of one: it can't be set (the person is told).
      const cutOff = res.stopReason === 'max_tokens' && cutOffInReminder(res.text);
      job.reminderTags = tags.set.length || tags.cancel.length || cutOff ? { ...tags, cutOff } : null;
    }
    // A song someone asked for (made once they hear the answer agreeing to it).
    if (job && (kind === 'direct' || kind === 'followup') && this.songsOn()) {
      // (Not one written inside a reminder: a song can't be put off till later.)
      const outside = withoutReminderTags(res.text);
      const songs = songTags(outside);
      const cutOff = res.stopReason === 'max_tokens' && cutOffInSong(outside);
      job.songTag = songs.length || cutOff ? { song: songs[0] ?? null, cutOff } : null;
    }
    // A picture someone asked for (drawn once they hear the answer agreeing to it).
    if (job && (kind === 'direct' || kind === 'followup') && this.imagesOn()) {
      // (Not one inside a reminder or a song's words.)
      const outside = withoutSongTags(withoutReminderTags(res.text));
      const images = imageTags(outside);
      const cutOff = res.stopReason === 'max_tokens' && cutOffInImage(outside);
      job.imageTag = images.length || cutOff ? { image: images[0] ?? null, cutOff } : null;
    }
    // Changes to the shared lists, or one to post (done once the answer is heard).
    if (job && (kind === 'direct' || kind === 'followup') && this.listsOn()) {
      // (Not ones inside a reminder, a song's words or a picture's description.)
      const outside = withoutImageTags(withoutSongTags(withoutReminderTags(res.text)));
      const tags = listTags(outside, { cutOff: res.stopReason === 'max_tokens' });
      job.listTags = tags.ops.length || tags.cutOff ? { ...tags, shown: job.listsShown ?? null } : null;
    }
    return cleaned.text;
  }

  /**
   * A follow-up reply asking for a full answer instead: LOOKUP (handled as a direct
   * answer), null (nothing said), or undefined (no such ask: an ordinary reply).
   * [LONG] (they want a story, a rant, a longer one) is always handed on. [LOOKUP] only
   * when they asked something (the quick model sent small talk like "Ho ho ho" on as
   * lookups). A marker only in its notes, before a line of its own, is just that line.
   */
  followupHandOff(text, words, info) {
    const raw = String(text ?? '');
    const last = (re) => {
      let at = -1;
      for (const m of raw.matchAll(new RegExp(re.source, 'gi'))) at = m.index;
      return at;
    };
    const lookupAt = last(LOOKUP_RE);
    const longAt = last(LONG_RE);
    const markerAt = Math.max(lookupAt, longAt);
    if (markerAt < 0) return undefined;
    // A pass after it: notes that only mentioned it ("not a [LONG] one. [PASS]", "...just a laugh. PASS"),
    // or a reply that starts with one.
    if (last(/\[\s*pass\s*\]/) > markerAt || /(?:^|[\s.!?,;:–—-])PASS[.!]?["'”’]?\s*$/.test(raw.slice(markerAt)) || /^[\s"'*_[(]*pass\b/i.test(raw)) return undefined;
    // Only in its notes, before a line of its own: that line is the reply. (One after its
    // line, "<say>Alright, buckle up.</say> [LONG]", is a hand-off: the teaser isn't said.)
    const sayAt = raw.search(/<say\s*>/i);
    const ownLine = words !== null && sayAt > markerAt && /[\p{L}\p{N}]/u.test(words);
    if (ownLine) return undefined;
    const long = longAt >= 0;
    const who = info?.name || 'their';
    if (long) {
      log.debug(`${who} wants something long; answering it properly`);
      return LOOKUP;
    }
    if (this.searchOn() && this.askedSince(info?.userIds, this.lastBotLineAt)) {
      log.debug(`${who}'s follow-up needs a lookup; answering it properly`);
      return LOOKUP;
    }
    log.debug(`${who}'s follow-up was sent on as a lookup, but they didn't ask anything; not replying`);
    return null;
  }

  /** Something they said since then asks something (a question, or "look up...", "tell me..."). */
  askedSince(userIds = [], since = 0) {
    const ids = new Set(userIds || []);
    return this.transcript.lines.some((l) => !l.isBot && l.at > since && (!ids.size || ids.has(l.userId)) && asksSomething(l.text, this.config.botAliases));
  }

  /** Its last few lines in the transcript (newest last). */
  ownRecentLines(n) {
    return this.transcript.lines
      .filter((l) => l.isBot)
      .slice(-n)
      .map((l) => l.text);
  }

  /** The names of the people in the call. */
  peopleNames() {
    const people = this.getCallInfo?.()?.people;
    return Array.isArray(people) ? people.filter(Boolean) : [];
  }

  /** Pictures can be drawn in this call (IMAGES on, with a Gemini key). */
  /** Shared lists can be kept and posted in this call (LISTS on). */
  listsOn() {
    return this.config.lists !== false && Boolean(this.onLists);
  }

  imagesOn() {
    return this.config.images?.enabled !== false && Boolean(this.onImage);
  }

  /** A picture someone asked for is up in the text chat: a quick "It's in the chat." if there's a pause for it. */
  picturePosted() {
    if (this.closed || this.singing()) return;
    const text = pickFresh(PICTURE_POSTED, this.lastPosted, this.random);
    this.lastPosted = [text];
    this.saySound(text, 'posted');
  }

  /** Songs can be made in this call (SONGS on, with a key that can make them). */
  songsOn() {
    return this.config.songs?.enabled !== false && Boolean(this.onSong);
  }

  /** How its last few lines opened, so it starts this one differently (empty when they varied). */
  openerHint() {
    const last = this.recentOpeners.slice(-3).filter(Boolean);
    // Only once there's a habit to break: the same start twice, or a laugh to open the last one.
    const repeated = [...new Set(last.filter((k, i) => last.indexOf(k) !== i || (k === 'laugh' && i === last.length - 1)))];
    if (!repeated.length) return '';
    const shown = repeated.map((k) => (k === 'laugh' ? 'a laugh' : k.startsWith('[') ? k : `"${k.charAt(0).toUpperCase()}${k.slice(1)}"`));
    return ` (Your last few lines started with ${shown.join(' and ')} too often: start this one some other way.)`;
  }

  /**
   * Phrases it has leaned on in this call ("pile of text", "cheese story"): pointed out
   * so it gives them a rest. Not names, nor what the others have been talking about.
   */
  overusedHint() {
    if (this.saidThisCall.length < OVERUSED_MIN) return '';
    const names = [this.config.botName, ...(this.config.botAliases || []), ...this.peopleNames()].filter(Boolean);
    const others = this.transcript.lines.filter((l) => !l.isBot).map((l) => l.text);
    // (Counted again only when it has said something new.)
    if (this.phraseCache?.n !== this.saidCount) this.phraseCache = { n: this.saidCount, found: phraseLines(this.saidThisCall) };
    const worn = pickOverused(this.phraseCache.found, { min: OVERUSED_MIN, max: OVERUSED_MAX, names, others });
    if (!worn.length) return '';
    return ` (You've already said these a lot in this call, so leave them out unless someone brings them up: ${worn.map((p) => `"${p}"`).join(', ')}.)`;
  }

  /** A line it's opening: remembered, so the next ones don't all start the same way. */
  noteOpener(text) {
    this.recentOpeners = [...this.recentOpeners, openerKey(text)].slice(-4);
  }

  /**
   * Takes the habits out of a part before it's said: no laugh to open it right after
   * laughing, one laugh a line at most, no "Hmm," right after its own "Hmm." (see human.js).
   */
  varyLine(text, { opening = true, job = null } = {}) {
    const laughedLately = this.clock() - this.lastLaughTagAt < LAUGHED_LATELY_MS || this.recentOpeners.slice(-2).includes('laugh') || Boolean(job?.reply?.laughed);
    return varyOpening(text, { laughedLately, afterSound: Boolean(job?.thinkSaid), opening });
  }

  /** Their latest line in the transcript (what a reply to them is answering). */
  latestLineFrom(userIds = []) {
    const ids = new Set(userIds || []);
    for (let i = this.transcript.lines.length - 1; i >= 0; i--) {
      const l = this.transcript.lines[i];
      if (!l.isBot && l.userId && ids.has(l.userId)) return l;
    }
    return null;
  }

  /**
   * Plans a quick "Hmm." for an answer to a question, in case it hasn't started a moment
   * after they stopped talking. Now and then only (THINK_CHANCE, THINK_GAP_MS). Returns the timer.
   */
  planThinkingSound(job) {
    const { info } = job;
    if (this.config.thinkingSounds !== true || this.clock() - this.lastThinkAt < THINK_GAP_MS) return null;
    const asked = this.latestLineFrom(info?.userIds);
    if (!asked || !isQuestion(asked.text, this.config.botAliases)) return null;
    if (this.random() >= THINK_CHANCE) return null;
    const t = info?.timing;
    const stopped = t ? (t.spokeUntil ?? t.endedAt ?? t.heardAt ?? this.clock()) : this.clock();
    const timer = setTimeout(() => this.sayThinkingSound(job), Math.max(150, THINK_AT_MS - (this.clock() - stopped)));
    timer.unref?.();
    return timer;
  }

  sayThinkingSound(job) {
    if (this.closed || job.ac.signal.aborted || job.epoch !== this.epoch || this.inflight !== job) return;
    // Its answer is already on its way, or someone is talking: no sound.
    if (job.reply?.sentAt != null || job.reply?.spoke || this.speaker.speaking || this.isAnyoneSpeaking()) return;
    const text = pickFresh(THINKING_SOUNDS, this.lastThinks, this.random);
    this.lastThinks = [...this.lastThinks, text].slice(-3);
    this.lastThinkAt = this.clock();
    job.thinkQueued = text;
    job.thinkPending = true;
    this.saySound(text, 'think', () => {
      job.thinkSaid = text;
      job.thinkAt = this.clock();
    }).then(() => {
      job.thinkPending = false;
    });
  }

  /** Someone laughed (a whole line of it). Now and then it laughs along: see the LAUGH_ constants. */
  noteLaugh({ userId, name, text = '' }) {
    const now = this.clock();
    this.recentLaughs = this.recentLaughs.filter((l) => now - l.at < LAUGH_GROUP_MS);
    if (userId) this.recentLaughs.push({ userId, at: now });
    if (this.config.laughAlong !== true || !CHATTINESS[this.chattiness] || this.talkingLess()) return;
    // At its own line (playing, or just finished): that's for them to laugh at, not it.
    if (this.transcript.recentBotLines(LAUGH_AFTER_OWN_LINE_MS).length > 0 || this.jokeOpen()) return;
    if (now - this.lastLaughAlongAt < LAUGH_GAP_MS) return;
    if (this.speaker.speaking || this.inflight || this.pending || this.answerOwed()) return;
    const people = new Set(this.recentLaughs.map((l) => l.userId)).size;
    // One person alone: only a real laugh ("hahaha", "lmao"), not a polite "ha ha".
    if (people < 2 && !isBigLaugh(text)) return;
    // One try when someone laughs, and one more if others join in (not one per line of laughing).
    if (people >= 2) {
      if (now - this.lastGroupLaughRollAt < LAUGH_GROUP_MS) return;
      this.lastGroupLaughRollAt = now;
    } else if (now - this.lastLaughRollAt < LAUGH_GROUP_MS) {
      return;
    }
    this.lastLaughRollAt = now;
    if (this.random() >= (people >= 2 ? LAUGH_CHANCE_GROUP : LAUGH_CHANCE_ONE)) return;
    this.lastLaughAlongAt = now;
    const laugh = pickFresh(LAUGHS, this.lastLaughs, this.random);
    this.lastLaughs = [...this.lastLaughs, laugh].slice(-2);
    log.debug(`laughing along with ${name || 'them'}${people >= 2 ? ' and the others' : ''}`);
    // (It laughed: its next line doesn't open with another laugh.)
    this.saySound(laugh, 'laugh', () => (this.lastLaughTagAt = this.clock()));
  }

  /**
   * Someone joined the call. Once it has been in the call a minute, they get a quick hi
   * (people joining close together get one between them).
   */
  someoneJoined({ userId, name }) {
    if (this.closed || this.config.helloGoodbye !== true || !CHATTINESS[this.chattiness]) return;
    const now = this.clock();
    if (now - this.listeningSince < WELCOME_AFTER_JOIN_MS) return;
    if (userId && now - (this.welcomed.get(userId) ?? -Infinity) < WELCOME_AGAIN_MS) return;
    this.welcomeQueue.set(userId || name, { userId, name });
    if (!this.welcomeTimer) this.armWelcome(0);
  }

  /** Says the hi once the joins have gathered (waiting a bit, twice at most, while someone is owed an answer). */
  armWelcome(tries) {
    this.welcomeTimer = setTimeout(() => {
      this.welcomeTimer = null;
      if (this.closed || !this.welcomeQueue.size) return;
      if ((this.answerOwed() || this.singing() || this.songWaiting) && tries < 2) {
        this.armWelcome(tries + 1);
        return;
      }
      const people = [...this.welcomeQueue.values()];
      this.welcomeQueue.clear();
      if (!this.stillWanted('welcome')) return;
      const now = this.clock();
      for (const p of people) if (p.userId) this.welcomed.set(p.userId, now);
      log.debug(`saying hi to ${people.map((p) => p.name).join(' and ')}`);
      this.request('welcome', { names: people.map((p) => p.name), userIds: people.map((p) => p.userId).filter(Boolean) });
    }, tries ? 5000 : WELCOME_GATHER_MS);
    this.welcomeTimer.unref?.();
  }

  /** They said they're heading out: a quick bye, if they've been around a while. True if one is on its way. */
  maybeSayBye({ userId, name }) {
    if (this.config.helloGoodbye !== true || !CHATTINESS[this.chattiness]) return false;
    const now = this.clock();
    const since = this.getJoinedAt?.(userId) ?? this.listeningSince;
    if (now - since < BYE_AFTER_MS) return false;
    if (userId && now - (this.byes.get(userId) ?? -Infinity) < BYE_AGAIN_MS) return false;
    if (now - this.lastFarewellAt < BYE_GAP_MS) return false;
    // Someone is owed an answer (or it's singing): no bye now, and none is counted as said.
    if (!this.stillWanted('farewell')) return false;
    if (userId) this.byes.set(userId, now);
    this.lastFarewellAt = now;
    log.debug(`${name} is heading out; saying bye`);
    this.request('farewell', { name, userIds: userId ? [userId] : [] });
    return true;
  }

  /**
   * Plays a song someone asked for: a quick "Alright, here it is." and then the song.
   * Its words go in the transcript (so a mic playing it back is known as its own voice).
   * Resolves to how it went ('played', 'stopped', ...).
   */
  async playSong(song, { userIds = [] } = {}) {
    if (this.closed || !song?.pcm?.length) return { outcome: 'dropped', started: false };
    // A quiet moment first: nobody talking, nothing of its own being written or said
    // (so a song never lands in the middle of an answer, or in front of one).
    // Told to stop (or to cancel the song) while it waits: it isn't played.
    const cancels = this.songCancels;
    this.songWaiting = true;
    try {
      const until = this.clock() + SONG_QUIET_WAIT_MS;
      while (!this.closed && this.songCancels === cancels && this.clock() < until) {
        const busy = this.inflight || this.pending || this.speaker.speaking || this.isAnyoneSpeaking() || this.isHearingSomething();
        if (!busy) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      this.songWaiting = false;
    }
    if (this.closed) return { outcome: 'dropped', started: false };
    if (this.songCancels !== cancels) return { outcome: 'stopped', started: false };
    const intro = pickFresh(SONG_INTROS, this.lastIntros, this.random);
    this.lastIntros = [intro];
    const line = this.transcript.add({ name: this.config.botName, text: `${intro} (sings) ${song.lyricsText}`, isBot: true });
    line.open = true;
    line.kind = 'song';
    line.info = { userIds }; // (gone with them if they opt out)
    this.markSpoke('song', { userIds });
    let started = false;
    const onStart = () => {
      if (!line.heard) line.heardAt = this.clock();
      line.heard = true;
    };
    log.info(this.config.logTranscripts ? `song: "${song.lyricsText}"` : `singing a ${Math.round(song.seconds)} s song`);
    this.speaker.say(intro, { kind: 'intro', onStart });
    // Handed over a tenth of a second at a time, so playing it doesn't hold everything else up.
    const source = async () => ({ stream: Readable.from(slices(song.pcm, (song.sampleRate || 48000) / 5)), sampleRate: song.sampleRate });
    const outcome = await this.speaker.say(song.lyricsText, {
      kind: 'song',
      continues: true,
      source,
      durationMs: Math.round(song.seconds * 1000),
      onStart: () => {
        started = true;
        onStart();
      },
    });
    this.settleLine(line, outcome, 'song');
    return { outcome, started };
  }

  /** A note in the log when a reply had sentences where it was thinking out loud (they're never said). */
  noteThinking(kind, info, cleaned) {
    const n = cleaned.dropped?.length || 0;
    const to = info?.name ? ` to ${info.name}` : '';
    log.info(
      cleaned.cutOff
        ? `${kind} reply${to} ran out of room before its line, so none of it was said`
        : cleaned.pass
          ? `${kind} reply${to} was only thinking out loud, so none of it was said`
          : `left out ${n === 1 ? 'a sentence' : `${n} sentences`} of thinking out loud from a ${kind} reply${to}`,
    );
    // They often quote people, so the words only reach the log when transcripts are on.
    if (this.config.logTranscripts && n) log.info(`not said: "${cleaned.dropped.join(' ')}"`);
  }
}

/** A buffer in pieces of `size` bytes (the last one shorter). */
function* slices(buf, size) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(buf.length, i + size));
}

/** The most it says in one reply, in characters: a line or two out loud. */
function maxCharsFor(kind) {
  return UNPROMPTED.has(kind) ? 160 : 300;
}

/** Who a reply is for (their names as in the transcript): "Mike's asking me to..." in a reply to Mike is narration. */
function askersOf(kind, info) {
  if (kind === 'roast') return info?.requester ? [info.requester] : [];
  if (kind === 'direct' || kind === 'followup') return info?.names?.length ? info.names : info?.name ? [info.name] : [];
  return [];
}

// A reply that starts like this may turn out to be a pass or a request to look it
// up: it's only judged once it's all in.
const MAYBE_NOT_AN_ANSWER = /^[\s"'*_[(]*(?:pass\b|look\s*up\b)/i;
// Sentences shorter than this wait for the next one, so the voice isn't choppy.
const MIN_PART_CHARS = 20;

/**
 * One reply on its way out: speaks it a sentence at a time while Claude is still
 * writing it, keeps its line in the transcript, and settles that line (heard,
 * cut off, never said) once every part is done.
 */
class SpokenReply {
  constructor(brain, kind, info, job, { onFirst } = {}) {
    this.brain = brain;
    this.kind = kind;
    this.info = info;
    this.job = job;
    this.onFirst = onFirst || (() => {});
    // Everything written so far (since the start, a search or a restart). Only the words
    // inside <say></say> go on to be spoken: anything before them is its own notes.
    this.written = '';
    this.fed = 0; // how much of those words has gone into raw
    this.raw = ''; // words written, not spoken yet
    this.parts = []; // { text, outcome, started }
    this.line = null;
    this.takeBackAc = null;
    // A reply that may turn out to be a pass (a follow-up, a joke, an answer after a
    // bare "Gremlin!") is judged whole before any of it is said, so reasoning written
    // before a [PASS] is never read out.
    this.holdAll = UNPROMPTED.has(kind) || Boolean(info?.afterCall);
    this.held = this.holdAll; // waiting for the whole reply before saying anything
    this.stopped = false; // nothing more will be said
    this.closed = false;
    this.settled = false;
    this.chars = 0;
    this.maxChars = maxCharsFor(kind);
    this.sentAt = null; // when its first sentence went to the voice
  }

  get spoke() {
    return this.parts.length > 0;
  }

  push(piece) {
    if (this.stopped) return;
    this.written += piece;
    const words = sayContent(this.written);
    // No <say> yet: notes, or a reply without tags (that one is said whole at the end).
    if (words === null || words.length <= this.fed) return;
    this.raw += words.slice(this.fed);
    this.fed = words.length;
    if (!this.held) this.drain(false);
  }

  /** Starts over on what it writes next (after a search, or when it's asked again). */
  forgetWritten() {
    this.written = '';
    this.fed = 0;
    this.raw = '';
  }

  /**
   * It started a web search: what it wrote so far (and hasn't said) was "let me check"
   * narration, not the answer. If some was said, the answer after the search starts
   * like a new line (it waits its turn), since people may be talking by then.
   */
  toolStarted() {
    this.searched = true;
    this.forgetWritten();
    if (this.spoke) this.freshStart = true;
  }

  /** Runs fn once people have started hearing this reply (now, if they have), and never if they don't. */
  whenHeard(fn) {
    if (this.line?.heard) fn();
    else (this.onHeard ??= []).push(fn);
  }

  /** It started playing (or went to the text channel because the voice failed). */
  heardNow() {
    const fns = this.onHeard || [];
    this.onHeard = [];
    for (const fn of fns) fn();
  }

  /** The request is being sent again (overloaded mid-reply, or asked once more): fine only if nothing was said. */
  restartable() {
    if (this.spoke || this.stopped) return false;
    this.forgetWritten();
    this.held = this.holdAll;
    return true;
  }

  /** Speaks every finished sentence (and, at the end, whatever is left). */
  drain(final) {
    while (!this.stopped && !this.held) {
      const end = final ? (this.raw.trim() ? this.raw.length : -1) : nextSentenceEnd(this.raw, MIN_PART_CHARS);
      if (end < 0) return;
      const sentence = this.raw.slice(0, end);
      if (!this.spoke && MAYBE_NOT_AN_ANSWER.test(this.raw) && !final) {
        this.held = true;
        return;
      }
      this.raw = this.raw.slice(end);
      if (!this.speakPart(sentence)) {
        this.stopped = true;
        this.raw = '';
      }
    }
  }

  /** The reply is complete. finalText: the whole reply, cleaned (said as one piece if nothing went out early). */
  finish(finalText) {
    if (this.stopped) return;
    if (this.refused && this.spoke) {
      // It stopped writing partway (a refusal): what's left would be half a sentence.
      this.raw = '';
      this.stopped = true;
      return;
    }
    if (!this.spoke) {
      this.raw = '';
      if (finalText) this.speakPart(finalText, { cleaned: true });
      this.stopped = true;
      return;
    }
    this.held = false;
    this.drain(true);
    this.stopped = true;
  }

  /** Whether an unprompted line still makes sense now that it's ready. */
  stillFresh() {
    const b = this.brain;
    const { job, kind, info } = this;
    if (!UNPROMPTED.has(kind)) return true;
    const newLines = b.transcript.count - job.linesAtStart;
    return b.clock() - job.startedAt <= 6000 && newLines < 2 && b.stillWanted(kind, info);
  }

  /** Says one part. False means stop: nothing more from this reply. */
  speakPart(sentence, { cleaned = false } = {}) {
    const b = this.brain;
    const { job, kind, info } = this;
    if (job.ac.signal.aborted || b.closed || job.epoch !== b.epoch) return false;
    if (!this.spoke && !this.stillFresh()) {
      // The conversation moved on (or it just talked, or someone is waiting on an answer).
      log.debug(`skipped a ${kind} that came too late${info?.name ? ` (for ${info.name})` : ''}`);
      job.ac.abort();
      return false;
    }
    let text = sentence.trim();
    if (!cleaned) {
      const c = cleanSpoken(text, this.cleanOptions({ maxChars: 10000 }));
      if (c.pass) return true; // only a stage direction, thinking out loud or the like: skip it
      text = c.text;
    }
    const room = this.maxChars - this.chars;
    let last = false;
    if (text.length > room) {
      // Over the length limit: a first answer is trimmed to fit; anything else stops here.
      if (this.spoke || UNPROMPTED.has(kind)) return false;
      const c = cleanSpoken(text, this.cleanOptions({ maxChars: room }));
      if (c.pass) return false;
      text = c.text;
      last = true;
    }
    // Not opening line after line the same way (a laugh, "Ha,"), and no "Hmm," after its own "Hmm.".
    text = b.varyLine(text, { opening: !this.spoke || Boolean(this.freshStart), job });
    if (!this.spoke) this.openLine(text);
    else this.line.text = `${this.line.text} ${text}`;
    this.sayPart(text);
    return !last;
  }

  /** How a part is cleaned up. first: nothing heard from it yet (or it starts again after a search). */
  cleanOptions(more) {
    const b = this.brain;
    return {
      botName: b.config.botName,
      audioTags: b.config.tts.audioTags,
      askers: askersOf(this.kind, this.info),
      // Opening the reply (nothing but "Alright, alright." said yet, or it starts again after a
      // search): a sentence that only describes what they asked is thinking out loud.
      first: Boolean(this.freshStart) || this.parts.every((p) => isLeadIn(p.text)),
      ...more,
    };
  }

  openLine(text) {
    const b = this.brain;
    const { job, kind, info } = this;
    const line = b.transcript.add({ name: b.config.botName, text, isBot: true });
    line.open = true;
    line.kind = kind;
    line.info = info;
    line.askedAt = job.startedAt;
    line.searched = Boolean(this.searched || job.searches);
    this.takeBackAc = new AbortController();
    line.takeBack = () => this.takeBackAc.abort(); // if they turn out not to be done asking
    line.reply = this;
    this.line = line;
    if (kind === 'quip') {
      line.callbacks = job.callbacks || [];
      b.jokeStarted(line);
    }
    const before = { lastBotLineAt: b.lastBotLineAt, engagedUntil: b.engagedUntil, followupsInARow: b.followupsInARow, talkingWith: b.talkingWith, lastJokeAt: b.lastJokeAt };
    b.noteOpener(text);
    b.markSpoke(kind, info);
    line.before = { ...before, seq: b.spokeSeq };
    if (kind === 'quip') line.jokeAt = b.lastJokeAt;
    this.onFirst();
    // Its lines often quote people, so they only reach the log when transcripts are on.
    if (b.config.logTranscripts) log.info(`${kind}: "${text}"`);
    else log.debug(`${kind} reply${info?.name ? ` to ${info.name}` : ''} started`);
    // An answer goes ahead of any joke that's still waiting for a pause.
    if (!UNPROMPTED.has(kind)) b.speaker.dropOptional?.();
  }

  sayPart(text) {
    const b = this.brain;
    const { kind, info } = this;
    const part = { text, outcome: null, started: false };
    // It laughs in this part: not again soon (in this reply or the next).
    if (hasLaughTag(text) || openerKey(text) === 'laugh') {
      this.laughed = true;
      b.lastLaughTagAt = b.clock();
    }
    // The first sentence (or the first after a web search) waits its turn; the rest follow right on.
    const first = !this.spoke || this.freshStart;
    this.freshStart = false;
    this.parts.push(part);
    this.chars += text.length + 1;
    if (this.sentAt === null) this.sentAt = b.clock();
    const firstPart = this.parts.length === 1;
    // An answer (or a reply to what they said) waits a bit longer while they're still
    // talking: they may not be done, and if they go on, it's written again for all of it.
    const askers = first && (kind === 'direct' || kind === 'followup') ? info?.userIds || [] : [];
    const hold = askers.length ? () => askers.some((u) => b.isSpeaking(u) || b.isHearingFrom(u)) : undefined;
    // Don't await playback: the rest can be written while this part plays.
    b.speaker
      .say(text, {
        kind,
        hold,
        // The rest of the reply follows the first sentence right on.
        continues: !first,
        tag: { line: this.line },
        signal: this.takeBackAc.signal,
        // When nothing of its own was ahead of it any more (for the timing log: waiting vs voice).
        onTurn: firstPart ? () => (this.turnAt ??= b.clock()) : undefined,
        onStart: () => {
          part.started = true;
          const firstSound = !this.line.heard;
          if (firstSound) this.line.heardAt = b.clock();
          this.line.heard = true;
          if (firstSound) {
            b.noteReplyTime(this);
            this.heardNow();
            if (kind === 'welcome') b.welcomeHeard(info);
          }
        },
      })
      .then((outcome) => {
        part.outcome = outcome;
        // The voice failed, so it was posted in the text channel instead: seen, if not heard.
        if (outcome === 'failed') this.heardNow();
        // A part that didn't play (dropped, cut off, taken back): the rest would make no sense alone.
        if (outcome !== 'played' && outcome !== 'failed') {
          this.stopped = true;
          this.takeBackAc.abort();
        }
        this.maybeSettle();
      });
  }

  /** It's being stopped right now: the transcript shows only what was heard, at once. */
  cutOff() {
    this.stopped = true;
    if (!this.line || this.settled) return;
    this.settled = true;
    this.line.text = this.parts
      .filter((p) => p.started || p.outcome === 'played' || p.outcome === 'failed')
      .map((p) => p.text)
      .join(' ');
    this.brain.settleLine(this.line, 'stopped', this.kind);
  }

  /** No more parts are coming. */
  close() {
    this.stopped = true;
    this.closed = true;
    this.maybeSettle();
  }

  maybeSettle() {
    if (!this.closed || this.settled || !this.line || this.parts.some((p) => !p.outcome)) return;
    this.settled = true;
    const said = (p) => p.outcome === 'played' || p.outcome === 'failed';
    if (this.parts.every(said)) {
      this.line.text = this.parts.map((p) => p.text).join(' ');
      // (Only its first sentence was logged when it started.)
      if (this.parts.length > 1 && this.brain.config.logTranscripts) log.info(`${this.kind}, all of it: "${this.line.text}"`);
      this.brain.settleLine(this.line, this.parts.at(-1).outcome, this.kind);
      return;
    }
    // Cut short: keep what was heard (settleLine marks it as cut off, or removes it if none was).
    this.line.text = this.parts
      .filter((p) => said(p) || p.started)
      .map((p) => p.text)
      .join(' ');
    if (this.parts.length > 1 && this.line.text && this.brain.config.logTranscripts) log.info(`${this.kind}, cut short after: "${this.line.text}"`);
    this.brain.settleLine(this.line, 'stopped', this.kind);
  }
}
