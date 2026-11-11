// How hard each model works on a reply, and the rules that keep answers accurate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '../src/claude.js';
import { loadConfig } from '../src/config.js';
import { buildSystem } from '../src/prompts.js';

const ok = () =>
  new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const anthropic = {
  apiKey: 'sk-test',
  workspaceId: '',
  model: 'claude-sonnet-5-5',
  effort: 'high',
  fastEffort: 'medium',
  thinking: 'between_tools',
  maxCallsPerMinute: 1000,
  webSearch: { enabled: true, maxUses: 2, dailyLimit: 100 },
};

test('each model sends its own effort level', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => (bodies.push(JSON.parse(init.body)), ok());
  const main = createClaude({ anthropic }, { fetchImpl });
  const fast = createClaude({ anthropic: { ...anthropic, thinking: 'disabled' } }, { fetchImpl, model: 'claude-haiku-5-5', effort: 'medium' });
  await main.createMessage({ system: [], user: 'x' });
  await fast.createMessage({ system: [], user: 'x' });
  assert.deepEqual(
    bodies.map((b) => [b.model, b.output_config.effort]),
    [
      ['claude-sonnet-5-5', 'high'],
      ['claude-haiku-5-5', 'medium'],
    ],
  );
  assert.equal(main.effort, 'high');
  assert.equal(fast.effort, 'medium');
});

test('a searched answer has room to think after the results', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => (bodies.push(JSON.parse(init.body)), ok());
  await createClaude({ anthropic }, { fetchImpl }).createMessage({ system: [], user: 'x', maxTokens: 150, search: true });
  assert.ok(bodies[0].max_tokens >= 2048);
  assert.equal(bodies[0].tools[0].max_uses, 2);
});

test('defaults favor accurate answers: careful main model, quick checks a step lower, two searches allowed', (t) => {
  const keys = ['CLAUDE_EFFORT', 'GREMLIN_CLAUDE_EFFORT', 'CLAUDE_FAST_EFFORT', 'WEB_SEARCH_MAX_USES'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    const c = loadConfig();
    if (c.envFile) {
      t.skip('a real .env is present, so its settings win over the defaults');
      return;
    }
    assert.equal(c.anthropic.effort, 'high');
    assert.equal(c.anthropic.fastEffort, 'medium');
    assert.equal(c.anthropic.webSearch.maxUses, 2);
    process.env.GREMLIN_CLAUDE_EFFORT = 'low'; // the old setting name still works
    assert.equal(loadConfig().anthropic.effort, 'low');
    process.env.CLAUDE_EFFORT = 'max'; // not allowed with this thinking mode: falls back
    assert.equal(loadConfig().anthropic.effort, 'high');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('every reply is told to get real answers right and not to make things up', () => {
  const text = buildSystem({ botName: 'Winslow', persona: 'p', lore: '' })[0].text;
  assert.match(text, /<getting_it_right>/);
  assert.match(text, /never invent numbers, names, patch details, or quotes/);
  assert.match(text, /say so in character instead of guessing/);
});
