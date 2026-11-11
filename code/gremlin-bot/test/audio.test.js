import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  MonoToDiscordPcm,
  createOpusDecoder,
  pcmToWav,
  rms,
  sampleRateFromFormat,
  stereo48kToMono16k,
} from '../src/audio.js';

function monoRamp(n, start = 0, step = 10) {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, start + i * step)), i * 2);
  return b;
}

async function collect(stream) {
  const parts = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

test('pcmToWav writes a valid 16-bit header', () => {
  const pcm = Buffer.alloc(3200);
  const wav = pcmToWav(pcm, 16000, 1);
  assert.equal(wav.length, 44 + 3200);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4), 36 + 3200);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 3200);
});

test('stereo48kToMono16k averages channels and decimates by 3', () => {
  const frames = 960; // 20 ms
  const b = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    b.writeInt16LE(1000, i * 4);
    b.writeInt16LE(3000, i * 4 + 2);
  }
  const out = stereo48kToMono16k(b);
  assert.equal(out.length, (frames / 3) * 2);
  for (let i = 0; i < out.length / 2; i++) assert.equal(out.readInt16LE(i * 2), 2000);
});

test('rms of a constant signal equals its magnitude', () => {
  const b = Buffer.alloc(200);
  for (let i = 0; i < 100; i++) b.writeInt16LE(i % 2 ? 500 : -500, i * 2);
  assert.equal(Math.round(rms(b)), 500);
  assert.equal(rms(Buffer.alloc(0)), 0);
});

test('sampleRateFromFormat parses pcm formats only', () => {
  assert.equal(sampleRateFromFormat('pcm_24000'), 24000);
  assert.equal(sampleRateFromFormat('mp3_44100_128'), null);
});

test('MonoToDiscordPcm doubles 24 kHz mono into 48 kHz stereo with interpolation', async () => {
  const input = monoRamp(1000, 0, 10);
  const out = await collect(Readable.from([input]).pipe(new MonoToDiscordPcm({ inputRate: 24000, leadingSilenceMs: 0 })));
  const frames = out.length / 4;
  assert.ok(frames >= 1996 && frames <= 2000, `got ${frames} frames`);
  for (let k = 0; k < 50; k++) {
    const l = out.readInt16LE(k * 4);
    const r = out.readInt16LE(k * 4 + 2);
    assert.equal(l, r, 'channels must match');
    assert.equal(l, k * 5, 'linear interpolation between ramp samples');
  }
});

test('MonoToDiscordPcm gives identical output no matter how chunks are split (odd bytes too)', async () => {
  const input = monoRamp(4801, -20000, 7);
  const whole = await collect(Readable.from([input]).pipe(new MonoToDiscordPcm({ inputRate: 22050, leadingSilenceMs: 0 })));
  const pieces = [];
  let i = 0;
  const sizes = [1, 3, 7, 2, 513, 1, 999, 4, 77];
  let s = 0;
  while (i < input.length) {
    const n = sizes[s++ % sizes.length];
    pieces.push(input.subarray(i, i + n));
    i += n;
  }
  const split = await collect(Readable.from(pieces).pipe(new MonoToDiscordPcm({ inputRate: 22050, leadingSilenceMs: 0 })));
  assert.equal(split.length, whole.length);
  assert.ok(split.equals(whole));
});

test('MonoToDiscordPcm adds leading silence and applies volume', async () => {
  const input = Buffer.alloc(200);
  for (let i = 0; i < 100; i++) input.writeInt16LE(1000, i * 2);
  const out = await collect(Readable.from([input]).pipe(new MonoToDiscordPcm({ inputRate: 48000, volume: 2, leadingSilenceMs: 20 })));
  const silenceBytes = 20 * 192;
  assert.ok(out.subarray(0, silenceBytes).every((b) => b === 0));
  assert.equal(out.readInt16LE(silenceBytes), 2000);
});

test('Opus decoder round trip keeps the signal', async () => {
  const { default: OpusScript } = await import('opusscript');
  const enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const dec = createOpusDecoder();
  const frame = Buffer.alloc(960 * 4);
  let total = 0;
  for (let f = 0; f < 10; f++) {
    for (let i = 0; i < 960; i++) {
      const v = Math.round(8000 * Math.sin((2 * Math.PI * 300 * (f * 960 + i)) / 48000));
      frame.writeInt16LE(v, i * 4);
      frame.writeInt16LE(v, i * 4 + 2);
    }
    const pcm = dec.decode(enc.encode(frame, 960));
    assert.equal(pcm.length, 960 * 4);
    if (f > 2) total += rms(pcm);
  }
  dec.destroy();
  enc.delete();
  assert.ok(total / 7 > 4000, 'decoded audio should be loud, not silence');
});
