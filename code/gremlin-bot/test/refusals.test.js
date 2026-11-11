import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { buildSystem } from '../src/prompts.js';
import { looksLikeSoftRefusal } from '../src/refusals.js';
import { textReply } from '../src/commands.js';

const baseConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin', 'grem'],
  timezone: 'UTC',
  defaultChattiness: 'medium',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
  // A configured second provider is available to detect unintended requests.
  venice: { kinds: [] },
};

function fakeClient(replies) {
  const calls = [];
  const queue = [...replies];
  return {
    calls,
    async createMessage(args) {
      calls.push(args);
      const next = queue.shift();
      const res = typeof next === 'function' ? await next(args) : { text: next, refusal: false };
      return { text: res.text ?? '', refusal: false, ...res };
    },
  };
}

function fakeSpeaker() {
  const said = [];
  return {
    said,
    speaking: false,
    talkedOver: false,
    wasAudibleBetween: () => false,
    stopKind() {},
    stop() {},
    say(text, opts) {
      said.push({ text, kind: opts?.kind });
      return Promise.resolve('played');
    },
  };
}

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function makeBrain({ replies = [], providerReplies = [], config = {}, withVenice = true } = {}) {
  const claude = fakeClient(replies);
  const venice = withVenice ? fakeClient(providerReplies) : null;
  if (venice) {
    venice.usable = true;
    venice.model = 'qwen-3-8-27b';
    venice.provider = 'venice';
    venice.canSearchNow = false;
  }
  const speaker = fakeSpeaker();
  const brain = new Brain({
    // (config.venice.kinds is [] so Venice never writes a line by itself.)
    config: { ...baseConfig, ...config },
    claude,
    venice,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike'], activities: [] }),
    getFacts: () => [],
    isAnyoneSpeaking: () => false,
    chattiness: 'medium',
    clock: () => 1_000_000,
  });
  return { brain, claude, venice, speaker };
}

test('a polite decline written as an ordinary reply is recognised, a real line is not', () => {
  for (const s of [
    "I'm sorry, but I can't help with that.",
    'Sorry, I cannot write that.',
    "I can't assist with that request.",
    "I'm unable to generate that.",
    'As an AI, I have to decline.',
    'That would violate my guidelines.',
    'I must decline.',
    "I'd rather not.",
    "I'm not comfortable with that.",
    "I won't answer that.",
    'I cannot do that.',
    // Shapes an independent reviewer flagged as refusals that the detector was missing.
    "That's not something I can help with.",
    'I must decline that request.',
  ]) {
    assert.equal(looksLikeSoftRefusal(s), true, s);
  }
  for (const s of [
    // Ordinary idioms that end a line in the same shape as a decline. These are the shapes a
    // real reply takes; matching them would throw away the answer and pay for a retry.
    "Sorry, I can't make it",
    "I'm not able to make it.",
    "That's just how I am, I can't help it.",
    "Because you keep moving while you shoot, and I can't help that.",
    "I can't say.",
    "I can't do it.",
    'The couch is not comfortable.',
    // "make" and "say" were dropped from the verbs entirely because of these two: an
    // independent reader classes both as lines a person says, not declines.
    "I can't make that.",
    "I can't say that.",
    "I can't make that jump in one go.",
    "I can't do that from here.",
    // It wrote a line: never judged as a refusal, whatever the words.
    "<say>I can't help with that, I'm a goblin.</say>",
    "<say>Sorry, but your build is a war crime.</say>",
    // Ordinary banter that happens to start the same way. Every pattern is anchored to the
    // END of the reply, so a decline that is followed by a joke is a line, not a refusal.
    "I can't help with that, I'm a goblin.",
    "I can't even, Mike.",
    'I won the argument, obviously.',
    "As an AI I'd know, but I'm a goblin.",
    'Mike, your aim is a policy violation.',
    "I'm not going to lie, that was sick.",
    'Twelve, obviously. Ask me something hard.',
    // A text-chat reply carries no <say> tags, so this path is where false positives would
    // hurt most: a real answer must never be mistaken for a decline.
    'Go Garen, he is easy and hits hard.',
  ]) {
    assert.equal(looksLikeSoftRefusal(s), false, s);
  }
  assert.equal(looksLikeSoftRefusal(''), false);
  assert.equal(looksLikeSoftRefusal(null), false);
});

test('provider guidance is always present in the system prompt', () => {
  const system = buildSystem({ botName: 'Babel', persona: 'Be helpful.' })[0].text;
  assert.match(system, /suitable for a general audience/);
  assert.match(system, /Follow provider content policies/);
  assert.match(system, /Protect children and vulnerable people/);
});

test('voice declines do not send the request to a second provider', async () => {
  for (const response of [{ text: '', refusal: true }, { text: "I cannot help with that request.", refusal: false }]) {
    const { brain, venice, speaker } = makeBrain({ replies: [() => response] });
    brain.hear({ name: 'Mike', text: 'gremlin answer my question' });
    await settle();
    assert.equal(venice.calls.length, 0);
    assert.equal(speaker.said.length, 1);
    assert.match(speaker.said[0].text, /cannot/);
    brain.close();
  }
});

test('text declines do not send the request to a second provider', async () => {
  for (const response of [{ text: '', refusal: true }, { text: "I cannot help with that request.", refusal: false }]) {
    const calls = [];
    const ctx = {
      config: { botName: 'Babel', persona: 'Be helpful.', lore: '', timezone: 'UTC', anthropic: { webSearch: { enabled: false } } },
      claude: { createMessage: async () => response },
      venice: { createMessage: async () => { calls.push('unexpected'); throw Error('Unexpected retry'); } },
      memory: { facts: () => [] }, sessions: new Map(),
    };
    assert.match(await textReply(ctx, { guildId: 'g', authorId: 'a', author: 'Mike', content: 'a question' }), /cannot help/);
    assert.deepEqual(calls, []);
  }
});

test('provider validation and permission rejections do not fail over', async () => {
  for (const status of [400, 403]) {
    const { brain, claude, venice } = makeBrain({ config: { venice: { kinds: ['direct'] } } });
    venice.createMessage = async () => { throw Object.assign(new Error('Request rejected'), { status }); };
    brain.hear({ name: 'Mike', text: 'gremlin answer my question' });
    await settle();
    assert.equal(claude.calls.length, 0);
    brain.close();
  }
});
