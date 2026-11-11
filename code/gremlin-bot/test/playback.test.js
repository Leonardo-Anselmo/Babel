import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { AudioPlayerStatus } from '@discordjs/voice';
import { Speaker } from '../src/speaker.js';

// Uses the real @discordjs/voice AudioPlayer and Opus encoder (no Discord connection).
function streamingTts(seconds, rate = 24000) {
  return {
    async stream() {
      const total = Math.round(seconds * rate) * 2;
      const chunk = 4800; // 100 ms
      let sent = 0;
      const stream = new Readable({
        read() {
          if (sent >= total) return this.push(null);
          const n = Math.min(chunk, total - sent);
          const buf = Buffer.alloc(n);
          for (let i = 0; i + 1 < n; i += 2) buf.writeInt16LE(Math.round(5000 * Math.sin(((sent + i) / 2) * 0.05)), i);
          sent += n;
          setTimeout(() => this.push(buf), 10); // arrives faster than real time, like ElevenLabs
        },
      });
      return { stream, sampleRate: rate };
    },
  };
}

test('a 1 s line really plays through the Discord audio player and finishes', async () => {
  const speaker = new Speaker({ tts: streamingTts(1) });
  const states = [];
  speaker.player.on('stateChange', (_a, b) => states.push(b.status));
  const t0 = Date.now();
  const outcome = await speaker.say('test line', { kind: 'direct' });
  const ms = Date.now() - t0;
  assert.equal(outcome, 'played');
  assert.ok(states.includes(AudioPlayerStatus.Playing), `states: ${states.join(',')}`);
  assert.equal(speaker.player.state.status, AudioPlayerStatus.Idle);
  assert.ok(ms > 900 && ms < 4000, `took ${ms} ms`);
  speaker.destroy();
});

test('stop() cuts real playback short', async () => {
  const speaker = new Speaker({ tts: streamingTts(5) });
  const t0 = Date.now();
  const p = speaker.say('long line', { kind: 'direct' });
  setTimeout(() => speaker.stop(), 600);
  assert.equal(await p, 'stopped');
  assert.ok(Date.now() - t0 < 2000);
  speaker.destroy();
});
