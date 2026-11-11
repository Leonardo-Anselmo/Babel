// Jokes come whole (setup and punchline in one reply), and Venice's bigger reasoning
// models with their thinking off and their long
// instructions cached (2026-10-29).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { setLogFile } from '../src/log.js';
import { TASKS, buildSystem } from '../src/prompts.js';
import { VENICE_THINKERS, createVenice, examplesFor, readVeniceStream, veniceDollars } from '../src/venice.js';

const LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'venice-bigger-')), 'bot.log');
setLogFile(LOG);
const logText = () => fs.readFileSync(LOG, 'utf8');

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** A fetch that answers Venice's chat completions; `replies` are per request: pieces, or { status, error }. */
function veniceFetch(replies, { usage = { prompt_tokens: 3000, completion_tokens: 40 }, reasoning = [] } = {}) {
  const sent = [];
  const queue = [...replies];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    const next = queue.shift() ?? ['<say>ok</say>'];
    if (!Array.isArray(next)) return new Response(JSON.stringify({ error: next.error }), { status: next.status });
    const enc = new TextEncoder();
    const events = [
      ...reasoning.map((r) => ({ choices: [{ delta: { reasoning_content: r } }] })),
      ...next.map((p, i) => ({ choices: [{ delta: { content: p }, finish_reason: i === next.length - 1 ? 'stop' : null }] })),
      { choices: [], usage },
    ];
    const stream = new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetchImpl, sent };
}

test('a joke someone asks for comes whole: setup and punchline in the same reply', () => {
  const system = buildSystem({ botName: 'Babel', persona: 'Be fun.' })[0].text;
  assert.match(system, /A joke someone asks for comes whole, in the same reply: the setup and the punchline together/);
  assert.match(system, /Never just the setup, a question left for them to answer, or "I've got one about\.\.\." with no joke\./);
  assert.match(TASKS.direct({ name: 'Mike', names: ['Mike'], botName: 'Babel' }), /One short sentence unless they asked for a joke \(setup and punchline together, in this reply\), a story/);
  assert.match(TASKS.followup({ name: 'Mike' }), /If they ask for a joke \(or another one\), tell the whole joke now: setup and punchline together, never just the setup\./);
  // Venice's worked examples show it: a question-and-answer joke asked and answered in one line.
  const said = (kind) => examplesFor(kind, 'Babel').filter((m) => m.role === 'assistant').map((m) => m.content);
  assert.ok(said('direct').some((t) => /^<say>Why does Risk of Rain need a weather app\? .+\.<\/say>$/.test(t)));
  assert.ok(said('followup').some((t) => /^<say>Why did the healer quit\? .+\.<\/say>$/.test(t)));
});

test("Venice's reasoning models: thinking off, instructions cached, and nothing changes for the others", async () => {
  assert.ok(VENICE_THINKERS.has('olafangensan-glm-4.7-flash-heretic'));
  const { fetchImpl, sent } = veniceFetch([['<say>One.</say>'], ['<say>Two.</say>'], ['<say>Three.</say>']]);
  const v = createVenice({ botName: 'Babel', venice: { apiKey: 'k', model: 'olafangensan-glm-4.7-flash-heretic' } }, { fetchImpl });
  await v.createMessage({ system: 'You are Babel. Long rules.', user: 'u', kind: 'direct' });
  await v.createMessage({ system: 'You are Babel. Long rules.', user: 'another', kind: 'quip' });
  await v.createMessage({ system: 'You are Babel. Other rules.', user: 'u', kind: 'direct' });
  const [a, b, c] = sent.map((s) => s.body);
  assert.equal(a.reasoning_effort, 'none');
  assert.deepEqual(a.venice_parameters, { include_venice_system_prompt: true, disable_thinking: true });
  // The same instructions go to the same cache, whatever the kind of line; other instructions elsewhere.
  assert.match(a.prompt_cache_key, /^babel-[0-9a-f]{16}$/);
  assert.equal(b.prompt_cache_key, a.prompt_cache_key);
  assert.notEqual(c.prompt_cache_key, a.prompt_cache_key);

  const plain = veniceFetch([['<say>Hi.</say>']]);
  const old = createVenice({ botName: 'Babel', venice: { apiKey: 'k', model: 'standard-test-model' } }, { fetchImpl: plain.fetchImpl });
  await old.createMessage({ system: 's', user: 'u', kind: 'direct' });
  const body = plain.sent[0].body;
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.prompt_cache_key, undefined, 'no cache price, so no cache key');
  assert.deepEqual(body.venice_parameters, { include_venice_system_prompt: true });
});

test('a setting the model refuses is dropped, asked again without it, and never sent again', async () => {
  const { fetchImpl, sent } = veniceFetch([{ status: 400, error: 'reasoning_effort "none" is not supported for this model' }, ['<say>Fine.</say>'], ['<say>Again.</say>']]);
  const v = createVenice({ botName: 'Babel', venice: { apiKey: 'k', model: 'olafangensan-glm-4.7-flash-heretic' } }, { fetchImpl });
  assert.equal((await v.createMessage({ system: 's', user: 'u', kind: 'direct' })).text, '<say>Fine.</say>');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].body.reasoning_effort, 'none');
  assert.equal(sent[1].body.reasoning_effort, undefined);
  assert.equal(sent[1].body.venice_parameters.disable_thinking, true, 'only the refused one goes');
  await v.createMessage({ system: 's', user: 'u', kind: 'direct' });
  assert.equal(sent.length, 3);
  assert.equal(sent[2].body.reasoning_effort, undefined);
  assert.match(logText(), /Venice's olafangensan-glm-4.7-flash-heretic doesn't take reasoning_effort, so it's left off/);
  // Any other 400 is still an error.
  const bad = veniceFetch([{ status: 400, error: 'messages: too long' }]);
  const v2 = createVenice({ venice: { apiKey: 'k', model: 'olafangensan-glm-4.7-flash-heretic' } }, { fetchImpl: bad.fetchImpl });
  await assert.rejects(v2.createMessage({ system: 's', user: 'u', kind: 'direct' }), (err) => err.status === 400);
  assert.equal(bad.sent.length, 1);
});

test('cached input is priced as cached; its thinking is never read out; the log says how fast and how much was cached', async () => {
  // 7,000 in, 6,000 of them from the cache, 50 out.
  const usage = { prompt_tokens: 7000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 6000 } };
  const want = (1000 * 0.07 + 6000 * 0.035 + 50 * 0.4) / 1e6;
  assert.ok(Math.abs(veniceDollars('olafangensan-glm-4.7-flash-heretic', usage) - want) < 1e-12);
  // A model without a cache price pays full price for all of it.
  assert.ok(Math.abs(veniceDollars('qwen-3-8-27b', usage) - (7000 * 0.45 + 50 * 3.2) / 1e6) < 1e-12);

  const { fetchImpl } = veniceFetch([['<say>Why did the ', 'chicken cross? To get away from Mike.</say>']], { usage, reasoning: ['Let me think about a joke.'] });
  const seen = [];
  const v = createVenice({ botName: 'Babel', venice: { apiKey: 'k', model: 'olafangensan-glm-4.7-flash-heretic' } }, { fetchImpl, onUsage: (e) => seen.push(e) });
  const pieces = [];
  const r = await v.createMessage({ system: 's', user: 'u', kind: 'direct', onText: (p) => pieces.push(p) });
  assert.equal(r.text, '<say>Why did the chicken cross? To get away from Mike.</say>');
  assert.equal(pieces.join(''), r.text, 'its thinking is never passed on');
  assert.ok(Math.abs(seen[0].dollars - want) < 1e-12);
  assert.match(logText(), /olafangensan-glm-4.7-flash-heretic \d+ ms, first words \d+ ms, in 7000 \(cached 6000\), out 50, stop stop/);

  const res = new Response(new ReadableStream({ start: (c) => c.close() }));
  assert.equal((await readVeniceStream(res)).firstAt, 0, 'no words, no time for them');
});

test('the timing line in the log names the one that wrote the answer', async () => {
  let now = 7_000_000;
  const replyWith = (text, name) => ({
    name,
    calls: [],
    provider: name,
    async createMessage(args) {
      this.calls.push(args);
      args.onText?.(text);
      return { text, refusal: false, stopReason: 'end_turn', searches: 0, citations: [] };
    },
  });
  const speaker = {
    said: [],
    speaking: false,
    wasAudibleBetween: () => false,
    say(text, opts = {}) {
      this.said.push(text);
      opts.onTurn?.();
      opts.onStart?.();
      return Promise.resolve('played');
    },
    stop() {},
    stopKind() {},
    dropOptional() {},
  };
  const venice = replyWith('<say>Venice says hi.</say>', 'venice');
  const brain = new Brain({
    config: {
      botName: 'Gremlin',
      botAliases: ['gremlin'],
      timezone: 'UTC',
      defaultChattiness: 'off',
      persona: 'You are Gremlin.',
      lore: '',
      tts: { audioTags: false },
      transcript: { maxLines: 40, maxMinutes: 15 },
      venice: { kinds: ['direct'] },
    },
    claude: replyWith('<say>Claude says hi.</say>', 'claude'),
    venice,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike'], activities: [] }),
    getFacts: () => [],
    isAnyoneSpeaking: () => false,
    chattiness: 'off',
    clock: () => now,
  });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin say hi', startedAt: now - 2000, spokeUntil: now - 500, at: now - 200 });
  await settle();
  assert.equal(venice.calls.length, 1);
  assert.match(logText(), /first sound [\d.]+ s after Mike stopped talking \(direct: [^)]*Venice [\d.]+, voice [\d.]+\)/);
});
