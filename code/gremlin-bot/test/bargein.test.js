// Saying its name while it talks: the early check in the call session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { AudioPlayerStatus } from '@discordjs/voice';
import { Brain } from '../src/brain.js';
import { VoiceSession } from '../src/session.js';
import { Speaker } from '../src/speaker.js';

function makeSession({ recent = ['Let me tell you about the time I ate a router.'], heard = async () => 'Gremlin wait' } = {}) {
  const members = new Map([['u1', { displayName: 'Mike', user: { bot: false } }]]);
  const guild = {
    id: 'g1',
    name: 'Test',
    channels: { cache: new Map([['B', { id: 'B', name: 'B', members: new Map() }]]) },
    voiceStates: { cache: new Map() },
    members: { cache: members, me: { id: 'bot' }, fetch: async () => ({}) },
  };
  const s = new VoiceSession({
    client: { user: { id: 'bot' } },
    guild,
    voiceChannel: { id: 'B' },
    textChannel: null,
    config: { botName: 'Gremlin', botAliases: ['gremlin'], stt: { extraTerms: [] }, logTranscripts: false, autoLeaveSeconds: 60 },
    memory: { isOptedOut: () => false, chattiness: () => null, facts: () => [] },
  });
  s.ready = true;
  const calls = { cutIns: [], dropped: [], heard: [], stt: [] };
  s.speaker = { speaking: true, audible: true };
  s.stt = {
    transcribe: (wav, opts) => {
      calls.stt.push(opts);
      return heard(wav, opts);
    },
    async transcribeDetailed(wav, opts) {
      return { text: await this.transcribe(wav, opts), wake: null, provider: 'test' };
    },
  };
  s.brain = {
    recentLines: () => recent,
    isOwnEcho: () => false,
    cutIn: (userId, id) => calls.cutIns.push([userId, id]),
    dropCutIn: (userId, id) => calls.dropped.push([userId, id]),
    hear: (h) => calls.heard.push(h),
  };
  return { s, calls };
}

const peek = { userId: 'u1', id: 1, wav: Buffer.alloc(32), durationMs: 900 };

test('saying its name over it stops it before the sentence is even finished', async () => {
  const { s, calls } = makeSession();
  await s.onPeek(peek);
  assert.deepEqual(calls.cutIns, [['u1', 1]], 'tied to the sentence it was caught in');
  assert.ok(calls.stt[0].signal instanceof AbortSignal, 'the early check has its own short time limit');
});

test('its name alone over it, when Whisper was far from sure of it, does not stop it', async () => {
  const { s, calls } = makeSession({ heard: async () => 'Gremlin' });
  s.stt.transcribeDetailed = async (wav, opts) => ({ text: await s.stt.transcribe(wav, opts), wake: null, unsureName: true, provider: 'test' });
  await s.onPeek(peek);
  assert.deepEqual(calls.cutIns, [], 'it keeps talking; their whole sentence is heard once they finish');
});

test('talking over it without its name changes nothing', async () => {
  const { s, calls } = makeSession({ heard: async () => 'hahaha no way' });
  await s.onPeek(peek);
  assert.deepEqual(calls.cutIns, []);
});

test('no early check while it is saying its own name (a mic could pick that up)', async () => {
  const { s, calls } = makeSession({ recent: ['Gremlin does not do homework.'] });
  await s.onPeek(peek);
  assert.equal(calls.stt.length, 0);
  assert.deepEqual(calls.cutIns, []);
});

test('no early check if it said its name a few seconds ago, even in an earlier line', async () => {
  const { s, calls } = makeSession({ recent: ['Gremlin is starving.', 'Mike, your aim is a war crime.'] });
  await s.onPeek(peek);
  assert.equal(calls.stt.length, 0);
});

test('no early check unless it is actually making sound', async () => {
  const { s, calls } = makeSession();
  s.speaker.audible = false; // a line is only waiting for a pause
  await s.onPeek(peek);
  assert.equal(calls.stt.length, 0);
});

test('a sentence that comes back empty lets go of its cut-in', async () => {
  const { s, calls } = makeSession({ heard: async () => '' });
  await s.onUtterance({ userId: 'u1', id: 3, wav: Buffer.alloc(32), durationMs: 1500, endedAt: Date.now() });
  assert.deepEqual(calls.dropped, [['u1', 3]]);
  assert.equal(calls.heard.length, 0);
});

test('the brain gets the sentence id and when they were talking', async () => {
  const { s, calls } = makeSession({ heard: async () => 'gremlin what' });
  await s.onUtterance({ userId: 'u1', id: 3, wav: Buffer.alloc(32), durationMs: 1500, startedAt: 100, spokeUntil: 1600, endedAt: 2300 });
  const h = calls.heard[0];
  assert.deepEqual([h.id, h.startedAt, h.spokeUntil, h.at, h.name], [3, 100, 1600, 2300, 'Mike']);
});

test('a slow early check does not cut off the answer to that same sentence', async () => {
  let finishPeek;
  const { s, calls } = makeSession({
    heard: (_wav, opts) =>
      opts.durationMs === 900 ? new Promise((r) => (finishPeek = r)) : Promise.resolve('gremlin what is up'),
  });
  const early = s.onPeek(peek);
  // The full sentence comes in and is handled first...
  await s.onUtterance({ userId: 'u1', id: 1, wav: Buffer.alloc(32), durationMs: 1800, endedAt: Date.now() });
  assert.equal(calls.heard.length, 1);
  // ...and the bot is now answering it when the early check finally returns.
  finishPeek('gremlin');
  await early;
  assert.deepEqual(calls.cutIns, [], 'the answer is not interrupted');
});

test('the early check still counts if their full sentence is still being transcribed', async () => {
  let finishFull;
  const { s, calls } = makeSession({
    heard: (_wav, opts) => (opts.durationMs === 900 ? Promise.resolve('gremlin hold') : new Promise((r) => (finishFull = r))),
  });
  const full = s.onUtterance({ userId: 'u1', id: 1, wav: Buffer.alloc(32), durationMs: 1800, endedAt: Date.now() });
  await s.onPeek(peek);
  assert.deepEqual(calls.cutIns, [['u1', 1]]);
  finishFull('gremlin hold on');
  await full;
  assert.equal(calls.heard.length, 1);
});

test('one early check per person at a time', async () => {
  let finish;
  const { s, calls } = makeSession({ heard: () => new Promise((r) => (finish = r)) });
  const first = s.onPeek(peek);
  await s.onPeek({ ...peek, durationMs: 2000 });
  assert.equal(calls.stt.length, 1);
  finish('gremlin');
  await first;
  assert.deepEqual(calls.cutIns, [['u1', 1]]);
});

// The real brain and mouth together: cut it off mid-line, then it answers.

class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.state = { status: AudioPlayerStatus.Idle };
    this.played = 0;
  }
  setStatus(status) {
    const old = this.state;
    this.state = { status };
    this.emit('stateChange', old, this.state);
  }
  play() {
    this.played++;
    this.setStatus(AudioPlayerStatus.Playing);
  }
  stop() {
    if (this.state.status !== AudioPlayerStatus.Idle) this.setStatus(AudioPlayerStatus.Idle);
    return true;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('cut off mid-line: it goes quiet, remembers it was cut off, then answers the person who cut in', async () => {
  const player = new FakePlayer();
  const tts = { stream: async () => ({ stream: Readable.from([Buffer.alloc(48000)]), sampleRate: 24000 }) };
  const speaker = new Speaker({ tts, player });
  const prompts = [];
  const replies = ['Once upon a time there was a goblin who ate a router.', 'Fine, Jess, what.'];
  const claude = {
    async createMessage(args) {
      prompts.push(args.user);
      return { text: replies.shift(), refusal: false };
    },
  };
  const brain = new Brain({
    config: {
      botName: 'Gremlin',
      botAliases: ['gremlin'],
      timezone: 'UTC',
      defaultChattiness: 'off',
      persona: 'You are Gremlin.',
      lore: '',
      tts: { audioTags: false },
      transcript: { maxLines: 40, maxMinutes: 15 },
    },
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
  });

  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin tell me a story' });
  await wait(150);
  assert.equal(player.played, 1);
  assert.equal(player.state.status, AudioPlayerStatus.Playing);

  brain.cutIn('u2'); // Jess said "Gremlin..." over it
  await wait(20);
  assert.equal(player.state.status, AudioPlayerStatus.Idle, 'stopped talking right away');
  assert.equal(speaker.speaking, false);

  brain.hear({ userId: 'u2', name: 'Jess', text: 'ok but what about me' });
  await wait(150);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /goblin who ate a router\. \(got cut off here\)/);
  assert.match(prompts[1], /Jess is talking to you/);
  assert.equal(player.played, 2, 'answered Jess');
  player.setStatus(AudioPlayerStatus.Idle);
  brain.close();
});

function realPair(replies) {
  const player = new FakePlayer();
  const tts = { stream: async () => ({ stream: Readable.from([Buffer.alloc(48000)]), sampleRate: 24000 }) };
  const speaker = new Speaker({ tts, player });
  const prompts = [];
  const queue = [...replies];
  const claude = {
    async createMessage(args) {
      prompts.push(args.user);
      const next = queue.shift();
      return typeof next === 'function' ? next(args) : { text: next, refusal: false };
    },
  };
  const brain = new Brain({
    config: {
      botName: 'Gremlin',
      botAliases: ['gremlin'],
      timezone: 'UTC',
      defaultChattiness: 'off',
      persona: 'You are Gremlin.',
      lore: '',
      tts: { audioTags: false },
      transcript: { maxLines: 40, maxMinutes: 15 },
    },
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
  });
  return { player, speaker, brain, prompts };
}

test('"Gremlin!" shouted over a line that ends before the transcript is back still means "wait"', async () => {
  const { player, speaker, brain, prompts } = realPair(['Let me explain the lore of this game in detail.']);
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin explain the lore' });
  await wait(150);
  assert.equal(speaker.audible, true);
  const startedAt = Date.now();
  await wait(400); // Jess shouts "Gremlin!" while it talks
  const spokeUntil = Date.now();
  player.setStatus(AudioPlayerStatus.Idle); // the line finishes on its own
  await wait(20);
  assert.equal(speaker.speaking, false);
  assert.equal(brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'Gremlin!', startedAt, spokeUntil }), 'listening');
  assert.equal(prompts.length, 1, 'no "What?" yet: waiting for the rest');
  brain.close();
});

test('calling it again while it was still thinking lets the answer play, with no extra "Yeah?"', async () => {
  let release;
  const slow = () => new Promise((r) => (release = r));
  const { player, speaker, brain, prompts } = realPair([slow, 'Since you asked twice.']);
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what is the best gun' });
  await wait(20);
  const startedAt = Date.now();
  await wait(300); // "hey Gremlin?" while it's still writing the answer
  const spokeUntil = Date.now();
  release({ text: 'The one you keep missing with.', refusal: false });
  await wait(150);
  assert.equal(speaker.audible, true, 'the answer started after he stopped');
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'hey gremlin?', startedAt, spokeUntil }), 'acknowledged');
  await wait(20);
  assert.equal(speaker.audible, true, 'the answer keeps playing');
  player.setStatus(AudioPlayerStatus.Idle);
  await wait(150);
  assert.equal(player.played, 1, 'the answer was the reply: no "Yeah?" after it');
  assert.equal(prompts.length, 1);
  // ...and it's still listening to Mike: what he says next gets answered.
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'no I meant for snipers', startedAt: Date.now() }), 'direct');
  await wait(150);
  assert.equal(prompts.length, 2);
  player.setStatus(AudioPlayerStatus.Idle);
  brain.close();
});
