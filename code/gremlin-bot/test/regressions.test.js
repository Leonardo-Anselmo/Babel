// Regression tests for bugs found in code review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Brain } from '../src/brain.js';
import { handleInteraction } from '../src/commands.js';
import { cleanSpoken } from '../src/prompts.js';
import { VoiceSession } from '../src/session.js';
import { Speaker } from '../src/speaker.js';
import { createTts } from '../src/tts.js';
import { isEchoOf } from '../src/wakeword.js';

// ---------- speaker: aborted ElevenLabs streams must never crash the process ----------

async function slowVoiceServer({ resetAfterMs } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/pcm' });
    let n = 0;
    const iv = setInterval(() => {
      if (resetAfterMs && n * 100 >= resetAfterMs) {
        clearInterval(iv);
        req.socket.destroy(); // network drop mid-stream
        return;
      }
      if (n++ > 100) {
        clearInterval(iv);
        res.end();
        return;
      }
      res.write(Buffer.alloc(2400)); // 50 ms of 24 kHz audio every 100 ms: slower than real time
    }, 100);
    res.on('close', () => clearInterval(iv));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const config = { tts: { elevenKey: 'x', voiceId: 'v', model: 'm', outputFormat: 'pcm_24000', stability: 0.4, similarity: 0.75, style: 0, speed: 1 } };
  const tts = createTts(config, { fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${port}/`, init) });
  return { tts, close: () => server.close() };
}

function trapUncaught() {
  const errors = [];
  const handler = (err) => errors.push(err);
  process.on('uncaughtException', handler);
  return { errors, release: () => process.off('uncaughtException', handler) };
}

test('dropping a quip after ElevenLabs answered does not crash', async () => {
  const trap = trapUncaught();
  const { tts, close } = await slowVoiceServer();
  let now = 0;
  const speaker = new Speaker({ tts, isAnyoneSpeaking: () => true, clock: () => now });
  const p = speaker.say('a quip', { kind: 'quip' });
  await new Promise((r) => setTimeout(r, 300));
  now = 10000;
  assert.equal(await p, 'dropped');
  await new Promise((r) => setTimeout(r, 400));
  speaker.destroy();
  close();
  trap.release();
  assert.deepEqual(trap.errors.map((e) => e.message), []);
});

test('stopping while lines are queued or pre-buffering does not crash', async () => {
  const trap = trapUncaught();
  const { tts, close } = await slowVoiceServer();
  const speaker = new Speaker({ tts });
  const a = speaker.say('one');
  const b = speaker.say('two');
  await new Promise((r) => setTimeout(r, 250)); // mid pre-buffer (stream is slower than real time)
  speaker.stop();
  assert.equal(await a, 'stopped');
  assert.equal(await b, 'stopped');
  await new Promise((r) => setTimeout(r, 400));
  speaker.destroy();
  close();
  trap.release();
  assert.deepEqual(trap.errors.map((e) => e.message), []);
});

test('a network drop mid-stream fails the line cleanly and hands it to the text fallback', async () => {
  const trap = trapUncaught();
  const { tts, close } = await slowVoiceServer({ resetAfterMs: 200 });
  const failures = [];
  const speaker = new Speaker({ tts, onVoiceFailure: (text) => failures.push(text) });
  const outcome = await speaker.say('dropped line');
  assert.equal(outcome, 'failed');
  assert.deepEqual(failures, ['dropped line']);
  speaker.destroy();
  close();
  trap.release();
  assert.deepEqual(trap.errors.map((e) => e.message), []);
});

// ---------- brain: "shut up" means shut up ----------

function brainWith(replies, extra = {}) {
  const said = [];
  let stops = 0;
  const calls = [];
  const queue = [...replies];
  const claude = {
    async createMessage(args) {
      calls.push(args);
      const next = queue.shift();
      return typeof next === 'function' ? next(args) : { text: next ?? '[PASS]', refusal: false };
    },
  };
  const brain = new Brain({
    config: {
      botName: 'Gremlin',
      botAliases: ['gremlin'],
      timezone: 'UTC',
      defaultChattiness: 'medium',
      persona: 'x',
      lore: '',
      tts: { audioTags: false },
      transcript: { maxLines: 40, maxMinutes: 15 },
    },
    claude,
    speaker: {
      say: (text) => {
        said.push(text);
        return Promise.resolve('played');
      },
      stop: () => stops++,
    },
    getCallInfo: () => ({}),
    clock: () => 1_000_000,
    ...extra,
  });
  return { brain, said, calls, stops: () => stops };
}

const settle = () => new Promise((r) => setImmediate(r));

test('"gremlin shut up" cancels a reply that is still being written', async () => {
  let release;
  const story = () => new Promise((r) => (release = r));
  const { brain, said } = brainWith([story]);
  brain.hear({ name: 'Mike', text: 'gremlin tell me a long story' });
  await settle();
  brain.hear({ name: 'Jess', text: 'gremlin shut up' });
  release({ text: 'Once upon a time...', refusal: false });
  await settle();
  await settle();
  assert.deepEqual(said, []);
});

test('shush also clears a reply that was waiting its turn', async () => {
  let release;
  const first = () => new Promise((r) => (release = r));
  const { brain, said, calls } = brainWith([first, 'second answer']);
  brain.hear({ name: 'Mike', text: 'gremlin question one' });
  await settle();
  brain.hear({ name: 'Jess', text: 'gremlin question two' }); // queued as pending
  brain.shush();
  release({ text: 'first answer', refusal: false });
  await settle();
  await settle();
  assert.deepEqual(said, []);
  assert.equal(calls.length, 1, 'the pending reply was never generated');
});

test('two people asking while it is still thinking (not talking) both get answers', async () => {
  let release;
  const first = () => new Promise((r) => (release = r));
  const { brain, said, calls } = brainWith([first, 'second answer']);
  brain.hear({ name: 'Mike', text: 'gremlin question one' });
  await settle();
  brain.hear({ name: 'Jess', text: 'gremlin question two' });
  release({ text: 'first answer', refusal: false });
  await settle();
  await settle();
  await settle();
  assert.equal(calls.length, 2);
  assert.deepEqual(said, ['first answer', 'second answer']);
});

test('chattiness off means no follow-ups either', async () => {
  const { brain } = brainWith(['Answer.'], { chattiness: 'off' });
  brain.hear({ name: 'Mike', text: 'gremlin hi' });
  await settle();
  assert.notEqual(brain.hear({ name: 'Mike', text: 'thanks dude' }), 'followup');
});

test('echo filter: real replies that reuse the bot words are not dropped', () => {
  assert.equal(isEchoOf('gremlin you absolute walnut', 'Mike, you absolute walnut, you died to a door'), false);
  assert.equal(isEchoOf('are you serious right now', 'Are you serious? Mike is right, now go cry.'), false);
  assert.equal(isEchoOf('you are all terrible at this game', 'You are all terrible at this game.'), true);
  assert.equal(isEchoOf('ok', 'ok'), false, 'too short to judge');
});

test('optional PASS variants stay quiet, but a real "pass" sentence still speaks when asked directly', () => {
  for (const s of ['Pass. Nothing funny here.', 'PASS - they moved on', '(PASS)', '"Pass"']) {
    assert.equal(cleanSpoken(s, { botName: 'Gremlin', optional: true }).pass, true, s);
  }
  assert.equal(cleanSpoken('(PASS)', { botName: 'Gremlin' }).pass, true);
  assert.equal(cleanSpoken('Pass the ammo, Mike.', { botName: 'Gremlin' }).pass, false);
});

// ---------- session + /join: races and channel moves ----------

function fakeGuild() {
  const voiceStates = new Map();
  return {
    id: 'g1',
    name: 'Test',
    channels: { cache: new Map([['A', { id: 'A', name: 'A', members: new Map() }], ['B', { id: 'B', name: 'B', members: new Map() }]]) },
    voiceStates: { cache: voiceStates },
    members: { cache: new Map(), me: { id: 'bot' }, fetch: async () => ({}) },
  };
}

function session(guild, channelId = 'B') {
  const s = new VoiceSession({
    client: { user: { id: 'bot' } },
    guild,
    voiceChannel: { id: channelId },
    textChannel: null,
    config: { autoLeaveSeconds: 60 },
    memory: { isOptedOut: () => false, chattiness: () => null, facts: () => [] },
  });
  s.ready = true;
  return s;
}

test('a stale "left the old channel" event does not end the session in the new channel', () => {
  const guild = fakeGuild();
  const s = session(guild, 'B');
  s.onVoiceStateUpdate({ id: 'bot', channelId: 'A' }, { id: 'bot', channelId: null, guild });
  assert.equal(s.ended, false);
  s.onVoiceStateUpdate({ id: 'bot', channelId: 'B' }, { id: 'bot', channelId: null, guild });
  assert.equal(s.ended, true, 'leaving our own channel does end it');
  clearTimeout(s.aloneTimer);
});

function joinInteraction(guild, userChannelId) {
  const replies = [];
  return {
    replies,
    isChatInputCommand: () => true,
    inGuild: () => true,
    commandName: 'join',
    guild: {
      ...guild,
      members: {
        ...guild.members,
        fetch: async () => ({
          voice: {
            channel: {
              id: userChannelId,
              type: 2,
              joinable: true,
              permissionsFor: () => ({ has: () => true }),
              toString: () => `#${userChannelId}`,
            },
          },
        }),
      },
    },
    guildId: 'g1',
    user: { id: 'u1' },
    channel: null,
    deferred: false,
    replied: false,
    async reply(m) {
      this.replied = true;
      replies.push(m.content ?? m);
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(m) {
      replies.push(m.content ?? m);
    },
  };
}

test('/join while still connecting says so instead of starting a second session', async () => {
  const guild = fakeGuild();
  const sessions = new Map([['g1', { starting: true, ended: false, channelId: 'A' }]]);
  const i = joinInteraction(guild, 'B');
  await handleInteraction(i, { sessions, config: { botName: 'Gremlin' } });
  assert.match(i.replies[0], /Still connecting/);
  assert.equal(sessions.size, 1);
});

test('/join from another channel moves the existing session', async () => {
  const guild = fakeGuild();
  let movedTo = null;
  const existing = { starting: false, ready: true, ended: false, channelId: 'A', moveTo: async (ch) => ((movedTo = ch.id), true) };
  const sessions = new Map([['g1', existing]]);
  const i = joinInteraction(guild, 'B');
  await handleInteraction(i, { sessions, config: { botName: 'Gremlin' } });
  assert.equal(movedTo, 'B');
  assert.match(i.replies.at(-1), /Moved to #B/);
  assert.equal(sessions.get('g1'), existing);
});
