import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, createClaude } from '../src/claude.js';
import { fetchWithReconnect, isDroppedConnection } from '../src/net.js';
import { cleanKeyterms, createStt, isPhantom, whisperTimeoutMs } from '../src/stt.js';
import { createTts, describeElevenError } from '../src/tts.js';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function recorder(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return typeof r === 'function' ? r(url, init) : r;
  };
  return { calls, fetchImpl };
}

const config = {
  anthropic: { apiKey: 'sk-test', workspaceId: '', model: 'claude-sonnet-5-5', effort: 'low', thinking: 'auto', maxCallsPerMinute: 100 },
  stt: { provider: 'deepgram', deepgramKey: 'dg-test', deepgramModel: 'nova-3', language: 'en', useKeyterms: true, extraTerms: [], elevenModel: 'scribe_v2' },
  tts: { elevenKey: 'el-test', voiceId: 'voice123', model: 'eleven_flash_v2_5', outputFormat: 'pcm_24000', stability: 0.4, similarity: 0.75, style: 0, speed: 1 },
};

test('Claude: Sonnet gets between_tools even if the models API claims disabled', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse(200, { capabilities: { thinking: { types: { disabled: { supported: true }, between_tools: { supported: true } } } } }),
    jsonResponse(200, { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: {} }),
  ]);
  const claude = createClaude(config, { fetchImpl });
  const res = await claude.createMessage({ system: [{ type: 'text', text: 'sys' }], user: 'hello' });
  assert.equal(res.text, 'hi');
  assert.equal(claude.thinkingMode, 'between_tools');
  const msg = calls[1];
  assert.equal(msg.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(msg.init.headers.authorization, 'Bearer sk-test');
  assert.equal(msg.init.headers['anthropic-version'], API_VERSION);
  const body = JSON.parse(msg.init.body);
  assert.deepEqual(body.thinking, { type: 'between_tools' });
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.temperature, undefined, 'sampling params were removed in 2026-10-21');
  assert.equal(body.messages[0].role, 'user');
});

test('Claude: Haiku uses thinking disabled', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse(404, { error: { type: 'not_found_error', message: 'nope' } }),
    jsonResponse(200, { content: [{ type: 'text', text: 'yo' }], stop_reason: 'end_turn' }),
  ]);
  const claude = createClaude({ ...config, anthropic: { ...config.anthropic, model: 'claude-haiku-5-5' } }, { fetchImpl });
  await claude.createMessage({ system: [], user: 'x' });
  assert.deepEqual(JSON.parse(calls[1].init.body).thinking, { type: 'disabled' });
});

test('Claude: retries overloaded errors, then succeeds', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse(200, {}),
    jsonResponse(529, { error: { type: 'overloaded_error', message: 'Overloaded' } }),
    jsonResponse(200, { content: [{ type: 'text', text: 'made it' }], stop_reason: 'end_turn' }),
  ]);
  const claude = createClaude(config, { fetchImpl, sleep: async () => {} });
  const res = await claude.createMessage({ system: [], user: 'x', retries: 2 });
  assert.equal(res.text, 'made it');
  assert.equal(calls.length, 3);
});

test('Claude: if a thinking setting is rejected it steps to the next option', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse(200, {}),
    jsonResponse(400, { error: { type: 'invalid_request_error', message: 'thinking.type "between_tools" is not supported for this model' } }),
    jsonResponse(200, { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
  ]);
  const claude = createClaude(config, { fetchImpl });
  const res = await claude.createMessage({ system: [], user: 'x', retries: 0 });
  assert.equal(res.text, 'ok');
  assert.equal(JSON.parse(calls[2].init.body).thinking, undefined);
  assert.equal(claude.thinkingMode, 'omit');
});

test('Claude: refusals are flagged, hard errors throw', async () => {
  const { fetchImpl } = recorder([
    jsonResponse(200, {}),
    jsonResponse(200, { content: [], stop_reason: 'refusal' }),
    jsonResponse(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
  ]);
  const claude = createClaude(config, { fetchImpl });
  const r = await claude.createMessage({ system: [], user: 'x' });
  assert.equal(r.refusal, true);
  await assert.rejects(() => claude.createMessage({ system: [], user: 'x' }), /401 authentication_error/);
});

test('Deepgram: sends WAV with model, keyterms and token auth', async () => {
  const { calls, fetchImpl } = recorder([
    jsonResponse(200, { results: { channels: [{ alternatives: [{ transcript: 'gremlin you there', confidence: 0.9 }] }] } }),
  ]);
  const stt = createStt(config, { fetchImpl });
  const text = await stt.transcribe(Buffer.from('RIFF....'), { durationMs: 1500, keyterms: ['Gremlin', 'xX_Sn1per_Xx', 'Jess', 'Gremlin'] });
  assert.equal(text, 'gremlin you there');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.deepgram.com/v1/listen');
  assert.equal(url.searchParams.get('model'), 'nova-3');
  assert.equal(url.searchParams.get('smart_format'), 'true');
  assert.deepEqual(url.searchParams.getAll('keyterm'), ['Gremlin', 'xX Sn1per Xx', 'Jess']);
  assert.equal(calls[0].init.headers.Authorization, 'Token dg-test');
  assert.equal(calls[0].init.headers['Content-Type'], 'audio/wav');
});

test('STT: filler hallucinations on tiny clips are dropped', () => {
  assert.equal(isPhantom('Thank you.', 600), true);
  assert.equal(isPhantom('Thank you.', 3000), false);
  assert.equal(isPhantom('gremlin', 600), false);
  assert.deepEqual(cleanKeyterms(['ab', '1234', 'Project Zomboid']), ['Project Zomboid']);
});

test('ElevenLabs STT: multipart upload with scribe model', async () => {
  const { calls, fetchImpl } = recorder([jsonResponse(200, { text: 'hello there' })]);
  const stt = createStt({ ...config, stt: { ...config.stt, provider: 'elevenlabs' } }, { fetchImpl });
  assert.equal(await stt.transcribe(Buffer.from('RIFF'), { durationMs: 2000 }), 'hello there');
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(calls[0].init.headers['xi-api-key'], 'el-test');
  assert.equal(calls[0].init.body.get('model_id'), 'scribe_v2');
});

test('ElevenLabs TTS: streams raw PCM with the configured voice and format', async () => {
  const pcm = Buffer.alloc(9600, 1);
  const { calls, fetchImpl } = recorder([new Response(pcm, { status: 200 })]);
  const tts = createTts(config, { fetchImpl });
  const { stream, sampleRate } = await tts.stream('hi');
  assert.equal(sampleRate, 24000);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).length, 9600);
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/text-to-speech/voice123/stream?output_format=pcm_24000');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model_id, 'eleven_flash_v2_5');
  assert.deepEqual(body.voice_settings, { stability: 0.4, similarity_boost: 0.75 });
});

test('ElevenLabs TTS: errors are explained in plain words', async () => {
  const { fetchImpl } = recorder([
    jsonResponse(401, { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota.' } }),
  ]);
  const tts = createTts(config, { fetchImpl });
  await assert.rejects(() => tts.stream('hi'), /out of ElevenLabs credits/);
  assert.match(describeElevenError(404, '{"detail":{"status":"voice_not_found","message":"x"}}').text, /voice ID .* isn't on this ElevenLabs account/);
});

test('ElevenLabs TTS: short fixed lines are kept and replayed without another request', async () => {
  const pcm = Buffer.alloc(4800, 2);
  const { calls, fetchImpl } = recorder([new Response(pcm, { status: 200 }), new Response(pcm, { status: 200 }), new Response(pcm, { status: 200 })]);
  const usage = [];
  const cfg = { ...config, tts: { ...config.tts } };
  const tts = createTts(cfg, { fetchImpl, onUsage: (u) => usage.push(u) });
  const drain = async (s) => {
    const chunks = [];
    for await (const c of s) chunks.push(c);
    return Buffer.concat(chunks);
  };
  assert.equal((await drain((await tts.stream('Yeah?', { cache: true })).stream)).length, 4800);
  const again = await tts.stream('Yeah?', { cache: true });
  assert.equal(again.cached, true);
  assert.deepEqual(await drain(again.stream), pcm);
  assert.equal(calls.length, 1, 'played from memory the second time');
  assert.equal(usage.length, 1, 'and not billed again');
  // A different voice setting means a new recording.
  cfg.tts.stability = 0.6;
  await drain((await tts.stream('Yeah?', { cache: true })).stream);
  assert.equal(calls.length, 2);
  // Lines not marked for the cache are never kept.
  await drain((await tts.stream('A real answer.')).stream);
  assert.equal(calls.length, 3);
});

test('ElevenLabs TTS: prewarm records the fixed lines ahead of time, and gives up quietly on errors', async () => {
  const pcm = Buffer.alloc(2400, 3);
  const { calls, fetchImpl } = recorder([
    new Response(pcm, { status: 200 }),
    jsonResponse(401, { detail: { status: 'quota_exceeded', message: 'over' } }),
  ]);
  const tts = createTts(config, { fetchImpl });
  await tts.prewarm(['Yeah?', 'One sec.', "What's up?"]);
  assert.equal(calls.length, 2, 'stops at the first failure');
  const kept = await tts.stream('Yeah?', { cache: true });
  assert.equal(kept.cached, true);
  await tts.prewarm(['Yeah?']);
  assert.equal(calls.length, 2, 'already kept: nothing to do');
});

test('STT: one-word answers are kept, and the local Whisper timeout grows with the clip', () => {
  assert.equal(isPhantom('Yeah.', 600), false);
  assert.equal(isPhantom('Okay.', 600), false);
  assert.equal(isPhantom('You.', 600), true);
  assert.equal(whisperTimeoutMs(1000), 3150);
  assert.equal(whisperTimeoutMs(20000), 6000);
  assert.equal(whisperTimeoutMs(60000), 8000, 'never more than before');
});

const dropped = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

test('a request whose connection dropped is sent once more; timeouts and cancels are not', async () => {
  let n = 0;
  const flaky = async () => {
    n++;
    if (n === 1) throw dropped();
    return new Response('ok');
  };
  assert.equal(await (await fetchWithReconnect(flaky, 'https://api.example.com/x')).text(), 'ok');
  assert.equal(n, 2);
  n = 0;
  const alwaysDrops = async () => {
    n++;
    throw dropped();
  };
  await assert.rejects(() => fetchWithReconnect(alwaysDrops, 'https://api.example.com/x'), /fetch failed/);
  assert.equal(n, 2, 'only once more');
  assert.equal(isDroppedConnection(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), false);
  const ac = new AbortController();
  ac.abort();
  n = 0;
  await assert.rejects(() => fetchWithReconnect(alwaysDrops, 'https://api.example.com/x', { signal: ac.signal }));
  assert.equal(n, 1, 'cancelled: not sent again');
});

test('Claude: a dropped connection is retried instead of losing the reply', async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('/models/')) return jsonResponse(200, { capabilities: {} });
    n++;
    if (n === 1) throw dropped();
    return jsonResponse(200, { content: [{ type: 'text', text: 'still here' }], stop_reason: 'end_turn', usage: {} });
  };
  const claude = createClaude(config, { fetchImpl });
  const res = await claude.createMessage({ system: [{ type: 'text', text: 'sys' }], user: 'hello', retries: 0 });
  assert.equal(res.text, 'still here');
  assert.equal(n, 2);
});
