// The desktop app's logic (desktop/lib): .env editing, settings, running the bot, data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { botTimeZone, dataDir, loadEnv, readTail, usageReport, whisperHealth } from '../desktop/lib/app-data.mjs';
import { BotProcess, parseCheckLine, stopReason } from '../desktop/lib/bot-process.mjs';
import { formatEnvValue, readEnv, setEnvValues } from '../desktop/lib/envfile.mjs';
import { writeFileSafely } from '../desktop/lib/safe-write.mjs';
import { shortcutFileName, syncShortcuts } from '../desktop/lib/shortcuts.mjs';
import { cleanValue, settingsView } from '../desktop/lib/settings.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'winslow-app-'));
const settle = () => new Promise((r) => setImmediate(r));

// ---- .env editing ------------------------------------------------------------

test('env: every kind of value reads back exactly as it was saved', () => {
  const values = ['abc', 'with space', 'has#hash', 'say "hi"', "it's", '  padded  ', '', 'a,b, c', 'sk-ant-api03-Abc_123-xyz', 'C:\\Users\\Daniel'];
  for (const v of values) {
    const text = setEnvValues('', { KEY: v });
    assert.equal(readEnv(text).KEY, v, `${JSON.stringify(v)} -> ${text}`);
  }
});

test('env: values that cannot be written safely are refused', () => {
  assert.throws(() => formatEnvValue('two\nlines'), /one line/);
  assert.throws(() => formatEnvValue(`both ' and "`), /both/);
  assert.throws(() => setEnvValues('', { 'bad-key': 'x' }), /Not a setting name/);
});

test('env: changes one line and leaves comments, order and unknown settings alone', () => {
  const before = ['# Gremlin settings', '', '# How chatty', 'CHATTINESS=low', 'CUSTOM_THING=keep me', '#CHATTINESS=commented', 'BOT_NAME=Winslow', ''].join('\n');
  const after = setEnvValues(before, { CHATTINESS: 'medium', NEW_ONE: 'x' });
  assert.equal(after, ['# Gremlin settings', '', '# How chatty', 'CHATTINESS=medium', 'CUSTOM_THING=keep me', '#CHATTINESS=commented', 'BOT_NAME=Winslow', 'NEW_ONE=x', ''].join('\n'));
});

test('env: keeps Windows line endings and a byte-order mark, and fixes duplicates', () => {
  const before = '\uFEFFA=1\r\nB=2\r\nA=3\r\n';
  const after = setEnvValues(before, { A: '9' });
  assert.equal(after, '\uFEFFA=9\r\nB=2\r\nA=9\r\n');
  assert.equal(setEnvValues('A=1', { B: '2' }), 'A=1\nB=2\n', 'a file without a final newline gets one');
});

// ---- settings ----------------------------------------------------------------

test('settings: keys are never sent to the window, only whether they are set', () => {
  const view = settingsView({ DISCORD_TOKEN: 'secret-token-123', ANTHROPIC_API_KEY: '', CHATTINESS: 'medium' });
  const json = JSON.stringify(view);
  assert.ok(!json.includes('secret-token-123'));
  const keys = view.find((g) => g.id === 'keys').fields;
  assert.equal(keys.find((f) => f.key === 'DISCORD_TOKEN').isSet, true);
  assert.equal(keys.find((f) => f.key === 'ANTHROPIC_API_KEY').isSet, false);
  assert.equal(
    view.flatMap((g) => g.fields).find((f) => f.key === 'CHATTINESS').value,
    'medium',
  );
});

test('settings: a value the app does not list (another Claude model) stays visible', () => {
  const model = settingsView({ CLAUDE_MODEL: 'claude-opus-5-5' })
    .flatMap((g) => g.fields)
    .find((f) => f.key === 'CLAUDE_MODEL');
  assert.ok(model.options.includes('claude-opus-5-5'));
  assert.equal(model.value, 'claude-opus-5-5');
});

test('settings: each change is checked before it is saved', () => {
  assert.equal(cleanValue('CHATTINESS', 'high'), 'high');
  assert.throws(() => cleanValue('CHATTINESS', 'loud'), /pick one of/);
  assert.equal(cleanValue('WEB_SEARCH_MAX_USES', '3'), '3');
  assert.throws(() => cleanValue('WEB_SEARCH_MAX_USES', '9'), /from 1 to 5/);
  assert.throws(() => cleanValue('ENABLE_PRESENCE', 'maybe'), /on or off/);
  assert.equal(cleanValue('DISCORD_TOKEN', '  abc.def  '), 'abc.def');
  assert.throws(() => cleanValue('DISCORD_TOKEN', 'abc def'), /no spaces/);
  assert.throws(() => cleanValue('DISCORD_TOKEN', ''), /paste the new key/);
  assert.throws(() => cleanValue('PATH', 'x'), /doesn't manage/);
});

// ---- running the bot ---------------------------------------------------------

/** A fake child process: output lines, an IPC channel, and an exit you control. */
function fakeChild({ out = [], code = 0, ipc = false, autoClose = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.sent = [];
  child.connected = ipc;
  child.killed = false;
  child.exit = (c = 0) => {
    child.connected = false;
    child.emit('exit', c, null);
    child.emit('close', c);
  };
  child.kill = () => {
    child.killed = true;
    child.exit(1);
  };
  child.send = (m) => {
    child.sent.push(m);
    if (m.type === 'shutdown') setImmediate(() => child.exit(0));
  };
  setImmediate(() => {
    for (const line of out) child.stdout.write(`${line}\n`);
    child.stdout.end();
    child.stderr.end();
    if (autoClose) setImmediate(() => child.emit('close', code));
  });
  return child;
}

function botSetup({ checkOut = ['OK    Node.js version: 22.22.0', 'OK    Discord: logged in as Winslow#2921'], checkCode = 0, libraries = true, holdCheck = false, platform = 'win32' } = {}) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'node_modules', 'discord.js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'discord.js', 'package.json'), '{}');
  // npm's own record of a finished install; without it, the install was cut short
  if (libraries) fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), '{}');
  const calls = [];
  let bot = null;
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === '-v') return fakeChild({ out: ['v22.22.0'] });
    if (args[0] === 'src/check.js') return fakeChild({ out: checkOut, code: checkCode, autoClose: !holdCheck });
    if (cmd.startsWith('npm')) return fakeChild({ out: ['added 120 packages'] });
    if (args[0] === 'src/index.js') {
      bot = fakeChild({ out: ['2026-10-23 08:00:00 INFO  [bot] logged in as Winslow#2921'], ipc: true, autoClose: false });
      return bot;
    }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const proc = new BotProcess({ botDir: dir, spawn, platform, stopWaitMs: 200 });
  const states = [];
  proc.on('state', (s) => states.push(s.state));
  return { proc, calls, states, child: () => bot, dir };
}

test('bot: start checks, launches with a private channel, and is online once it reports in', async () => {
  const { proc, calls, states, child } = botSetup();
  await proc.start();
  assert.deepEqual(states, ['preparing', 'checking', 'starting']);
  assert.equal(proc.check.ok, true);
  assert.deepEqual(proc.check.items[1], { result: 'ok', label: 'Discord', detail: 'logged in as Winslow#2921' });
  const launch = calls.find((c) => c.args[0] === 'src/index.js');
  assert.deepEqual(launch.opts.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
  assert.equal(launch.opts.windowsHide, true);
  child().emit('message', { type: 'status', ready: true, user: 'Winslow#2921', calls: [] });
  assert.equal(proc.state, 'running');
  assert.equal(proc.status.user, 'Winslow#2921');
  await settle();
  assert.ok(proc.lines.some((l) => l.source === 'bot' && /logged in/.test(l.text)));
});

test('bot: stop asks it to leave and save, then it is offline', async () => {
  const { proc, child } = botSetup();
  await proc.start();
  child().emit('message', { type: 'status', ready: true });
  await proc.stop();
  assert.deepEqual(child().sent, [{ type: 'shutdown' }]);
  assert.equal(child().killed, false, 'stopped by itself, not killed');
  assert.equal(proc.state, 'stopped');
  assert.equal(proc.lastExit.expected, true);
});

test('bot: a bot that ignores the stop request is ended after a few seconds', async () => {
  const { proc, child } = botSetup();
  await proc.start();
  child().send = (m) => child().sent.push(m); // never exits by itself
  await proc.stop();
  assert.equal(child().killed, true);
  assert.equal(proc.state, 'stopped');
});

test('bot: a failed start-up check stops there, and "start anyway" skips it', async () => {
  const { proc, calls } = botSetup({ checkOut: ['OK    Node.js version: 22', 'FAIL  Discord: HTTP 401 (token is wrong or was reset)'], checkCode: 1 });
  await proc.start();
  assert.equal(proc.state, 'check-failed');
  assert.deepEqual(proc.check.items[1], { result: 'fail', label: 'Discord', detail: 'HTTP 401 (token is wrong or was reset)' });
  assert.ok(!calls.some((c) => c.args[0] === 'src/index.js'));
  await proc.start({ force: true });
  assert.equal(calls.filter((c) => c.args[0] === 'src/check.js').length, 1, 'no second check');
  assert.equal(proc.state, 'starting');
});

test('bot: if it exits on its own, the app says so', async () => {
  const { proc, child } = botSetup();
  await proc.start();
  child().exit(1);
  assert.equal(proc.state, 'stopped');
  assert.equal(proc.lastExit.expected, false);
  assert.match(proc.lines.at(-1).text, /stopped on his own/);
});

test('bot: pressing Stop during the start-up check cancels the start', async () => {
  const { proc, calls } = botSetup({ holdCheck: true });
  const starting = proc.start();
  await settle();
  await settle();
  assert.equal(proc.state, 'checking');
  await proc.stop();
  await starting;
  assert.equal(proc.state, 'stopped');
  assert.ok(!calls.some((c) => c.args[0] === 'src/index.js'), 'never launched');
});

test('bot: installs the libraries first if they are missing or half-installed (npm needs a shell on Windows)', async () => {
  const { proc, calls } = botSetup({ libraries: false });
  await proc.start();
  const npm = calls.find((c) => c.cmd.startsWith('npm'));
  assert.equal(npm.cmd, 'npm ci --omit=dev --no-audit --no-fund', 'one command line for the shell');
  assert.deepEqual(npm.args, []);
  assert.equal(npm.opts.shell, true);
  assert.equal(proc.state, 'starting');

  const other = botSetup({ libraries: false, platform: 'linux' });
  await other.proc.start();
  const direct = other.calls.find((c) => c.cmd.startsWith('npm'));
  assert.equal(direct.cmd, 'npm');
  assert.deepEqual(direct.args, ['ci', '--omit=dev', '--no-audit', '--no-fund']);
  assert.equal(direct.opts.shell, false);
});

test('bot: stopping a helper on Windows ends everything it started, and waits for that', async () => {
  const calls = [];
  let killer;
  const proc = new BotProcess({
    botDir: tmp(),
    platform: 'win32',
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      killer = new EventEmitter();
      return killer;
    },
  });
  let killed = false;
  proc.helper = { pid: 4242, kill: () => (killed = true) };
  let done = false;
  const stopping = proc.stopHelper().then(() => (done = true));
  assert.deepEqual(calls, [{ cmd: 'taskkill', args: ['/pid', '4242', '/T', '/F'], opts: { windowsHide: true, stdio: 'ignore' } }]);
  await settle();
  assert.equal(done, false, 'not done until taskkill has finished');
  killer.emit('exit', 0);
  await stopping;
  assert.equal(killed, false, 'taskkill did it');

  const again = proc.stopHelper();
  killer.emit('error', new Error('no taskkill'));
  await again;
  assert.equal(killed, true, 'falls back to a plain kill');
  proc.helper = null;
  await proc.stopHelper(); // nothing running is fine
});

// ---- saving files ------------------------------------------------------------

/** fs.promises with renames that fail `failures` times with `code`, and deletes that can fail too. */
function flakyFs(failures, code, { rmFails = 0 } = {}) {
  let renames = 0;
  let rms = 0;
  return {
    renames: () => renames,
    writeFile: (...a) => fs.promises.writeFile(...a),
    rename: async (from, to) => {
      renames += 1;
      if (renames <= failures) throw Object.assign(new Error(code), { code });
      return fs.promises.rename(from, to);
    },
    rm: async (...a) => {
      rms += 1;
      if (rms <= rmFails) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return fs.promises.rm(...a);
    },
  };
}

test('save: a file held for a moment (OneDrive, virus scan) is retried, never half-written', async () => {
  const dir = tmp();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'OLD=1\n');
  const fsp = flakyFs(2, 'EBUSY');
  await writeFileSafely(file, 'NEW=1\n', { fsp, wait: async () => {} });
  assert.equal(fs.readFileSync(file, 'utf8'), 'NEW=1\n');
  assert.equal(fsp.renames(), 3);
  assert.deepEqual(fs.readdirSync(dir), ['.env'], 'no temporary copy left behind');
});

test('save: if the swap keeps failing it writes directly, and the temporary copy (with keys) is removed', async () => {
  const dir = tmp();
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'OLD=1\n');
  await writeFileSafely(file, 'KEY=secret\n', { fsp: flakyFs(99, 'EPERM', { rmFails: 2 }), wait: async () => {} });
  assert.equal(fs.readFileSync(file, 'utf8'), 'KEY=secret\n');
  assert.deepEqual(fs.readdirSync(dir), ['.env']);
});

test('save: a real failure is reported, not hidden', async () => {
  const dir = tmp();
  await assert.rejects(writeFileSafely(path.join(dir, 'missing-folder', 'persona.md'), 'x', { wait: async () => {} }), /ENOENT/);
});

test('settings: a .env that exists but cannot be read is an error, not "no keys"', () => {
  const dir = tmp();
  assert.deepEqual(loadEnv(dir), {}, 'no .env yet');
  fs.mkdirSync(path.join(dir, '.env')); // unreadable as a file (EISDIR)
  assert.throws(() => loadEnv(dir), /Couldn't open \.env/);
});

test('bot: no Node.js on the PC is explained, not a crash', async () => {
  const dir = tmp();
  const proc = new BotProcess({
    botDir: dir,
    spawn: () => {
      throw Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
    },
  });
  await proc.start();
  assert.equal(proc.state, 'stopped');
  assert.match(proc.lines.at(-1).text, /Node\.js isn't installed/);
});

test('bot: a start that fails is counted as a problem, so Home can show why', async () => {
  const proc = new BotProcess({
    botDir: tmp(),
    spawn: () => {
      throw Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
    },
  });
  await proc.start();
  assert.equal(proc.snapshot().problems.count, 1);
  assert.match(proc.snapshot().problems.last.text, /^Couldn't start: Node\.js isn't installed/);
  assert.ok(proc.snapshot().runStartedAt > 0);
});

test('bot: warnings and errors since the last start are counted, and the window hears about each one', async () => {
  const { proc, child } = botSetup();
  await proc.start();
  child().emit('message', { type: 'status', ready: true });
  const counts = [];
  proc.on('status', (s) => counts.push(s.problems.count));
  proc.addLine('2026-10-23 08:00:01 INFO  [bot] logged in', 'bot');
  proc.addLine('2026-10-23 08:00:02 WARN  [whisper] local Whisper stopped answering; restarting it', 'bot');
  proc.addLine('2026-10-23 08:00:03 ERROR [bot] text reply failed: boom', 'bot');
  proc.addLine('a WARN in the middle of a line is not a level', 'bot');
  proc.addLine('2026-10-23 08:00:04 WARN  [x] the setup window has its own lines', 'setup');
  assert.deepEqual(counts, [1, 2], 'one update per warning or error');
  const { problems } = proc.snapshot();
  assert.equal(problems.count, 2);
  assert.match(problems.last.text, /ERROR \[bot\] text reply failed: boom/);
  await proc.stop();
  assert.equal(proc.snapshot().problems.count, 2, 'still there after he stops');
  await proc.start();
  assert.deepEqual(proc.snapshot().problems, { count: 0, last: null }, 'a new start counts again from zero');
  assert.ok(!proc.lines.some((l) => l.text === 'v22.22.0'), 'the bare Node.js version line is not shown');
});

test('bot: the reason he stopped is the last line that names an error, not Node\'s footer or the stack', () => {
  const crash = [
    '2026-10-23 08:00:01 INFO  [bot] logged in as Winslow#2921',
    'file:///C:/Bot/src/session.js:212',
    '    this.brain.say(text);',
    '               ^',
    '',
    "TypeError: Cannot read properties of undefined (reading 'say')",
    '    at VoiceSession.onSpeech (file:///C:/Bot/src/session.js:212:16)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    '',
    'Node.js v22.12.0',
  ];
  assert.equal(stopReason(crash), "TypeError: Cannot read properties of undefined (reading 'say')");
  assert.equal(
    stopReason(['2026-10-23 08:00:01 ERROR [bot] unexpected error: boom. Details are in data/bot.log.', '2026-10-23 08:00:01 INFO  [bot] SIGTERM received, leaving voice']),
    'unexpected error: boom. Details are in data/bot.log.',
  );
  assert.equal(stopReason(['Fatal error: no persona', '    at main (file:///C:/Bot/src/app.js:1:1)']), 'Fatal error: no persona');
  assert.equal(stopReason(["Winslow can't start yet. Fix these in Settings:", '  - DISCORD_TOKEN is empty.', '']), 'DISCORD_TOKEN is empty.', 'no error word: the last line that says something');
  assert.equal(stopReason(['', '   ']), '');
});

test('bot: start-up check lines are understood', () => {
  assert.deepEqual(parseCheckLine('SKIP  Speech-to-text backup: no DEEPGRAM_API_KEY, so...'), { result: 'skip', label: 'Speech-to-text backup', detail: 'no DEEPGRAM_API_KEY, so...' });
  assert.equal(parseCheckLine('Pre-flight check'), null);
});

// ---- the bot's data ----------------------------------------------------------

test('data: the end of a big log starts at a whole line', () => {
  const dir = tmp();
  const file = path.join(dir, 'bot.log');
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(50)}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const tail = readTail(file, 10_000);
  assert.ok(tail.startsWith('line '));
  assert.ok(tail.trimEnd().endsWith(`line 4999 ${'x'.repeat(50)}`));
  assert.equal(readTail(path.join(dir, 'missing.log')), '');
});

test('data: usage totals for today and this month, in the bot time zone', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'BOT_TIMEZONE=America/Los_Angeles\nDATA_DIR=mydata\n');
  assert.equal(dataDir(dir), path.join(dir, 'mydata'));
  fs.mkdirSync(path.join(dir, 'mydata'));
  const bucket = { ttsChars: 6053, ttsDollars: 0.24, sttSeconds: 689, sttDollars: 0, claudeRequests: 100, claudeSearches: 3, claudeDollars: 0.28 };
  fs.writeFileSync(path.join(dir, 'mydata', 'usage.json'), JSON.stringify({ days: { '2026-10-22': bucket }, months: { '2026-10': bucket } }));
  // 3 a.m. UTC on Oct 23 is still Oct 22 in California.
  const r = await usageReport(dir, { now: Date.parse('2026-10-23T03:00:00Z') });
  assert.equal(r.today.total, '$0.52');
  assert.equal(r.month.total, '$0.52');
  assert.equal(r.monthName, 'October');
  assert.match(r.today.lines[0], /6,053 characters spoken/);
});

test('data: an invalid time zone falls back to UTC instead of breaking the totals', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'BOT_TIMEZONE=Pacific Time\n');
  assert.equal(botTimeZone(loadEnv(dir)), 'UTC');
  assert.equal(botTimeZone({}), 'America/Los_Angeles', 'the default when it is not set');
  fs.mkdirSync(path.join(dir, 'data'));
  const bucket = { ttsChars: 10, ttsDollars: 0.5, sttDollars: 0, claudeDollars: 0 };
  fs.writeFileSync(path.join(dir, 'data', 'usage.json'), JSON.stringify({ days: { '2026-10-23': bucket }, months: { '2026-10': bucket } }));
  const r = await usageReport(dir, { now: Date.parse('2026-10-23T03:00:00Z') });
  assert.equal(r.today.total, '$0.50', 'Oct 23 in UTC');
});

test('data: usage that cannot be read is an error, not $0.00 (no file yet is $0.00)', async () => {
  const dir = tmp();
  const r = await usageReport(dir);
  assert.equal(r.today.total, '$0.00', 'nothing spent yet');
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'usage.json'), '{"days": {');
  await assert.rejects(usageReport(dir), /usage\.json is damaged/);
  fs.rmSync(path.join(dir, 'data', 'usage.json'));
  fs.mkdirSync(path.join(dir, 'data', 'usage.json')); // unreadable (EISDIR), like a file OneDrive holds
  await assert.rejects(usageReport(dir), /Couldn't open usage\.json \(EISDIR\)/);
});

test('data: checking on Whisper is only a peek, so it can still close when the bot is off', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.env'), 'WHISPER_PORT=8199\n');
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    return { ok: true, json: async () => ({ ok: true, model: 'large-v3-turbo' }) };
  };
  assert.deepEqual(await whisperHealth(dir, { fetchImpl }), { ok: true, model: 'large-v3-turbo' });
  assert.deepEqual(asked, ['http://127.0.0.1:8199/health?peek=1']);
});

test('settings: the time zone has to be a real one', () => {
  assert.equal(cleanValue('BOT_TIMEZONE', ' Europe/London '), 'Europe/London');
  assert.equal(cleanValue('BOT_TIMEZONE', ''), '', 'empty means the default');
  assert.throws(() => cleanValue('BOT_TIMEZONE', 'Pacific Time'), /Time zone: "Pacific Time" isn't a time zone name\. Use one like America\/Los_Angeles/);
});

test('bot: when he stops on his own, the app keeps his last words as the reason', async () => {
  const { proc, child } = botSetup();
  await proc.start();
  child().stderr = new PassThrough();
  child().emit('message', { type: 'status', ready: true });
  proc.addLine('2026-10-23 08:00:01 INFO  [bot] something ordinary', 'bot');
  proc.addLine('Discord rejected DISCORD_TOKEN. Reset it in the Developer Portal (Bot tab) and paste the new one into .env.', 'bot');
  child().exit(1);
  assert.equal(proc.lastExit.reason, 'Discord rejected DISCORD_TOKEN. Reset it in the Developer Portal (Bot tab) and paste the new one into .env.');
});

// ---- shortcuts named after the bot -------------------------------------------

/** Shortcut files and the app's record of them, in memory. */
function fakeShortcuts(files = {}) {
  const links = new Map(Object.entries(files));
  const disk = new Map();
  const shell = {
    readShortcutLink(file) {
      if (!links.has(file)) throw new Error('not found');
      return links.get(file);
    },
    writeShortcutLink(file, op, options) {
      assert.equal(op, 'create');
      links.set(file, { ...options });
      return true;
    },
  };
  const fsImpl = {
    readFileSync(file) {
      if (!disk.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return disk.get(file);
    },
    writeFileSync(file, text) {
      disk.set(file, text);
    },
    rmSync(file) {
      links.delete(file);
    },
  };
  return { links, disk, shell, fsImpl };
}

const APP_DIR = 'C:\\Bot\\desktop';
const shortcutArgs = (name, extra = {}) => ({
  name,
  appDir: APP_DIR,
  places: ['/Desktop', '/StartMenu'],
  recordFile: '/userData/shortcuts.json',
  options: { target: '/app/Winslow.exe', args: `"${APP_DIR}"`, description: `Start, stop and set up ${name}` },
  ...extra,
});

test('shortcuts: named after the bot, without characters Windows refuses', () => {
  assert.equal(shortcutFileName('Babel'), 'Babel.lnk');
  assert.equal(shortcutFileName('Mr: Babel?'), 'Mr Babel.lnk');
  assert.equal(shortcutFileName(' ..'), 'Voice bot.lnk');
});

test('shortcuts: after a rename, the app renames its own shortcuts and remembers the new name', () => {
  const ours = { args: `"${APP_DIR}"` };
  const t = fakeShortcuts({ [path.join('/Desktop', 'Winslow.lnk')]: ours, [path.join('/StartMenu', 'Winslow.lnk')]: ours });
  assert.equal(syncShortcuts({ ...shortcutArgs('Babel'), shell: t.shell, fsImpl: t.fsImpl }), 2);
  assert.deepEqual([...t.links.keys()].sort(), [path.join('/Desktop', 'Babel.lnk'), path.join('/StartMenu', 'Babel.lnk')].sort());
  assert.equal(JSON.parse(t.disk.get('/userData/shortcuts.json')).name, 'Babel');
  // Started again: nothing left to do.
  assert.equal(syncShortcuts({ ...shortcutArgs('Babel'), shell: t.shell, fsImpl: t.fsImpl }), 0);
});

test('shortcuts: one someone deleted is not brought back, and other programs\' shortcuts are never touched', () => {
  const t = fakeShortcuts({
    [path.join('/Desktop', 'Winslow.lnk')]: { args: '"C:\\Games\\Winslow"' }, // not this app
    [path.join('/StartMenu', 'Winslow.lnk')]: { args: `"${APP_DIR}"` },
  });
  syncShortcuts({ ...shortcutArgs('Babel'), shell: t.shell, fsImpl: t.fsImpl });
  assert.ok(t.links.has(path.join('/Desktop', 'Winslow.lnk')), 'left alone');
  assert.ok(!t.links.has(path.join('/Desktop', 'Babel.lnk')), 'none made where there was none of ours');
  assert.ok(t.links.has(path.join('/StartMenu', 'Babel.lnk')));
  assert.ok(!t.links.has(path.join('/StartMenu', 'Winslow.lnk')));
});

test('shortcuts: install-app.bat makes them in both places', () => {
  const t = fakeShortcuts();
  assert.equal(syncShortcuts({ ...shortcutArgs('Babel', { make: true }), shell: t.shell, fsImpl: t.fsImpl }), 2);
  assert.equal(t.links.get(path.join('/Desktop', 'Babel.lnk')).description, 'Start, stop and set up Babel');
});
