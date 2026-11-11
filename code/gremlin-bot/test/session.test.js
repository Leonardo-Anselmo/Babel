// Voice connection recovery, and slash-command guards that protect a running call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleInteraction } from '../src/commands.js';
import { Memory } from '../src/memory.js';
import { VoiceSession } from '../src/session.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeConnection extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'ready' };
    this.rejoins = 0;
    this.onRejoin = () => {};
  }
  setStatus(status) {
    const old = this.state;
    this.state = { status };
    this.emit('stateChange', old, this.state);
    this.emit(status, old, this.state);
  }
  rejoin() {
    this.rejoins++;
    this.onRejoin();
    return true;
  }
  destroy() {
    this.setStatus('destroyed');
  }
}

function makeSession() {
  const posts = [];
  const guild = {
    id: 'g1',
    name: 'Test',
    channels: { cache: new Map([['B', { id: 'B', name: 'B', members: new Map() }]]) },
    voiceStates: { cache: new Map() },
    members: { cache: new Map(), me: { id: 'bot' }, fetch: async () => ({}) },
  };
  const s = new VoiceSession({
    client: { user: { id: 'bot' } },
    guild,
    voiceChannel: { id: 'B' },
    textChannel: { send: async (m) => posts.push(m.content ?? m) },
    config: { autoLeaveSeconds: 60 },
    memory: { isOptedOut: () => false, chattiness: () => null, facts: () => [] },
    timing: { settleMs: 30, readyMs: 40, backoffMs: 10 },
  });
  s.ready = true;
  s.connection = new FakeConnection();
  return { s, posts };
}

test('a dropped voice connection that comes back by itself is left alone', async () => {
  const { s } = makeSession();
  s.connection.setStatus('disconnected');
  const recovering = s.recover();
  await wait(5);
  s.connection.setStatus('connecting');
  await recovering;
  assert.equal(s.connection.rejoins, 0);
  assert.equal(s.ended, false);
});

test('a dropped voice connection is rejoined instead of leaving the call', async () => {
  const { s } = makeSession();
  s.connection.onRejoin = () => setTimeout(() => s.connection.setStatus('ready'), 5);
  s.connection.setStatus('disconnected');
  await s.recover();
  assert.equal(s.connection.rejoins, 1);
  assert.equal(s.ended, false);
});

test('if rejoining keeps failing it says so in text, then leaves', async () => {
  const { s, posts } = makeSession();
  s.connection.setStatus('disconnected');
  await s.recover();
  assert.equal(s.connection.rejoins, 3);
  assert.equal(s.ended, true);
  assert.match(posts[0], /lost the voice connection/);
});

test('only one reconnect runs at a time', async () => {
  const { s } = makeSession();
  s.connection.setStatus('disconnected');
  const a = s.recover();
  const b = s.recover();
  await Promise.all([a, b]);
  assert.equal(s.connection.rejoins, 3);
});

function interaction(commandName, { userId = 'u1', options = {} } = {}) {
  const out = { replies: [], followUps: [] };
  return {
    out,
    isChatInputCommand: () => true,
    inGuild: () => true,
    commandName,
    guildId: 'g1',
    user: { id: userId },
    channel: null,
    deferred: false,
    replied: false,
    options: {
      getString: (name) => options[name],
      getInteger: (name) => options[name],
    },
    async reply(m) {
      this.replied = true;
      out.replies.push(typeof m === 'string' ? m : m.content);
    },
    async followUp(m) {
      out.followUps.push(typeof m === 'string' ? m : m.content);
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(m) {
      out.replies.push(typeof m === 'string' ? m : m.content);
    },
  };
}

test('/say only works for people in the call, and not back to back', async () => {
  const said = [];
  const session = { ready: true, ended: false, hasMember: (id) => id === 'inCall', brain: { sayExactly: (t) => said.push(t) } };
  const ctx = { sessions: new Map([['g1', session]]), config: { botName: 'Gremlin' } };
  const outsider = interaction('say', { userId: 'outsider', options: { text: 'hello' } });
  await handleInteraction(outsider, ctx);
  assert.match(outsider.out.replies[0], /Join the voice channel first/);
  const first = interaction('say', { userId: 'inCall', options: { text: 'hello' } });
  await handleInteraction(first, ctx);
  assert.equal(first.out.replies[0], 'Saying it.');
  const second = interaction('say', { userId: 'inCall', options: { text: 'again' } });
  await handleInteraction(second, ctx);
  assert.match(second.out.replies[0], /Try again in/);
  assert.deepEqual(said, ['hello']);
});

test('/memories shows every fact, split across messages when the list is long', async () => {
  const facts = Array.from({ length: 40 }, (_, i) => ({ text: `Fact number ${i + 1} ${'x'.repeat(150)}` }));
  const i = interaction('memories');
  await handleInteraction(i, { memory: { facts: () => facts } });
  const all = [...i.out.replies, ...i.out.followUps];
  assert.ok(all.length > 1);
  assert.ok(all.every((m) => m.length <= 1900));
  assert.match(all.at(-1), /^40\. Fact number 40|\n40\. Fact number 40/);
});

test('a memory file that can not be saved right away keeps retrying (opt-outs must stick)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-memory-'));
  try {
    const memory = new Memory(dir);
    const file = path.join(dir, 'memory.json');
    fs.mkdirSync(file); // something is in the way, like a sync app holding the file
    memory.setOptOut('g1', 'u1', true);
    await wait(400);
    assert.ok(memory.failedSaves >= 1);
    fs.rmSync(file, { recursive: true });
    await wait(2300);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).guilds.g1.optouts, ['u1']);
    assert.equal(memory.failedSaves, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two /join commands at the same moment start only one copy of the bot', async () => {
  const realStart = VoiceSession.prototype.start;
  let starts = 0;
  VoiceSession.prototype.start = async function () {
    starts++;
    this.starting = false;
    this.ready = true;
    this.brain = { chattiness: 'low' };
  };
  try {
    const channel = { id: 'B', type: 2, joinable: true, full: false, permissionsFor: () => ({ has: () => true }), toString: () => '#B' };
    const guild = { members: { fetch: async () => ({ voice: { channel } }), me: { id: 'bot' } } };
    const sessions = new Map();
    const ctx = { sessions, config: { botName: 'Gremlin' }, memory: {}, usage: null };
    let releaseDefer;
    const first = interaction('join');
    first.guild = guild;
    first.deferReply = () => new Promise((r) => (releaseDefer = r)); // Discord is slow to acknowledge
    const second = interaction('join', { userId: 'u2' });
    second.guild = guild;
    const a = handleInteraction(first, ctx);
    await wait(5);
    await handleInteraction(second, ctx);
    assert.match(second.out.replies[0], /Still connecting/);
    releaseDefer();
    await a;
    assert.equal(starts, 1);
    assert.equal(sessions.size, 1);
  } finally {
    VoiceSession.prototype.start = realStart;
  }
});

test('/join while it is moving channels says so instead of moving twice', async () => {
  const channel = { id: 'C', type: 2, joinable: true, full: false, permissionsFor: () => ({ has: () => true }), toString: () => '#C' };
  const guild = { members: { fetch: async () => ({ voice: { channel } }), me: { id: 'bot' } } };
  const existing = { starting: false, moving: true, ended: false, channelId: 'B', moveTo: async () => assert.fail('should not move') };
  const i = interaction('join');
  i.guild = guild;
  await handleInteraction(i, { sessions: new Map([['g1', existing]]), config: { botName: 'Gremlin' } });
  assert.match(i.out.replies[0], /Still moving/);
});

test('a second channel move while one is in progress is refused, not raced', async () => {
  const { s } = makeSession();
  s.moveInProgress = true;
  assert.equal(await s.moveTo({ id: 'C', name: 'C' }, null), false);
  assert.equal(s.connection.rejoins, 0);
});

test('if /leave lands before /join finishes, it never joins voice', async () => {
  const { s } = makeSession();
  s.connection = null;
  s.end('asked to leave');
  await assert.rejects(() => s.start(), /cancelled/);
  assert.equal(s.connection, null);
});
