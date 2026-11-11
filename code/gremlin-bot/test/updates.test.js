// Loading updates by itself: when the bot's code, settings or personality change while
// it runs, the app restarts it to load them once nobody is in a call with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIN_GAP_MS, RECOVER_GAP_MS, RECOVER_TRIES, SETTLE_MS, UpdateWatcher, appSnapshot, snapshot } from '../desktop/lib/updates.mjs';
import { FIELDS } from '../desktop/lib/settings.mjs';
import { autoUpdateOn } from '../desktop/lib/app-data.mjs';

test('what counts as an update: code in src/, settings, personality, the Whisper server; not libraries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-updates-'));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('src/brain.js', 'a');
  write('src/common-words.txt', 'b');
  write('.env', 'X=1');
  write('persona.md', 'p');
  write('whisper/server.py', 's');
  write('src/node_modules/x/index.js', 'lib');
  write('desktop/main.mjs', 'app');
  const key = (snap) => JSON.stringify([...snap].sort());
  const before = snapshot(dir);
  assert.deepEqual([...before.keys()].sort(), ['.env', 'persona.md', 'src/brain.js', 'src/common-words.txt', 'whisper/server.py']);
  write('src/node_modules/x/index.js', 'lib2');
  assert.equal(key(snapshot(dir)), key(before), 'libraries are not watched');
  write('src/brain.js', 'changed');
  assert.notEqual(key(snapshot(dir)), key(before));
  write('src/new-file.js', 'n');
  assert.ok(snapshot(dir).has('src/new-file.js'));
  assert.deepEqual([...appSnapshot(dir).keys()], ['desktop/main.mjs']);
  assert.equal(autoUpdateOn({}), true, 'on unless turned off');
  assert.equal(autoUpdateOn({ AUTO_UPDATE: 'false' }), false);
});

function setup({ enabled = true } = {}) {
  let now = 1_000_000;
  let files = new Map([
    ['src/brain.js', '1'],
    ['.env', '1'],
  ]);
  let appFiles = new Map([['desktop/main.mjs', '1']]);
  const restarts = [];
  const events = [];
  const bot = {
    state: 'running',
    status: { calls: [] },
    restart() {
      restarts.push(now);
    },
    addLine() {},
  };
  const w = new UpdateWatcher({
    botDir: '/x',
    bot,
    enabled: () => enabled,
    clock: () => now,
    setTimer: () => null,
    clearTimer: () => {},
    snapshotImpl: () => new Map(files),
    appSnapshotImpl: () => new Map(appFiles),
  });
  for (const e of ['waiting', 'idle', 'restarting', 'app-updated', 'restart-failed', 'gave-up']) w.on(e, (d) => events.push(d && Object.keys(d).length ? [e, d] : e));
  w.start();
  w.botStarting();
  return {
    w,
    bot,
    restarts,
    events,
    change: (rel) => {
      files = new Map(files);
      files.set(rel, String(Number(files.get(rel) ?? 0) + 1));
    },
    changeApp: () => {
      appFiles = new Map([['desktop/main.mjs', '2']]);
    },
    advance: (ms) => (now += ms),
  };
}

test('an update that has held still is loaded with a restart, once nobody is in a call', () => {
  const s = setup();
  s.w.tick();
  assert.deepEqual(s.restarts, []);
  s.change('src/brain.js');
  s.w.tick(); // just changed: wait for the rest of the files
  s.advance(SETTLE_MS - 1000);
  s.w.tick();
  assert.deepEqual(s.restarts, []);
  // Someone's in a call: it waits, and the window says so.
  s.bot.status = { calls: [{ server: 'Pressure' }] };
  s.advance(2000);
  s.w.tick();
  assert.deepEqual(s.restarts, []);
  assert.deepEqual(s.events, [['waiting', { automatic: true, inCall: true }]]);
  s.bot.status = { calls: [] };
  s.w.tick();
  assert.equal(s.restarts.length, 1);
  assert.deepEqual(s.events.slice(1), ['idle', 'restarting']);
  // As it starts again, what's there is what it loaded.
  s.bot.state = 'starting';
  s.w.botStarting();
  s.bot.state = 'running';
  s.advance(SETTLE_MS * 2);
  s.w.tick();
  assert.equal(s.restarts.length, 1);
});

test('turned off: it only says an update is waiting; a second update soon after waits a couple of minutes', () => {
  const off = setup({ enabled: false });
  off.change('src/brain.js');
  off.w.tick();
  off.advance(SETTLE_MS);
  off.w.tick();
  assert.deepEqual(off.restarts, []);
  assert.deepEqual(off.events, [['waiting', { automatic: false, inCall: false }]]);

  const s = setup();
  s.change('src/brain.js');
  s.w.tick();
  s.advance(SETTLE_MS);
  s.w.tick();
  assert.equal(s.restarts.length, 1);
  s.w.botStarting();
  s.change('src/brain.js');
  s.w.tick();
  s.advance(SETTLE_MS);
  s.w.tick();
  assert.equal(s.restarts.length, 1, 'not two restarts in a row');
  s.advance(MIN_GAP_MS);
  s.w.tick();
  assert.equal(s.restarts.length, 2);
});

test('a setting it took on the spot (chattiness, auto-join) is not an update; anything else changed still is', () => {
  const s = setup();
  s.change('.env');
  s.w.accept(['.env']);
  s.w.tick();
  s.advance(SETTLE_MS);
  s.w.tick();
  assert.deepEqual(s.restarts, []);
  s.change('src/brain.js');
  s.change('.env');
  s.w.accept(['.env']);
  s.w.tick();
  s.advance(SETTLE_MS);
  s.w.tick();
  assert.equal(s.restarts.length, 1, 'the code change still loads');
});

test("the app's own files changing: only a note to reopen the app", () => {
  const s = setup();
  s.changeApp();
  s.w.tick();
  s.w.tick();
  assert.deepEqual(s.events, ['app-updated']);
  assert.deepEqual(s.restarts, []);
  // Stopped: nothing to restart.
  s.bot.state = 'stopped';
  s.change('src/brain.js');
  s.advance(SETTLE_MS * 2);
  s.w.tick();
  s.w.tick();
  assert.deepEqual(s.restarts, []);
});

test('he did not come back up after restarting for an update: it says so and tries again a minute later, a few times', () => {
  const s = setup();
  const starts = [];
  s.bot.lastForce = true; // he was started with "Start anyway"
  s.bot.restart = () => {
    s.restarts.push(1);
    s.bot.state = 'check-failed'; // the start-up check failed this time
  };
  s.bot.start = ({ force }) => {
    starts.push(force);
    s.bot.state = starts.length < 2 ? 'check-failed' : 'running';
  };
  s.change('src/brain.js');
  s.w.tick();
  s.advance(SETTLE_MS);
  s.w.tick();
  assert.equal(s.restarts.length, 1);
  s.w.tick();
  assert.ok(s.events.some((e) => Array.isArray(e) && e[0] === 'restart-failed'));
  s.advance(RECOVER_GAP_MS - 1000);
  s.w.tick();
  assert.deepEqual(starts, [], 'a minute first');
  s.advance(2000);
  s.w.tick();
  assert.deepEqual(starts, [true], 'started the same way as before');
  s.w.tick();
  s.advance(RECOVER_GAP_MS + 1000);
  s.w.tick();
  assert.deepEqual(starts, [true, true]);
  assert.equal(s.bot.state, 'running');
  s.w.tick();
  assert.equal(s.w.recovery, null, 'up again');
  assert.ok(RECOVER_TRIES >= 2);
});

test('after Stop, it never starts him again by itself', () => {
  const s = setup();
  const starts = [];
  s.bot.restart = () => {
    s.restarts.push(1);
    s.bot.state = 'check-failed';
  };
  s.bot.start = () => starts.push(1);
  s.change('src/brain.js');
  s.w.tick();
  s.advance(SETTLE_MS);
  s.w.tick();
  s.w.tick();
  s.w.takenOver(); // he pressed Stop (or Start) himself
  s.bot.state = 'stopped';
  s.bot.lastExit = { expected: true };
  s.advance(RECOVER_GAP_MS * 5);
  s.w.tick();
  s.w.tick();
  assert.deepEqual(starts, []);
});

test('a .env change that is still waiting stays waiting; the auto-update switch itself applies at once', () => {
  const s = setup();
  assert.equal(s.w.matches('.env'), true);
  s.change('.env');
  assert.equal(s.w.matches('.env'), false, 'so the app does not accept it as applied');
  assert.equal(FIELDS.get('AUTO_UPDATE').live, true);
  assert.equal(FIELDS.get('AUTO_JOIN').live, true);
});
