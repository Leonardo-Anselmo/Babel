// Reading the bot's files and services for the app: the data folder, logs, usage
// totals, account credit and the local Whisper server. Nothing here writes to the
// files the bot itself keeps (usage.json, memory.json) while it's running.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { readEnv } from './envfile.mjs';
import { isTimeZone } from './settings.mjs';

/**
 * The bot's .env as { KEY: value }, or {} if there isn't one yet. If it exists but
 * can't be read (OneDrive not synced, the file in use) that's an error: showing
 * every key as "not set" would invite overwriting them.
 */
export function loadEnv(botDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(botDir, '.env'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Couldn't open .env (${err.code || err.message}). If it's in OneDrive, check that it's synced, then try again.`);
  }
  return readEnv(text);
}

export function dataDir(botDir, env = loadEnv(botDir)) {
  return path.resolve(botDir, (env.DATA_DIR || '').trim() || 'data');
}

/** The bot's time zone from its settings, or UTC if that isn't a real time zone (like the bot does). */
export function botTimeZone(env) {
  const zone = (env.BOT_TIMEZONE || '').trim() || 'America/Los_Angeles';
  return isTimeZone(zone) ? zone : 'UTC';
}

/** The end of a text file (the last maxBytes), from a whole line on. '' if it doesn't exist. */
export function readTail(file, maxBytes = 400_000) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8').replace(/^﻿/, '');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Today's and this month's totals from data/usage.json, in the bot's time zone. No
 * file yet means nothing spent yet; one that can't be read is an error, not $0.00.
 */
export async function usageReport(botDir, { now = Date.now() } = {}) {
  const usage = await import('../../src/usage.js');
  const env = loadEnv(botDir);
  const timezone = botTimeZone(env);
  let data = { days: {}, months: {} };
  let text = null;
  try {
    text = fs.readFileSync(path.join(dataDir(botDir, env), 'usage.json'), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Couldn't open usage.json (${err.code || err.message}). If it's in OneDrive, check that it's synced.`);
  }
  if (text !== null) {
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      throw new Error("usage.json is damaged, so the totals can't be shown. The bot sets it aside and counts from zero the next time it starts.");
    }
  }
  const day = usage.dayKey(now, timezone);
  const today = { ...usage.emptyBucket(), ...data?.days?.[day] };
  const month = { ...usage.emptyBucket(), ...data?.months?.[day.slice(0, 7)] };
  const view = (b) => ({ total: usage.money(usage.totalDollars(b)), lines: usage.describeBucket(b), bucket: b });
  return { today: view(today), month: view(month), monthName: new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: timezone }).format(now) };
}

/** Real credit left with ElevenLabs and Deepgram (keys stay in this process). */
export async function credits(botDir, { fetchImpl = globalThis.fetch } = {}) {
  const usage = await import('../../src/usage.js');
  const env = loadEnv(botDir);
  const timezone = botTimeZone(env);
  const config = {
    tts: { elevenKey: (env.ELEVENLABS_API_KEY || '').trim() },
    stt: { provider: (env.STT_PROVIDER || 'deepgram').trim().toLowerCase(), deepgramKey: (env.DEEPGRAM_API_KEY || '').trim() },
  };
  const [eleven, deepgram] = await Promise.all([
    usage.elevenLabsQuota(config, { fetchImpl }),
    usage.deepgramBalance(config, { fetchImpl }),
  ]);
  return {
    eleven: eleven && {
      used: eleven.used,
      limit: eleven.limit,
      left: Math.max(0, eleven.limit - eleven.used),
      tier: eleven.tier,
      resets: eleven.resetsAt ? usage.shortDate(eleven.resetsAt, timezone) : null,
    },
    deepgram: deepgram && { dollars: usage.money(deepgram.dollars) },
  };
}

function whisperBase(env) {
  const port = Number((env.WHISPER_PORT || '').trim()) || 8178;
  return `http://127.0.0.1:${port}`;
}

/**
 * The local Whisper server's status, or null if it isn't running. Only a peek: it
 * doesn't count as use, so the window checking every few seconds doesn't keep
 * Whisper (and its graphics memory) from closing by itself when the bot is off.
 */
export async function whisperHealth(botDir, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`${whisperBase(loadEnv(botDir))}/health?peek=1`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.ok ? json : null;
  } catch {
    return null;
  }
}

/** Asks the local Whisper server to quit now (it frees the graphics memory). */
export async function stopWhisper(botDir, { fetchImpl = globalThis.fetch } = {}) {
  try {
    await fetchImpl(`${whisperBase(loadEnv(botDir))}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The bot's notes on its recent calls (CALL_MEMORY), newest first, from data/memory.json:
 * [{ guildId, id, at, minutes, server, channel, people, summary }]. Reading is safe
 * while the bot runs; changes go through the bot then (see forgetCallsInFile).
 */
export function readCalls(botDir) {
  const file = path.join(dataDir(botDir), 'memory.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Couldn't open data/memory.json (${err.code || err.message}).`);
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error("data/memory.json couldn't be read (it may be damaged).");
  }
  const out = [];
  for (const [guildId, g] of Object.entries(data?.guilds || {})) {
    for (const c of Array.isArray(g?.calls) ? g.calls : []) {
      if (!c || typeof c.id !== 'string') continue;
      out.push({
        guildId,
        id: c.id,
        at: String(c.at || ''),
        minutes: Number(c.minutes) || 0,
        server: String(c.server || ''),
        channel: String(c.channel || ''),
        people: Array.isArray(c.people) ? c.people.map(String) : [],
        summary: String(c.summary || ''),
      });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * memory.json's text with one saved call (id) or all of them (id null, and then the jokes
 * he kept to call back to as well) taken out, for one server or all (guildId null). Only
 * for when the bot is off. Returns { text, count, jokes }.
 */
export function forgetCallsInFile(text, { guildId = null, id = null } = {}) {
  const data = JSON.parse(String(text).replace(/^﻿/, ''));
  let count = 0;
  let jokes = 0;
  for (const [g, entry] of Object.entries(data?.guilds || {})) {
    if (guildId && g !== guildId) continue;
    if (!id && Array.isArray(entry?.landed) && entry.landed.length) {
      jokes += entry.landed.length;
      entry.landed = [];
    }
    if (!Array.isArray(entry?.calls)) continue;
    const keep = entry.calls.filter((c) => id && c?.id !== id);
    count += entry.calls.length - keep.length;
    entry.calls = keep;
  }
  return { text: JSON.stringify(data, null, 2), count, jokes };
}

/** The jokes of his that got a laugh, kept to call back to (newest first): [{ guildId, text, at }]. */
export function readLandedJokes(botDir) {
  const file = path.join(dataDir(botDir), 'memory.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Couldn't open data/memory.json (${err.code || err.message}).`);
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error("data/memory.json couldn't be read (it may be damaged).");
  }
  const out = [];
  for (const [guildId, g] of Object.entries(data?.guilds || {})) {
    for (const j of Array.isArray(g?.landed) ? g.landed : []) {
      if (j && typeof j.text === 'string' && j.text.trim()) out.push({ guildId, text: j.text, at: String(j.at || '') });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * True when a copy of the bot is running that this app didn't start (start-windows.bat):
 * it holds a local port while it runs (src/instance-lock.js). Its memory.json mustn't be
 * edited under it, since its next save would write the old contents back.
 */
export function botRunningElsewhere(port = 8177) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(false)));
  });
}

/** Whether SCREEN_LOOKS is on in the bot's settings right now (on unless set to something false). */
export function screenLooksOn(env) {
  const v = String(env.SCREEN_LOOKS ?? '').trim().toLowerCase();
  return v === '' || ['1', 'true', 'yes', 'on'].includes(v);
}

/** Whether AUTO_UPDATE is on (the app restarts him to load an update once nobody's in a call): on unless set to something false. */
export function autoUpdateOn(env) {
  const v = String(env.AUTO_UPDATE ?? '').trim().toLowerCase();
  return v === '' || ['1', 'true', 'yes', 'on'].includes(v);
}
