// memory.json and usage.json: only a missing file starts fresh. A damaged one is
// moved aside, one that can't be read is never saved over, and nothing is written
// when nothing changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_FACTS, Memory, readJsonFile } from '../src/memory.js';
import { Usage } from '../src/usage.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-data-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the loggers print with console.error/console.warn while fn runs. */
async function logged(fn) {
  const lines = [];
  const { error, warn } = console;
  console.error = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.error = error;
    console.warn = warn;
  }
}

const asideFiles = (dir, base) => fs.readdirSync(dir).filter((f) => new RegExp(`^${base}\\.corrupt-.+\\.json$`).test(f));

test('memory: no file yet starts empty, and nothing is written until something changes', () => {
  const dir = tmp();
  try {
    const memory = new Memory(dir);
    assert.equal(memory.chattiness('g1'), null);
    memory.flush(); // what shutting down does
    assert.equal(fs.existsSync(path.join(dir, 'memory.json')), false, 'nothing changed, nothing saved');
    memory.setChattiness('g1', 'high');
    memory.flush();
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8')).guilds.g1.chattiness, 'high');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory: shutting down without changes leaves the file exactly as it was', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'memory.json');
    const text = '{"guilds":{"g1":{"facts":[{"text":"Weevil hates ranked","by":"u1","at":"2026-10-01T00:00:00.000Z"}],"optouts":["u9"],"chattiness":"low"}}}';
    fs.writeFileSync(file, text);
    const memory = new Memory(dir);
    assert.equal(memory.isOptedOut('g1', 'u9'), true);
    assert.equal(memory.facts('g1')[0].text, 'Weevil hates ranked');
    memory.flush();
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory: a damaged file is moved aside (not lost) with an error, and memory starts empty', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'memory.json'), '{"guilds": {"g1": {"facts": [');
    const { value: memory, lines } = await logged(() => new Memory(dir));
    const aside = asideFiles(dir, 'memory');
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"guilds": {"g1": {"facts": [', 'kept as it was');
    assert.equal(fs.existsSync(path.join(dir, 'memory.json')), false);
    assert.deepEqual(memory.facts('g1'), []);
    assert.ok(lines.some((l) => /ERROR \[memory\].*damaged.*moved to memory\.corrupt-/.test(l)), lines.join('\n'));
    // A file that is valid JSON but not a memory file counts as damaged too.
    fs.writeFileSync(path.join(dir, 'memory.json'), '[1, 2, 3]');
    await logged(() => new Memory(dir));
    assert.equal(asideFiles(dir, 'memory').length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory: a file it cannot read is never saved over; once it reads, this run is kept on top', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'memory.json');
    fs.mkdirSync(file); // in the way and unreadable, like a file a sync app is holding
    const { value: memory, lines } = await logged(() => new Memory(dir, { retryReadMs: 100 }));
    assert.ok(memory.unreadable);
    assert.ok(lines.some((l) => /ERROR \[memory\] could not read .*opt-outs.*nothing is saved over the file/.test(l)), lines.join('\n'));
    memory.setOptOut('g1', 'u1', true);
    memory.setOptOut('g1', 'u2', false); // opted back in while it couldn't be read
    memory.remember('g1', 'Mike always plays support', 'u1');
    memory.flush();
    assert.equal(fs.statSync(file).isDirectory(), true, 'not saved over');

    // The file comes back (the sync app lets go of it).
    fs.rmSync(file, { recursive: true });
    const saved = { guilds: { g1: { facts: [{ text: 'Weevil hates ranked', by: 'u3', at: '2026-10-01T00:00:00.000Z' }], optouts: ['u2', 'u9'], chattiness: 'medium' } } };
    fs.writeFileSync(file, JSON.stringify(saved));
    await logged(() => wait(600)); // the retry reads it, then the change is saved
    assert.equal(memory.unreadable, null);
    const now = JSON.parse(fs.readFileSync(file, 'utf8')).guilds.g1;
    assert.deepEqual(now.facts.map((f) => f.text), ['Weevil hates ranked', 'Mike always plays support']);
    assert.deepEqual(now.optouts.sort(), ['u1', 'u9'], 'the saved opt-out is honored, and so are this run\'s changes');
    assert.equal(now.chattiness, 'medium');
    assert.equal(memory.isOptedOut('g1', 'u9'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory: when the list is full, remember says which old fact made room', () => {
  const dir = tmp();
  try {
    const memory = new Memory(dir);
    for (let i = 1; i <= MAX_FACTS; i++) assert.deepEqual(memory.remember('g1', `Fact ${i}`, 'u1').dropped, []);
    const r = memory.remember('g1', 'One more', 'u1');
    assert.equal(r.text, 'One more');
    assert.deepEqual(r.dropped.map((f) => f.text), ['Fact 1']);
    assert.equal(memory.facts('g1').length, MAX_FACTS);
    assert.equal(memory.addFact('g1', '   ', 'u1'), null, 'addFact still returns the saved text (or null)');
    assert.equal(memory.addFact('g1', ' Tidy   spaces ', 'u1'), 'Tidy spaces');
    clearTimeout(memory.saveTimer);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reading a JSON file: a byte-order mark (Notepad) is fine', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'x.json');
    fs.writeFileSync(file, '﻿{"guilds":{}}');
    assert.deepEqual(readJsonFile(file), { status: 'ok', data: { guilds: {} } });
    assert.deepEqual(readJsonFile(path.join(dir, 'missing.json')), { status: 'missing' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usage: a damaged file is moved aside with an error, and the counts start from zero', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'usage.json'), '{"days": {"2026-10-22": {"ttsChars": 1');
    const { value: u, lines } = await logged(() => new Usage({ dataDir: dir, timezone: 'UTC' }));
    assert.deepEqual(u.data.days, {});
    assert.equal(asideFiles(dir, 'usage').length, 1);
    assert.ok(lines.some((l) => /ERROR \[usage\].*damaged.*usage\.corrupt-/.test(l)), lines.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usage: a file it cannot read is never saved over; this run is added once it reads', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'usage.json');
    fs.mkdirSync(file);
    const now = Date.parse('2026-10-22T12:00:00Z');
    const { value: u } = await logged(() => new Usage({ dataDir: dir, timezone: 'UTC', clock: () => now }));
    assert.ok(u.unreadable);
    u.record({ type: 'tts', chars: 50, model: 'eleven_flash_v2_5' });
    u.flush();
    assert.equal(fs.statSync(file).isDirectory(), true, 'not saved over');
    fs.rmSync(file, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, days: { '2026-10-22': { ttsChars: 100, ttsRequests: 2 } }, months: { '2026-10': { ttsChars: 900 } } }));
    await logged(() => u.flush());
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.days['2026-10-22'].ttsChars, 150);
    assert.equal(saved.days['2026-10-22'].ttsRequests, 3);
    assert.equal(saved.months['2026-10'].ttsChars, 950);
    assert.equal(u.today().ttsChars, 150);
    clearTimeout(u.saveTimer);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usage: shutting down without new counts leaves the file exactly as it was', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'usage.json');
    const text = '{"version":1,"days":{"2026-10-22":{"ttsChars":7}},"months":{"2026-10":{"ttsChars":7}}}';
    fs.writeFileSync(file, text);
    const u = new Usage({ dataDir: dir, timezone: 'UTC' });
    u.flush();
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
