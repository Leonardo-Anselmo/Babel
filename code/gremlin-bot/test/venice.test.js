// Venice as the brain for some lines (VENICE_FOR), and the Claude fixes from the same
// test: the joke prompt that made it pass every time, and notes said out loud after a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { TASKS, cleanSpoken, isThinkingOutLoud, passesAfterLine, sayContent } from '../src/prompts.js';
import { createVenice, examplesFor, normalizeFormat, readVeniceStream, veniceDollars } from '../src/venice.js';

const baseConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  timezone: 'UTC',
  defaultChattiness: 'medium',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
  anthropic: { webSearch: { enabled: true, maxUses: 2, dailyLimit: 100 } },
};

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function fakeClient(replies, name = 'claude') {
  const calls = [];
  const queue = [...replies];
  return {
    name,
    calls,
    canSearchNow: true,
    async createMessage(args) {
      calls.push(args);
      const next = queue.shift();
      return { text: next ?? '[PASS]', refusal: false, stopReason: 'end_turn', searches: 0, citations: [] };
    },
  };
}

function autoSpeaker() {
  const said = [];
  return {
    said,
    speaking: false,
    wasAudibleBetween: () => false,
    say(text, opts = {}) {
      said.push({ text, kind: opts.kind });
      opts.onStart?.();
      return Promise.resolve('played');
    },
    stop() {},
    stopKind() {},
    dropOptional() {},
  };
}

/** A fetch that answers Venice's chat completions with these streamed pieces. */
function veniceFetch(pieces, { status = 200, usage = { prompt_tokens: 3000, completion_tokens: 40 }, finish = 'stop' } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (status !== 200) return new Response(JSON.stringify({ error: 'nope' }), { status });
    const enc = new TextEncoder();
    const events = [...pieces.map((p, i) => ({ choices: [{ delta: { content: p }, finish_reason: i === pieces.length - 1 ? finish : null }] })), { choices: [], usage }];
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

// ---------------------------------------------------------------------------
// Claude fixes
// ---------------------------------------------------------------------------

test('the joke check no longer asks it to pass four times out of five (it passed every time)', () => {
  const t = TASKS.quip({});
  assert.doesNotMatch(t, /four times out of five|nine times out of ten/);
  assert.match(t, /hand you a line you'd bet gets a laugh/);
  assert.match(t, /what they're saying right now, not something from earlier/);
  assert.match(t, /never a stock line like "that's the most X thing I've heard"/);
  assert.match(t, /\[PASS\], as you will most of the time/);
  assert.match(TASKS.quip({ choosy: true }), /falling flat/);
});

test('its own jokes are written by the joke model (the main one by default), the rest as before', async () => {
  const claude = fakeClient([], 'main');
  const fast = fakeClient([], 'fast');
  const jokes = fakeClient([], 'jokes');
  const brain = new Brain({ config: baseConfig, claude, claudeFast: fast, claudeJokes: jokes, speaker: autoSpeaker(), getCallInfo: () => ({}) });
  assert.equal(brain.clientFor('quip'), jokes);
  assert.equal(brain.clientFor('followup'), fast);
  assert.equal(brain.clientFor('direct'), claude);
  assert.equal(brain.clientFor('roast'), claude);
  // Without a joke model, the fast one (as before).
  assert.equal(new Brain({ config: baseConfig, claude, claudeFast: fast, speaker: autoSpeaker(), getCallInfo: () => ({}) }).clientFor('quip'), fast);
  // Venice, when it writes jokes, comes first.
  const venice = fakeClient([], 'venice');
  assert.equal(new Brain({ config: { ...baseConfig, venice: { kinds: ['quip'] } }, claude, claudeFast: fast, claudeJokes: jokes, venice, speaker: autoSpeaker(), getCallInfo: () => ({}) }).clientFor('quip'), venice);
  const { loadConfig } = await import('../src/config.js');
  const saved = { j: process.env.CLAUDE_JOKE_MODEL, m: process.env.CLAUDE_MODEL };
  try {
    delete process.env.CLAUDE_JOKE_MODEL;
    delete process.env.CLAUDE_MODEL;
    const c = loadConfig();
    if (!c.envFile) assert.equal(c.anthropic.jokeModel, 'claude-sonnet-5-5');
    process.env.CLAUDE_JOKE_MODEL = 'claude-haiku-5-5';
    assert.equal(loadConfig().anthropic.jokeModel, 'claude-haiku-5-5');
  } finally {
    if (saved.j === undefined) delete process.env.CLAUDE_JOKE_MODEL;
    else process.env.CLAUDE_JOKE_MODEL = saved.j;
    if (saved.m === undefined) delete process.env.CLAUDE_MODEL;
    else process.env.CLAUDE_MODEL = saved.m;
  }
});

test("notes it wrote as its line, then a pass after it: nothing is said (the 2026-10-29 leak)", async () => {
  const leak =
    "<say>Leonardo's last line was about the list and asking me to stop repeating the struck titles, so a quick acknowledgement works. Keep it short.</say> Actually I need to just output the reply. Leonardo said \"Oh yeah\", which is a reaction, not a question for me. I'll pass. [PASS]";
  assert.equal(passesAfterLine(leak), true);
  assert.equal(passesAfterLine('<say>Ha, nice.</say>'), false);
  assert.equal(passesAfterLine('Not a [PASS], answering this. <say>Sure thing.</say>'), false, 'a pass before its line is just notes');
  assert.equal(passesAfterLine('<say>Done.</say> <list_add list="x">PASS</list_add>'), false, "a tag's words don't count");
  assert.equal(passesAfterLine('<say>Ha, Mike, that is the worst build I have ever seen.</say> Definitely not a [PASS] moment.'), false, 'a pass that ends the reply, not one in a note');
  // Even without the pass, its first sentence is taken for thinking out loud.
  const c = cleanSpoken(sayContent(leak), { botName: 'Babel', optional: true, maxChars: 160, wholeSentences: true, askers: ['Leonardo'] });
  assert.deepEqual(c.dropped, ["Leonardo's last line was about the list and asking me to stop repeating the struck titles, so a quick acknowledgement works."]);
  // Short real lines stay real lines.
  for (const line of ['Keep it short.', "I'll pass.", 'Keep it under a minute.', "Leonardo's last line was a banger."]) assert.equal(isThinkingOutLoud(line, { first: true, mayPass: true, askers: ['Leonardo'] }), false, line);
  assert.equal(isThinkingOutLoud('It reads the match log and will output a line for every kill.', { first: true, askers: ['Mike'] }), false);
  assert.equal(isThinkingOutLoud('Actually I need to just output the reply.', { first: true }), true);

  // Through the brain: an answer, then a follow-up written that way, stays quiet.
  let now = 5_000_000;
  const claude = fakeClient(['<say>Jinx, if your team protects you.</say>', leak]);
  const speaker = autoSpeaker();
  const brain = new Brain({ config: baseConfig, claude, speaker, getCallInfo: () => ({ channelName: 'Lobby', people: ['Leonardo', 'Mike'], activities: [] }), clock: () => now });
  brain.hear({ userId: 'u1', id: 1, name: 'Leonardo', text: 'gremlin who is better, ashe or jinx', startedAt: now - 1500, spokeUntil: now - 200 });
  await settle();
  now += 3000;
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Leonardo', text: 'oh if it snows oh my god', startedAt: now - 1200, spokeUntil: now - 200 }), 'followup');
  await settle(10);
  assert.equal(claude.calls.length, 2);
  assert.deepEqual(
    speaker.said.map((s) => s.text),
    ['Jinx, if your team protects you.'],
  );
});

// ---------------------------------------------------------------------------
// Venice
// ---------------------------------------------------------------------------

test("Venice's format slips are tidied into <say>, and nothing else changes", () => {
  assert.equal(normalizeFormat('[say]Hopefully not expensive.[/say]'), '<say>Hopefully not expensive.</say>');
  assert.equal(normalizeFormat('[says] I am not sure.'), '<say> I am not sure.');
  assert.equal(normalizeFormat('<span id="say">Alright, here it is.</span><song style="rock" seconds="30">[Verse]\nla</song>'), '<say>Alright, here it is.</say><song style="rock" seconds="30">[Verse]\nla</song>');
  assert.equal(normalizeFormat('<say id="1">Hi.</say>'), '<say>Hi.</say>');
  assert.equal(normalizeFormat('<say>[laughs] Fair.</say> <list_add list="games">Hades 2</list_add>'), '<say>[laughs] Fair.</say> <list_add list="games">Hades 2</list_add>');
  assert.equal(normalizeFormat('[PASS]'), '[PASS]');
  assert.equal(normalizeFormat('<say>That build is <b>wild</b>, Mike,<br/>really.</say>'), '<say>That build is wild, Mike, really.</say>');
  assert.equal(normalizeFormat('<say>Hi.</say> <image aspect="1:1">x</image> <song style="a">[Verse]</song>'), '<say>Hi.</say> <image aspect="1:1">x</image> <song style="a">[Verse]</song>', 'its own tags stay');
  assert.equal(sayContent(normalizeFormat('[say]Ha.')), 'Ha.');
  assert.equal(normalizeFormat('<think>They want a joke. <say>no</say></think><say>Ha.</say>'), '<say>Ha.</say>');
  assert.equal(normalizeFormat('<think>still thinking <say>'), '', 'thinking still being written');
});

test('a streamed Venice reply is passed on tidied, and never takes back what it passed on', async () => {
  const full = '<think>A joke, then.</think>[sa' + 'y]Somewhere a minion' + ' is bragging.[/s' + 'ay] <list_add list="g">X</list_add>';
  for (const size of [1, 2, 3, 5, 8, 100]) {
    const pieces = [];
    for (let i = 0; i < full.length; i += size) pieces.push(full.slice(i, i + size));
    const { fetchImpl } = veniceFetch(pieces);
    const res = await fetchImpl('https://x', { body: '{}' });
    const out = [];
    const r = await readVeniceStream(res, (p) => out.push(p));
    const final = normalizeFormat(full);
    assert.equal(out.join(''), final, `pieces of ${size}`);
    let so = '';
    for (const p of out) {
      so += p;
      assert.ok(final.startsWith(so));
      assert.doesNotMatch(so, /\[sa$|\[$/, 'a half-written [say] is held back');
    }
    assert.equal(r.text, final);
  }
});

test('a Venice request: provider guidance enabled, worked examples for the kind, a format reminder last, the usual reply shape', async () => {
  const { fetchImpl, sent } = veniceFetch(['<say>Done, it is on there.</say> ', '<list_add list="games">Hades 2</list_add>'], { usage: { prompt_tokens: 5000, completion_tokens: 30 } });
  const usage = [];
  const v = createVenice({ botName: 'Babel', venice: { apiKey: 'k', model: 'qwen-3-8-27b', temperature: 0.7 } }, { fetchImpl, onUsage: (u) => usage.push(u) });
  const pieces = [];
  const system = [{ type: 'text', text: 'You are Babel.\n\n<lists>\n- rules\n</lists>' }, { type: 'text', text: '<songs>\n- rules\n</songs>' }];
  const r = await v.createMessage({ system, user: '<task>add hades</task>', maxTokens: 300, kind: 'direct', onText: (p) => pieces.push(p) });
  const body = sent[0].body;
  assert.equal(sent[0].url, 'https://api.venice.ai/api/v1/chat/completions');
  assert.equal(sent[0].headers.authorization, 'Bearer k');
  assert.deepEqual(body.venice_parameters, { include_venice_system_prompt: true, disable_thinking: true });
  assert.equal(body.model, 'qwen-3-8-27b');
  assert.equal(body.max_completion_tokens, 300);
  assert.equal(body.temperature, 0.7);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'You are Babel.\n\n<lists>\n- rules\n</lists>\n\n<songs>\n- rules\n</songs>');
  // Worked examples (user, then the reply wanted) for only the tags that are on, then the real message with the reminder last.
  const ex = body.messages.slice(1, -1);
  assert.ok(ex.some((m) => m.role === 'assistant' && /<list_add list="snacks for Saturday">chips<\/list_add>/.test(m.content)));
  assert.ok(ex.some((m) => m.role === 'assistant' && /<song style=/.test(m.content)));
  assert.ok(!ex.some((m) => /<image |<reminder /.test(m.content)), 'no examples of pictures or reminders when they are off');
  assert.ok(ex.every((m, i) => m.role === (i % 2 ? 'assistant' : 'user')));
  assert.ok(ex.filter((m) => m.role === 'user').every((m) => m.content.startsWith('(A made-up example of how to reply')));
  assert.equal(ex.length, examplesFor('direct', 'Babel', { lists: true, songs: true }).length);
  assert.match(body.messages.at(-1).content, /^<task>add hades<\/task>\n\n\(Reply format: your line inside <say><\/say>/);
  assert.match(body.messages.at(-1).content, /If they asked you to put something on a list or make a song, add that tag/);
  assert.doesNotMatch(body.messages.at(-1).content, /picture|reminder/);
  assert.equal(r.text, '<say>Done, it is on there.</say> <list_add list="games">Hades 2</list_add>');
  assert.equal(pieces.join(''), r.text);
  assert.deepEqual(r.usage, { input_tokens: 5000, output_tokens: 30 });
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(r.searches, 0);
  assert.ok(Math.abs(usage[0].dollars - (5000 * 0.45 + 30 * 3.2) / 1e6) < 1e-12);
  // A joke check gets its own examples, one of them a pass, and a shorter reminder.
  const q = examplesFor('quip', 'Babel');
  assert.ok(q.some((m) => m.role === 'assistant' && m.content === '[PASS]'));
  assert.match(q[0].content, /<task>\nNobody is talking to you right now/);
  // The made-up examples use the bot's name, and no real people.
  assert.match(JSON.stringify(examplesFor('followup', 'Babel')), /Babel \(you\)/);
});

test('Venice: running out of room maps to max_tokens, a busy server is asked again, a bad key or no credit is an error', async () => {
  const cut = veniceFetch(['<say>This goes on and'], { finish: 'length' });
  const v1 = createVenice({ venice: { apiKey: 'k' } }, { fetchImpl: cut.fetchImpl });
  assert.equal((await v1.createMessage({ system: 's', user: 'u', kind: 'quip' })).stopReason, 'max_tokens');

  let calls = 0;
  const ok = veniceFetch(['[PASS]']);
  const busy = async (url, init) => (++calls === 1 ? new Response('busy', { status: 429 }) : ok.fetchImpl(url, init));
  const v2 = createVenice({ venice: { apiKey: 'k' } }, { fetchImpl: busy, sleep: async () => {} });
  assert.equal((await v2.createMessage({ system: 's', user: 'u', kind: 'quip' })).text, '[PASS]');
  assert.equal(calls, 2);

  const broke = veniceFetch([], { status: 402 });
  const v3 = createVenice({ venice: { apiKey: 'k' } }, { fetchImpl: broke.fetchImpl });
  await assert.rejects(v3.createMessage({ system: 's', user: 'u', kind: 'direct' }), (err) => err.status === 402);
  assert.equal(veniceDollars('nobody-knows', { prompt_tokens: 1 }), null);
});

test('the brain sends only the kinds VENICE_FOR covers to Venice, and answers written by Venice never search', async () => {
  let now = 5_000_000;
  const claude = fakeClient(['<say>Claude answers this one.</say>']);
  const venice = { ...fakeClient(['<say>Venice jumps in.</say>'], 'venice'), canSearchNow: false };
  const brain = new Brain({
    config: { ...baseConfig, venice: { kinds: ['quip', 'roast'] } },
    claude,
    venice,
    speaker: autoSpeaker(),
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike'], activities: [] }),
    clock: () => now,
  });
  assert.equal(brain.clientFor('quip'), venice);
  assert.equal(brain.clientFor('roast'), venice);
  assert.equal(brain.clientFor('direct'), claude);
  assert.equal(brain.clientFor('followup'), claude);
  assert.equal(brain.searchOn(), true);
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what time is it', startedAt: now - 1500, spokeUntil: now - 200 });
  await settle();
  assert.equal(claude.calls.length, 1);
  assert.equal(claude.calls[0].kind, 'direct', 'the kind goes along (Venice picks its examples by it)');
  assert.equal(venice.calls.length, 0);

  const all = new Brain({ config: { ...baseConfig, venice: { kinds: ['direct', 'quip'] } }, claude: fakeClient([]), venice, speaker: autoSpeaker(), getCallInfo: () => ({}), clock: () => now });
  assert.equal(all.searchOn(), false);
  // Without a Venice client, VENICE_FOR does nothing.
  const none = new Brain({ config: { ...baseConfig, venice: { kinds: ['direct'] } }, claude, speaker: autoSpeaker(), getCallInfo: () => ({}), clock: () => now });
  assert.equal(none.clientFor('direct'), claude);
  assert.equal(none.searchOn(), true);
});

test('a follow-up line followed by a pass stays quiet, a pass before its line does not', async () => {
  for (const [reply, expected] of [
    ['<say>Ha, good one.</say> Wait, that was for Jess, not me. [PASS]', []],
    ['That one is for me, not a [PASS]. <say>Ha, good one.</say>', ['Ha, good one.']],
  ]) {
    let now = 5_000_000;
    const claude = fakeClient(['<say>Jinx, if your team protects you.</say>', reply]);
    const speaker = autoSpeaker();
    const brain = new Brain({ config: baseConfig, claude, speaker, getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }), clock: () => now });
    brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin who is better, ashe or jinx', startedAt: now - 1500, spokeUntil: now - 200 });
    await settle();
    now += 3000;
    assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'that is so funny', startedAt: now - 1200, spokeUntil: now - 200 }), 'followup');
    await settle(10);
    assert.deepEqual(speaker.said.map((s) => s.text).slice(1), expected, reply);
  }
});

test('VENICE_FOR picks the kinds of line, the key and model come from .env, and usage counts Venice apart', async () => {
  const { loadConfig, VENICE_KINDS } = await import('../src/config.js');
  const keys = ['VENICE_FOR', 'VENICE_API_KEY', 'VENICE_MODEL', 'VENICE_TEMPERATURE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    const off = loadConfig();
    if (off.envFile) return; // a real .env is here: its settings win
    assert.deepEqual(off.venice.kinds, []);
    assert.equal(off.venice.for, 'off');
    assert.equal(off.venice.model, 'qwen-3-8-27b');
    assert.equal(off.venice.temperature, 0.7);
    process.env.VENICE_FOR = 'Jokes';
    process.env.VENICE_API_KEY = 'k';
    process.env.VENICE_MODEL = 'qwen-3-8-27b';
    process.env.VENICE_TEMPERATURE = '5';
    const on = loadConfig();
    assert.deepEqual(on.venice.kinds, ['quip', 'roast']);
    assert.equal(on.venice.model, 'qwen-3-8-27b');
    assert.equal(on.venice.temperature, 2, 'kept within 0 to 2');
    process.env.VENICE_FOR = 'everything';
    assert.deepEqual(loadConfig().venice.kinds, [], 'an unknown setting is off');
    assert.ok(VENICE_KINDS.answers.includes('direct') && !VENICE_KINDS.answers.includes('followup') && VENICE_KINDS.all.includes('followup'));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  const { costOf, describeBucket, emptyBucket, totalDollars } = await import('../src/usage.js');
  const d = costOf({ type: 'venice', model: 'qwen-3-8-27b', usage: { prompt_tokens: 5000, completion_tokens: 40 }, dollars: 0.001036 });
  assert.equal(d.veniceRequests, 1);
  assert.equal(d.veniceInput, 5000);
  assert.equal(d.claudeRequests, 0);
  assert.ok(Math.abs(totalDollars(d) - 0.001036) < 1e-12);
  assert.ok(describeBucket(d).some((l) => /^Venice: 1 replies and checks/.test(l)));
  assert.ok(!describeBucket(emptyBucket()).some((l) => /Venice/.test(l)), 'no Venice line until it has written something');
  const { FIELDS } = await import('../desktop/lib/settings.mjs');
  assert.deepEqual(FIELDS.get('VENICE_FOR').options, ['off', 'jokes', 'answers', 'all']);
  assert.equal(FIELDS.get('VENICE_API_KEY').type, 'secret');
});

test('its own jokes are spaced out by chattiness (now that the joke check jumps in)', () => {
  let now = 5_000_000;
  const brain = new Brain({ config: { ...baseConfig, anthropic: { webSearch: { enabled: false } } }, claude: fakeClient([]), speaker: autoSpeaker(), chattiness: 'medium', getCallInfo: () => ({}), clock: () => now });
  assert.equal(brain.stillWanted('quip', {}), true);
  brain.markSpoke('quip');
  now += 150_000; // past the 2.5 minute cooldown after any line of its own
  assert.equal(brain.stillWanted('quip', {}), false, 'but not 5 minutes since its last joke');
  now += 150_000;
  assert.equal(brain.stillWanted('quip', {}), true);
  // An answer isn't a joke: only the usual cooldown after it.
  brain.markSpoke('direct', { name: 'Mike', userIds: ['u1'] });
  now += 150_000;
  assert.equal(brain.stillWanted('quip', {}), true);
  // Jokes that fall flat stretch the gap too (the same factor as the other waits).
  assert.equal(brain.quipPacing().jokeGapMs, 300_000);
  for (let i = 0; i < 5; i++) brain.jokeTuning.record('shushed'); // (it goes by reactions once 5 jokes are in)
  assert.ok(brain.quipPacing().jokeGapMs > 300_000);
});

test('when Venice turns a request down (no credit, a bad key), Claude writes it, and Venice rests for a while', async () => {
  let now = 5_000_000;
  const claude = fakeClient(['<say>Claude here.</say>']);
  const broke = veniceFetch([], { status: 402 });
  const venice = createVenice({ botName: 'Gremlin', venice: { apiKey: 'k' } }, { fetchImpl: broke.fetchImpl });
  const speaker = autoSpeaker();
  const brain = new Brain({ config: { ...baseConfig, venice: { kinds: ['direct', 'quip'] } }, claude, venice, speaker, getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike'], activities: [] }), clock: () => now });
  assert.equal(brain.searchOn(), false, 'answers by Venice: no search');
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what time is it', startedAt: now - 1500, spokeUntil: now - 200 });
  await settle(12);
  assert.equal(broke.sent.length, 1);
  assert.deepEqual(speaker.said.map((s) => s.text), ['Claude here.']);
  assert.equal(venice.usable, false);
  assert.equal(brain.clientFor('quip'), brain.claudeJokes, 'Claude writes its lines while Venice rests');
  assert.equal(brain.searchOn(), true);
});

test('a joke nobody heard does not hold off the next one', () => {
  let now = 5_000_000;
  const brain = new Brain({ config: { ...baseConfig, anthropic: { webSearch: { enabled: false } } }, claude: fakeClient([]), speaker: autoSpeaker(), chattiness: 'medium', getCallInfo: () => ({}), clock: () => now });
  const line = brain.transcript.add({ name: 'Gremlin', text: 'A joke.', isBot: true });
  line.before = { lastBotLineAt: 0, engagedUntil: 0, followupsInARow: 0, talkingWith: new Set(), lastJokeAt: -Infinity, seq: 1 };
  brain.markSpoke('quip');
  line.jokeAt = brain.lastJokeAt;
  brain.settleLine(line, 'dropped', 'quip');
  now += 160_000;
  assert.equal(brain.stillWanted('quip', {}), true);
});

test('a provider content-filter finish is returned as a refusal', async () => {
  const encoder = new TextEncoder();
  const event = { choices: [{ delta: {}, finish_reason: 'content_filter' }] };
  let calls = 0;
  const client = createVenice({ venice: { apiKey: 'test', model: 'qwen-3-8-27b' } }, {
    fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n')); c.close(); } }));
    },
  });
  const reply = await client.createMessage({ system: 'Be helpful.', user: 'a question' });
  assert.equal(reply.refusal, true);
  assert.equal(reply.stopReason, 'refusal');
  assert.equal(calls, 1);
});
