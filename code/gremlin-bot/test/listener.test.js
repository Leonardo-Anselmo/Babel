import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import OpusScript from 'opusscript';
import { Listener } from '../src/listener.js';

const LISTEN = { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 5000, voiceRms: 200 };

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

function setup(extra = {}, { wantPeek } = {}) {
  let now = 1_000_000;
  const receiver = fakeReceiver();
  const listener = new Listener({
    receiver,
    listen: { ...LISTEN, ...extra },
    shouldListen: () => true,
    wantPeek,
    clock: () => now,
  });
  const utterances = [];
  const peeks = [];
  listener.on('utterance', (u) => utterances.push(u));
  listener.on('peek', (p) => peeks.push(p));
  return {
    receiver,
    listener,
    utterances,
    peeks,
    advance: (ms) => {
      now += ms;
    },
    // Delivers packets one at a time, 20 ms apart on the fake clock, like Discord does.
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

test('one sentence followed by a pause becomes one utterance', async () => {
  const t = setup();
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 50 })); // 1 s of speech
  t.listener.sweep();
  assert.equal(t.utterances.length, 0, 'not finished until the pause is long enough');
  t.advance(750);
  t.listener.sweep();
  assert.equal(t.utterances.length, 1);
  const u = t.utterances[0];
  assert.equal(u.userId, 'u1');
  assert.ok(u.voicedMs >= 900, `voiced ${u.voicedMs}`);
  assert.equal(u.wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(u.wav.readUInt32LE(24), 16000);
  t.listener.stop();
});

test('short clicks and coughs are ignored', async () => {
  const t = setup();
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 5 })); // 100 ms
  t.advance(800);
  t.listener.sweep();
  assert.equal(t.utterances.length, 0);
  t.listener.stop();
});

test('quiet trailing audio counts as a pause and gets trimmed', async () => {
  const t = setup();
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 40, silentFrames: 60 })); // 0.8 s speech + 1.2 s near-silence
  t.listener.sweep();
  assert.equal(t.utterances.length, 1);
  const u = t.utterances[0];
  // 40 voiced + up to 5 preroll + 10 kept trailing frames, at 20 ms each
  assert.ok(u.durationMs <= (40 + 5 + 10 + 2) * 20, `duration ${u.durationMs}`);
  t.listener.stop();
});

test('very long talking is cut into chunks at the max length', async () => {
  const t = setup({ maxUtteranceMs: 3000 });
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 200 })); // 4 s
  assert.equal(t.utterances.length, 1, 'first chunk emitted at 3 s');
  t.advance(800);
  t.listener.sweep();
  assert.equal(t.utterances.length, 2);
  t.listener.stop();
});

test('dropping a user discards buffered audio', async () => {
  const t = setup();
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 50 }));
  t.listener.drop('u1');
  t.advance(1000);
  t.listener.sweep();
  assert.equal(t.utterances.length, 0);
  assert.equal(t.listener.users.size, 0);
  t.listener.stop();
});

test('people who should not be heard are never subscribed', () => {
  const receiver = fakeReceiver();
  const listener = new Listener({ receiver, listen: LISTEN, shouldListen: (id) => id !== 'optedOut' });
  listener.onSpeakingStart('optedOut');
  assert.equal(receiver.streams.size, 0);
  listener.onSpeakingStart('ok');
  assert.equal(receiver.streams.size, 1);
  listener.stop();
});

test('a stream closed by the library flushes speech and resubscribes', async () => {
  const t = setup();
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 30 }));
  const first = t.receiver.streams.get('u1');
  first.destroy();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(t.utterances.length, 1, 'buffered speech was not lost');
  assert.notEqual(t.receiver.streams.get('u1'), first, 'subscribed again');
  t.listener.stop();
});

test('an open mic sending only background noise does not count as someone talking', async () => {
  const t = setup();
  t.receiver.speaking.users.set('u1', Date.now()); // Discord: u1 is sending audio
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ silentFrames: 30 })); // ...but it's quiet
  assert.equal(t.listener.isAnyoneSpeaking(), false);
  await t.feed('u1', packets({ toneFrames: 5 })); // now they talk
  assert.equal(t.listener.isAnyoneSpeaking(), true);
  await t.feed('u1', packets({ silentFrames: 40 })); // the sentence ends after 0.7 s of quiet
  assert.equal(t.listener.isAnyoneSpeaking(), false);
  t.receiver.speaking.users.set('u2', Date.now()); // someone it doesn't listen to (opted out): counts
  assert.equal(t.listener.isAnyoneSpeaking(), true);
  t.listener.stop();
});

test('isAnyoneSpeaking ignores bots', () => {
  const receiver = fakeReceiver();
  receiver.speaking.users.set('musicbot', Date.now());
  const listener = new Listener({ receiver, listen: LISTEN, shouldListen: () => true });
  assert.equal(listener.isAnyoneSpeaking((id) => id !== 'musicbot'), false);
  receiver.speaking.users.set('human', Date.now());
  assert.equal(listener.isAnyoneSpeaking((id) => id !== 'musicbot'), true);
});

test('while the bot is talking, a long sentence is checked early, twice at most', async () => {
  const t = setup({}, { wantPeek: () => true });
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 40 })); // 0.8 s: not yet
  assert.equal(t.peeks.length, 0);
  await t.feed('u1', packets({ toneFrames: 10 })); // passes 0.9 s of speech
  assert.equal(t.peeks.length, 1);
  const p = t.peeks[0];
  assert.equal(p.userId, 'u1');
  assert.equal(p.wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(p.wav.readUInt32LE(24), 16000);
  assert.ok(p.durationMs >= 900 && p.durationMs <= 1100, `peek covers ${p.durationMs} ms`);
  await t.feed('u1', packets({ toneFrames: 100 })); // 2.8 s total
  assert.equal(t.peeks.length, 2, 'second look at 2 s, then no more');
  assert.ok(t.peeks[1].durationMs >= 2000);
  t.advance(800);
  t.listener.sweep();
  assert.equal(t.utterances.length, 1, 'the full sentence still arrives as usual');
  assert.ok(t.utterances[0].id > 0);
  assert.equal(t.peeks[0].id, t.utterances[0].id, 'peeks and the final sentence share an id');
  assert.equal(t.peeks[1].id, t.utterances[0].id);
  t.listener.stop();
});

test('no early checks while the bot is quiet, or on short sentences', async () => {
  let botTalking = false;
  const t = setup({}, { wantPeek: () => botTalking });
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 60 }));
  t.advance(800);
  t.listener.sweep();
  assert.equal(t.peeks.length, 0, 'bot was quiet');
  botTalking = true;
  await t.feed('u1', packets({ toneFrames: 40 })); // 0.8 s
  t.advance(800);
  t.listener.sweep();
  assert.equal(t.peeks.length, 0, 'too short to bother');
  assert.equal(t.utterances.length, 2);
  assert.ok(t.utterances[1].id > t.utterances[0].id, 'each sentence gets a new id');
  t.listener.stop();
});

test('if the bot starts talking mid-sentence, the later check still happens', async () => {
  let botTalking = false;
  const t = setup({}, { wantPeek: () => botTalking });
  t.listener.onSpeakingStart('u1');
  await t.feed('u1', packets({ toneFrames: 60 })); // 1.2 s, bot quiet at 0.9 s
  assert.equal(t.peeks.length, 0);
  botTalking = true;
  await t.feed('u1', packets({ toneFrames: 50 })); // passes 2 s
  assert.equal(t.peeks.length, 1);
  t.listener.stop();
});

// Raw 20 ms PCM frames fed straight in (the decoder passes them through).
function pcmSetup(extra = {}) {
  let now = 2_000_000;
  const receiver = fakeReceiver();
  const listener = new Listener({
    receiver,
    listen: { ...LISTEN, maxUtteranceMs: 20000, noiseMargin: 2, ...extra },
    shouldListen: () => true,
    clock: () => now,
    createDecoder: () => ({ name: 'pass', decode: (p) => p, destroy() {} }),
  });
  const utterances = [];
  listener.on('utterance', (u) => utterances.push(u));
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  // A frame of noise at about the given loudness, or a syllable-shaped voice.
  const frame = (level) => {
    const b = Buffer.alloc(3840);
    for (let i = 0; i < 960; i++) {
      const v = Math.round(rnd() * level * 1.732);
      b.writeInt16LE(v, i * 4);
      b.writeInt16LE(v, i * 4 + 2);
    }
    return b;
  };
  return {
    receiver,
    listener,
    utterances,
    frame,
    now: () => now,
    advance: (ms) => (now += ms),
    async feed(userId, frames, { sweepEvery = 1 } = {}) {
      const s = receiver.streams.get(userId);
      let talking = 0;
      for (let i = 0; i < frames.length; i++) {
        s.push(frames[i]);
        await new Promise((r) => setImmediate(r));
        now += 20;
        if (i % sweepEvery === 0) listener.sweep();
        if (listener.isAnyoneSpeaking()) talking++;
      }
      return talking / frames.length;
    },
  };
}

test('an open mic with steady background noise is not "always talking", and speech over it is still heard', async () => {
  const t = pcmSetup();
  t.receiver.speaking.users.set('u1', 0);
  t.listener.onSpeakingStart('u1');
  const hiss = (n) => Array.from({ length: n }, () => t.frame(300)); // louder than VOICE_RMS_THRESHOLD
  await t.feed('u1', hiss(100)); // its level is learned in the first half second
  t.utterances.length = 0;
  const talking = await t.feed('u1', hiss(500)); // 10 s of hiss
  assert.ok(talking < 0.05, `counted as talking ${Math.round(talking * 100)}% of the time`);
  assert.equal(t.utterances.length, 0, 'no noise clips sent to speech-to-text');
  // Someone talks over the hiss: three syllables, then quiet.
  const syllable = () => [...Array.from({ length: 10 }, () => t.frame(3000)), ...hiss(4)];
  await t.feed('u1', [...syllable(), ...syllable(), ...syllable(), ...hiss(50)]);
  assert.equal(t.utterances.length, 1, 'one sentence');
  assert.ok(t.utterances[0].voicedMs >= 500, `voiced ${t.utterances[0].voicedMs}`);
  t.listener.stop();
});

test('a lone click does not start a sentence, and clicks do not keep one going', async () => {
  const t = pcmSetup();
  t.listener.onSpeakingStart('u1');
  const quiet = (n) => Array.from({ length: n }, () => t.frame(40));
  const clicks = [];
  for (let i = 0; i < 40; i++) clicks.push(...(i % 8 === 0 ? [t.frame(4000)] : quiet(1)));
  await t.feed('u1', [...quiet(30), ...clicks, ...quiet(40)]);
  assert.equal(t.utterances.length, 0);
  assert.equal(t.listener.hasOpenSentence(), false);
  t.listener.stop();
});

test('NOISE_MARGIN=0 turns the background-noise check off', async () => {
  const t = pcmSetup({ noiseMargin: 0 });
  t.receiver.speaking.users.set('u1', 0);
  t.listener.onSpeakingStart('u1');
  const talking = await t.feed('u1', Array.from({ length: 200 }, () => t.frame(300)));
  assert.ok(talking > 0.9, 'every frame over VOICE_RMS_THRESHOLD counts, as before');
  t.listener.stop();
});

test('frames still end-to-end encrypted are skipped instead of heard as noise', async () => {
  let decoded = 0;
  const receiver = fakeReceiver();
  const listener = new Listener({
    receiver,
    listen: LISTEN,
    shouldListen: () => true,
    createDecoder: () => ({ name: 'count', decode: () => (decoded++, Buffer.alloc(3840, 0x40)), destroy() {} }),
  });
  listener.onSpeakingStart('u1');
  const s = receiver.streams.get('u1');
  s.push(Buffer.from([0x78, 1, 2, 3, 0xfa, 0xfa]));
  s.push(Buffer.from([0x78, 1, 2, 3, 4, 5]));
  await new Promise((r) => setImmediate(r));
  assert.equal(decoded, 1, 'only the decrypted frame reached the decoder');
  listener.stop();
});

test('someone still talking whose subscription was lost is picked back up', async () => {
  const t = pcmSetup();
  t.listener.onSpeakingStart('u1');
  t.receiver.speaking.users.set('u1', 0);
  t.listener.drop('u1'); // say, after a channel move; Discord sends no new "start" while they keep talking
  assert.equal(t.listener.users.size, 0);
  t.advance(2500);
  t.listener.sweep();
  assert.equal(t.listener.users.size, 1, 'listening again');
  t.listener.stop();
});
