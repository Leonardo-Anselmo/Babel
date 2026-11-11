// The pieces around the faster ears and the new voice: pause checks in the listener,
// the end-of-turn and name checks in the call, the Whisper server calls, the v4
// voice with its fallback, and the new settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import OpusScript from 'opusscript';
import { FIELDS, cleanValue } from '../desktop/lib/settings.mjs';
import { BotProcess } from '../desktop/lib/bot-process.mjs';
import { loadConfig } from '../src/config.js';
import { Listener, PAUSE_CHECK_MS } from '../src/listener.js';
import { VoiceSession } from '../src/session.js';
import { createStt } from '../src/stt.js';
import { FALLBACK_MODEL, createTts, isModelProblem, stripAudioTags } from '../src/tts.js';

// ---------------------------------------------------------------------------
// Listener: sentence start, short pauses, ending a sentence early, name checks
// ---------------------------------------------------------------------------

const LISTEN = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 8000, voiceRms: 200 };

function fakeReceiver() {
  const speaking = new EventEmitter();
  speaking.users = new Map();
  const streams = new Map();
  return {
    speaking,
    streams,
    subscribe(userId) {
      const s = new Readable({ objectMode: true, read() {} });
      streams.set(userId, s);
      return s;
    },
  };
}

function packets({ toneFrames = 0, silentFrames = 0 }) {
  const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const out = [];
  const frame = Buffer.alloc(960 * 4);
  let n = 0;
  for (let f = 0; f < toneFrames + silentFrames; f++) {
    const loud = f < toneFrames;
    for (let i = 0; i < 960; i++, n++) {
      const v = loud ? Math.round(6000 * Math.sin((2 * Math.PI * 220 * n) / 48000)) : 0;
      frame.writeInt16LE(v, i * 4);
      frame.writeInt16LE(v, i * 4 + 2);
    }
    out.push(Buffer.from(enc.encode(frame, 960)));
  }
  enc.delete();
  return out;
}

function listenerSetup({ wantNameChecks } = {}) {
  let now = 2_000_000;
  const receiver = fakeReceiver();
  const listener = new Listener({ receiver, listen: LISTEN, shouldListen: () => true, wantNameChecks, clock: () => now });
  const events = { start: [], pause: [], namecheck: [], utterance: [] };
  for (const k of Object.keys(events)) listener.on(k, (e) => events[k].push(e));
  return {
    listener,
    events,
    advance: (ms) => (now += ms),
    async feed(userId, pkts) {
      const s = receiver.streams.get(userId);
      for (const p of pkts) {
        s.push(p);
        await new Promise((r) => setImmediate(r));
        now += 20;
      }
    },
  };
}

const wavMs = (wav) => ((wav.length - 44) / 2 / 16000) * 1000;

test('listener: a sentence start is announced, a short pause is handed out once, and ending it early works', async () => {
  const t = listenerSetup();
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 30 }));
  assert.equal(t.events.start.length, 1);
  const id = t.events.start[0].id;
  assert.ok(t.listener.voicedMs('u1') >= 500, `voiced ${t.listener.voicedMs('u1')}`);
  await t.feed('u1', packets({ silentFrames: Math.round(PAUSE_CHECK_MS / 20) + 2 }));
  assert.equal(t.events.pause.length, 1, 'once per pause');
  const p = t.events.pause[0];
  assert.deepEqual([p.userId, p.id, p.pauseSeq], ['u1', id, 1]);
  assert.ok(p.voicedMs >= 500);
  assert.equal(t.events.utterance.length, 0, 'not over yet: the full pause has not passed');
  assert.equal(t.listener.endSentence('u1', id, 1), true, 'the model says they sound done');
  assert.equal(t.events.utterance.length, 1);
  assert.equal(t.events.utterance[0].id, id);
  assert.equal(t.listener.voicedMs('u1'), 0);
  t.listener.stop();
});

test('listener: an answer from an old pause does nothing once they have started talking again', async () => {
  const t = listenerSetup();
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 30, silentFrames: 12 }));
  const { id } = t.events.pause[0];
  await t.feed('u1', packets({ toneFrames: 20 }));
  assert.equal(t.listener.endSentence('u1', id, 1), false, 'they kept going');
  await t.feed('u1', packets({ silentFrames: 12 }));
  assert.equal(t.events.pause.length, 2);
  assert.equal(t.events.pause[1].pauseSeq, 2);
  assert.equal(t.listener.endSentence('u1', id + 1, 2), false, 'another sentence');
  assert.equal(t.listener.endSentence('u1', id, 2), true);
  t.listener.stop();
});

test('listener: when their audio just stops (Discord goes quiet), the pause clip gets the quiet the model expects', async () => {
  const t = listenerSetup();
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 30 }));
  t.advance(PAUSE_CHECK_MS + 20);
  t.listener.sweep();
  assert.equal(t.events.pause.length, 1);
  const p = t.events.pause[0];
  assert.ok(wavMs(p.wav) >= 30 * 20 + PAUSE_CHECK_MS - 25, `clip ${wavMs(p.wav)} ms`);
  const tail = p.wav.subarray(p.wav.length - 2 * 16 * 150); // the last 150 ms
  assert.ok(tail.every((b) => b === 0), 'it ends in silence');
  t.listener.stop();
});

test('listener: name checks every 300 ms of talking, only while wanted', async () => {
  let wanted = true;
  const t = listenerSetup({ wantNameChecks: () => wanted });
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 34 })); // about 680 ms
  assert.equal(t.events.namecheck.length, 2);
  const c = t.events.namecheck[1];
  assert.equal(c.userId, 'u1');
  assert.ok(wavMs(c.wav) <= 2500 + 20);
  wanted = false;
  await t.feed('u1', packets({ toneFrames: 20 }));
  assert.equal(t.events.namecheck.length, 2);
  t.listener.stop();
});

// ---------------------------------------------------------------------------
// The call: end-of-turn and name checks
// ---------------------------------------------------------------------------

function callSetup({ check = async () => ({ complete: 0.9, wake: null }), listen = {}, extras = { turn: true, wake: 'gremlin' } } = {}) {
  const guild = {
    id: 'g1',
    name: 'Test',
    channels: { cache: new Map([['B', { id: 'B', name: 'B', members: new Map() }]]) },
    voiceStates: { cache: new Map() },
    members: { cache: new Map([['u1', { displayName: 'Mike', user: { bot: false } }]]), fetch: async () => ({}) },
  };
  const s = new VoiceSession({
    client: { user: { id: 'bot' } },
    guild,
    voiceChannel: { id: 'B' },
    textChannel: null,
    config: { botName: 'Gremlin', botAliases: ['gremlin'], stt: { extraTerms: [] }, autoLeaveSeconds: 60, listen: { minSpeechMs: 300, ...listen } },
    memory: { isOptedOut: () => false, chattiness: () => null, facts: () => [] },
  });
  const calls = { checks: [], ended: [], cutIns: [] };
  s.stt = {
    extras,
    async checkPause(wav, opts) {
      calls.checks.push(opts);
      return check(opts);
    },
  };
  s.listener = { endSentence: (...a) => (calls.ended.push(a), true) };
  s.speaker = { audible: true };
  s.brain = { recentLines: () => [], cutIn: (...a) => calls.cutIns.push(a) };
  return { s, calls };
}

const pause = { userId: 'u1', id: 3, pauseSeq: 2, wav: Buffer.alloc(64), voicedMs: 900 };

test('call: they sound done after a short pause, so their sentence ends now', async () => {
  const { s, calls } = callSetup();
  await s.onPause(pause);
  assert.deepEqual(calls.checks, [{ turn: true }]);
  assert.deepEqual(calls.ended, [['u1', 3, 2]]);
});

test('call: they do not sound done (or the check is not there), so it waits the usual pause', async () => {
  const unsure = callSetup({ check: async () => ({ complete: 0.2, wake: null }) });
  await unsure.s.onPause(pause);
  assert.deepEqual(unsure.calls.ended, []);
  const down = callSetup({ check: async () => null });
  await down.s.onPause(pause);
  assert.deepEqual(down.calls.ended, []);
  const off = callSetup({ listen: { smartTurn: false } });
  await off.s.onPause(pause);
  assert.deepEqual(off.calls.checks, [], 'SMART_TURN off: not asked');
  const none = callSetup({ extras: { turn: false, wake: null } });
  await none.s.onPause(pause);
  assert.deepEqual(none.calls.checks, [], 'no end-of-turn model on this Whisper');
  const short = callSetup();
  await short.s.onPause({ ...pause, voicedMs: 200 });
  assert.deepEqual(short.calls.checks, [], 'too short to be a sentence anyway');
});

test('call: the name detector hears its name over it, so it stops and listens (unsure: the words decide)', async () => {
  const { s, calls } = callSetup({ check: async () => ({ complete: null, wake: 0.91 }) });
  await s.onNameCheck({ userId: 'u1', id: 4, wav: Buffer.alloc(64) });
  assert.deepEqual(calls.checks, [{ turn: false, wake: true, seconds: 2.5 }]);
  assert.deepEqual(calls.cutIns, [['u1', 4, { unsure: true }]]);
});

test('call: no stop for a low score, a quiet bot, its own name in its recent lines, or a sentence already handled', async () => {
  const low = callSetup({ check: async () => ({ wake: 0.6 }) });
  await low.s.onNameCheck({ userId: 'u1', id: 4, wav: Buffer.alloc(64) });
  assert.deepEqual(low.calls.cutIns, []);
  const strict = callSetup({ check: async () => ({ wake: 0.8 }), listen: { nameThreshold: 0.85 } });
  await strict.s.onNameCheck({ userId: 'u1', id: 4, wav: Buffer.alloc(64) });
  assert.deepEqual(strict.calls.cutIns, [], 'NAME_DETECTOR_THRESHOLD is respected');
  const quiet = callSetup({ check: async () => ({ wake: 0.99 }) });
  quiet.s.speaker.audible = false;
  await quiet.s.onNameCheck({ userId: 'u1', id: 4, wav: Buffer.alloc(64) });
  assert.deepEqual(quiet.calls.checks, []);
  const self = callSetup({ check: async () => ({ wake: 0.99 }) });
  self.s.brain.recentLines = () => ['Gremlin says hi.'];
  await self.s.onNameCheck({ userId: 'u1', id: 4, wav: Buffer.alloc(64) });
  assert.deepEqual(self.calls.checks, [], 'its own voice could fool the detector');
  const late = callSetup({ check: async () => ({ wake: 0.99 }) });
  late.s.transcribedUpTo.set('u1', 4);
  await late.s.onNameCheck({ userId: 'u1', id: 4, wav: Buffer.alloc(64) });
  assert.deepEqual(late.calls.cutIns, []);
  const none = callSetup({ extras: { turn: true, wake: null } });
  await none.s.onNameCheck({ userId: 'u1', id: 4, wav: Buffer.alloc(64) });
  assert.deepEqual(none.calls.checks, [], 'no name detector installed');
});

// ---------------------------------------------------------------------------
// Speech-to-text: the Whisper server's pause check and name score
// ---------------------------------------------------------------------------

const sttConfig = (provider = 'whisper') => ({
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  stt: { provider, language: 'en', deepgramKey: 'dg', deepgramModel: 'nova-3', useKeyterms: false, whisper: { port: 8178 } },
  tts: {},
});
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

test('stt: the pause check asks the local server, and anything wrong is just "no answer"', async () => {
  const urls = [];
  const stt = createStt(sttConfig(), { fetchImpl: async (url) => (urls.push(String(url)), json({ complete: 0.87, wake: 0.12, ms: 31 })) });
  assert.deepEqual(await stt.checkPause(Buffer.alloc(64), { turn: true }), { complete: 0.87, wake: 0.12 });
  assert.match(urls[0], /^http:\/\/127\.0\.0\.1:8178\/turn\?turn=1&wake=0$/);
  await stt.checkPause(Buffer.alloc(64), { turn: false, wake: true, seconds: 2.5 });
  assert.match(urls[1], /\/turn\?turn=0&wake=1&seconds=2\.5$/);
  const broken = createStt(sttConfig(), { fetchImpl: async () => json({ error: 'x' }, 500) });
  assert.equal(await broken.checkPause(Buffer.alloc(64)), null);
  const down = createStt(sttConfig(), { fetchImpl: async () => Promise.reject(new TypeError('fetch failed')) });
  assert.equal(await down.checkPause(Buffer.alloc(64)), null);
  const deepgram = createStt(sttConfig('deepgram'), { fetchImpl: async () => assert.fail('not asked') });
  assert.equal(await deepgram.checkPause(Buffer.alloc(64)), null);
});

test('stt: the name score comes back with the words, and the extras are only trusted from local Whisper', async () => {
  const stt = createStt(sttConfig(), { fetchImpl: async () => json({ text: ' Table, what time is it? ', speech_seconds: 1.4, wake: 0.93 }) });
  assert.deepEqual(await stt.transcribeDetailed(Buffer.alloc(64), { durationMs: 1500 }), { text: 'Table, what time is it?', wake: 0.93, unsureName: false, provider: 'whisper' });
  // A clip of just its name that Whisper was far from sure of says so.
  const unsure = createStt(sttConfig(), { fetchImpl: async () => json({ text: 'Table', speech_seconds: 0.6, unsure_name: true }) });
  assert.deepEqual(await unsure.transcribeDetailed(Buffer.alloc(64), { durationMs: 800 }), { text: 'Table', wake: null, unsureName: true, provider: 'whisper' });
  assert.deepEqual(stt.extras, { turn: false, wake: null });
  stt.setExtras({ turn: true, wake: 'gremlin' });
  assert.deepEqual(stt.extras, { turn: true, wake: 'gremlin' });
  stt.setExtras({ turn: false });
  assert.deepEqual(stt.extras, { turn: false, wake: null });
  const dg = createStt(sttConfig('deepgram'));
  dg.setExtras({ turn: true, wake: 'gremlin' });
  assert.deepEqual(dg.extras, { turn: false, wake: null });
});

// ---------------------------------------------------------------------------
// The voice: v4 settings and tags, and falling back when the model can't be used
// ---------------------------------------------------------------------------

const ttsConfig = (model, extra = {}) => ({
  tts: { elevenKey: 'k', voiceId: 'v', model, outputFormat: 'pcm_24000', stability: 0.4, similarity: 0.75, style: 0.3, speed: 1.1, ...extra },
});
const audio = () => new Response(new Uint8Array(4800), { status: 200 });

test('voice: v4 gets only stability and similarity, and keeps the delivery tags', async () => {
  const bodies = [];
  const tts = createTts(ttsConfig('eleven_v4_turbo'), { fetchImpl: async (url, init) => (bodies.push(JSON.parse(init.body)), audio()) });
  await tts.stream('[laughs] Nice shot.');
  assert.deepEqual(bodies[0], { text: '[laughs] Nice shot.', model_id: 'eleven_v4_turbo', voice_settings: { stability: 0.4, similarity_boost: 0.75 } });
});

test('voice: other models get style and speed, and the words without tags', async () => {
  const bodies = [];
  const tts = createTts(ttsConfig('eleven_flash_v2_5'), { fetchImpl: async (url, init) => (bodies.push(JSON.parse(init.body)), audio()) });
  await tts.stream('[laughs] Nice  shot. [sarcastic]');
  assert.deepEqual(bodies[0], { text: 'Nice shot.', model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.3, speed: 1.1 } });
  assert.equal(stripAudioTags('[whispers] hi'), 'hi');
});

test('voice: a model the account cannot use switches to Flash for the rest of the run (said once)', async () => {
  const models = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    models.push(body.model_id);
    if (body.model_id === 'eleven_v4_turbo') return json({ detail: { status: 'invalid_model_id', message: 'Model eleven_v4_turbo does not exist or is not available' } }, 400);
    return audio();
  };
  const tts = createTts(ttsConfig('eleven_v4_turbo'), { fetchImpl });
  const usage = [];
  const withUsage = createTts(ttsConfig('eleven_v4_turbo'), { fetchImpl, onUsage: (e) => usage.push(e) });
  const r = await tts.stream('[laughs] Ha.');
  assert.ok(r.stream);
  assert.equal(tts.model, FALLBACK_MODEL);
  await tts.stream('Again.');
  assert.deepEqual(models, ['eleven_v4_turbo', FALLBACK_MODEL, FALLBACK_MODEL], 'tried once, then straight to the fallback');
  await withUsage.stream('Once.');
  assert.deepEqual(usage, [{ type: 'tts', chars: 5, model: FALLBACK_MODEL }], 'billed at what was actually used');
});

test('voice: running out of credits is not a model problem (no switching)', async () => {
  let calls = 0;
  const tts = createTts(ttsConfig('eleven_v4_turbo'), {
    fetchImpl: async () => (calls++, json({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota' } }, 401)),
  });
  await assert.rejects(tts.stream('Hi.'), /out of ElevenLabs credits/);
  assert.equal(calls, 1);
  assert.equal(tts.model, 'eleven_v4_turbo');
  assert.equal(isModelProblem(404, 'voice_not_found', 'voice not found'), false);
  assert.equal(isModelProblem(422, '', 'output_format pcm_24000 is not supported for this model'), true);
  assert.equal(isModelProblem(500, '', 'model error'), false);
});

// ---------------------------------------------------------------------------
// Settings and the app's link to the bot
// ---------------------------------------------------------------------------

test('settings: the new options are in the app with the same defaults as the bot', (t) => {
  const keys = ['CALL_MEMORY', 'SCREEN_LOOKS', 'SMART_TURN', 'TALK_OVER_PAUSE', 'NAME_DETECTOR_THRESHOLD'];
  for (const k of keys) assert.ok(FIELDS.get(k), k);
  assert.throws(() => cleanValue('NAME_DETECTOR_THRESHOLD', '1.5'), /0\.3 to 0\.99/);
  assert.equal(cleanValue('CALL_MEMORY', 'true'), 'true');
  assert.ok(FIELDS.get('ELEVENLABS_MODEL').suggestions.includes('eleven_v4_turbo'));
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    const c = loadConfig();
    if (c.envFile) {
      t.skip('a real .env is present, so its settings win over the defaults');
      return;
    }
    assert.equal(String(c.callMemory), FIELDS.get('CALL_MEMORY').default);
    assert.equal(String(c.screenLooks), FIELDS.get('SCREEN_LOOKS').default);
    assert.equal(String(c.listen.smartTurn), FIELDS.get('SMART_TURN').default);
    assert.equal(String(c.listen.talkOverPause), FIELDS.get('TALK_OVER_PAUSE').default);
    assert.equal(String(c.listen.nameThreshold), FIELDS.get('NAME_DETECTOR_THRESHOLD').default);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('app: messages from the bot other than status reports are passed on (screen requests, forget answers)', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.connected = true;
  child.send = () => {};
  const proc = new BotProcess({ botDir: '.', spawn: () => child });
  const got = [];
  const statuses = [];
  proc.on('message', (m) => got.push(m));
  proc.on('state', (s) => statuses.push(s.state));
  proc.launch();
  child.emit('message', { type: 'screenshot-request', id: 1 });
  child.emit('message', 'junk');
  child.emit('message', { type: 'status', ready: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, [{ type: 'screenshot-request', id: 1 }]);
  assert.equal(proc.status.ready, true, 'status reports still work');
  assert.ok(statuses.includes('running'));
  child.stdout.end();
  child.stderr.end();
});
