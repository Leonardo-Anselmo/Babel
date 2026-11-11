// Auto-join: it joins a voice channel by itself once two or more people have been in it
// for a few seconds, follows them if they all move, stays out after /leave until
// everyone has left voice, and waits ten minutes after a join that failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutoJoiner, JOIN_DELAY_MS, anyoneInVoice, pickChannel } from '../src/autojoin.js';
import { linkToApp } from '../src/app-link.js';
import { Memory } from '../src/memory.js';
import { EventEmitter } from 'node:events';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-autojoin-'));

const person = (id, { bot = false, deaf = false } = {}) => ({ id, displayName: id, user: { bot, username: id }, voice: { deaf } });

/** A server with voice channels; g.move(person, channelId) moves someone (null: out of voice). */
function server(specs, { afk = null } = {}) {
  const channels = new Map();
  const g = { id: 'g1', name: 'Pressure', afkChannelId: afk, channels: { cache: channels }, members: { me: { id: 'bot' } }, voiceStates: { cache: new Map() } };
  g.move = (p, channelId) => {
    for (const ch of channels.values()) ch.members.delete(p.id);
    if (channelId) {
      channels.get(channelId).members.set(p.id, p);
      g.voiceStates.cache.set(p.id, { channelId, member: p });
    } else g.voiceStates.cache.delete(p.id);
  };
  for (const s of specs) {
    channels.set(s.id, {
      id: s.id,
      name: s.id,
      type: s.type ?? 2,
      full: Boolean(s.full),
      joinable: s.joinable ?? true,
      members: new Map(),
      // has([...]) for View/Connect/Speak, has(x) for Move Members (which nobody gave it here).
      permissionsFor: () => ({ has: (x) => (Array.isArray(x) ? (s.perms ?? true) : false) }),
    });
    for (const p of s.people || []) g.move(p, s.id);
  }
  return g;
}

function fakeTimers() {
  let now = 1_000_000;
  const timers = new Set();
  return {
    clock: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
    async run(ms) {
      const end = now + ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= end && timers.has(t)) {
          now = Math.max(now, t.at);
          timers.delete(t);
          t.fn();
          for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
        }
      }
      now = end;
    },
    get pending() {
      return timers.size;
    },
  };
}

function setup(g, { autoJoin = true, joinFails = false } = {}) {
  const memory = new Memory(tmp());
  const sessions = new Map();
  const joins = [];
  const moves = [];
  const t = fakeTimers();
  const client = { isReady: () => true, guilds: { cache: new Map([[g.id, g]]) } };
  const aj = new AutoJoiner({
    client,
    config: { autoJoin },
    memory,
    sessions,
    ...t,
    join: async (guild, channel) => {
      joins.push(channel.id);
      if (joinFails) throw new Error('no voice');
      const s = {
        ended: false,
        ready: true,
        channelId: channel.id,
        get voiceChannel() {
          return guild.channels.cache.get(this.channelId);
        },
        moveTo: async (to) => {
          moves.push(to.id);
          s.channelId = to.id;
          return true;
        },
      };
      sessions.set(guild.id, s);
    },
  });
  return { aj, memory, sessions, joins, moves, t };
}

test('the channel to join: the one with the most people (two at least) that it can talk in', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => person(id));
  const bot = person('otherbot', { bot: true });
  const deaf = person('deaf', { deaf: true });
  const g = server([
    { id: 'Lobby', people: [a, bot, deaf] }, // one who counts
    { id: 'Raid', people: [b, c] },
    { id: 'Stage', type: 13, people: [person('s1'), person('s2'), person('s3')] },
    { id: 'Locked', perms: false, people: [person('l1'), person('l2'), person('l3')] },
    { id: 'Full', full: true, people: [person('f1'), person('f2'), person('f3')] },
    { id: 'AFK', people: [d, person('z1'), person('z2'), person('z3')] },
  ], { afk: 'AFK' });
  assert.equal(pickChannel(g)?.id, 'Raid');
  assert.equal(pickChannel(g, { isOptedOut: (id) => id === 'b' }), null, 'someone who opted out does not count');
  g.move(person('e'), 'Lobby');
  assert.equal(pickChannel(g, { prefer: 'Lobby' })?.id, 'Lobby', 'a tie goes to where it already is');
  assert.equal(anyoneInVoice(g), true);
});

test('it joins once the group has been together a few seconds, and not if they split up first', async () => {
  const [a, b] = [person('a'), person('b')];
  const g = server([{ id: 'Lobby', people: [a] }, { id: 'Raid' }]);
  const s = setup(g);
  s.aj.checkAll();
  assert.equal(s.t.pending, 0, 'one person is not a hangout');
  g.move(b, 'Lobby');
  s.aj.onVoiceStateUpdate({}, { guild: g });
  await s.t.run(JOIN_DELAY_MS - 1000);
  assert.deepEqual(s.joins, []);
  g.move(b, null);
  s.aj.onVoiceStateUpdate({}, { guild: g });
  await s.t.run(5000);
  assert.deepEqual(s.joins, [], 'they split up before the wait was over');
  g.move(b, 'Lobby');
  s.aj.onVoiceStateUpdate({}, { guild: g });
  await s.t.run(JOIN_DELAY_MS);
  assert.deepEqual(s.joins, ['Lobby']);
  s.aj.onVoiceStateUpdate({}, { guild: g });
  await s.t.run(JOIN_DELAY_MS);
  assert.deepEqual(s.joins, ['Lobby'], 'once');
});

test('off by default unless turned on (per server, or AUTO_JOIN for all)', async () => {
  const g = server([{ id: 'Lobby', people: [person('a'), person('b')] }]);
  const s = setup(g, { autoJoin: false });
  s.aj.checkAll();
  await s.t.run(JOIN_DELAY_MS);
  assert.deepEqual(s.joins, []);
  s.aj.set('g1', true);
  await s.t.run(JOIN_DELAY_MS);
  assert.deepEqual(s.joins, ['Lobby']);
  assert.equal(s.memory.autoJoin('g1'), true);
});

test('/leave keeps it out until everyone has left voice', async () => {
  const [a, b] = [person('a'), person('b')];
  const g = server([{ id: 'Lobby', people: [a, b] }]);
  const s = setup(g);
  s.aj.sessionEnded('g1', 'asked to leave');
  assert.ok(s.memory.autoJoinPausedAt('g1'));
  s.aj.checkAll();
  await s.t.run(JOIN_DELAY_MS * 3);
  assert.deepEqual(s.joins, [], 'they told it to go');
  // Turning it on from the app when it's already on doesn't undo the /leave...
  s.aj.set('g1', true);
  await s.t.run(JOIN_DELAY_MS);
  assert.deepEqual(s.joins, []);
  // ...but everyone leaving voice does.
  g.move(a, null);
  g.move(b, null);
  s.aj.onVoiceStateUpdate({}, { guild: g });
  assert.equal(s.memory.autoJoinPausedAt('g1'), null);
  g.move(a, 'Lobby');
  g.move(b, 'Lobby');
  s.aj.onVoiceStateUpdate({}, { guild: g });
  await s.t.run(JOIN_DELAY_MS);
  assert.deepEqual(s.joins, ['Lobby']);
  // "/autojoin on" typed by someone undoes a /leave right away.
  const s2 = setup(g);
  s2.aj.sessionEnded('g1', 'removed from voice');
  s2.aj.set('g1', true, { undoLeave: true });
  await s2.t.run(JOIN_DELAY_MS);
  assert.deepEqual(s2.joins, ['Lobby']);
});

test('after a join that failed it waits ten minutes; everyone leaving its channel for another makes it follow', async () => {
  const [a, b] = [person('a'), person('b')];
  const g = server([{ id: 'Lobby', people: [a, b] }, { id: 'Raid' }]);
  const bad = setup(g, { joinFails: true });
  bad.aj.checkAll();
  await bad.t.run(JOIN_DELAY_MS);
  assert.deepEqual(bad.joins, ['Lobby']);
  bad.aj.onVoiceStateUpdate({}, { guild: g });
  await bad.t.run(5 * 60000);
  assert.deepEqual(bad.joins, ['Lobby'], 'not again right away');
  bad.aj.onVoiceStateUpdate({}, { guild: g });
  await bad.t.run(JOIN_DELAY_MS);
  bad.aj.onVoiceStateUpdate({}, { guild: g });
  await bad.t.run(6 * 60000);
  bad.aj.onVoiceStateUpdate({}, { guild: g });
  await bad.t.run(JOIN_DELAY_MS);
  assert.deepEqual(bad.joins, ['Lobby', 'Lobby'], 'tries again after ten minutes');

  const s = setup(g);
  s.aj.checkAll();
  await s.t.run(JOIN_DELAY_MS);
  assert.deepEqual(s.joins, ['Lobby']);
  g.move(a, 'Raid');
  g.move(b, 'Raid');
  s.aj.onVoiceStateUpdate({}, { guild: g });
  await s.t.run(JOIN_DELAY_MS);
  assert.deepEqual(s.moves, ['Raid']);
});

test('someone dragged it into a channel: it stays there instead of walking back to the group', async () => {
  const [a, b] = [person('a'), person('b')];
  const g = server([{ id: 'Lobby', people: [a, b] }, { id: 'Parking' }]);
  const s = setup(g);
  s.aj.checkAll();
  await s.t.run(JOIN_DELAY_MS);
  assert.deepEqual(s.joins, ['Lobby']);
  const session = s.sessions.get('g1');
  session.channelId = 'Parking';
  session.placed = true; // (what the session notes when it's dragged)
  s.aj.onVoiceStateUpdate({}, { guild: g });
  await s.t.run(JOIN_DELAY_MS * 2);
  assert.deepEqual(s.moves, []);
});

test('the desktop app sees it per server and turns it on or off for all of them', () => {
  const g = server([{ id: 'Lobby' }]);
  const s = setup(g, { autoJoin: false });
  const proc = new EventEmitter();
  const sent = [];
  proc.send = (m) => sent.push(m);
  const client = { isReady: () => true, user: { tag: 'Gremlin#1' }, guilds: { cache: new Map([['g1', { id: 'g1', name: 'Pressure' }]]) } };
  const link = linkToApp({ proc, client, sessions: new Map(), memory: s.memory, defaultChattiness: 'low', levels: ['off', 'low'], hearing: () => ({}), shutdown: () => {}, autoJoiner: s.aj });
  link.report();
  assert.equal(sent.at(-1).servers[0].autoJoin, false);
  proc.emit('message', { type: 'set-auto-join', on: true });
  assert.equal(s.memory.autoJoin('g1'), true);
  assert.equal(sent.at(-1).servers[0].autoJoin, true);
  proc.emit('message', { type: 'set-auto-join', on: 'yes' });
  assert.equal(s.memory.autoJoin('g1'), true, 'only true or false');
  link.stop();
});
