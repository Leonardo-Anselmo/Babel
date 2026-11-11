// Fixes from the Oct 28 refinement pass (a live call plus the weekly review of Oct 21-27).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain, FILLERS, isBigLaugh } from '../src/brain.js';
import { TASKS, buildSystem, cleanSpoken } from '../src/prompts.js';
import { asksSomething, asksToTalkLess, isJustHesitation, isQuestion, nearlyRepeats, overusedPhrases, withoutLeadingName } from '../src/human.js';
import { cleanNotes, keepNewest } from '../src/callnotes.js';
import { corrections } from '../src/vocab.js';
import { setLogFile } from '../src/log.js';

// Log lines (debug and up) go to a file the tests can read.
const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'refine-')), 'bot.log');
setLogFile(LOG);
const logText = () => fs.readFileSync(LOG, 'utf8');

const baseConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin', 'grem'],
  timezone: 'UTC',
  defaultChattiness: 'medium',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
};

function fakeClaude(replies) {
  const calls = [];
  const queue = [...replies];
  return {
    calls,
    async createMessage(args) {
      calls.push(args);
      const next = queue.shift();
      if (typeof next === 'function') return next(args);
      return { text: next ?? '[PASS]', refusal: false };
    },
  };
}

function fakeSpeaker() {
  const said = [];
  const stoppedKinds = [];
  let stops = 0;
  return {
    said,
    stoppedKinds,
    get stops() {
      return stops;
    },
    stopKind(kind) {
      stoppedKinds.push(kind);
    },
    speaking: false,
    talkedOver: false,
    wasAudibleBetween() {
      return this.talkedOver;
    },
    say(text, opts) {
      said.push({ text, kind: opts?.kind });
      return Promise.resolve('played');
    },
    stop() {
      stops++;
    },
  };
}

function makeBrain({ replies = [], fast = [], chattiness = 'medium', config = {}, people = ['Mike', 'Jess'], ...more } = {}) {
  let now = 1_000_000;
  const claude = fakeClaude(replies);
  const claudeFast = fakeClaude(fast);
  const speaker = fakeSpeaker();
  const brain = new Brain({
    config: { ...baseConfig, ...config },
    claude,
    claudeFast,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people, activities: [] }),
    getFacts: () => [],
    isAnyoneSpeaking: () => false,
    chattiness,
    clock: () => now,
    ...more,
  });
  return { brain, claude, claudeFast, speaker, advance: (ms) => (now += ms), now: () => now };
}

/** It answers Mike by name, then a moment passes: the next lines may be replies to it. */
async function afterAnAnswer(t, ask = 'gremlin what gun should I use') {
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: ask });
  await settle();
  t.advance(1000);
}

const saidTexts = (speaker) => speaker.said.map((s) => s.text);

const settle = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// A. Its name, when Whisper was far from sure of it
// ---------------------------------------------------------------------------

test('an unsure call of its name gets no "Yeah?", but what they say next is still for it', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off', replies: ['Numbers first, always.'] });
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin', unsureName: true }), 'listening-quietly');
  await settle();
  assert.deepEqual(speaker.said, [], 'no "Yeah?" for what may have been noise');
  assert.equal(claude.calls.length, 0);
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'what came first, the numbers or the story' }), 'direct');
  await settle();
  assert.equal(claude.calls.length, 1);
  assert.match(claude.calls[0].user, /wasn't sure/, 'told the call may not have been one');
  assert.match(claude.calls[0].user, /\[PASS\]/, 'and that it may pass');
  assert.deepEqual(speaker.said, [{ text: 'Numbers first, always.', kind: 'direct' }]);
});

test('the line after an unsure call can be passed on when it was not for it', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off', replies: ['[PASS]'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin', unsureName: true });
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'Thank you' }), 'direct');
  await settle();
  assert.equal(claude.calls.length, 1);
  assert.deepEqual(speaker.said, [], 'nothing said');
});

test('an unsure call over its talking does not stop it', async () => {
  const { brain, speaker } = makeBrain({ chattiness: 'off' });
  speaker.speaking = true;
  speaker.talkedOver = true;
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin', unsureName: true, startedAt: 999_000, spokeUntil: 999_500 }), 'listening-quietly');
  assert.equal(speaker.stops, 0);
});

test('calling it again after an unsure call gets the usual "Yeah?"', async () => {
  const { brain, speaker, advance } = makeBrain({ chattiness: 'off' });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin', unsureName: true });
  advance(4000);
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'Gremlin', unsureName: true }), 'acknowledged');
  await settle();
  assert.equal(speaker.said.length, 1);
  assert.equal(speaker.said[0].kind, 'ack');
});

test('a sure call still gets its "Yeah?", and its name in the next line is a plain direct ask', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off', replies: ['Sure.'] });
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin' }), 'acknowledged');
  await settle();
  assert.equal(speaker.said[0].kind, 'ack');
  // After an unsure call, a line with its name in it is simply for it.
  const b = makeBrain({ chattiness: 'off', replies: ['Sure.'] });
  b.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin', unsureName: true });
  b.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'Gremlin what time is it' });
  await settle();
  assert.doesNotMatch(b.claude.calls[0].user, /wasn't sure/);
  assert.equal(claude.calls.length, 0);
});

test('the direct-answer prompt after an unsure call differs from the one after a sure call', () => {
  const sure = TASKS.direct({ name: 'Mike', botName: 'Gremlin', afterCall: true });
  const unsure = TASKS.direct({ name: 'Mike', botName: 'Gremlin', afterCall: true, unsureCall: true });
  assert.match(sure, /almost certainly for you/);
  assert.doesNotMatch(unsure, /almost certainly/);
  assert.match(unsure, /may not be talking to you/);
});

// ---------------------------------------------------------------------------
// B. Replies without its name: hesitations, repeats, "you don't have to respond to everything"
// ---------------------------------------------------------------------------

test('hesitating ("Errm", "uh", "hmm") is not a reply to check; "mhm" and a real reply are', () => {
  for (const t of ['Errm', 'Erm.', 'uh...', 'Um', 'Hmm', 'hm hm', 'uhh um']) assert.equal(isJustHesitation(t), true, t);
  for (const t of ['mhm', 'Mm.', 'eh', 'Oh.', 'Hmm, okay', 'um yeah', 'uh huh', 'er what']) assert.equal(isJustHesitation(t), false, t);
});

test('"Errm" right after its line gets no reply check; what they say next does', async () => {
  const t = makeBrain({ replies: ['<say>The shotgun.</say>'], fast: ['<say>Sure, the rifle works too.</say>'] });
  await afterAnAnswer(t);
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'Errm' }), 'hesitating');
  await settle();
  assert.equal(t.claudeFast.calls.length, 0);
  assert.equal(t.brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'what about the rifle' }), 'followup');
  await settle();
  // (A question from the one it was talking with goes to the main model.)
  assert.equal(t.claude.calls.length, 2);
  assert.equal(t.claudeFast.calls.length, 0);
});

test('a reply without its name: no questions back, no opening with their name, and [LONG] for something long', () => {
  const f = TASKS.followup({ name: 'Mike' });
  assert.match(f, /Don't ask them a question back unless you really need the answer/);
  assert.match(f, /never ask what they meant or whether they're talking to you/);
  assert.match(f, /Don't start with their name/);
  assert.match(f, /reply with exactly \[LONG\] instead/);
  assert.match(f, /similar-sounding word/);
});

test('a short question from the person it was talking with, right after its line, is pointed out', () => {
  assert.match(TASKS.followup({ name: 'Mike', partner: true, asked: true }), /Their newest line asks something, right after your line: answer it/);
  assert.doesNotMatch(TASKS.followup({ name: 'Mike', partner: true }), /newest line asks/);
  assert.doesNotMatch(TASKS.followup({ name: 'Jess', asked: true }), /newest line asks/, 'not from someone else');
  // "is that true" has no "?" but is one; "Babel, do it" and "it is the best" are not.
  assert.equal(isQuestion('is that true'), true);
  assert.equal(isQuestion('did you catch that'), true);
  assert.equal(isQuestion("don't you think"), true);
  assert.equal(isQuestion('Gremlin, do it', ['gremlin']), false);
  assert.equal(isQuestion('gremlin is the best', ['gremlin']), false);
  assert.equal(isQuestion('do that again'), false);
});

test('"is that true" from the person it was answering reaches the reply check marked as a question', async () => {
  const t = makeBrain({ replies: ['<say>I once beat a raid boss with a spoon.</say>', '<say>Every word of it.</say>'] });
  await afterAnAnswer(t, 'gremlin spit it out');
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'is that true' }), 'followup');
  await settle();
  // (The main model takes a question from the one it was talking with.)
  assert.match(t.claude.calls[1].user, /Their newest line asks something/);
  assert.equal(t.claudeFast.calls.length, 0);
});

test('a follow-up that nearly repeats one of its last lines is dropped', async () => {
  assert.equal(
    nearlyRepeats("Leonardo, I asked because I'm nosy, but I'd rather not get into it.", ["Leonardo, I asked because I'm nosy, and I know more than I'm letting on."]),
    true,
  );
  assert.equal(nearlyRepeats('The shotgun, obviously.', ['Take the rifle, trust me.']), false);
  assert.equal(nearlyRepeats('Yeah.', ['Yeah.']), false, 'too short to judge');
  const t = makeBrain({ replies: ["<say>I asked because I'm nosy, that's all.</say>"], fast: ["<say>I asked because I'm nosy, but let's drop it.</say>"] });
  await afterAnAnswer(t, 'gremlin why did you ask that');
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'I need to know why' }), 'followup');
  await settle();
  assert.equal(t.claudeFast.calls.length, 1);
  assert.deepEqual(saidTexts(t.speaker), ["I asked because I'm nosy, that's all."]);
});

test('being told to butt in less: what counts', () => {
  for (const t of [
    "Oh my god Babel you don't have to respond to everything",
    'you dont need to reply to every single thing',
    'nobody asked you',
    'no one asked',
    "I wasn't talking to you",
    "I wasn't even talking to you",
    "Nobody's talking to you.",
    'Who asked?',
    'bro who asked you',
    'Bro, nobody asked you to.',
    'stop butting in',
    'only talk when someone says your name',
    'stay out of this',
    "you don't have to respond to everything Leonardo says",
  ])
    assert.equal(asksToTalkLess(t, { aliases: ['Babel'], people: ['Leonardo', 'Mike'] }), true, t);
  // Said to a friend these are about the friend: they count only with its name.
  for (const t of ['quit interrupting', 'talk less', 'you talk way too much', 'Stop interrupting me.', 'You should talk less, you keep giving away our position.']) {
    assert.equal(asksToTalkLess(t, { aliases: ['Babel'] }), false, t);
    assert.equal(asksToTalkLess(`Babel, ${t}`, { aliases: ['Babel'] }), true, `Babel, ${t}`);
  }
  for (const t of ['We don\'t have to talk about everything.', "I don't have to answer to everyone.", 'Babel, tell him nobody asked.']) assert.equal(asksToTalkLess(t, { aliases: ['Babel'] }), false, t);
  for (const t of ["don't stop chiming in", 'I was talking to you', 'you have to respond', 'nobody asked for pineapple pizza but here we are', 'I talk less than him']) assert.equal(asksToTalkLess(t), false, t);
  // Said to someone else in the call: not to it (unless it's named too).
  const who = { aliases: ['Babel'], people: ['Mike', 'Jess'] };
  assert.equal(asksToTalkLess('Mike, you talk way too much', who), false);
  assert.equal(asksToTalkLess('Babel, you talk way too much, Mike agrees', who), true);
  assert.equal(asksToTalkLess('Babel talk less', who), true);
});

test('"you don\'t have to respond to everything": for 20 minutes only its name (or its partner\'s question) gets a reply', async () => {
  const t = makeBrain({
    chattiness: 'high',
    replies: ['<say>Fair, I will pipe down.</say>', '<say>Shotgun.</say>'],
    fast: ['<say>It really is.</say>', '<say>Should not be said.</say>'],
  });
  assert.equal(t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: "Gremlin you don't have to respond to everything" }), 'direct');
  await settle();
  assert.equal(t.brain.talkingLess(), true);
  t.advance(1000);
  assert.equal(t.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'I mean it was kind of funny though' }), 'talking-less');
  assert.equal(t.brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'yeah okay' }), 'talking-less');
  assert.equal(t.brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'wait, is that true?' }), 'followup', 'a question from the person it answered still counts');
  await settle();
  assert.equal(t.claude.calls.length, 2, '(the main model takes a question from the one it was talking with)');
  // No jokes meanwhile.
  t.brain.maybeScheduleQuip();
  assert.equal(t.brain.lullTimer, null);
  // Its name still gets an answer.
  assert.equal(t.brain.hear({ userId: 'u2', id: 5, name: 'Jess', text: 'gremlin best gun for close range' }), 'direct');
  t.advance(20 * 60000);
  assert.equal(t.brain.talkingLess(), false, 'back to normal after 20 minutes');
});

test('"nobody asked you" right after its line: it takes the hint without a word; /chattiness ends it', async () => {
  const t = makeBrain({ replies: ['<say>The rifle, trust me.</say>'] });
  await afterAnAnswer(t);
  assert.equal(t.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'nobody asked you' }), 'talk-less');
  await settle();
  assert.equal(t.claudeFast.calls.length, 0);
  assert.equal(t.speaker.said.length, 1);
  assert.equal(t.brain.talkingLess(), true);
  t.brain.setChattiness('medium');
  assert.equal(t.brain.talkingLess(), false);
  assert.match(logText(), /Jess asked me to butt in less/);
});

// ---------------------------------------------------------------------------
// C, F. Handing a follow-up on to a full answer
// ---------------------------------------------------------------------------

test('a follow-up is sent on as a lookup only when they asked something', async () => {
  const t = makeBrain({
    config: { anthropic: { webSearch: { enabled: true } } },
    replies: ['<say>Patch twenty-five point twenty-one.</say>', '<say>It came out last Tuesday.</say>'],
    fast: ['Just a laugh. [LOOKUP]', '<say>[LOOKUP]</say>'],
  });
  await afterAnAnswer(t, 'gremlin what patch are we on');
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'Ho ho ho' }), 'followup');
  await settle();
  assert.equal(t.claudeFast.calls.length, 1);
  assert.equal(t.claude.calls.length, 1, 'small talk is not sent on');
  assert.equal(t.speaker.said.length, 1, 'and nothing is said for it');
  t.advance(1000);
  assert.equal(t.brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'when did that come out' }), 'followup');
  await settle(6);
  assert.equal(t.claude.calls.length, 2, 'a question is answered properly');
  assert.deepEqual(saidTexts(t.speaker), ['Patch twenty-five point twenty-one.', 'It came out last Tuesday.']);
});

test('a marker only in its notes, next to a line of its own, is just that line', async () => {
  const t = makeBrain({ config: { anthropic: { webSearch: { enabled: true } } }, replies: ['<say>The rifle.</say>'], fast: ['No [LOOKUP] needed. <say>Told you, the rifle.</say>'] });
  await afterAnAnswer(t);
  t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'you sure' });
  await settle();
  assert.equal(t.claude.calls.length, 1);
  assert.deepEqual(saidTexts(t.speaker), ['The rifle.', 'Told you, the rifle.']);
});

test('a follow-up that runs long, or asks for [LONG], gets a proper answer instead of silence', async () => {
  const long = `<say>${'So the thing about that rant is that it just keeps going and going '.repeat(4)}and never stops.</say>`;
  for (const fast of [long, '[LONG]']) {
    const t = makeBrain({ replies: ['<say>Chuds everywhere, man.</say>', '<say>Okay, the long version: it started with a toaster.</say>'], fast: [fast] });
    await afterAnAnswer(t, 'gremlin give me your rant');
    assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'make it even longer' }), 'followup');
    await settle(6);
    assert.equal(t.claude.calls.length, 2, fast.slice(0, 20));
    assert.match(t.claude.calls[1].user, /Mike is talking to you/);
    assert.deepEqual(saidTexts(t.speaker), ['Chuds everywhere, man.', 'Okay, the long version: it started with a toaster.']);
  }
  // A joke that runs long is still just left out.
  assert.equal(cleanSpoken(long.replace(/<\/?say>/g, ''), { maxChars: 160, optional: true, wholeSentences: true }).tooLong, true);
});

// ---------------------------------------------------------------------------
// D. "One sec"
// ---------------------------------------------------------------------------

test('"one sec" comes when a search starts, and a slow answer gets one that does not claim a search', async () => {
  const searching = makeBrain({
    config: { anthropic: { webSearch: { enabled: true } } },
    replies: [
      (args) => {
        args.onToolStart?.();
        return { text: '<say>Tuesday at ten.</say>', refusal: false, searches: 1 };
      },
    ],
  });
  searching.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin when does the patch drop' });
  await settle();
  assert.equal(searching.speaker.said[0].kind, 'filler');
  assert.ok(FILLERS.includes(searching.speaker.said[0].text));
  assert.deepEqual(searching.speaker.said.slice(1), [{ text: 'Tuesday at ten.', kind: 'direct' }]);
  // No search, just slow: "One sec.", "Hang on." or "Gimme a second.", never "Lemme look that up."
  for (let i = 0; i < 12; i++) {
    const slow = makeBrain({ config: { anthropic: { webSearch: { enabled: true } } }, replies: [() => new Promise(() => {})], fillerAfterMs: 0 });
    slow.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin tell me a story' });
    await new Promise((r) => setTimeout(r, 2));
    assert.equal(slow.speaker.said.length, 1);
    assert.ok(FILLERS.slice(0, 3).includes(slow.speaker.said[0].text), slow.speaker.said[0].text);
  }
});

// ---------------------------------------------------------------------------
// E. Opening with their name
// ---------------------------------------------------------------------------

test("a follow-up doesn't open with the name of the person it's answering", async () => {
  assert.equal(withoutLeadingName("Kneeheel, you're really considering it? I'm down.", ['Kneeheel']), "You're really considering it? I'm down.");
  assert.equal(withoutLeadingName('[curious] Namjoo, what was that about?', ['Namjoo Ahluwala']), '[curious] What was that about?');
  assert.equal(withoutLeadingName('Mike, no.', ['Mike']), 'Mike, no.', 'too little left');
  assert.equal(withoutLeadingName('Jess, hand them over, please.', ['Mike']), 'Jess, hand them over, please.', 'turning to someone else');
  assert.equal(withoutLeadingName('Look, it happens to everyone.', ['Mike']), 'Look, it happens to everyone.');
  const t = makeBrain({ replies: ['<say>The rifle.</say>'], fast: ['<say>Mike, the rifle has more range, trust me.</say>'] });
  await afterAnAnswer(t);
  t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'but why the rifle' });
  await settle();
  assert.deepEqual(saidTexts(t.speaker), ['The rifle.', 'The rifle has more range, trust me.']);
});

// ---------------------------------------------------------------------------
// G, F, R. What the system prompt says
// ---------------------------------------------------------------------------

test("the rules say it can't hear sound, says bye only to someone leaving, doesn't treat old news as new, and promises nothing for later", () => {
  const sys = buildSystem({ botName: 'Gremlin', persona: 'x', songs: true })[0].text;
  assert.match(sys, /you can't hear voices, tone, volume, echo, music or background noise/);
  assert.match(sys, /Only say goodbye to someone who clearly said they're leaving the call/);
  assert.match(sys, /Things from much earlier in the call may be over by now/);
  assert.match(sys, /Never promise to do something in a moment or later/);
  assert.match(sys, /it takes a few seconds to make/);
  assert.doesNotMatch(sys, /a minute or so/);
});

// ---------------------------------------------------------------------------
// H. Phrases it has worn out
// ---------------------------------------------------------------------------

test('phrases it keeps using in a call are pointed out, longest first, not names or the topic', () => {
  const lines = ['That is a pile of text right there.', 'Another pile of text, Mike.', 'Pile of text again.', 'Cheese story is still on the table.', 'The cheese story waits.', 'Ask me about the cheese story.'];
  assert.deepEqual(overusedPhrases(lines), ['pile of text', 'cheese story']);
  assert.deepEqual(overusedPhrases(lines, { others: ['tell us the cheese story then'] }), ['pile of text'], 'they asked about it: the topic');
  assert.deepEqual(overusedPhrases(['Mike, nice.', 'Mike, nice one.', 'Mike, nice try.'], { names: ['Mike'] }), [], 'a name is not a habit');
  assert.deepEqual(overusedPhrases(['I think so.', 'I think it is.', 'I think not.']), [], 'only common words');
});

test('once it has said a phrase in three of its lines, its next prompt asks it to give it a rest', async () => {
  const t = makeBrain({
    chattiness: 'off',
    replies: ['<say>That is a pile of text.</say>', '<say>Another pile of text for you.</say>', '<say>Pile of text, again.</say>', '<say>Fine.</say>'],
  });
  for (let i = 0; i < 4; i++) {
    t.brain.hear({ userId: 'u1', id: i + 1, name: 'Mike', text: `gremlin read this number ${i}` });
    await settle();
    t.advance(30000);
  }
  assert.doesNotMatch(t.claude.calls[2].user, /said these a lot/);
  assert.match(t.claude.calls[3].user, /You've already said these a lot in this call, so leave them out unless someone brings them up: "pile of text"/);
});

// ---------------------------------------------------------------------------
// I. Laughing along
// ---------------------------------------------------------------------------

test('laughing along: one person needs a real laugh, a group less so, and not more than every four minutes', async () => {
  assert.equal(isBigLaugh('hahaha'), true);
  assert.equal(isBigLaugh('ha ha ha'), true);
  assert.equal(isBigLaugh('lmao'), true);
  assert.equal(isBigLaugh('Ha ha.'), false);
  assert.equal(isBigLaugh('hehe'), false);
  const t = makeBrain({ config: { laughAlong: true } });
  t.brain.random = () => 0;
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'ha ha' });
  await settle();
  assert.equal(t.speaker.said.length, 0, 'a polite "ha ha" from one person');
  t.advance(6000);
  t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'hahaha' });
  await settle();
  assert.equal(t.speaker.said.length, 1);
  assert.equal(t.speaker.said[0].kind, 'laugh');
  t.advance(200000);
  t.brain.hear({ userId: 'u2', id: 3, name: 'Jess', text: 'hahahaha' });
  t.brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'ha ha' });
  await settle();
  assert.equal(t.speaker.said.length, 1, 'not within four minutes');
  t.advance(50000);
  t.brain.hear({ userId: 'u2', id: 5, name: 'Jess', text: 'ha' });
  t.brain.hear({ userId: 'u1', id: 6, name: 'Mike', text: 'ha ha' });
  await settle();
  assert.equal(t.speaker.said.length, 2, 'two people laughing: even small laughs count');
});

// ---------------------------------------------------------------------------
// K, M. Call notes and learned words
// ---------------------------------------------------------------------------

test('call notes that run long lose their older middle, keeping the first sentence and the newest', () => {
  const s = Array.from({ length: 30 }, (_, i) => `Thing ${i} happened in round ${i}.`);
  const kept = keepNewest(s.join(' '), 60);
  assert.ok(kept.split(' ').length <= 60, kept);
  assert.ok(kept.startsWith('Thing 0 happened'));
  assert.ok(kept.endsWith('Thing 29 happened in round 29.'));
  assert.equal(cleanNotes(s.join(' '), { maxWords: 60 }), kept);
  assert.equal(keepNewest('Short notes. Very short.', 60), 'Short notes. Very short.');
});

test('a name it brought up itself just before is not learned from its answer', async () => {
  const learned = [];
  const t = makeBrain({
    chattiness: 'off',
    replies: ['<say>I swear on the adobo, nothing beats it.</say>', '<say>Adobo, obviously.</say>'],
    learnWords: (said, heard, opts) => learned.push({ said, heard, opts }),
  });
  t.brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'gremlin best food' });
  await settle();
  t.advance(20000);
  t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin what about adolfo' });
  await settle();
  assert.ok(learned.at(-1).opts.ownWords.includes('adobo'), JSON.stringify(learned.at(-1).opts));
  assert.deepEqual(corrections('Adobo, obviously.', ['gremlin what about adolfo'], { own: ['adobo', 'thing'] }), []);
  assert.equal(corrections('Adobo, obviously.', ['gremlin what about adolfo']).length, 1, '(without it, it would be learned)');
});

// ---------------------------------------------------------------------------
// P, Q. The log for the weekly review
// ---------------------------------------------------------------------------

test('a joke check that passes is logged, and the notes log leaves out the hidden tags', async () => {
  const t = makeBrain({ chattiness: 'high', fast: ['[PASS]'] });
  t.brain.request('quip', {});
  await settle();
  assert.match(logText(), /joke check: passed/);
  const s = makeBrain({
    chattiness: 'off',
    config: { logTranscripts: true, songs: { maxSeconds: 60 } },
    replies: ['On it. <say>On it, give me a few seconds.</say> <song style="punk" seconds="30">[Verse] Mike lost to a door</song>'],
    onSong: () => {},
  });
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin make a song about me losing to a door' });
  await settle();
  const notes = logText().split('\n').filter((l) => l.includes('direct notes (not said)'));
  assert.ok(notes.some((l) => l.includes('"On it."')), notes.join('\n'));
  assert.ok(!notes.some((l) => l.includes('Mike lost to a door')), 'not the song');
});

// ---------------------------------------------------------------------------
// J. Timing: waiting behind its own line is not the voice being slow
// ---------------------------------------------------------------------------

test('time an answer spent waiting behind its own earlier line is logged apart from the voice', async () => {
  const t = makeBrain({ chattiness: 'off', replies: ['<say>Half past nine.</say>'] });
  t.brain.speaker = {
    ...t.speaker,
    say(text, opts = {}) {
      t.advance(5000); // its earlier line still playing
      opts.onTurn?.();
      t.advance(300); // the voice
      opts.onStart?.();
      return Promise.resolve('played');
    },
  };
  const now = t.now();
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what time is it', startedAt: now - 2000, spokeUntil: now - 500, at: now - 200 });
  await settle();
  assert.match(logText(), /first sound 5\.8 s after Mike stopped talking \(direct: end of sentence 0\.3, hearing 0\.2, Claude 0\.0, waiting for my own line 5\.0, voice 0\.3\)/);
});

// ---------------------------------------------------------------------------
// From the independent review of these fixes
// ---------------------------------------------------------------------------

test('the repeat filter leaves alone an answer to a parallel question, and one they asked to hear again', async () => {
  assert.equal(nearlyRepeats('Ahri is the best pick for mid lane right now.', ['Darius is the best pick for top lane right now.']), false);
  const parallel = makeBrain({ replies: ['<say>Darius is the best pick for top lane right now.</say>', '<say>Darius is the best pick for top lane, trust me on that.</say>'] });
  await afterAnAnswer(parallel, "gremlin what's the best champ for top");
  parallel.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'wait, who is the best for top?' });
  await settle();
  assert.equal(parallel.speaker.said.length, 2, 'asked again: said again');
  const again = makeBrain({ replies: ['<say>The rifle has way more range than the shotgun.</say>'], fast: ['<say>I said the rifle has way more range than the shotgun.</say>'] });
  await afterAnAnswer(again, 'gremlin rifle or shotgun');
  again.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'Wait, say that again.' });
  await settle();
  assert.equal(again.speaker.said.length, 2);
});

test('a request for facts that is not phrased as a question still gets looked up', async () => {
  const t = makeBrain({
    config: { anthropic: { webSearch: { enabled: true } } },
    replies: ['<say>Patch twenty-five point twenty-one.</say>', '<say>Worlds starts on the first of October.</say>'],
    fast: ['[LOOKUP]'],
  });
  await afterAnAnswer(t, 'gremlin what patch are we on');
  t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'Look up when worlds starts.' });
  await settle(6);
  assert.equal(t.claude.calls.length, 2);
});

test('told to butt in less, it still answers the person it was answering when they ask it something', async () => {
  const t = makeBrain({ replies: ['<say>Fine, quieter.</say>'], fast: ['<say>Because the rifle outranges it.</say>', '<say>Sure.</say>'] });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: "gremlin you don't have to respond to everything" });
  await settle();
  t.advance(1000);
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'Tell me why.' }), 'followup');
  assert.equal(t.brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'go on' }), 'followup');
  assert.equal(t.brain.hear({ userId: 'u2', id: 4, name: 'Jess', text: 'tell me why' }), 'talking-less', 'not someone it was not answering');
});

test('"nobody asked you" from someone else does not cancel its reply to a question it was asked', async () => {
  let release;
  const t = makeBrain({ replies: ['<say>The patch dropped this morning.</say>', () => new Promise((r) => (release = r))] });
  await afterAnAnswer(t, 'gremlin did the patch drop');
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'wait, really?' }), 'followup');
  await settle();
  assert.equal(t.brain.hear({ userId: 'u2', id: 3, name: 'Jess', text: 'nobody asked you' }), 'talk-less');
  release({ text: '<say>Yep, it went live around ten.</say>', refusal: false });
  await settle();
  assert.deepEqual(saidTexts(t.speaker), ['The patch dropped this morning.', 'Yep, it went live around ten.']);
});

test('a follow-up handed on to a full answer still counts toward the replies in a row', async () => {
  const run = async (fast) => {
    const t = makeBrain({
      chattiness: 'low',
      people: ['Mike', 'Jess'],
      replies: Array.from({ length: 8 }, (_, i) => `<say>Full answer number ${i}, with words.</say>`),
      fast: Array.from({ length: 8 }, () => fast),
    });
    t.brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'hey' }); // someone else talks too
    await afterAnAnswer(t, 'gremlin tell me a story');
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(t.brain.hear({ userId: 'u1', id: i + 2, name: 'Mike', text: `and then what happened number ${i}` }));
      await settle(6);
      t.advance(1000);
    }
    return outcomes;
  };
  assert.deepEqual(await run('[LONG]'), ['followup', 'followup', 'heard', 'heard', 'heard'], 'two in a row on low chattiness, as with short ones');
});

test('a [LONG] after a teaser line hands off without saying the teaser', async () => {
  const t = makeBrain({ replies: ['<say>Chuds, everywhere.</say>', '<say>Okay, the long version: it started with a toaster.</say>'], fast: ['<say>Alright, buckle up.</say> [LONG]'] });
  await afterAnAnswer(t, 'gremlin give me your rant');
  t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'make it longer' });
  await settle(6);
  assert.deepEqual(saidTexts(t.speaker), ['Chuds, everywhere.', 'Okay, the long version: it started with a toaster.']);
  // ...but a [PASS] after notes that mention it is a pass.
  const p = makeBrain({ replies: ['<say>Chuds, everywhere.</say>'], fast: ['Not a [LONG] one. [PASS]'] });
  await afterAnAnswer(p, 'gremlin give me your rant');
  p.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'lol okay' });
  await settle(6);
  assert.equal(p.claude.calls.length, 1);
  assert.equal(p.speaker.said.length, 1);
});

test('trimming call notes keeps numbers like 25.21 and 3.5 whole', () => {
  const notes = `They played League on patch 25.21 all night. ${Array.from({ length: 30 }, (_, i) => `Round ${i} went to Mike with a 3.5 KDA.`).join(' ')}`;
  const kept = keepNewest(notes, 40);
  assert.ok(kept.startsWith('They played League on patch 25.21 all night.'), kept);
  assert.ok(kept.endsWith('Round 29 went to Mike with a 3.5 KDA.'), kept);
  assert.doesNotMatch(kept, /25\. |3\. 5/);
});

test('a leading name that starts a list of names stays', () => {
  assert.equal(withoutLeadingName('Mike, Jess and Leo all lost that one.', ['Mike']), 'Mike, Jess and Leo all lost that one.');
  assert.equal(withoutLeadingName('Mike, and you too, honestly.', ['Mike']), 'Mike, and you too, honestly.');
  assert.equal(withoutLeadingName("Leonardo, I asked because I'm nosy.", ['Leonardo']), "I asked because I'm nosy.");
});

test('an unsure call of its name does not cancel a reply someone else is waiting on', async () => {
  let release;
  const t = makeBrain({ replies: ['<say>Shotgun, every time.</say>'], fast: [() => new Promise((r) => (release = r))] });
  await afterAnAnswer(t, 'gremlin best gun');
  assert.equal(t.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'what about the rifle though' }), 'followup');
  await settle();
  assert.equal(t.brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'Gremlin', unsureName: true }), 'listening-quietly');
  release({ text: '<say>Fair, the rifle is safer at range.</say>', refusal: false });
  await settle();
  assert.deepEqual(saidTexts(t.speaker), ['Shotgun, every time.', 'Fair, the rifle is safer at range.']);
});

test('variants of one habit are pointed out once', () => {
  const lines = ['A pile of text, Mike.', 'That pile of math again.', 'Just a pile of text.', 'More pile of text.', "I'm not saying it.", "Still not saying it.", 'Not saying it, ever.', 'The cheese story waits.', 'Cheese story time.', 'Ask about the cheese story.'];
  assert.deepEqual(overusedPhrases(lines), ['pile of', 'not saying it', 'cheese story'], 'the longest when it is said as often');
});

test('statements that start like questions are not questions', () => {
  for (const t of ["Don't you dare.", 'Have it your way.', 'Did it! Finally.', 'Can you not.']) assert.equal(isQuestion(t), false, t);
  assert.equal(isQuestion('have you seen it'), true);
});

test('the "no promises for later" rule makes room for reminders, songs and pictures', () => {
  const sys = buildSystem({ botName: 'Gremlin', persona: 'x', reminders: true, songs: true, images: true })[0].text;
  assert.match(sys, /Setting up a reminder, a song or a picture with its tag in that same reply counts as doing it now/);
  assert.doesNotMatch(buildSystem({ botName: 'Gremlin', persona: 'x' })[0].text, /Setting up/);
});

test('asking it for something: requests count, callouts to teammates do not', () => {
  for (const t of ['Look up when worlds starts.', 'Tell me who won.', 'Explain that.', 'Go on.', 'Wait, say that again.', "Sorry, I didn't catch that.", 'You cut out.', 'Come again.', 'I wonder what the best build for Jinx is.', 'is that true'])
    assert.equal(asksSomething(t, ['babel']), true, t);
  for (const t of ['Keep going, keep going!', 'Go on, push!', 'Check mid.', 'Give me the blue buff.', 'Find him, he went bot.', 'Tell him to group.', 'Search the bushes.', 'Look up!', 'Ho ho ho', 'I need to know why'])
    assert.equal(asksSomething(t, ['babel']), false, t);
});

test('told to butt in less, even the only one talking gets no reply check for small talk', async () => {
  const t = makeBrain({ people: ['Mike'], replies: ['<say>Fine, quieter.</say>'] });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: "gremlin you don't have to respond to everything" });
  await settle();
  t.advance(1000);
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'I am going to build a collector.' }), 'talking-less');
  assert.equal(t.claudeFast.calls.length, 0);
});

test("its own word with a 's is still its own word", async () => {
  const learned = [];
  const t = makeBrain({
    chattiness: 'off',
    replies: ["<say>Hell yeah, adobo's incredible.</say>", '<say>Adobo, obviously.</say>'],
    learnWords: (said, heard, opts) => learned.push({ said, heard, opts }),
  });
  t.brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'gremlin best food' });
  await settle();
  t.advance(20000);
  t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin what about adolfo' });
  await settle();
  assert.ok(learned.at(-1).opts.ownWords.includes('adobo'));
});

test('a reply that mentions [LONG] in its notes and ends with PASS is a pass', async () => {
  const t = makeBrain({ replies: ['<say>Chuds, everywhere.</say>'], fast: ['Not a [LONG] one, just a laugh. PASS'] });
  await afterAnAnswer(t, 'gremlin give me your rant');
  t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'lol okay' });
  await settle(6);
  assert.equal(t.claude.calls.length, 1);
  assert.equal(t.speaker.said.length, 1);
});
