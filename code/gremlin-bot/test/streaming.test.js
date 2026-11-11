// Faster replies: Claude's answer is read as it streams in and spoken a sentence
// at a time, and the stream reader that makes that possible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { readStream } from '../src/claude.js';
import { nextSentenceEnd } from '../src/prompts.js';

const baseConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  timezone: 'UTC',
  defaultChattiness: 'off',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
  anthropic: { webSearch: { enabled: false } },
};

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** A speaker that records lines and lets a test say how each one ends. */
function fakeSpeaker() {
  const lines = [];
  return {
    lines,
    speaking: false,
    wasAudibleBetween: () => false,
    say(text, opts = {}) {
      const line = { text, opts };
      lines.push(line);
      return new Promise((resolve) => {
        line.end = (outcome) => {
          if (!line.outcome) {
            line.outcome = outcome;
            resolve(outcome);
          }
        };
        opts.signal?.addEventListener('abort', () => {
          if (!line.started) line.end('dropped');
        });
      });
    },
    start(i) {
      lines[i].started = true;
      lines[i].opts.onStart?.();
    },
    stop() {
      for (const l of lines) l.end?.('stopped');
    },
    stopKind() {},
    dropOptional() {},
  };
}

/**
 * A Claude whose reply arrives in pieces the test hands out one by one (send), then
 * finishes with done(); onText gets each piece, like the real streaming client.
 */
function streamingClaude() {
  const calls = [];
  let current = null;
  return {
    calls,
    async createMessage(args) {
      calls.push(args);
      return new Promise((resolve, reject) => {
        let text = '';
        current = {
          // Its words come inside <say></say>, as the bot asks for: the tag opens the reply
          // (and the answer after a search).
          send(piece) {
            const p = text ? piece : `<say>${piece}`;
            text += p;
            args.onText?.(p);
          },
          tool() {
            args.onToolStart?.();
            text = '';
          },
          done(final = text) {
            resolve({ text: final, refusal: false, searches: 0, citations: [] });
          },
        };
        args.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
    get reply() {
      return current;
    },
  };
}

function setup(config = {}) {
  let now = 7_000_000;
  const claude = streamingClaude();
  const speaker = fakeSpeaker();
  const brain = new Brain({
    config: { ...baseConfig, ...config },
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
    clock: () => now,
  });
  return { brain, claude, speaker, advance: (ms) => (now += ms) };
}

test('a streamed answer starts speaking at its first sentence, before the rest is written', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what should I build' });
  await settle();
  claude.reply.send('Go for the heavy armor build');
  assert.equal(speaker.lines.length, 0, 'not a whole sentence yet');
  claude.reply.send(', it carries the team. Then grab');
  assert.deepEqual(speaker.lines.map((l) => l.text), ['Go for the heavy armor build, it carries the team.']);
  assert.equal(speaker.lines[0].opts.continues, false, 'the first sentence waits for its turn like any answer');
  claude.reply.send(' the shield.');
  claude.reply.done();
  await settle();
  assert.deepEqual(speaker.lines.map((l) => l.text), ['Go for the heavy armor build, it carries the team.', 'Then grab the shield.']);
  assert.equal(speaker.lines[1].opts.continues, true, 'the rest follows right on');
  assert.equal(speaker.lines[1].opts.tag.line, speaker.lines[0].opts.tag.line, 'both parts belong to one transcript line');
  speaker.start(0);
  speaker.lines[0].end('played');
  speaker.start(1);
  speaker.lines[1].end('played');
  await settle();
  const said = brain.transcript.lines.filter((l) => l.isBot).map((l) => l.text);
  assert.deepEqual(said, ['Go for the heavy armor build, it carries the team. Then grab the shield.']);
});

test('short sentences wait for the next one, so the voice is not choppy', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin are you ready for this' });
  await settle();
  claude.reply.send('Yep. ');
  assert.equal(speaker.lines.length, 0);
  claude.reply.send('Ready when you are, chief. ');
  assert.deepEqual(speaker.lines.map((l) => l.text), ['Yep. Ready when you are, chief.']);
  claude.reply.done();
});

test('a reply that starts with PASS is held until it is all in, and then not said', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin' });
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'jess are you coming tonight' });
  await settle();
  claude.reply.send('PASS - that was for Jess. ');
  claude.reply.send('She will answer it herself.');
  claude.reply.done();
  await settle();
  assert.deepEqual(
    speaker.lines.map((l) => l.text).filter((t) => !/^(Yeah\?|What's up\?|I'm here\.|Go ahead\.|Talk to me\.)$/.test(t)),
    [],
  );
});

test('what it wrote before a web search is not said', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin when does the patch drop' });
  await settle();
  claude.reply.send('Let me check');
  claude.reply.tool();
  claude.reply.send('Patch drops Tuesday at ten. ');
  claude.reply.send('Bring snacks.');
  claude.reply.done('Patch drops Tuesday at ten. Bring snacks.');
  await settle();
  assert.deepEqual(speaker.lines.map((l) => l.text), ['Patch drops Tuesday at ten.', 'Bring snacks.']);
});

test('a part that does not get to play stops the rest, and the transcript keeps only what was heard', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin tell me about the map' });
  await settle();
  claude.reply.send('The north side has the best loot by far. ');
  speaker.start(0);
  claude.reply.send('The south side is a trap. ');
  speaker.lines[0].end('played');
  speaker.lines[1].end('stopped'); // cut off before it started
  claude.reply.send('And the middle is just sad.');
  claude.reply.done();
  await settle();
  assert.equal(speaker.lines.length, 2, 'nothing more after a part was cut off');
  const said = brain.transcript.lines.filter((l) => l.isBot).map((l) => l.text);
  assert.deepEqual(said, ['The north side has the best loot by far. (got cut off here)']);
});

test('nothing streamed early (one short sentence): the cleaned whole reply is said once', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin say hi to everyone' });
  await settle();
  claude.reply.send('Gremlin (you): Hey Mike');
  claude.reply.done();
  await settle();
  assert.deepEqual(speaker.lines.map((l) => l.text), ['Hey Mike']);
});

test('a sentence end is found once the space after it arrives, skipping abbreviations', () => {
  assert.equal(nextSentenceEnd('Hello there.'), -1, 'the space after it has not arrived');
  assert.equal(nextSentenceEnd('Hello there. Then'), 12);
  assert.equal(nextSentenceEnd('Ask Dr. Mario about it. Ok'), 23);
  assert.equal(nextSentenceEnd('Wait! "Really?" he said', 0), 5);
  assert.equal(nextSentenceEnd('Hi. That is a long one. More', 10), 23, 'too short alone: runs on to the next end');
});

// ---------------------------------------------------------------------------
// The stream reader
// ---------------------------------------------------------------------------

function sse(events, { split = 0, crlf = false } = {}) {
  let text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  if (crlf) text = text.replace(/\n/g, '\r\n');
  const bytes = Buffer.from(text);
  const chunks = [];
  const size = split || bytes.length;
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  return { body: (async function* gen() { yield* chunks; })() };
}

const EVENTS = [
  ['message_start', { type: 'message_start', message: { usage: { input_tokens: 120, cache_read_input_tokens: 100 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['ping', { type: 'ping' }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
  ['message_stop', { type: 'message_stop' }],
];

test('stream reader: text pieces as they come, and the same result as a plain reply', async () => {
  for (const opts of [{}, { split: 7 }, { split: 3, crlf: true }]) {
    const pieces = [];
    const r = await readStream(sse(EVENTS, opts), { onText: (t) => pieces.push(t) });
    assert.deepEqual(pieces, ['Hello ', 'there.'], JSON.stringify(opts));
    assert.deepEqual(r.content, [{ type: 'text', text: 'Hello there.' }]);
    assert.equal(r.stop_reason, 'end_turn');
    assert.deepEqual(r.usage, { input_tokens: 120, cache_read_input_tokens: 100, output_tokens: 7 });
  }
});

test('stream reader: a web search start is reported and its input is put back together', async () => {
  let toolStarts = 0;
  const r = await readStream(
    sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'x', name: 'web_search', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query": "patch' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' notes"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { url: 'https://example.com', title: 'Ex' } } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Tuesday.' } }],
    ]),
    { onToolStart: () => toolStarts++ },
  );
  assert.equal(toolStarts, 1);
  assert.deepEqual(r.content[0].input, { query: 'patch notes' });
  assert.deepEqual(r.content[1].citations, [{ url: 'https://example.com', title: 'Ex' }]);
});

test('stream reader: an error in the stream is thrown, overloaded as 529 so it can be retried', async () => {
  await assert.rejects(
    readStream(sse([['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]])),
    (err) => err.status === 529 && /overloaded/.test(err.message),
  );
});
