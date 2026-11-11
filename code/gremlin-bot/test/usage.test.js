import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pcmToWav } from '../src/audio.js';
import { createClaude } from '../src/claude.js';
import { createStt, wavSeconds } from '../src/stt.js';
import { createTts } from '../src/tts.js';
import {
  Usage,
  costOf,
  dayKey,
  deepgramBalance,
  describeBucket,
  elevenLabsQuota,
  money,
  oneLine,
  totalDollars,
} from '../src/usage.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('prices: voice, hearing and Claude', () => {
  near(costOf({ type: 'tts', chars: 1000, model: 'eleven_flash_v2_5' }).ttsDollars, 0.04);
  near(costOf({ type: 'tts', chars: 1000, model: 'eleven_multilingual_v2' }).ttsDollars, 0.08);
  near(costOf({ type: 'stt', provider: 'deepgram', seconds: 60, keyterms: true }).sttDollars, 0.0056);
  near(costOf({ type: 'stt', provider: 'deepgram', seconds: 60, keyterms: false }).sttDollars, 0.0043);
  const c = costOf({
    type: 'claude',
    model: 'claude-sonnet-5-5',
    usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500 },
  });
  near(c.claudeDollars, (1000 * 2 + 100 * 10 + 2000 * 0.1 + 500 * 2.5) / 1e6);
  assert.equal(c.claudeRequests, 1);
  assert.equal(costOf({ type: 'claude', model: 'some-future-model', usage: { input_tokens: 5 } }).claudeDollars, 0, 'unknown models are counted, not priced');
});

test('Flash speech works out to 0.2 credits a character on Starter (matches the ElevenLabs dashboard)', () => {
  const lines = describeBucket(costOf({ type: 'tts', chars: 3780, model: 'eleven_flash_v2_5' }));
  assert.match(lines[0], /3,780 characters spoken \(about 756 ElevenLabs credits/);
});

test('days follow the configured time zone', () => {
  const ms = Date.parse('2026-10-22T06:30:00Z');
  assert.equal(dayKey(ms, 'America/Los_Angeles'), '2026-10-21');
  assert.equal(dayKey(ms, 'UTC'), '2026-10-22');
  assert.equal(dayKey(ms, 'Not/AZone'), '2026-10-22', 'bad zone falls back to UTC');
});

test('records into today, this month and a per-call snapshot', () => {
  let now = Date.parse('2026-10-22T20:00:00Z');
  const u = new Usage({ timezone: 'UTC', clock: () => now });
  u.record({ type: 'tts', chars: 500, model: 'eleven_flash_v2_5' });
  const snap = u.snapshot();
  u.record({ type: 'tts', chars: 100, model: 'eleven_flash_v2_5' });
  u.record({ type: 'stt', provider: 'deepgram', seconds: 30, keyterms: true });
  assert.equal(u.since(snap).ttsChars, 100);
  assert.equal(u.since(snap).sttRequests, 1);
  assert.equal(u.today().ttsChars, 600);
  now = Date.parse('2026-10-23T20:00:00Z');
  u.record({ type: 'tts', chars: 50, model: 'eleven_flash_v2_5' });
  assert.equal(u.today().ttsChars, 50);
  assert.equal(u.thisMonth().ttsChars, 650);
  assert.match(oneLine(u.thisMonth()), /650 characters spoken/);
  assert.ok(totalDollars(u.thisMonth()) > 0);
});

test('a bad event never throws', () => {
  const u = new Usage();
  u.record(null);
  u.record({ type: 'claude' });
  assert.equal(u.snapshot().claudeRequests, 1);
});

test('totals survive a restart, and old days are pruned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-usage-'));
  try {
    let now = Date.parse('2026-08-01T12:00:00Z');
    const u = new Usage({ dataDir: dir, timezone: 'UTC', clock: () => now });
    for (let i = 0; i < 70; i++) {
      u.record({ type: 'tts', chars: 10, model: 'eleven_flash_v2_5' });
      now += 86400000;
    }
    u.flush();
    const again = new Usage({ dataDir: dir, timezone: 'UTC', clock: () => now - 86400000 });
    assert.equal(Object.keys(again.data.days).length, 62);
    assert.equal(again.today().ttsChars, 10);
    assert.equal(Object.values(again.data.months).reduce((s, b) => s + b.ttsChars, 0), 700);
    clearTimeout(u.saveTimer);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt usage file starts fresh instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-usage-'));
  try {
    fs.writeFileSync(path.join(dir, 'usage.json'), '{not json');
    const u = new Usage({ dataDir: dir, timezone: 'UTC' });
    assert.deepEqual(u.data.days, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('money formatting', () => {
  assert.equal(money(0), '$0.00');
  assert.equal(money(0.004), '<$0.01');
  assert.equal(money(1.234), '$1.23');
});

test('WAV length is read from the header', () => {
  assert.equal(wavSeconds(pcmToWav(Buffer.alloc(32000), 16000, 1)), 1);
  assert.equal(wavSeconds(Buffer.from('not a wav')), 0);
});

const config = {
  anthropic: { apiKey: 'sk-test', workspaceId: '', model: 'claude-sonnet-5-5', effort: 'low', thinking: 'between_tools', maxCallsPerMinute: 100 },
  stt: { provider: 'deepgram', deepgramKey: 'dg-test', deepgramModel: 'nova-3', language: 'en', useKeyterms: true, extraTerms: [], elevenModel: 'scribe_v2' },
  tts: { elevenKey: 'el-test', voiceId: 'v1', model: 'eleven_flash_v2_5', outputFormat: 'pcm_24000', stability: 0.4, similarity: 0.75, style: 0, speed: 1 },
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('the API clients report what each request used', async () => {
  const events = [];
  const onUsage = (e) => events.push(e);
  const claude = createClaude(config, {
    onUsage,
    fetchImpl: async () => json(200, { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } }),
  });
  await claude.createMessage({ system: [], user: 'x' });
  const stt = createStt(config, {
    onUsage,
    fetchImpl: async () => json(200, { results: { channels: [{ alternatives: [{ transcript: 'yo gremlin' }] }] } }),
  });
  await stt.transcribe(pcmToWav(Buffer.alloc(64000), 16000, 1), { durationMs: 2000, keyterms: ['Gremlin'] });
  const tts = createTts(config, { onUsage, fetchImpl: async () => new Response(Buffer.alloc(100), { status: 200 }) });
  await tts.stream('twelve chars');
  const failing = createTts(config, { onUsage, fetchImpl: async () => json(401, { detail: { status: 'quota_exceeded' } }) });
  await assert.rejects(() => failing.stream('not billed'));
  assert.deepEqual(events, [
    { type: 'claude', model: 'claude-sonnet-5-5', usage: { input_tokens: 7, output_tokens: 3 } },
    { type: 'stt', provider: 'deepgram', seconds: 2, keyterms: true },
    { type: 'tts', chars: 12, model: 'eleven_flash_v2_5' },
  ]);
});

test('real balances: ElevenLabs credits and Deepgram credit, or nothing if unavailable', async () => {
  const eleven = await elevenLabsQuota(config, {
    fetchImpl: async () => json(200, { tier: 'starter', character_count: 1440, character_limit: 40000, next_character_count_reset_unix: 1795219200 }),
  });
  assert.deepEqual(eleven, { used: 1440, limit: 40000, tier: 'starter', resetsAt: 1795219200000 });
  assert.equal(await elevenLabsQuota(config, { fetchImpl: async () => json(401, {}) }), null);
  assert.equal(await elevenLabsQuota(config, { fetchImpl: async () => { throw new Error('offline'); } }), null);

  const calls = [];
  const dg = await deepgramBalance(config, {
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/projects')) return json(200, { projects: [{ project_id: 'p1', name: 'mine' }] });
      return json(200, { balances: [{ balance_id: 'b', amount: 196.4, units: 'usd' }] });
    },
  });
  assert.deepEqual(dg, { dollars: 196.4 });
  assert.equal(calls[1], 'https://api.deepgram.com/v1/projects/p1/balances');
  assert.equal(await deepgramBalance(config, { fetchImpl: async () => json(403, {}) }), null);
  assert.equal(await deepgramBalance({ ...config, stt: { ...config.stt, provider: 'elevenlabs' } }), null);
});
