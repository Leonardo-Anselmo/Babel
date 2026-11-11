// Fixes from the Oct 29 refinement pass (the night's calls with friends, then Daniel's
// Venice tests): it carries on through a short comment said over it, a question from the
// one it was talking with goes to the main model, with VENICE_FOR=all Claude decides
// whether a follow-up gets a reply at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain, isAside } from '../src/brain.js';
import { setLogFile } from '../src/log.js';
import { buildSystem, followupCheck, followupCheckSaysYes } from '../src/prompts.js';

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'refine2-')), 'bot.log');
setLogFile(LOG);
const logText = () => fs.readFileSync(LOG, 'utf8');

const baseConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  timezone: 'UTC',
  defaultChattiness: 'medium',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
  anthropic: { webSearch: { enabled: false } },
  listen: {},
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function fakeClient(replies, name) {
  const calls = [];
  const queue = [...replies];
  return {
    name,
    calls,
    canSearchNow: false,
    async createMessage(args) {
      calls.push(args);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(args);
      args.onText?.(next ?? '[PASS]');
      return { text: next ?? '[PASS]', refusal: false, stopReason: 'end_turn', searches: 0, citations: [] };
    },
  };
}

function autoSpeaker() {
  const said = [];
  return {
    said,
    speaking: false,
    wasAudibleBetween: () => false,
    say(text, opts = {}) {
      said.push(text);
      opts.onStart?.();
      return Promise.resolve('played');
    },
    stop() {},
    stopKind() {},
    dropOptional() {},
  };
}

function makeBrain({ replies = [], fast = [], venice = null, config = {}, people = ['Mike', 'Jess'] } = {}) {
  let now = 9_000_000;
  const claude = fakeClient(replies, 'claude');
  const claudeFast = fakeClient(fast, 'fast');
  const speaker = autoSpeaker();
  const brain = new Brain({
    config: { ...baseConfig, ...config },
    claude,
    claudeFast,
    venice,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people, activities: [] }),
    getFacts: () => [],
    isAnyoneSpeaking: () => false,
    clock: () => now,
  });
  return { brain, claude, claudeFast, speaker, advance: (ms) => (now += ms) };
}

/** It answers Mike by name, then a moment passes: his next lines may be replies to it. */
async function afterAnAnswer(t, ask = 'gremlin which movie should we watch') {
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: ask });
  await settle();
  t.advance(1000);
}

// ---------------------------------------------------------------------------
// Talked over by a short comment, it carries on
// ---------------------------------------------------------------------------

test('a short comment is an aside; a question, a request, a correction or its name is not', () => {
  const aliases = ['gremlin'];
  // Said over it in the Oct 29 calls (it dropped its line for each).
  for (const s of ["That's so crazy", 'thing is awesome.', "That's crazy bro.", 'I think like last year.', "Yeah, we'll see about that body", 'oh my god', "lmao that's true"]) {
    assert.equal(isAside(s, aliases), true, s);
  }
  for (const s of [
    'Not yet.',
    "oh we've seen that already",
    'Add it to the list',
    "Gremlin, what's",
    'Not you Gremlin',
    'what was that',
    'is that right',
    "that's wrong",
    "I didn't say that",
    'okay add The Thing',
    'Wait, did you hear my burp?',
    'Oh the one with all the influencers', // seven words: more than a comment
  ]) {
    assert.equal(isAside(s, aliases), false, s);
  }
});

/** A speaker that can pause; the test starts the line. */
function pausingSpeaker() {
  const lines = [];
  let current = null;
  return {
    lines,
    paused: false,
    resumes: 0,
    stops: 0,
    speaking: false,
    wasAudibleBetween: () => false,
    say(text, opts = {}) {
      const line = { text, opts };
      lines.push(line);
      return new Promise((resolve) => {
        line.end = (outcome) => {
          if (line.outcome) return;
          line.outcome = outcome;
          if (lines[current] === line) current = null;
          resolve(outcome);
        };
      });
    },
    start(i) {
      lines[i].started = true;
      current = i;
      lines[i].opts.onStart?.();
    },
    nowPlaying() {
      return current === null ? null : { kind: lines[current].opts.kind, tag: lines[current].opts.tag, paused: this.paused };
    },
    pause() {
      if (current === null || this.paused) return false;
      this.paused = true;
      return true;
    },
    resume() {
      if (!this.paused) return false;
      this.paused = false;
      this.resumes++;
      return true;
    },
    stop() {
      this.stops++;
      this.paused = false;
      for (const l of lines) l.end?.('stopped');
    },
    stopKind() {},
    dropOptional() {},
  };
}

async function pausedForMike() {
  let now = 4_000_000;
  const talking = new Map();
  const speaker = pausingSpeaker();
  const claude = fakeClient(['<say>Try The Descent, it is properly scary and nobody in it is dubbed.</say>'], 'claude');
  const brain = new Brain({
    config: { ...baseConfig, defaultChattiness: 'off' },
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
    isSpeaking: (u) => talking.has(u),
    voicedMs: (u) => talking.get(u) ?? 0,
    isHearingFrom: () => false,
    clock: () => now,
  });
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what horror movie should we watch' }), 'direct');
  await settle();
  speaker.start(0);
  brain.speechStarted('u1', 2);
  talking.set('u1', 700);
  await wait(250);
  assert.ok(speaker.paused, 'it paused to listen');
  talking.delete('u1');
  return { brain, speaker, advance: (ms) => (now += ms) };
}

test('talked over with a short comment, it carries on; with a correction it drops the rest and answers', async () => {
  const a = await pausedForMike();
  assert.equal(a.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: "That's so crazy" }), 'carried-on');
  assert.equal(a.speaker.resumes, 1);
  assert.equal(a.speaker.stops, 0);
  assert.match(logText(), /carried on with my answer \(it was only a comment\)/);
  a.brain.close();

  const b = await pausedForMike();
  assert.notEqual(b.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: "oh we've seen that already" }), 'carried-on');
  assert.equal(b.speaker.resumes, 0);
  assert.ok(b.speaker.stops >= 1, 'it dropped the rest');
  b.brain.close();
});

// ---------------------------------------------------------------------------
// A question from the one it was talking with goes to the main model
// ---------------------------------------------------------------------------

test('a question right after its line from the one it was talking with goes to the main model; other follow-ups stay quick', async () => {
  const t = makeBrain({ replies: ['<say>Lake Mungo or Wolf Creek.</say>', '<say>Both are in English.</say>'], fast: ['[PASS]'] });
  await afterAnAnswer(t);
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'out of those, which ones are in English?' }), 'followup');
  await settle();
  assert.equal(t.claude.calls.length, 2);
  assert.equal(t.claude.calls[1].kind, 'followup');
  assert.equal(t.claudeFast.calls.length, 0);
  assert.deepEqual(t.speaker.said, ['Lake Mungo or Wolf Creek.', 'Both are in English.']);

  // Not a question: the quick model, as before.
  const q = makeBrain({ replies: ['<say>Lake Mungo.</say>'], fast: ['[PASS]'] });
  await afterAnAnswer(q);
  assert.equal(q.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'oh nice I love that one' }), 'followup');
  await settle();
  assert.equal(q.claude.calls.length, 1);
  assert.equal(q.claudeFast.calls.length, 1);
});

// ---------------------------------------------------------------------------
// VENICE_FOR=all: Claude decides whether a follow-up gets a reply
// ---------------------------------------------------------------------------

test("Claude's check: one word, about whether to reply (not what to say), and only a clear NO keeps it quiet", () => {
  const { system, user } = followupCheck({ botName: 'Babel', name: 'Mike', partner: true, asked: true, transcript: '[21:00] Mike: lol' });
  assert.match(system, /You don't write the reply\. Answer with one word: YES or NO\./);
  assert.match(user, /<recent_transcript>\n\[21:00\] Mike: lol\n<\/recent_transcript>/);
  assert.match(user, /Their newest line asks something right after Babel's line/);
  assert.equal(followupCheckSaysYes('NO'), false);
  assert.equal(followupCheckSaysYes('No.'), false);
  assert.equal(followupCheckSaysYes('YES'), true);
  assert.equal(followupCheckSaysYes("I can't help with that"), true, 'anything but a clear no lets it through');
  assert.equal(followupCheckSaysYes(''), true);
});

test('VENICE_FOR=all: Venice writes the follow-up, but a NO from Claude keeps it quiet', async () => {
  const venice = { ...fakeClient(['<say>Lake Mungo.</say>', '<say>Mike, the one with the ladder again.</say>'], 'venice'), canSearchNow: false };
  const t = makeBrain({ fast: ['NO'], venice, config: { venice: { kinds: ['direct', 'followup', 'quip'] } } });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin which movie' });
  await settle();
  t.advance(1000);
  // (With Venice writing answers, the answer above was Venice's too.)
  venice.calls.length = 0;
  assert.equal(t.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'Mike did you finish your fries' }), 'followup');
  await settle();
  assert.equal(venice.calls.length, 1, 'asked alongside');
  assert.equal(t.claudeFast.calls.length, 1);
  assert.equal(t.claudeFast.calls[0].maxTokens, 5);
  assert.equal(t.claudeFast.calls[0].onText, undefined, 'the check never speaks');
  assert.deepEqual(t.speaker.said, ['Lake Mungo.']);
  assert.match(logText(), /chose not to reply to Jess \(followup, Claude's check\)/);
});

test("VENICE_FOR=all: a YES from Claude (or no answer from it) lets Venice's line through", async () => {
  const run = async (fast) => {
    const venice = { ...fakeClient(['<say>Fair point, the fries were mid.</say>', '<say>Lake Mungo.</say>'], 'venice'), canSearchNow: false };
    const t = makeBrain({ fast, venice, config: { venice: { kinds: ['followup'] } }, replies: ['<say>Lake Mungo.</say>'] });
    t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin which movie' });
    await settle();
    t.advance(1000);
    assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'the fries were mid though' }), 'followup');
    await settle();
    return t;
  };
  const yes = await run(['YES']);
  assert.ok(yes.speaker.said.includes('Fair point, the fries were mid.'));
  const failed = await run([new Error('overloaded')]);
  assert.ok(failed.speaker.said.includes('Fair point, the fries were mid.'), 'Claude unreachable: Venice decides');
  assert.match(logText(), /couldn't ask Claude whether to reply \(overloaded\), so Venice decides/);
});

test("VENICE_FOR=all: for a question from the one it was talking with, the main model makes the call", async () => {
  const venice = { ...fakeClient(['<say>Both, and Lake Mungo is scarier.</say>'], 'venice'), canSearchNow: false };
  const t = makeBrain({ replies: ['<say>Lake Mungo or Wolf Creek.</say>', 'YES'], fast: [], venice, config: { venice: { kinds: ['followup'] } } });
  await afterAnAnswer(t);
  t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'which ones are in English?' });
  await settle();
  assert.equal(t.claude.calls.length, 2);
  assert.equal(t.claude.calls[1].maxTokens, 5);
  assert.ok(t.speaker.said.includes('Both, and Lake Mungo is scarier.'));
});

// ---------------------------------------------------------------------------
// Fixes from the independent review of this pass
// ---------------------------------------------------------------------------

test('review: requests, corrections and questions without a "?" are not asides', () => {
  const aliases = ['gremlin'];
  for (const s of ['remind me in ten minutes', 'roast Jess', 'slow down', 'one more time', 'I meant the other one', 'we watched that', 'heard that one', 'and for mid', 'but which one is better', 'you sure', 'shut up', 'be quiet', 'nobody asked you', 'what about the rifle']) {
    assert.equal(isAside(s, aliases), false, s);
  }
  for (const s of ["That's so crazy", 'fair enough', 'oh my god', 'thing is awesome.']) assert.equal(isAside(s, aliases), true, s);
});

test('review: "shut up" or "nobody asked you" said over it is never carried on through', async () => {
  const a = await pausedForMike();
  assert.notEqual(a.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'shut up' }), 'carried-on');
  assert.equal(a.speaker.resumes, 0);
  a.brain.close();
  const b = await pausedForMike();
  assert.notEqual(b.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'nobody asked you' }), 'carried-on');
  assert.equal(b.speaker.resumes, 0);
  b.brain.close();
});

test('review: a question in the second piece of a follow-up still goes to the main model', async () => {
  let release;
  const t = makeBrain({ replies: ['<say>Lake Mungo.</say>', '<say>I am good too.</say>'], fast: [() => new Promise((r) => (release = r))] });
  await afterAnAnswer(t);
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: "yeah I'm good", startedAt: 9_001_000, spokeUntil: 9_001_800 }), 'followup');
  await settle();
  t.brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'what about you', startedAt: 9_002_200, spokeUntil: 9_003_000 });
  release?.({ text: '[PASS]', refusal: false });
  await settle();
  const last = t.claude.calls.at(-1);
  assert.equal(last.kind, 'followup', 'the redo went to the main model');
  assert.match(last.user, /Their newest line asks something/);
});

test('review: past 1.5 s without an answer from Claude, Venice decides; when Venice failed and Claude wrote it, the check is not used', async () => {
  const venice = { ...fakeClient(['<say>Lake Mungo.</say>', '<say>The fries were mid.</say>'], 'venice'), canSearchNow: false };
  const slow = () => new Promise((r) => setTimeout(() => r({ text: 'NO', refusal: false }), 2500));
  const t = makeBrain({ fast: [slow], venice, config: { venice: { kinds: ['direct', 'followup'] } } });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin which movie' });
  await settle();
  t.advance(1000);
  t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'the fries were mid though' });
  await wait(1700);
  await settle();
  assert.ok(t.speaker.said.includes('The fries were mid.'), t.speaker.said.join(' | '));
  assert.match(logText(), /Claude's check on whether to reply took too long, so Venice decides/);

  const broke = { ...fakeClient([], 'venice'), canSearchNow: false };
  broke.createMessage = async () => {
    const err = new Error('Venice 402: out of credit');
    err.status = 402;
    throw err;
  };
  const u = makeBrain({ replies: ['<say>Lake Mungo.</say>'], fast: ['NO', '<say>Claude covers this one.</say>'], venice: broke, config: { venice: { kinds: ['followup'] } } });
  u.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin which movie' });
  await settle();
  u.advance(1000);
  u.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'the fries were mid though' });
  await settle(10);
  assert.ok(u.speaker.said.includes('Claude covers this one.'), u.speaker.said.join(' | '));
});

// ---------------------------------------------------------------------------
// Second look by the reviewer
// ---------------------------------------------------------------------------

test('second look: comments and requests, sorted', () => {
  const aliases = ['gremlin'];
  for (const s of ['now roast Mike', 'I asked about mid', 'same joke', 'louder', 'pause', 'actually it was Jess', 'I mean the other one']) assert.equal(isAside(s, aliases), false, s);
  for (const s of ['so true', 'so good', "that's actually crazy", "that's mean", 'the other team is cracked']) assert.equal(isAside(s, aliases), true, s);
});

// ---------------------------------------------------------------------------
// System prompt and repeated comments
// ---------------------------------------------------------------------------

test('the system prompt retains its content rule', () => {
  assert.match(buildSystem({ botName: 'Babel', persona: 'Anything goes.' })[0].text, /Protect children and vulnerable people/);
});

test('same and same here are comments; same joke is a request', () => {
  assert.equal(isAside('same', ['gremlin']), true);
  assert.equal(isAside('same here', ['gremlin']), true);
  assert.equal(isAside('same joke', ['gremlin']), false);
});
