// Raw audio helpers. Everything is 16-bit signed little-endian PCM.
// Discord gives us (after Opus decode) 48 kHz stereo; speech-to-text wants
// 16 kHz mono; ElevenLabs sends mono at 16-44.1 kHz and Discord playback
// wants 48 kHz stereo again.

import { Transform } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const DISCORD_RATE = 48000;
export const DISCORD_CHANNELS = 2;
export const FRAME_SAMPLES = 960; // 20 ms at 48 kHz
export const STEREO_BYTES_PER_MS = (DISCORD_RATE * DISCORD_CHANNELS * 2) / 1000; // 192

const clamp16 = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

/** RMS loudness of an interleaved 16-bit buffer (any channel count). */
export function rms(buf) {
  const n = Math.floor(buf.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

// 31-tap Blackman-windowed low-pass at 7 kHz, so content above 8 kHz doesn't
// fold back into the speech band when we drop from 48 kHz to 16 kHz.
const DECIMATION_TAPS = (() => {
  const n = 31;
  const m = n - 1;
  const fc = 7000 / DISCORD_RATE;
  const h = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m / 2;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / m) + 0.08 * Math.cos((4 * Math.PI * i) / m);
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
})();

/** 48 kHz stereo -> 16 kHz mono: average the channels, low-pass, keep every 3rd sample. */
export function stereo48kToMono16k(pcm) {
  const frames = Math.floor(pcm.length / 4);
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = (pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) / 2;
  const outLen = Math.floor(frames / 3);
  const out = Buffer.alloc(outLen * 2);
  const half = (DECIMATION_TAPS.length - 1) / 2;
  const last = frames - 1;
  for (let i = 0; i < outLen; i++) {
    const center = i * 3;
    let acc = 0;
    for (let k = 0; k < DECIMATION_TAPS.length; k++) {
      let idx = center + k - half;
      if (idx < 0) idx = 0;
      else if (idx > last) idx = last;
      acc += DECIMATION_TAPS[k] * mono[idx];
    }
    out.writeInt16LE(clamp16(Math.round(acc)), i * 2);
  }
  return out;
}

/** Wraps raw PCM in a 44-byte WAV header. */
export function pcmToWav(pcm, sampleRate, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Streaming converter: mono 16-bit PCM at any sample rate -> 48 kHz stereo,
 * using linear interpolation. Safe across arbitrary chunk boundaries
 * (including chunks that split a sample in half).
 */
export class MonoToDiscordPcm extends Transform {
  constructor({ inputRate, volume = 1, leadingSilenceMs = 60 } = {}) {
    // Room for ~1.3 s of output so upstream audio isn't throttled while we pre-buffer.
    super({ readableHighWaterMark: 256 * 1024 });
    if (!inputRate || inputRate < 4000 || !Number.isInteger(inputRate)) throw new Error(`Bad input sample rate: ${inputRate}`);
    // Positions are kept as exact integers in units of 1/48000 of an input
    // sample, so output is identical however the input is chunked.
    this.step = inputRate; // advance per output sample
    this.unit = DISCORD_RATE; // one input sample
    this.volume = volume;
    this.leadingSilenceMs = leadingSilenceMs;
    this.started = false;
    this.carryByte = null; // odd trailing byte from the previous chunk
    this.prev = null; // last input sample of the previous chunk
    this.pos = 0; // read position (in 1/48000 sample units), relative to `prev` (index 0) when prev exists
  }

  _transform(chunk, _enc, done) {
    try {
      if (!this.started) {
        this.started = true;
        if (this.leadingSilenceMs > 0) {
          this.push(Buffer.alloc(Math.round(this.leadingSilenceMs * STEREO_BYTES_PER_MS / 4) * 4));
        }
      }
      let data = chunk;
      if (this.carryByte !== null) {
        data = Buffer.concat([Buffer.from([this.carryByte]), chunk]);
        this.carryByte = null;
      }
      if (data.length % 2 === 1) {
        this.carryByte = data[data.length - 1];
        data = data.subarray(0, data.length - 1);
      }
      const n = data.length / 2;
      if (n === 0) return done();

      // Build the sample window: [prev, ...this chunk]
      const hasPrev = this.prev !== null;
      const len = n + (hasPrev ? 1 : 0);
      const samples = new Int32Array(len);
      let w = 0;
      if (hasPrev) samples[w++] = this.prev;
      for (let i = 0; i < n; i++) samples[w++] = data.readInt16LE(i * 2);

      // Output samples we can produce while staying inside the window (pos < (len-1) * unit).
      const limit = (len - 1) * this.unit;
      const outCount = this.pos < limit ? Math.ceil((limit - this.pos) / this.step) : 0;
      const out = Buffer.alloc(outCount * 4);
      let t = this.pos;
      for (let k = 0; k < outCount; k++) {
        const i = Math.floor(t / this.unit);
        const frac = (t - i * this.unit) / this.unit;
        const a = samples[i];
        const b = i + 1 < len ? samples[i + 1] : a;
        const v = clamp16(Math.round((a + (b - a) * frac) * this.volume));
        out.writeInt16LE(v, k * 4);
        out.writeInt16LE(v, k * 4 + 2);
        t += this.step;
      }
      // Re-anchor so the next window starts at this window's last sample.
      this.pos = t - limit;
      this.prev = samples[len - 1];
      if (out.length) this.push(out);
      done();
    } catch (err) {
      done(err);
    }
  }
}

/** Parses an ElevenLabs output format like "pcm_24000" into its sample rate. */
export function sampleRateFromFormat(format) {
  const m = /^pcm_(\d+)$/.exec(format || '');
  return m ? Number(m[1]) : null;
}

/**
 * Creates a stateful Opus decoder for one speaker (48 kHz stereo out).
 * Prefers the native @discordjs/opus if it happens to be installed,
 * otherwise uses opusscript (pure WebAssembly, no build tools needed).
 */
export function createOpusDecoder() {
  try {
    const { OpusEncoder } = require('@discordjs/opus');
    const codec = new OpusEncoder(DISCORD_RATE, DISCORD_CHANNELS);
    return { name: '@discordjs/opus', decode: (packet) => codec.decode(packet), destroy() {} };
  } catch {
    // fall through to opusscript
  }
  const OpusScript = require('opusscript');
  const codec = new OpusScript(DISCORD_RATE, DISCORD_CHANNELS, OpusScript.Application.VOIP);
  let alive = true;
  return {
    name: 'opusscript',
    decode: (packet) => codec.decode(packet),
    destroy() {
      if (alive) {
        alive = false;
        try {
          codec.delete();
        } catch {
          // already freed
        }
      }
    },
  };
}
