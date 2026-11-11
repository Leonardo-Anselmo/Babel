// The log file (data/bot.log): a fuller record than the console window shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger, setLogFile, setLogLevel } from '../src/log.js';

test('log lines also go to the log file, debug included, while the window only shows info and up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlog-'));
  const file = path.join(dir, 'data', 'bot.log');
  setLogLevel('error'); // keeps this test's console quiet; the file still gets everything
  setLogFile(file);
  const log = logger('call');
  log.debug('heard Mike (1.2 s): talking to me, answering');
  log.info('second line', { n: 1 });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /DEBUG \[call\] heard Mike \(1\.2 s\): talking to me, answering\n/);
  assert.match(text, /INFO  \[call\] second line \{ n: 1 \}\n/);
});

test('a big log file is set aside as bot.old.log and a fresh one started', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlog-'));
  const file = path.join(dir, 'bot.log');
  fs.writeFileSync(file, 'x'.repeat(5_000_001));
  setLogLevel('error');
  setLogFile(file);
  logger('bot').info('fresh start');
  assert.equal(fs.statSync(path.join(dir, 'bot.old.log')).size, 5_000_001);
  assert.match(fs.readFileSync(file, 'utf8'), /^\S+ \S+ INFO  \[bot\] fresh start\n$/);
});
