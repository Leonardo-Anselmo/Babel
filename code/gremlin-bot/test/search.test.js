// Web search: when answers can look things up, and how failures are handled.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Brain, SEARCH_CAME_UP_EMPTY } from '../src/brain.js';
import { createClaude, resetSearchCount } from '../src/claude.js';
import { textReply } from '../src/commands.js';
import { TASKS, buildSystem, sourceLinks } from '../src/prompts.js';
import { costOf, describeBucket } from '../src/usage.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = (text, extra = {}) =>
  json(200, { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, ...extra });

function config({ enabled = true, maxUses = 1, dailyLimit = 150 } = {}) {
  return {
    anthropic: {
      apiKey: 'sk-test',
      workspaceId: '',
      model: 'claude-sonnet-5-5',
      effort: 'low',
      thinking: 'between_tools', // skip the models lookup unless a test wants it
      maxCallsPerMinute: 1000,
      webSearch: { enabled, maxUses, dailyLimit },
    },
  };
}

function recorder(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return typeof r === 'function' ? r() : r;
  };
  return { calls, fetchImpl };
}

beforeEach(() => resetSearchCount());

test('answers that may search get the web search tool, with room to use it', async () => {
  const { calls, fetchImpl } = recorder([answer('Patch 9.2 nerfed it.'), answer('Plain.')]);
  const claude = createClaude(config({ maxUses: 2 }), { fetchImpl });
  await claude.createMessage({ system: [], user: 'x', maxTokens: 150, search: true });
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search_20260318', name: 'web_search', max_uses: 2, allowed_callers: ['direct'] }]);
  assert.ok(calls[0].body.max_tokens >= 800);
  await claude.createMessage({ system: [], user: 'x', maxTokens: 150 });
  assert.equal(calls[1].body.tools, undefined, 'no search unless asked for');
  assert.equal(calls[1].body.max_tokens, 150);
});

test('an unsupported tool version steps down to an older one, and remembers it', async () => {
  const reject = () => json(400, { error: { type: 'invalid_request_error', message: 'tools.0: unknown tool type web_search_2026xxxx' } });
  const { calls, fetchImpl } = recorder([reject, reject, answer('Found it.'), answer('Again.')]);
  const claude = createClaude(config(), { fetchImpl });
  const res = await claude.createMessage({ system: [], user: 'x', search: true });
  assert.equal(res.text, 'Found it.');
  assert.deepEqual(calls.map((c) => c.body.tools[0].type), ['web_search_20260318', 'web_search_20260209', 'web_search_20250305']);
  await claude.createMessage({ system: [], user: 'x', search: true });
  assert.equal(calls[3].body.tools[0].type, 'web_search_20250305');
  assert.equal(calls[2].body.tools[0].allowed_callers, undefined);
});

test('if search is turned off for the organization it answers without it from then on', async () => {
  const { calls, fetchImpl } = recorder([
    json(400, { error: { type: 'invalid_request_error', message: 'Web search is not enabled for this organization.' } }),
    answer('From memory.'),
    answer('Still from memory.'),
  ]);
  const claude = createClaude(config(), { fetchImpl });
  assert.equal((await claude.createMessage({ system: [], user: 'x', search: true })).text, 'From memory.');
  assert.equal(calls[1].body.tools, undefined);
  await claude.createMessage({ system: [], user: 'x', search: true });
  assert.equal(calls[2].body.tools, undefined);
  assert.match(claude.searchStatus, /^off: turned off for your Anthropic organization/);
});

test('a model the Models API says can not search never gets the tool', async () => {
  const { calls, fetchImpl } = recorder([
    json(200, { capabilities: { thinking: { types: { between_tools: { supported: true } } }, server_tools: { web_search: { supported: false } } } }),
    answer('No search here.'),
  ]);
  const claude = createClaude({ ...config(), anthropic: { ...config().anthropic, thinking: 'auto' } }, { fetchImpl });
  await claude.createMessage({ system: [], user: 'x', search: true });
  assert.equal(calls[1].body.tools, undefined);
  assert.match(claude.searchStatus, /doesn't support web search/);
});

test('turned off in .env, or a daily limit of 0, means no searches', async () => {
  for (const cfg of [config({ enabled: false }), config({ dailyLimit: 0 })]) {
    const { calls, fetchImpl } = recorder([answer('ok')]);
    await createClaude(cfg, { fetchImpl }).createMessage({ system: [], user: 'x', search: true });
    assert.equal(calls[0].body.tools, undefined);
  }
});

test('the daily search limit stops searching once reached', async () => {
  const searched = () => answer('Looked it up.', { usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } } });
  const { calls, fetchImpl } = recorder([searched, searched, answer('No more searching today.')]);
  const claude = createClaude(config({ dailyLimit: 2 }), { fetchImpl });
  for (let i = 0; i < 3; i++) await claude.createMessage({ system: [], user: 'x', search: true });
  assert.ok(calls[0].body.tools && calls[1].body.tools);
  assert.equal(calls[2].body.tools, undefined);
});

test('a paused search turn is sent back once to finish, and the text is joined', async () => {
  const paused = json(200, {
    content: [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'patch notes' } },
      { type: 'text', text: 'The latest patch ' },
    ],
    stop_reason: 'pause_turn',
    usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
  });
  const finished = answer('buffed shotguns again.', {
    content: [{ type: 'text', text: 'buffed shotguns again.', citations: [{ type: 'web_search_result_location', url: 'https://example.com/notes', title: 'Notes' }] }],
  });
  const events = [];
  const { calls, fetchImpl } = recorder([paused, finished]);
  const claude = createClaude(config(), { fetchImpl, onUsage: (e) => events.push(e) });
  const res = await claude.createMessage({ system: [], user: 'what changed', search: true });
  assert.equal(res.text, 'The latest patch buffed shotguns again.');
  assert.equal(res.searches, 1);
  assert.deepEqual(res.citations, [{ url: 'https://example.com/notes', title: 'Notes' }]);
  assert.equal(calls[1].body.messages.length, 2);
  assert.equal(calls[1].body.messages[1].role, 'assistant');
  assert.equal(events.length, 2, 'both requests are counted');
});

test('"let me look that up" written before the search is not part of the answer', async () => {
  const { fetchImpl } = recorder([
    json(200, {
      content: [
        { type: 'text', text: 'Let me look that up.', citations: null },
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'shotgun nerf patch' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com/a', title: 'A' }] },
        { type: 'text', text: 'Yeah, ' },
        { type: 'text', text: 'they cut its range last patch.', citations: [{ type: 'web_search_result_location', url: 'https://example.com/a', title: 'A' }] },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 900, output_tokens: 40, server_tool_use: { web_search_requests: 1 } },
    }),
  ]);
  const res = await createClaude(config(), { fetchImpl }).createMessage({ system: [], user: 'x', search: true });
  assert.equal(res.text, 'Yeah, they cut its range last patch.');
  assert.deepEqual(res.citations, [{ url: 'https://example.com/a', title: 'A' }]);
  assert.equal(res.searches, 1);
});

test('a search that comes back with nothing to say still gets a reply, not silence', async () => {
  const { brain, calls } = brainWith({ reply: async () => ({ text: '', refusal: false, searches: 1 }) });
  const said = [];
  brain.speaker.say = (t, o) => (said.push([o.kind, t]), Promise.resolve('played'));
  brain.hear({ name: 'Mike', text: 'gremlin when is the next season' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 1);
  assert.deepEqual(said, [['direct', SEARCH_CAME_UP_EMPTY]]);
});

test('searches are counted and priced in usage', () => {
  const b = costOf({ type: 'claude', model: 'claude-haiku-5-5', usage: { server_tool_use: { web_search_requests: 3 } } });
  assert.equal(b.claudeSearches, 3);
  assert.ok(Math.abs(b.claudeDollars - 0.03) < 1e-9);
  assert.match(describeBucket(b)[2], /3 web searches/);
});

test('the system prompt explains when to search, only when search is on', () => {
  const base = { botName: 'Gremlin', persona: 'p', lore: '' };
  assert.match(buildSystem({ ...base, webSearch: true })[0].text, /<web_search>/);
  assert.doesNotMatch(buildSystem(base)[0].text, /<web_search>/);
});

function brainWith({ reply, fillerAfterMs = 20, onSources }) {
  const said = [];
  const calls = [];
  const brain = new Brain({
    config: {
      botName: 'Gremlin',
      botAliases: ['gremlin'],
      timezone: 'UTC',
      defaultChattiness: 'off',
      persona: 'p',
      lore: '',
      tts: { audioTags: false },
      transcript: { maxLines: 40, maxMinutes: 15 },
      anthropic: { webSearch: { enabled: true } },
    },
    claude: { createMessage: async (args) => (calls.push(args), reply(args)) },
    speaker: { speaking: false, wasAudibleBetween: () => false, say: (t, o) => (said.push(o.kind), Promise.resolve('played')), stop() {}, dropOptional() {} },
    getCallInfo: () => ({}),
    fillerAfterMs,
    onSources,
  });
  return { brain, said, calls };
}

test('a slow answer gets a quick "one sec" first; a fast one does not', async () => {
  const slow = brainWith({ reply: () => new Promise((r) => setTimeout(() => r({ text: 'It got nerfed.', refusal: false }), 80)) });
  slow.brain.hear({ name: 'Mike', text: 'gremlin did they nerf the shotgun' });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(slow.said, ['filler', 'direct']);
  assert.equal(slow.calls[0].search, true, 'answers to people may search');

  const fast = brainWith({ reply: async () => ({ text: 'Obviously.', refusal: false }) });
  fast.brain.hear({ name: 'Mike', text: 'gremlin you good' });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(fast.said, ['direct']);
});

test('jokes and quick checks never search', async () => {
  const { brain, calls } = brainWith({ reply: async () => ({ text: '[PASS]', refusal: false }) });
  brain.chattiness = 'high';
  brain.request('quip', {});
  await new Promise((r) => setImmediate(r));
  assert.equal(calls[0].search, false);
});

test('a follow-up question that needs a lookup (no name said) gets a proper, searched answer', async () => {
  const replies = [
    { text: 'November fourth.', refusal: false, searches: 1 },
    { text: '[LOOKUP]', refusal: false },
    { text: 'Same day, and it costs ten bucks.', refusal: false, searches: 1 },
  ];
  const { brain, calls } = brainWith({ reply: async () => replies.shift() });
  const said = [];
  brain.speaker.say = (t, o) => (said.push(t), Promise.resolve('played'));
  brain.chattiness = 'high';
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin when does season nine start' });
  await new Promise((r) => setTimeout(r, 10));
  brain.hear({ userId: 'u2', name: 'Jess', text: 'what about the battle pass' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 3);
  assert.equal(calls[1].search, false, 'the quick follow-up check never searches itself');
  assert.match(calls[1].user, /\[LOOKUP\]/);
  assert.doesNotMatch(calls[1].system[0].text, /<web_search>/, 'only calls that can search are told about it');
  assert.equal(calls[2].search, true);
  assert.match(calls[2].system[0].text, /<web_search>/);
  assert.match(calls[2].user, /Jess is talking to you/);
  assert.deepEqual(said, ['November fourth.', 'Same day, and it costs ten bucks.']);
});

test('follow-ups are not told about lookups when search is off', () => {
  assert.doesNotMatch(TASKS.followup({ lookup: false }), /LOOKUP/);
  assert.match(TASKS.followup({ lookup: true }), /\[LOOKUP\]/);
});

test('a spoken answer that used web results shows its sources in the text channel', async () => {
  const posted = [];
  const cites = [{ url: 'https://a.example/notes', title: 'Notes' }];
  const { brain } = brainWith({
    reply: async () => ({ text: 'They nerfed it Tuesday.', refusal: false, searches: 1, citations: cites }),
    onSources: (c) => posted.push(c),
  });
  brain.hear({ name: 'Mike', text: 'gremlin did they nerf the shotgun' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(posted, [cites]);

  const none = [];
  const plain = brainWith({ reply: async () => ({ text: 'Obviously.', refusal: false }), onSources: (c) => none.push(c) });
  plain.brain.hear({ name: 'Mike', text: 'gremlin you good' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(none, [], 'nothing posted when it did not look anything up');
});

test('source links are wrapped so Discord does not embed them, and odd ones are skipped', () => {
  const links = sourceLinks([
    { url: 'https://a.example/x' },
    { url: 'javascript:alert(1)' },
    { url: 'https://b.example/<x>' },
    { url: 'https://c.example/y' },
    { url: 'https://d.example/z' },
  ]);
  assert.deepEqual(links, ['<https://a.example/x>', '<https://c.example/y>']);
});

test('text replies show where a looked-up answer came from', async () => {
  const claude = {
    createMessage: async (args) => {
      assert.equal(args.search, true);
      return { text: 'Season 9 starts Nov 4.', refusal: false, citations: [{ url: 'https://a.example/s9' }, { url: 'https://b.example/x' }, { url: 'https://c.example/y' }] };
    },
  };
  const text = await textReply(
    {
      config: { botName: 'Gremlin', persona: 'p', lore: '', timezone: 'UTC', anthropic: { webSearch: { enabled: true } } },
      claude,
      memory: { facts: () => [] },
      sessions: new Map(),
    },
    { guildId: 'g1', authorId: 'u1', author: 'Mike', content: 'when does season 9 start' },
  );
  assert.equal(text, 'Season 9 starts Nov 4.\n-# Sources: <https://a.example/s9> <https://b.example/x>');
});
