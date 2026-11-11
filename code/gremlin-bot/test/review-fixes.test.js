// Fixes from the independent review of the upgrades: echo while paused, "wait" while
// paused, the talk-over watch between sentences, who is still owed an answer, a refusal
// partway through, the answer after a web search, which phrases make it look at the
// screen, the voice fallback, and the app's checks before changing memory.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { botRunningElsewhere, screenLooksOn } from '../desktop/lib/app-data.mjs';
import { Brain, asksToLook } from '../src/brain.js';
import { commandDefinitions, handleInteraction } from '../src/commands.js';
import { Memory } from '../src/memory.js';
import { createStt } from '../src/stt.js';
import { FALLBACK_MODEL, createTts } from '../src/tts.js';

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

/** A speaker that can pause; the test decides when lines start and end. */
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
          if (line.outcome) return;
          line.outcome = outcome;
          if (lines[current] === line) current = null;
          resolve(outcome);
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
      return { kind: lines[current].opts.kind, tag: lines[current].opts.tag, paused: this.paused };
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

/** Claude that streams: the test hands out pieces and ends the reply. */
function streamingClaude() {
  const calls = [];
  const replies = [];
  return {
    calls,
    replies,
    async createMessage(args) {
      calls.push(args);
      return new Promise((resolve, reject) => {
        let text = '';
        replies.push({
          args,
          // Its words come inside <say></say>, as the bot asks for: the tag opens the reply
          // (and the answer after a search).
          send(piece) {
            const p = text ? piece : `<say>${piece}`;
            text += p;
            args.onText?.(p);
          },
          tool() {
            args.onToolStart?.();
            text = '';
          },
          // Overloaded mid-reply: the client asks whether it may start over, and does.
          restart() {
            const ok = args.onRetry?.();
            if (ok) text = '';
            return ok;
          },
          done(final = text, extra = {}) {
            resolve({ text: final, refusal: false, searches: 0, citations: [], ...extra });
          },
        });
        args.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
}

function setup({ config = {} } = {}) {
  let now = 4_000_000;
  const claude = streamingClaude();
  const speaker = pausingSpeaker();
  const talking = new Map();
  const hearing = new Set();
  const brain = new Brain({
    config: { ...baseConfig, ...config, listen: { ...baseConfig.listen, ...config.listen } },
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
    isSpeaking: (u) => talking.has(u),
    voicedMs: (u) => talking.get(u) ?? 0,
    isHearingFrom: (u) => hearing.has(u),
    clock: () => now,
  });
  return { brain, claude, speaker, talking, hearing, advance: (ms) => (now += ms) };
}

/** Mike asks; the first sentence of the answer starts playing (more of it may follow). */
async function answeringMike(t, sentences = ['Once upon a time a goblin ate a router whole. '], { done = true } = {}) {
  assert.equal(t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin tell me a story' }), 'direct');
  await settle();
  for (const s of sentences) t.claude.replies[0].send(s);
  if (done) t.claude.replies[0].done();
  await settle();
  t.speaker.start(0);
}

async function mikeTalksOver(t, id = 2) {
  t.brain.speechStarted('u1', id);
  t.talking.set('u1', 700);
  await wait(250);
}

test('screen looks: only clear asks to look at the screen', () => {
  const aliases = ['gremlin'];
  for (const s of [
    'gremlin look at this',
    'Gremlin, take a look at this boss',
    'hey gremlin, quick, look at this',
    'gremlin can you look at this',
    'look at this, gremlin',
    'gremlin what is on my screen',
    "gremlin what's on the screen right now",
    'gremlin what am I looking at',
    'gremlin can you see my screen',
    'gremlin look at my screen',
    "gremlin look at what I'm doing",
    'gremlin, look at that',
  ]) {
    assert.ok(asksToLook(s, aliases), s);
  }
  for (const s of [
    'gremlin you see what I mean',
    'gremlin did you see that goal last night',
    'gremlin take a look at the forecast for saturday',
    'gremlin check out my new build',
    'gremlin can you see it coming',
    'gremlin look at them go',
    'gremlin look at those stats from last season',
    "gremlin I'll look at this later",
    'gremlin I was looking at that new GPU yesterday',
    "gremlin don't look at that, it's a spoiler",
  ]) {
    assert.equal(asksToLook(s, aliases), false, s);
  }
});

test('paused: a few words of its own answer through their mic count as echo (it carries on)', async () => {
  const t = setup();
  await answeringMike(t);
  await mikeTalksOver(t);
  assert.equal(t.speaker.pauses, 1);
  t.talking.delete('u1');
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'a goblin ate' }), 'echo');
  assert.equal(t.speaker.resumes, 1);
  assert.equal(t.speaker.stops, 0);
  assert.equal(t.brain.echoesFrom('u1'), 1, 'their mic is known to echo now');
  assert.equal(t.claude.calls.length, 1, 'no reply to its own words');
  t.brain.close();
});

test('paused: "wait" or just its name means listen for the rest; a lone "no" gets answered', async () => {
  const t = setup();
  await answeringMike(t);
  await mikeTalksOver(t);
  t.talking.delete('u1');
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'wait wait' }), 'listening');
  assert.equal(t.speaker.stops, 1, 'the answer stops');
  await settle();
  assert.equal(t.claude.calls.length, 1, 'no reply to "wait"');
  assert.equal(t.brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'which router was it' }), 'direct', 'the next sentence is for it');

  const t2 = setup();
  await answeringMike(t2);
  await mikeTalksOver(t2);
  t2.talking.delete('u1');
  assert.equal(t2.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'no' }), 'direct');
  t.brain.close();
  t2.brain.close();
});

test('talking over it just as one sentence ends and the next begins still pauses it', async () => {
  const t = setup();
  await answeringMike(t, ['Once upon a time a goblin ate a router whole. ', 'Then it ate the modem for dessert. '], { done: false });
  assert.equal(t.speaker.lines.length, 2);
  t.speaker.lines[0].end('played'); // between sentences: nothing is playing
  t.brain.speechStarted('u1', 2);
  t.talking.set('u1', 800);
  await wait(250);
  assert.equal(t.speaker.pauses, 0, 'nothing to pause yet');
  t.speaker.start(1);
  await wait(150);
  assert.equal(t.speaker.pauses, 1, 'paused as soon as the next sentence started');
  t.claude.replies[0].done();
  t.brain.close();
});

test('someone else taking the floor: an answer Mike is already hearing is not owed to him again', async () => {
  const t = setup();
  t.speaker.wasAudibleBetween = () => true; // Jess talks over it
  await answeringMike(t, ['Once upon a time a goblin ate a router whole. '], { done: false });
  assert.equal(t.brain.hear({ userId: 'u2', id: 5, name: 'Jess', text: 'gremlin what time is it', startedAt: 4_000_000, spokeUntil: 4_000_500 }), 'direct');
  await settle();
  assert.equal(t.claude.calls.length, 2);
  assert.match(t.claude.calls[1].user, /Jess is talking to you/);
  assert.doesNotMatch(t.claude.calls[1].user, /Mike and Jess/);
  t.brain.close();
});

test('a refusal partway through: what was said stays, and the half-written rest is not said', async () => {
  const t = setup();
  await answeringMike(t, ['Mike plays like his monitor is turned off. ', 'And honestly his'], { done: false });
  t.claude.replies[0].done('Mike plays like his monitor is turned off. And honestly his', { refusal: true });
  await settle();
  assert.deepEqual(t.speaker.lines.map((l) => l.text), ['Mike plays like his monitor is turned off.']);
  t.brain.close();
});

test('the answer after a web search waits its turn like a new line (people may be talking by then)', async () => {
  const t = setup();
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin when is the patch' });
  await settle();
  const r = t.claude.replies[0];
  r.send('Good question, it changed recently. ');
  r.tool();
  r.send('Patch drops Tuesday at ten. ');
  r.send('Bring snacks.');
  r.done('Patch drops Tuesday at ten. Bring snacks.');
  await settle();
  const [first, afterSearch, rest] = t.speaker.lines;
  assert.equal(first.opts.continues, false);
  assert.equal(afterSearch.text, 'Patch drops Tuesday at ten.');
  assert.equal(afterSearch.opts.continues, false, 'not glued on to what it said before the search');
  assert.equal(typeof afterSearch.opts.hold, 'function', 'it waits for Mike if he is talking');
  assert.equal(rest.opts.continues, true);
  t.brain.close();
});

test('overloaded partway: started over only if none of it was said', async () => {
  const t = setup();
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin tell me something' });
  await settle();
  const r = t.claude.replies[0];
  r.send('Let me'); // not a whole sentence: nothing said yet
  assert.equal(r.restart(), true, 'fine to send it again');
  r.send('Here is a fact about goblins. ');
  assert.equal(t.speaker.lines.length, 1);
  assert.equal(r.args.onRetry(), false, 'part of it was said: not again');
  t.brain.close();
});

// ---------------------------------------------------------------------------
// The voice fallback, the pause check's time limit, /forgetcalls, and the app
// ---------------------------------------------------------------------------

const ttsConfig = (model) => ({ tts: { elevenKey: 'k', voiceId: 'v', model, outputFormat: 'pcm_24000', stability: 0.4, similarity: 0.75, style: 0, speed: 1 } });
const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const audio = () => new Response(new Uint8Array(4800), { status: 200 });

test('voice: a v4 error that Flash fails too is not the model: no switch, the real error comes through', async () => {
  const models = [];
  const tts = createTts(ttsConfig('eleven_v4_turbo'), {
    fetchImpl: async (url, init) => {
      models.push(JSON.parse(init.body).model_id);
      return json({ detail: { status: 'invalid_text', message: 'Text is invalid' } }, 400);
    },
  });
  await assert.rejects(tts.stream('Hi.'), /Text is invalid/);
  assert.deepEqual(models, ['eleven_v4_turbo', FALLBACK_MODEL]);
  assert.equal(tts.model, 'eleven_v4_turbo', 'it keeps the chosen model');
});

test('voice: two lines failing on v4 at once both get spoken with Flash', async () => {
  const tts = createTts(ttsConfig('eleven_v4_turbo'), {
    fetchImpl: async (url, init) => {
      await wait(5);
      return JSON.parse(init.body).model_id === 'eleven_v4_turbo' ? json({ detail: { status: 'model_access_denied', message: 'no access' } }, 403) : audio();
    },
  });
  const [a, b] = await Promise.all([tts.stream('One.'), tts.stream('Two.')]);
  assert.ok(a.stream && b.stream);
  assert.equal(tts.model, FALLBACK_MODEL);
});

test('stt: the pause check can be given a longer time limit (the start-up check uses one)', async () => {
  let signal;
  const stt = createStt(
    { botName: 'Gremlin', botAliases: [], stt: { provider: 'whisper', language: 'en', whisper: { port: 8178 } }, tts: {} },
    {
      fetchImpl: (url, init) =>
        new Promise((resolve, reject) => {
          signal = init.signal;
          const timer = setTimeout(() => resolve(new Response(JSON.stringify({ complete: null, wake: 0.9 }), { status: 200 })), 450);
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal.reason);
          });
        }),
    },
  );
  assert.equal(await stt.checkPause(Buffer.alloc(64), { wake: true, turn: false }), null, 'the usual limit is 400 ms');
  assert.deepEqual(await stt.checkPause(Buffer.alloc(64), { wake: true, turn: false, timeoutMs: 2000 }), { complete: null, wake: 0.9 });
  assert.ok(signal);
});

test('/forgetcalls: server managers can clear its notes on calls, including the call going on now', async () => {
  const def = commandDefinitions('Gremlin').find((c) => c.name === 'forgetcalls');
  assert.equal(def.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  const memory = new Memory(fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-forget-')));
  memory.addCall('g1', { summary: 'one' });
  memory.addCall('g1', { summary: 'two' });
  let cleared = 0;
  const sessions = new Map([['g1', { ended: false, callNotes: { clear: () => cleared++ } }]]);
  const replies = [];
  const i = {
    isChatInputCommand: () => true,
    inGuild: () => true,
    commandName: 'forgetcalls',
    guildId: 'g1',
    user: { id: 'u1' },
    async reply(m) {
      replies.push(m.content);
    },
  };
  await handleInteraction(i, { memory, sessions });
  assert.deepEqual(memory.calls('g1'), []);
  assert.equal(cleared, 1);
  assert.match(replies[0], /Forgot my notes on the last 2 calls, and started this call's notes over\./);
});

test('app: a bot running outside the app is noticed (its lock port is taken), and SCREEN_LOOKS is read like the bot does', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  assert.equal(await botRunningElsewhere(port), false);
  const server = net.createServer();
  await new Promise((r) => server.listen({ port, host: '127.0.0.1', exclusive: true }, r));
  try {
    assert.equal(await botRunningElsewhere(port), true);
  } finally {
    server.close();
  }
  assert.equal(screenLooksOn({}), true);
  assert.equal(screenLooksOn({ SCREEN_LOOKS: 'off' }), false);
  assert.equal(screenLooksOn({ SCREEN_LOOKS: ' Yes ' }), true);
});

test('opting out mid-call takes what they said out of the transcript and the notes', () => {
  const forgotten = [];
  const brain = new Brain({
    config: baseConfig,
    claude: { createMessage: async () => ({ text: '[PASS]' }) },
    speaker: pausingSpeaker(),
    getCallInfo: () => ({}),
    callNotes: { add() {}, forgetSpeaker: (u) => forgotten.push(u) },
  });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'my secret plan is to win' });
  brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'cool story' });
  brain.forgetSpeaker('u1');
  assert.deepEqual(brain.transcript.lines.map((l) => l.text), ['cool story']);
  assert.deepEqual(forgotten, ['u1']);
  brain.close();
});

test('a sound too short to be a sentence lets go of a cut-in waiting on it', () => {
  const brain = new Brain({ config: baseConfig, claude: { createMessage: async () => ({ text: 'x' }) }, speaker: pausingSpeaker(), getCallInfo: () => ({}) });
  brain.cutIn('u1', 4, { unsure: true });
  assert.equal(brain.cutIns.has('u1'), true);
  brain.dropCutIn('u1', 4);
  assert.equal(brain.cutIns.has('u1'), false, 'their next sentence is not taken as talking to it');
  brain.close();
});

test('paused: a single word, or words from a part it has not said yet, are them talking (not echo)', async () => {
  const t = setup();
  await answeringMike(t, ['No, the shotgun is the best pick up close. ', 'But what you really want is the rifle. '], { done: false });
  await mikeTalksOver(t);
  t.talking.delete('u1');
  assert.equal(t.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'what' }), 'direct', 'a single word is him');
  assert.equal(t.brain.echoesFrom('u1'), 0);

  const t2 = setup();
  await answeringMike(t2, ['No, the shotgun is the best pick up close. ', 'But what you really want is the rifle. '], { done: false });
  await mikeTalksOver(t2);
  t2.talking.delete('u1');
  // (Not said yet, so it's him; a short comment like that lets it carry on.)
  assert.equal(t2.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'the rifle' }), 'carried-on', 'not said yet, so it is him');
  assert.equal(t2.brain.echoesFrom('u1'), 0);
  t.claude.replies[0].done();
  t2.claude.replies[0].done();
  t.brain.close();
  t2.brain.close();
});

test('a short echo of one of its short lines is ignored but does not mark their mic as echoing', () => {
  const t = setup();
  t.brain.transcript.add({ name: 'Gremlin', text: 'Hang on.', isBot: true });
  assert.equal(t.brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'hang on' }), 'echo');
  assert.equal(t.brain.echoesFrom('u2'), 0);
  t.brain.close();
});

test('a short sound only ends the wait for the sentence it was (not a later breath)', async () => {
  const t = setup();
  await answeringMike(t);
  await mikeTalksOver(t, 2);
  t.talking.delete('u1');
  t.hearing.add('u1'); // sentence 2 is being transcribed
  t.brain.soundIgnored('u1', 3); // a breath after it
  assert.equal(t.speaker.resumes, 0, 'still waiting for sentence 2');
  t.brain.soundIgnored('u1', 2); // sentence 2 itself was too short
  assert.equal(t.speaker.resumes, 1);
  t.brain.cutIn('u2', 7, { unsure: true });
  t.brain.soundIgnored('u2', 8);
  assert.equal(t.brain.cutIns.has('u2'), true);
  t.brain.soundIgnored('u2', 7);
  assert.equal(t.brain.cutIns.has('u2'), false);
  t.brain.close();
});

test('opting out also drops its answers to them, and an answer to them still on its way', async () => {
  const t = setup();
  await answeringMike(t, ['Sorry to hear about that, Mike. '], { done: false });
  t.brain.hear({ userId: 'u2', id: 3, name: 'Jess', text: 'brutal' });
  t.brain.forgetSpeaker('u1');
  assert.equal(t.speaker.stops, 1, 'the answer to him stops');
  assert.deepEqual(t.brain.transcript.lines.map((l) => l.text), ['brutal']);
  t.brain.close();
});

test('a word or two heard only by the name detector needs to be surer before it says "Yeah?"', () => {
  const t = setup();
  assert.equal(t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'bagel', wake: 0.75 }), 'direct', 'heard, but answered with a reply that may pass');
  const t2 = setup();
  assert.equal(t2.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'bagel', wake: 0.9 }), 'acknowledged');
  t.brain.close();
  t2.brain.close();
});
