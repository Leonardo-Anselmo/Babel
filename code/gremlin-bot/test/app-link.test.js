// The bot's side of the desktop app: status reports, commands, clean stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { linkToApp } from '../src/app-link.js';

function setup() {
  const sent = [];
  const proc = Object.assign(new EventEmitter(), { send: (m) => sent.push(m) });
  const guilds = new Map([
    ['g1', { id: 'g1', name: 'The Pressure Chamber' }],
    ['g2', { id: 'g2', name: 'Other Server' }],
  ]);
  const client = { isReady: () => true, user: { tag: 'Winslow#2921' }, guilds: { cache: guilds } };
  const brainLevels = [];
  const session = {
    guild: guilds.get('g1'),
    voiceChannel: { name: 'Gaming' },
    joinedAt: 1234,
    humans: () => [{ displayName: 'Daniel' }, { displayName: 'Weevil' }],
    brain: { setChattiness: (l) => brainLevels.push(l) },
  };
  const sessions = new Map([['g1', session]]);
  const saved = {};
  const memory = { chattiness: (id) => saved[id] || null, setChattiness: (id, l) => (saved[id] = l) };
  const stops = [];
  const link = linkToApp({
    proc,
    client,
    sessions,
    memory,
    defaultChattiness: 'low',
    levels: ['off', 'low', 'medium', 'high'],
    hearing: () => ({ provider: 'whisper', detail: 'Whisper large-v3-turbo on your graphics card' }),
    shutdown: (why) => stops.push(why),
  });
  return { link, proc, sent, saved, brainLevels, stops };
}

test('app link: nothing happens when the bot was not started by the app', () => {
  assert.equal(linkToApp({ proc: new EventEmitter(), client: {}, sessions: new Map(), memory: {}, levels: [], hearing: () => ({}), shutdown() {} }), null);
});

test('app link: reports who it is, its servers, calls and hearing', () => {
  const { link, sent } = setup();
  link.report();
  const s = sent.at(-1);
  assert.equal(s.type, 'status');
  assert.equal(s.ready, true);
  assert.equal(s.user, 'Winslow#2921');
  assert.deepEqual(s.servers, [
    { name: 'The Pressure Chamber', chattiness: 'low' },
    { name: 'Other Server', chattiness: 'low' },
  ]);
  assert.deepEqual(s.calls, [{ server: 'The Pressure Chamber', channel: 'Gaming', people: ['Daniel', 'Weevil'], since: 1234 }]);
  assert.equal(s.hearing.provider, 'whisper');
  link.stop();
});

test('app link: chattiness from the app applies to every server and the call right away', () => {
  const { link, proc, sent, saved, brainLevels } = setup();
  proc.emit('message', { type: 'set-chattiness', level: 'medium' });
  assert.deepEqual(saved, { g1: 'medium', g2: 'medium' });
  assert.deepEqual(brainLevels, ['medium']);
  assert.equal(sent.at(-1).servers[0].chattiness, 'medium', 'reports the change straight back');
  proc.emit('message', { type: 'set-chattiness', level: 'loud' });
  assert.deepEqual(saved, { g1: 'medium', g2: 'medium' }, 'ignores levels that do not exist');
  link.stop();
});

test('app link: stops cleanly when asked, or when the app goes away', () => {
  const { link, proc, stops } = setup();
  proc.emit('message', { type: 'shutdown' });
  proc.emit('disconnect');
  assert.deepEqual(stops, ['stop request from the app', 'the app closed']);
  link.stop();
});

test('app link: chattiness that comes in while it is still connecting is not lost', () => {
  const sent = [];
  const proc = Object.assign(new EventEmitter(), { send: (m) => sent.push(m) });
  const guilds = new Map();
  let ready = false;
  const client = { isReady: () => ready, user: null, guilds: { cache: guilds } };
  const saved = { g1: 'low', g9: 'high' }; // what memory.json has, from earlier runs
  let flushes = 0;
  const memory = {
    chattiness: (id) => saved[id] || null,
    setChattiness: (id, l) => (saved[id] = l),
    guildIds: () => Object.keys(saved),
    flush: () => flushes++,
  };
  const link = linkToApp({ proc, client, sessions: new Map(), memory, defaultChattiness: 'low', levels: ['off', 'low', 'medium', 'high'], hearing: () => ({}), shutdown() {} });
  proc.emit('message', { type: 'set-chattiness', level: 'medium' });
  assert.deepEqual(saved, { g1: 'medium', g9: 'medium' }, 'the servers it remembers get it right away');
  assert.equal(flushes, 1, 'and it is saved at once, in case it is stopped before it logs in');
  // Logged in: a server it had no saved settings for gets it too.
  guilds.set('g1', { id: 'g1', name: 'The Pressure Chamber' });
  guilds.set('g2', { id: 'g2', name: 'New Server' });
  ready = true;
  link.ready();
  assert.deepEqual(saved, { g1: 'medium', g9: 'medium', g2: 'medium' });
  assert.deepEqual(sent.at(-1).servers, [
    { name: 'The Pressure Chamber', chattiness: 'medium' },
    { name: 'New Server', chattiness: 'medium' },
  ]);
  link.ready(); // nothing waiting any more
  assert.equal(flushes, 2);
  link.stop();
});
