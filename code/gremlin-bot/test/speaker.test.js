import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { AudioPlayerStatus } from '@discordjs/voice';
import { Speaker } from '../src/speaker.js';

class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.state = { status: AudioPlayerStatus.Idle };
    this.played = [];
  }
  setStatus(status) {
    const old = this.state;
    this.state = { status };
    this.emit('stateChange', old, this.state);
  }
  play(resource) {
    this.played.push(resource);
    this.setStatus(AudioPlayerStatus.Playing);
  }
  stop() {
    if (this.state.status !== AudioPlayerStatus.Idle) this.setStatus(AudioPlayerStatus.Idle);
    return true;
  }
}

function fakeTts({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async stream(text, { signal }) {
      calls.push({ text, signal });
      if (fail) throw fail;
      return { stream: Readable.from([Buffer.alloc(4800)]), sampleRate: 24000 };
    },
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('plays a line and resolves when playback finishes', async () => {
  const player = new FakePlayer();
  const tts = fakeTts();
  const speaker = new Speaker({ tts, player });
  let started = false;
  const done = speaker.say('hello there', { kind: 'direct', onStart: () => (started = true) });
  await tick(120);
  assert.equal(player.played.length, 1);
  assert.equal(started, true);
  assert.equal(speaker.speaking, true);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await done, 'played');
  assert.equal(tts.calls[0].text, 'hello there');
});

test('lines play one after another', async () => {
  const player = new FakePlayer();
  const speaker = new Speaker({ tts: fakeTts(), player });
  const a = speaker.say('one');
  const b = speaker.say('two');
  await tick(120);
  assert.equal(player.played.length, 1);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await a, 'played');
  await tick(120);
  assert.equal(player.played.length, 2);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await b, 'played');
});

test('an unprompted quip is dropped if nobody pauses, without paying ElevenLabs for it', async () => {
  const player = new FakePlayer();
  const tts = fakeTts();
  let now = 0;
  const speaker = new Speaker({ tts, player, isAnyoneSpeaking: () => true, clock: () => now });
  const p = speaker.say('quip', { kind: 'quip' });
  await tick(50);
  now = 4000; // past the 3 s gap wait
  assert.equal(await p, 'dropped');
  assert.equal(player.played.length, 0);
  assert.equal(tts.calls.length, 0, 'never synthesized');
});

test('a quip is only synthesized once there is a pause', async () => {
  const player = new FakePlayer();
  const tts = fakeTts();
  let talking = true;
  const speaker = new Speaker({ tts, player, isAnyoneSpeaking: () => talking });
  const p = speaker.say('quip', { kind: 'quip' });
  await tick(100);
  assert.equal(tts.calls.length, 0, 'not while people are talking');
  talking = false;
  await tick(150);
  assert.equal(tts.calls.length, 1);
  assert.equal(player.played.length, 1);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await p, 'played');
});

test('a direct answer still plays if people keep talking, and synthesizes while it waits', async () => {
  const player = new FakePlayer();
  const tts = fakeTts();
  let now = 0;
  const speaker = new Speaker({ tts, player, isAnyoneSpeaking: () => true, clock: () => now });
  const p = speaker.say('answer', { kind: 'direct' });
  await tick(50);
  assert.equal(tts.calls.length, 1, 'started right away');
  now = 2000;
  await tick(150);
  assert.equal(player.played.length, 1);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await p, 'played');
});

test('the next line is fetched early only if it will surely be said', async () => {
  const player = new FakePlayer();
  const tts = fakeTts();
  const speaker = new Speaker({ tts, player });
  const a = speaker.say('answer one', { kind: 'direct' });
  const b = speaker.say('a quip', { kind: 'quip' });
  await tick(120);
  assert.deepEqual(tts.calls.map((c) => c.text), ['answer one'], 'the quip waits its turn');
  const c = speaker.say('answer two', { kind: 'direct' });
  speaker.stop();
  await Promise.all([a, b, c]);
});

test('stop() cuts the current line and clears the queue', async () => {
  const player = new FakePlayer();
  const tts = fakeTts();
  const speaker = new Speaker({ tts, player });
  const a = speaker.say('one');
  const b = speaker.say('two');
  await tick(120);
  speaker.stop();
  assert.equal(await a, 'stopped');
  assert.equal(await b, 'stopped');
  assert.ok(tts.calls.every((c) => c.signal.aborted));
});

test('voice failure hands the line to the text fallback', async () => {
  const player = new FakePlayer();
  const failures = [];
  const speaker = new Speaker({
    tts: fakeTts({ fail: new Error('quota_exceeded') }),
    player,
    onVoiceFailure: (text, err) => failures.push([text, err.message]),
  });
  assert.equal(await speaker.say('joke'), 'failed');
  assert.deepEqual(failures, [['joke', 'quota_exceeded']]);
});

test('audible is only true while a line is actually playing', async () => {
  const player = new FakePlayer();
  let someoneTalking = true;
  const speaker = new Speaker({ tts: fakeTts(), player, isAnyoneSpeaking: () => someoneTalking });
  const done = speaker.say('wait for it', { kind: 'direct' });
  await tick(100);
  assert.equal(speaker.speaking, true, 'busy waiting for a pause');
  assert.equal(speaker.audible, false, 'but not making a sound yet');
  someoneTalking = false;
  await tick(150);
  assert.equal(player.played.length, 1);
  assert.equal(speaker.audible, true);
  speaker.stop();
  assert.equal(speaker.audible, false, 'stopping makes it quiet right away');
  assert.equal(await done, 'stopped');
  assert.equal(speaker.audible, false);
});

test('dropOptional clears waiting jokes but keeps answers', async () => {
  const player = new FakePlayer();
  const tts = fakeTts();
  let talking = true;
  const speaker = new Speaker({ tts, player, isAnyoneSpeaking: () => talking });
  const quip = speaker.say('a joke', { kind: 'quip' }); // waiting for a pause
  const queuedQuip = speaker.say('another joke', { kind: 'followup' });
  const answer = speaker.say('the answer', { kind: 'direct' });
  await tick(50);
  speaker.dropOptional();
  assert.equal(await quip, 'stopped');
  assert.equal(await queuedQuip, 'dropped');
  talking = false;
  await tick(150);
  assert.deepEqual(tts.calls.map((c) => c.text), ['the answer']);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await answer, 'played');
});

test('a joke whose audio loaded just as someone started talking waits, then gives up', async () => {
  const player = new FakePlayer();
  let now = 0;
  let talking = false;
  const tts = {
    calls: [],
    async stream(text) {
      this.calls.push(text);
      talking = true; // someone starts talking while the audio loads
      return { stream: Readable.from([Buffer.alloc(48000)]), sampleRate: 24000 };
    },
  };
  const speaker = new Speaker({ tts, player, isAnyoneSpeaking: () => talking, clock: () => now });
  const p = speaker.say('quip', { kind: 'quip' });
  await tick(100);
  assert.equal(player.played.length, 0, 'did not start over them');
  now = 5000;
  assert.equal(await p, 'dropped');
  assert.equal(player.played.length, 0);
});

test('an optional line also waits while a just-finished sentence is being transcribed', async () => {
  const player = new FakePlayer();
  const tts = fakeTts();
  let hearing = true;
  const speaker = new Speaker({ tts, player, isHearing: () => hearing });
  const quip = speaker.say('quip', { kind: 'quip' });
  const answer = speaker.say('answer', { kind: 'direct' });
  await tick(120);
  assert.equal(player.played.length, 0, 'the quip holds');
  hearing = false;
  await tick(150);
  assert.equal(player.played.length, 1);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await quip, 'played');
  await tick(150);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await answer, 'played');
});

test('committed: true while it is saying something or has a line it must say, not for lines it may drop', async () => {
  const player = new FakePlayer();
  let talking = true; // someone is talking, so lines wait for a pause
  const speaker = new Speaker({ tts: fakeTts(), player, isAnyoneSpeaking: () => talking });
  assert.equal(speaker.committed, false);
  speaker.say('a joke', { kind: 'quip' });
  await tick(20);
  assert.equal(speaker.speaking, true, 'busy with the waiting joke');
  assert.equal(speaker.committed, false, 'but it may still drop it');
  speaker.say('the answer', { kind: 'direct' });
  await tick(20);
  assert.equal(speaker.committed, true, 'an answer is waiting its turn');
  speaker.stop();
  assert.equal(speaker.committed, false, 'nothing left to say after stop()');
  talking = false;
  speaker.say('Yeah?', { kind: 'ack' });
  await tick(150);
  assert.equal(player.played.length, 1);
  assert.equal(speaker.committed, true, 'saying it now');
  player.setStatus(AudioPlayerStatus.Idle);
});

test('a quick "Yeah?" is skipped if the caller is already saying the rest', async () => {
  const player = new FakePlayer();
  const tts = fakeTts();
  const speaker = new Speaker({ tts, player, isAnyoneSpeaking: () => false });
  const outcome = await speaker.say('Yeah?', { kind: 'ack', busy: () => true });
  assert.equal(outcome, 'dropped');
  assert.equal(player.played.length, 0);
  assert.equal(tts.calls.length, 0, 'not paid for');
});

test('a quick "Yeah?" waits only for the caller: other people chatting does not hold it back', async () => {
  const player = new FakePlayer();
  const speaker = new Speaker({ tts: fakeTts(), player, isAnyoneSpeaking: () => true });
  const done = speaker.say('Yeah?', { kind: 'ack', busy: () => false });
  await tick(150);
  assert.equal(player.played.length, 1, 'said right away');
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await done, 'played');
});

test('a line taken back before it starts is never played, and one already playing keeps going', async () => {
  const player = new FakePlayer();
  const speaker = new Speaker({ tts: fakeTts(), player });
  const first = new AbortController();
  const second = new AbortController();
  const a = speaker.say('one', { signal: first.signal });
  const b = speaker.say('two', { signal: second.signal });
  await tick(120);
  assert.equal(player.played.length, 1, 'the first is playing');
  first.abort();
  second.abort();
  assert.equal(await b, 'dropped', 'the waiting one is forgotten');
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await a, 'played', 'too late to take back the one already playing');
  await tick(120);
  assert.equal(player.played.length, 1);
});

test('an answer holds while whoever asked is still talking, up to a limit', async () => {
  const player = new FakePlayer();
  let now = 0;
  let asking = true;
  const speaker = new Speaker({ tts: fakeTts(), player, isAnyoneSpeaking: () => false, clock: () => now });
  const done = speaker.say('the answer', { kind: 'direct', hold: () => asking });
  await tick(200);
  now = 3000; // past the usual 1.2 s gap wait
  await tick(200);
  assert.equal(player.played.length, 0, 'still held: they are still asking');
  asking = false;
  await tick(200);
  assert.equal(player.played.length, 1);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await done, 'played');

  asking = true;
  const stuck = speaker.say('another answer', { kind: 'direct', hold: () => asking });
  await tick(200);
  now += 6000; // held longer than the limit: it goes ahead
  await tick(200);
  assert.equal(player.played.length, 2);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await stuck, 'played');
});

test('stopKind stops only lines of that kind', async () => {
  const player = new FakePlayer();
  const speaker = new Speaker({ tts: fakeTts(), player });
  const ack = speaker.say('Yeah?', { kind: 'ack' });
  const answer = speaker.say('An answer.', { kind: 'direct' });
  await tick(120);
  assert.equal(player.played.length, 1);
  speaker.stopKind('ack');
  assert.equal(await ack, 'stopped');
  await tick(120);
  assert.equal(player.played.length, 2, 'the answer still plays');
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await answer, 'played');
});

test('the quick fixed lines ask for the replay cache; answers do not', async () => {
  const player = new FakePlayer();
  const seen = [];
  const tts = {
    async stream(text, opts) {
      seen.push([text, Boolean(opts.cache)]);
      return { stream: Readable.from([Buffer.alloc(4800)]), sampleRate: 24000 };
    },
  };
  const speaker = new Speaker({ tts, player });
  const a = speaker.say('Yeah?', { kind: 'ack' });
  await tick(150);
  player.setStatus(AudioPlayerStatus.Idle);
  await a;
  const b = speaker.say('A real answer.', { kind: 'direct' });
  await tick(150);
  player.setStatus(AudioPlayerStatus.Idle);
  await b;
  assert.deepEqual(seen, [['Yeah?', true], ['A real answer.', false]]);
});

test('a "Hmm." or a laugh is not talking: someone starting over it is not talking over it', async () => {
  const player = new FakePlayer();
  let now = 1000;
  const speaker = new Speaker({ tts: fakeTts(), player, clock: () => now });
  const hmm = speaker.say('Hmm.', { kind: 'think' });
  await tick(120);
  assert.equal(player.played.length, 1);
  assert.equal(speaker.nowPlaying().kind, 'think');
  assert.equal(speaker.audible, false);
  now = 1600;
  assert.equal(speaker.wasAudibleBetween(1000, 1600), false);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await hmm, 'played');
  // An answer is talking.
  const answer = speaker.say('The answer.', { kind: 'direct' });
  await tick(120);
  assert.equal(speaker.audible, true);
  now = 2400;
  assert.equal(speaker.wasAudibleBetween(1700, 2400), true);
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await answer, 'played');
});

test('lines that waited through a song do not lose that time (a reminder still plays after a long song)', async () => {
  const player = new FakePlayer();
  let now = 0;
  const speaker = new Speaker({ tts: fakeTts(), player, clock: () => now });
  const song = speaker.say('la la', { kind: 'song', source: async () => ({ stream: Readable.from([Buffer.alloc(9600)]), sampleRate: 48000 }), durationMs: 90000 });
  await tick(120);
  assert.equal(speaker.nowPlaying().kind, 'song');
  const reminder = speaker.say('Time to stretch.', { kind: 'reminder' });
  now = 90000; // the song played for 90 s; a reminder is only good for 60 s of waiting
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await song, 'played');
  await tick(150);
  assert.equal(player.played.length, 2, 'the reminder still plays');
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await reminder, 'played');
});
