// Talking over it: the person it's answering makes it pause (a laugh lets it carry
// on, anything else gets answered), the name detector, and looking at the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { AudioPlayerStatus } from '@discordjs/voice';
import { Brain, isJustAReaction } from '../src/brain.js';
import { Speaker } from '../src/speaker.js';

const baseConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  timezone: 'UTC',
  defaultChattiness: 'off',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
  anthropic: { webSearch: { enabled: false } },
  listen: {},
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
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

/** A speaker that can pause: the test starts lines and says how they end. */
function pausingSpeaker() {
  const lines = [];
  let current = null;
  return {
    lines,
    paused: false,
    pauses: 0,
    resumes: 0,
    stops: 0,
    speaking: false,
    wasAudibleBetween: () => false,
    say(text, opts = {}) {
      const line = { text, opts };
      lines.push(line);
      return new Promise((resolve) => {
        line.end = (outcome) => {
          if (!line.outcome) {
            line.outcome = outcome;
            if (lines[current] === line) current = null;
            resolve(outcome);
          }
        };
        opts.signal?.addEventListener('abort', () => {
          if (!line.started) line.end('dropped');
        });
      });
    },
    start(i) {
      lines[i].started = true;
      current = i;
      lines[i].opts.onStart?.();
    },
    nowPlaying() {
      if (current === null) return null;
      const l = lines[current];
      return { kind: l.opts.kind, tag: l.opts.tag, paused: this.paused };
    },
    pause() {
      if (current === null || this.paused) return false;
      this.paused = true;
      this.pauses++;
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

function setup({ replies = ['Once upon a time a goblin ate a router, and it was delicious.'], config = {}, owner = null, screenshot } = {}) {
  let now = 9_000_000;
  const claude = fakeClaude(replies);
  const speaker = pausingSpeaker();
  const talking = new Map(); // userId -> how much of their current sentence was talking (ms)
  const hearing = new Set(); // users whose finished sentence is being transcribed
  const brain = new Brain({
    config: { ...baseConfig, ...config, listen: { ...baseConfig.listen, ...config.listen } },
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
    isSpeaking: (u) => talking.has(u),
    voicedMs: (u) => talking.get(u) ?? 0,
    isHearingFrom: (u) => hearing.has(u),
    isOwner: (u) => u === owner,
    getScreenshot: screenshot,
    clock: () => now,
  });
  return { brain, claude, speaker, talking, hearing, advance: (ms) => (now += ms) };
}

/** Mike asks, the answer starts playing. */
async function answering(t) {
  assert.equal(t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin tell me a story' }), 'direct');
  await settle();
  t.speaker.start(0);
}

/** Mike talks over the answer long enough for it to pause. */
async function mikeTalksOver(t, id = 2) {
  t.brain.speechStarted('u1', id);
  t.talking.set('u1', 200);
  await wait(150);
  assert.equal(t.speaker.pauses, 0, 'a short sound does not pause it');
  t.talking.set('u1', 700);
  await wait(150);
  assert.equal(t.speaker.pauses, 1, 'it paused to listen');
}

/** Mike's sentence ends and is on its way to being transcribed. */
function mikeStops(t) {
  t.talking.delete('u1');
  t.hearing.add('u1');
}

test('a laugh or "yeah" is only a reaction; anything with more in it is not', () => {
  for (const s of ['hahaha', 'Haha yeah.', 'lol true', 'oh wow', 'yeah yeah', 'mm', 'nice']) assert.equal(isJustAReaction(s), true, s);
  for (const s of ['wait what', 'no', 'huh', 'haha but which one', 'yeah but why', '', 'ok so what about the boss']) assert.equal(isJustAReaction(s), false, s);
});

test('the person it is answering talks over it: it pauses, and carries on after a laugh', async () => {
  const t = setup();
  await answering(t);
  await mikeTalksOver(t);
  assert.equal(t.speaker.nowPlaying().paused, true);
  mikeStops(t);
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'hahaha' }), 'carried-on');
  assert.equal(t.speaker.resumes, 1, 'carried on where it stopped');
  assert.equal(t.speaker.stops, 0);
  assert.equal(t.claude.calls.length, 1, 'no new reply for a laugh');
  t.brain.close();
});

test('anything else from them while it is paused gets answered instead', async () => {
  const t = setup({ replies: ['Once upon a time a goblin ate a router.', 'The red one, obviously.'] });
  await answering(t);
  await mikeTalksOver(t);
  mikeStops(t);
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'wait which router was it' }), 'direct');
  assert.equal(t.speaker.stops, 1, 'the rest of the old answer is dropped');
  assert.equal(t.speaker.resumes, 0);
  await settle();
  assert.equal(t.claude.calls.length, 2);
  assert.match(t.claude.calls[1].user, /or you were answering them/, 'it may still pass if that was for someone else');
  assert.match(t.claude.calls[1].user, /\(got cut off here\)/, 'it knows it was cut off');
  t.brain.close();
});

test('someone else talking over it does not pause it', async () => {
  const t = setup();
  await answering(t);
  t.brain.speechStarted('u2', 2);
  t.talking.set('u2', 900);
  await wait(250);
  assert.equal(t.speaker.pauses, 0);
  t.brain.close();
});

test('paused too long: it drops the answer, and their sentence still gets answered', async () => {
  const t = setup({ replies: ['Once upon a time a goblin ate a router.', 'Got it, long story short: yes.'] });
  await answering(t);
  await mikeTalksOver(t);
  t.advance(8100);
  await wait(250);
  assert.equal(t.speaker.stops, 1, 'gave up on the paused answer');
  assert.equal(t.brain.paused, null);
  mikeStops(t);
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'and that is why I never trust the north side' }), 'direct');
  await settle();
  assert.match(t.claude.calls[1].user, /or you were answering them/);
  t.brain.close();
});

test('its own voice in their mic: it carries on, and after twice it stops pausing for them', async () => {
  const t = setup();
  await answering(t);
  const line = t.speaker.lines[0].text;
  for (let i = 0; i < 2; i++) {
    await mikeTalksOver(t, 2 + i);
    t.speaker.pauses = 0;
    mikeStops(t);
    assert.equal(t.brain.hear({ userId: 'u1', id: 2 + i, name: 'Mike', text: line }), 'echo');
    t.hearing.delete('u1');
  }
  assert.equal(t.speaker.resumes, 2);
  t.brain.speechStarted('u1', 4);
  t.talking.set('u1', 900);
  await wait(250);
  assert.equal(t.speaker.pauses, 0, 'no more pausing for that mic');
  t.brain.close();
});

test('they went quiet and nothing came of it: it carries on', async () => {
  const t = setup();
  await answering(t);
  await mikeTalksOver(t);
  t.talking.delete('u1'); // too short to count: nothing is being transcribed
  await wait(250);
  t.advance(1300);
  await wait(250);
  assert.equal(t.speaker.resumes, 1);
  t.brain.close();
});

test('their sentence came back empty: it carries on', async () => {
  const t = setup();
  await answering(t);
  await mikeTalksOver(t);
  mikeStops(t);
  t.brain.dropCutIn('u1', 2);
  assert.equal(t.speaker.resumes, 1);
  t.brain.close();
});

test('TALK_OVER_PAUSE off: it never pauses', async () => {
  const t = setup({ config: { listen: { talkOverPause: false } } });
  await answering(t);
  t.brain.speechStarted('u1', 2);
  t.talking.set('u1', 900);
  await wait(250);
  assert.equal(t.speaker.pauses, 0);
  t.brain.close();
});

// ---------------------------------------------------------------------------
// The name detector
// ---------------------------------------------------------------------------

test('the name detector alone counts as talking to it, and then the reply may pass', async () => {
  const t = setup({ replies: ['Half past nine.'] });
  assert.equal(t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'table what time is it', wake: 0.93 }), 'direct');
  await settle();
  assert.match(t.claude.calls[0].user, /or you were answering them/);
});

test('a detector score under its threshold is not enough', () => {
  const t = setup();
  assert.equal(t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'table what time is it', wake: 0.65 }), 'heard');
  const strict = setup({ config: { listen: { nameThreshold: 0.9 } } });
  assert.equal(strict.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'table what time is it', wake: 0.85 }), 'heard');
  assert.equal(strict.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'table what time is it', wake: 0.9 }), 'direct');
});

test('only the name, heard by the detector: a quick "Yeah?" and it listens', () => {
  const t = setup();
  assert.equal(t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Table?', wake: 0.95 }), 'acknowledged');
});

test('cut off by the name detector: the reply may pass unless the words show its name', async () => {
  const t = setup({ replies: ['Once upon a time a goblin ate a router.', 'Sure thing.', 'Yes, Jess.'] });
  await answering(t);
  t.brain.cutIn('u2', 5, { unsure: true });
  assert.equal(t.speaker.stops, 1, 'it stopped to listen');
  assert.equal(t.brain.hear({ userId: 'u2', id: 5, name: 'Jess', text: 'pass me the bagel' }), 'direct');
  await settle();
  assert.match(t.claude.calls[1].user, /or you were answering them/);
  t.brain.cutIn('u2', 6, { unsure: true });
  assert.equal(t.brain.hear({ userId: 'u2', id: 6, name: 'Jess', text: 'gremlin what time is it' }), 'direct');
  await settle();
  assert.doesNotMatch(t.claude.calls[2].user, /or you were answering them/, 'the words had its name: a real question');
});

// ---------------------------------------------------------------------------
// Looking at the owner's screen
// ---------------------------------------------------------------------------

test('the owner asking it to look gets a picture of the screen sent with the question', async () => {
  let shots = 0;
  const t = setup({ owner: 'u1', replies: ['That boss is weak to fire.'], screenshot: async () => (shots++, { jpeg: 'QUJD' }) });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin look at this, what do I do here' });
  await settle();
  assert.equal(shots, 1);
  const user = t.claude.calls[0].user;
  assert.ok(Array.isArray(user), 'the picture and the text');
  assert.deepEqual(user[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  assert.match(user[1].text, /asked you to look at their screen: the attached picture is their screen right now/);
});

test('nobody else can make it look', async () => {
  let shots = 0;
  const t = setup({ owner: 'u1', replies: ['Nope.'], screenshot: async () => (shots++, { jpeg: 'QUJD' }) });
  t.brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'gremlin look at this' });
  await settle();
  assert.equal(shots, 0);
  assert.equal(typeof t.claude.calls[0].user, 'string');
  assert.doesNotMatch(t.claude.calls[0].user, /screen/);
});

test('when the screen cannot be captured, it says so', async () => {
  const t = setup({ owner: 'u1', replies: ["Can't see it."], screenshot: async () => ({ error: "it can only see the screen when it's started from the desktop app" }) });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: "gremlin what's on my screen" });
  await settle();
  assert.match(t.claude.calls[0].user, /you couldn't see it \(it can only see the screen when it's started from the desktop app\)/);
});

test('SCREEN_LOOKS off: no picture', async () => {
  let shots = 0;
  const t = setup({ owner: 'u1', config: { screenLooks: false }, replies: ['Ok.'], screenshot: async () => (shots++, { jpeg: 'QUJD' }) });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin look at this' });
  await settle();
  assert.equal(shots, 0);
});

// ---------------------------------------------------------------------------
// The real speaker: pausing, and the next sentence of a reply following right on
// ---------------------------------------------------------------------------

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
  pause() {
    if (this.state.status !== AudioPlayerStatus.Playing) return false;
    this.setStatus(AudioPlayerStatus.Paused);
    return true;
  }
  unpause() {
    if (this.state.status !== AudioPlayerStatus.Paused) return false;
    this.setStatus(AudioPlayerStatus.Playing);
    return true;
  }
  stop() {
    if (this.state.status !== AudioPlayerStatus.Idle) this.setStatus(AudioPlayerStatus.Idle);
    return true;
  }
}

function realSpeaker({ talking = () => false } = {}) {
  const player = new FakePlayer();
  const requested = [];
  const tts = {
    stream: async (text) => {
      requested.push(text);
      return { stream: Readable.from([Buffer.alloc(48000)]), sampleRate: 24000 };
    },
  };
  let now = 1_000_000;
  const speaker = new Speaker({ tts, player, isAnyoneSpeaking: talking, clock: () => now });
  return { player, speaker, requested, advance: (ms) => (now += ms) };
}

test('speaker: a paused line is silent (not audible, not counted as talking over), then carries on', async () => {
  const { player, speaker, advance } = realSpeaker();
  const done = speaker.say('A long story about routers.', { kind: 'direct', tag: { line: 'L' } });
  await wait(100);
  assert.equal(player.state.status, AudioPlayerStatus.Playing);
  assert.deepEqual(speaker.nowPlaying(), { kind: 'direct', tag: { line: 'L' }, paused: false });
  advance(1000);
  assert.equal(speaker.pause(), true);
  assert.equal(player.state.status, AudioPlayerStatus.Paused);
  assert.equal(speaker.audible, false);
  assert.equal(speaker.nowPlaying().paused, true);
  assert.equal(speaker.committed, true, 'it still has something to say');
  const pausedAt = 1_001_000;
  advance(3000);
  assert.equal(speaker.wasAudibleBetween(pausedAt + 100, pausedAt + 2900), false, 'nobody talked over it while it was paused');
  assert.equal(speaker.resume(), true);
  assert.equal(player.state.status, AudioPlayerStatus.Playing);
  assert.equal(speaker.audible, true);
  advance(500);
  assert.equal(speaker.wasAudibleBetween(pausedAt + 3000, pausedAt + 3500), true);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await done, 'played');
});

test('speaker: stopping a paused line ends it', async () => {
  const { player, speaker } = realSpeaker();
  const done = speaker.say('Another story.', { kind: 'direct' });
  await wait(100);
  speaker.pause();
  speaker.stop();
  assert.equal(await done, 'stopped');
  assert.equal(player.state.status, AudioPlayerStatus.Idle);
});

test('speaker: the next sentence of a reply is fetched early and follows right on, even if someone is talking', async () => {
  let talking = false;
  const { player, speaker, requested } = realSpeaker({ talking: () => talking });
  const first = speaker.say('First sentence of it.', { kind: 'followup' });
  await wait(100);
  assert.equal(player.played, 1);
  const second = speaker.say('And the second one.', { kind: 'followup', continues: true });
  await wait(20);
  assert.deepEqual(requested, ['First sentence of it.', 'And the second one.'], 'its audio was asked for while the first played');
  talking = true; // someone starts talking: a new optional line would wait for a pause
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await first, 'played');
  await wait(100);
  assert.equal(player.played, 2, 'the second sentence went right on');
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await second, 'played');
});
