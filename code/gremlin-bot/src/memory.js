// Small per-server store saved to data/memory.json: things people asked the
// bot to remember, who opted out of being listened to, chattiness, auto-join, how its
// jokes have been landing (and the ones that got a laugh), words it learned to spell
// for the speech-to-text, reminders people asked for, the shared lists people keep with
// it, and (with CALL_MEMORY on) short notes on its last few calls. Never stores audio or
// transcripts.

import fs from 'node:fs';
import path from 'node:path';
import { MAX_LANDED, mentionsAny } from './jokes.js';
import { TRASH_KEEP, mergeLists } from './lists.js';
import { logger } from './log.js';

const log = logger('memory');

export const MAX_FACTS = 40;
export const MAX_FACT_CHARS = 200;
// Notes on its last calls in each server (CALL_MEMORY): the newest ones are kept.
export const MAX_CALLS = 10;
const MAX_CALL_CHARS = 1200;
const MAX_LANDED_CHARS = 300;
// While memory.json is there but can't be read, how often to try it again.
const RETRY_READ_MS = 30000;

// Makes call ids unique even for two calls saved in the same millisecond.
let callSeq = 0;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const validMemory = (d) => isObject(d) && isObject(d.guilds);
const pause = new Int32Array(new SharedArrayBuffer(4));

/**
 * Reads one of the bot's JSON files. Only a file that isn't there means "start
 * fresh". One that a sync app or virus scanner is holding is tried again for a
 * moment, then reported as unreadable, so nothing gets saved over it. A damaged
 * one is moved aside (kept, for a look later) instead of being overwritten.
 * @returns {{ status: 'ok' | 'missing' | 'unreadable' | 'corrupt', data?: any, error?: Error, movedTo?: string }}
 */
export function readJsonFile(file, { valid = isObject, tries = 5, waitMs = 400 } = {}) {
  let text;
  for (let attempt = 1; ; attempt++) {
    try {
      text = fs.readFileSync(file, 'utf8');
      break;
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 'missing' };
      if (attempt >= tries) return { status: 'unreadable', error: err };
      Atomics.wait(pause, 0, 0, waitMs); // a short wait, only ever at start-up
    }
  }
  let problem;
  try {
    const data = JSON.parse(text.replace(/^﻿/, ''));
    if (valid(data)) return { status: 'ok', data };
    problem = 'not what the bot saves there';
  } catch (err) {
    problem = err.message;
  }
  const ext = path.extname(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const movedTo = path.join(path.dirname(file), `${path.basename(file, ext)}.corrupt-${stamp}${ext}`);
  try {
    fs.renameSync(file, movedTo);
  } catch (err) {
    return { status: 'unreadable', error: new Error(`it is damaged (${problem}) and couldn't be moved aside (${err.code || err.message})`) };
  }
  return { status: 'corrupt', error: new Error(problem), movedTo };
}

export class Memory {
  /**
   * @param {string} dataDir
   * @param {{ retryReadMs?: number }} [o]
   */
  constructor(dataDir, { retryReadMs = RETRY_READ_MS } = {}) {
    this.file = path.join(dataDir, 'memory.json');
    this.data = { guilds: {} };
    this.saveTimer = null;
    this.failedSaves = 0;
    this.dirty = false; // changed since the last save
    // Set while memory.json is there but can't be read. Nothing is saved over it until
    // it can be, and once it reads, this run's changes are kept on top of it.
    this.unreadable = null;
    this.optOutChanges = []; // [guildId, userId, out, names] made while it couldn't be read
    this.retryTimer = null;
    this.callsForgottenAt = new Map(); // guildId -> when /forgetcalls (or the app) last cleared them
    this.reloadListeners = []; // told once memory.json could be read after all (see onReload)
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      log.warn(`could not make the folder ${dataDir}: ${err.message}`);
    }
    const r = readJsonFile(this.file, { valid: validMemory });
    if (r.status === 'ok') this.data = r.data;
    else if (r.status === 'corrupt') {
      log.error(`${this.file} was damaged (${r.error.message}), so it was moved to ${path.basename(r.movedTo)} and memory starts empty`);
    } else if (r.status === 'unreadable') {
      this.unreadable = r.error.code || r.error.message;
      log.error(
        `could not read ${this.file} (${this.unreadable}). Remembered facts, opt-outs and chattiness aren't loaded, ` +
          `and nothing is saved over the file until it can be read. Trying again every ${Math.round(retryReadMs / 1000)} s.`,
      );
      this.retryTimer = setInterval(() => {
        if (this.retryRead() && this.dirty) this.save();
      }, retryReadMs);
      this.retryTimer.unref?.();
    }
  }

  /** Tries memory.json again after it couldn't be read. True once it has been (or it's gone). */
  retryRead() {
    if (!this.unreadable) return true;
    const r = readJsonFile(this.file, { valid: validMemory, tries: 1 });
    if (r.status === 'unreadable') return false;
    if (r.status === 'corrupt') log.error(`${this.file} was damaged (${r.error.message}), so it was moved to ${path.basename(r.movedTo)}`);
    const saved = r.status === 'ok' ? r.data : { guilds: {} };
    // What was saved, plus what changed this run: new facts, chattiness, opt-outs.
    for (const [id, mine] of Object.entries(this.data.guilds)) {
      const g = (saved.guilds[id] ??= { facts: [], optouts: [], chattiness: null });
      g.facts = [...(g.facts || []), ...(mine.facts || [])].slice(-MAX_FACTS);
      if (mine.calls?.length) g.calls = [...(g.calls || []), ...mine.calls].slice(-MAX_CALLS);
      if (mine.chattiness) g.chattiness = mine.chattiness;
      if (typeof mine.autoJoin === 'boolean') g.autoJoin = mine.autoJoin;
      if (mine.autoJoinPausedAt !== undefined) g.autoJoinPausedAt = mine.autoJoinPausedAt;
      // Reminders set meanwhile, numbered after the ones in the file (they're told apart by key).
      if (mine.reminders?.length) {
        const theirs = Array.isArray(g.reminders) ? g.reminders : [];
        let next = theirs.reduce((n, r) => Math.max(n, Number(r?.id) || 0), 0);
        g.reminders = [...theirs, ...mine.reminders.map((r) => (theirs.some((x) => x?.id === r.id) ? { ...r, id: ++next } : r))];
      }
      // Lists changed meanwhile (only the ones this run could see): added to the file's own.
      if (mine.lists?.length) g.lists = mergeLists(g.lists, mine.lists);
      // Lists deleted or cleared meanwhile, kept to bring back: the newest first.
      if (mine.listsTrash?.length) g.listsTrash = [...mine.listsTrash, ...(Array.isArray(g.listsTrash) ? g.listsTrash : [])].slice(0, TRASH_KEEP);
      // (The joke score, kept jokes and learned words aren't saved while the file can't be read: what's in it stays.)
    }
    this.data = saved;
    for (const [guildId, userId, out, names] of this.optOutChanges) this.applyOptOut(guildId, userId, out, names);
    this.optOutChanges = [];
    this.unreadable = null;
    clearInterval(this.retryTimer);
    this.retryTimer = null;
    log.info(`read ${this.file} after all${this.dirty ? "; this run's changes are kept on top" : ''}`);
    for (const fn of this.reloadListeners) {
      try {
        fn();
      } catch (err) {
        log.warn(`after reading ${this.file}: ${err.message}`);
      }
    }
    return true;
  }

  /** Calls fn once memory.json could be read after all (reminders saved in it are armed then). */
  onReload(fn) {
    this.reloadListeners.push(fn);
  }

  guild(guildId) {
    if (!this.data.guilds[guildId]) this.data.guilds[guildId] = { facts: [], optouts: [], chattiness: null };
    const g = this.data.guilds[guildId];
    g.facts ??= [];
    g.optouts ??= [];
    return g;
  }

  /** The servers it has saved anything for. */
  guildIds() {
    return Object.keys(this.data.guilds);
  }

  facts(guildId) {
    return this.guild(guildId).facts;
  }

  /**
   * Saves a fact. Returns { text, dropped }: the fact as saved (null if it was empty),
   * and the oldest facts pushed out to make room when the list was full.
   */
  remember(guildId, text, by) {
    const g = this.guild(guildId);
    const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS);
    if (!clean) return { text: null, dropped: [] };
    g.facts.push({ text: clean, by, at: new Date().toISOString() });
    const dropped = g.facts.length > MAX_FACTS ? g.facts.splice(0, g.facts.length - MAX_FACTS) : [];
    this.save();
    return { text: clean, dropped };
  }

  addFact(guildId, text, by) {
    return this.remember(guildId, text, by).text;
  }

  /** index is 1-based, as shown to users. */
  removeFact(guildId, index) {
    const g = this.guild(guildId);
    if (index < 1 || index > g.facts.length) return null;
    const [removed] = g.facts.splice(index - 1, 1);
    this.save();
    return removed;
  }

  isOptedOut(guildId, userId) {
    return this.guild(guildId).optouts.includes(userId);
  }

  /**
   * names: what they're called (display, user and global name), kept with the opt-out so
   * jokes naming them are never kept or offered, even when Discord doesn't say who they are.
   */
  applyOptOut(guildId, userId, out, names = []) {
    const g = this.guild(guildId);
    const has = g.optouts.includes(userId);
    if (out && !has) g.optouts.push(userId);
    if (!out && has) g.optouts = g.optouts.filter((id) => id !== userId);
    const known = names.map((n) => String(n ?? '').trim().slice(0, 64)).filter(Boolean);
    if (out && known.length) {
      g.optoutNames = { ...(g.optoutNames || {}), [userId]: [...new Set([...(g.optoutNames?.[userId] || []), ...known])].slice(0, 6) };
      // The jokes it kept that name them go too.
      if (Array.isArray(g.landed)) g.landed = g.landed.filter((j) => !mentionsAny(j?.text, known));
    }
    if (!out && g.optoutNames?.[userId]) {
      const { [userId]: _gone, ...rest } = g.optoutNames;
      g.optoutNames = rest;
    }
  }

  setOptOut(guildId, userId, out, { names = [] } = {}) {
    this.applyOptOut(guildId, userId, out, names);
    if (this.unreadable) this.optOutChanges.push([guildId, userId, out, names]);
    this.save();
  }

  /** The names kept with this server's opt-outs (see applyOptOut). */
  optOutNames(guildId) {
    const g = this.data.guilds[guildId];
    return Object.entries(g?.optoutNames || {})
      .filter(([id]) => g.optouts?.includes(id))
      .flatMap(([, names]) => (Array.isArray(names) ? names : []));
  }

  /** Notes on its last calls in this server, oldest first: { id, at, minutes, server, channel, people, summary }. */
  calls(guildId) {
    const g = this.data.guilds[guildId];
    return Array.isArray(g?.calls) ? g.calls : [];
  }

  /** Saves notes on a call that just ended. Returns its id (null if there was nothing to save). */
  addCall(guildId, { at, minutes = 0, server = '', channel = '', people = [], summary = '' }) {
    const text = String(summary).replace(/\s+/g, ' ').trim().slice(0, MAX_CALL_CHARS);
    if (!text) return null;
    const g = this.guild(guildId);
    g.calls ??= [];
    const id = `c${Date.now().toString(36)}${(++callSeq).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    g.calls.push({
      id,
      at: at || new Date().toISOString(),
      minutes: Math.max(0, Math.round(Number(minutes) || 0)),
      server: String(server || '').slice(0, 100),
      channel: String(channel || '').slice(0, 100),
      people: [...new Set(people.map((p) => String(p).slice(0, 64)))].slice(0, 20),
      summary: text,
    });
    if (g.calls.length > MAX_CALLS) g.calls.splice(0, g.calls.length - MAX_CALLS);
    this.save();
    return id;
  }

  /** Replaces a saved call's notes (with the final summary). False if it's gone (forgotten meanwhile). */
  updateCall(guildId, id, summary) {
    const call = this.calls(guildId).find((c) => c.id === id);
    const text = String(summary || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CALL_CHARS);
    if (!call || !text) return false;
    call.summary = text;
    this.save();
    return true;
  }

  /** Forgets one saved call. Returns it, or null if there was no such call. */
  forgetCall(guildId, id) {
    const calls = this.calls(guildId);
    const i = calls.findIndex((c) => c.id === id);
    if (i < 0) return null;
    const [removed] = calls.splice(i, 1);
    this.save();
    return removed;
  }

  /** Forgets every saved call in this server, and the jokes it kept from them. Returns how many calls there were. */
  forgetCalls(guildId) {
    // A call that ends from now on can still be saved, but not the summary of one that ended before.
    this.callsForgottenAt.set(guildId, Date.now());
    const n = this.calls(guildId).length;
    if (n) this.guild(guildId).calls = [];
    const jokes = this.landedJokes(guildId).length;
    if (jokes) this.guild(guildId).landed = [];
    if (n || jokes) this.save();
    return n;
  }

  /** Its jokes that got a laugh in this server, oldest first: [{ text, at, usedAt }]. */
  landedJokes(guildId) {
    const j = this.data.guilds[guildId]?.landed;
    return Array.isArray(j) ? j.filter((x) => x && typeof x.text === 'string') : [];
  }

  /** Keeps a joke that got a laugh (the newest dozen are kept). False if there was nothing to keep. */
  addLandedJoke(guildId, text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LANDED_CHARS);
    if (!clean) return false;
    const g = this.guild(guildId);
    const before = this.landedJokes(guildId).find((j) => j.text === clean);
    g.landed = this.landedJokes(guildId).filter((j) => j.text !== clean);
    // (Told again word for word and it got a laugh: it still rests from its last use.)
    g.landed.push({ text: clean, at: new Date().toISOString(), usedAt: before?.usedAt ?? null });
    if (g.landed.length > MAX_LANDED) g.landed.splice(0, g.landed.length - MAX_LANDED);
    this.save();
    return true;
  }

  /** It called back to one of those jokes: it rests a while. */
  markJokeUsed(guildId, text) {
    const j = this.landedJokes(guildId).find((x) => x.text === text);
    if (!j) return false;
    j.usedAt = new Date().toISOString();
    this.save();
    return true;
  }

  /** True if this server's calls were forgotten at or after this time (a summary still being written is then dropped). */
  callsForgottenSince(guildId, time) {
    return (this.callsForgottenAt.get(guildId) ?? -Infinity) >= time;
  }

  chattiness(guildId) {
    return this.guild(guildId).chattiness || null;
  }

  setChattiness(guildId, level) {
    this.guild(guildId).chattiness = level;
    this.save();
  }

  /** How its jokes have landed in this server (a JokeTuning state), or null. */
  jokes(guildId) {
    return this.data.guilds[guildId]?.jokes ?? null;
  }

  setJokes(guildId, state) {
    this.guild(guildId).jokes = state;
    this.save();
  }

  /** Words it learned to spell for the speech-to-text in this server: [{ term, heard, count, at }]. */
  words(guildId) {
    const w = this.data.guilds[guildId]?.words;
    return Array.isArray(w) ? w : [];
  }

  setWords(guildId, entries) {
    this.guild(guildId).words = entries;
    this.save();
  }

  /** Reminders people asked for in this server that haven't gone off yet (see reminders.js). */
  reminders(guildId) {
    const r = this.data.guilds[guildId]?.reminders;
    return Array.isArray(r) ? r : [];
  }

  setReminders(guildId, list) {
    this.guild(guildId).reminders = list;
    this.save();
  }

  /** The shared lists people keep with it in this server (see lists.js). */
  lists(guildId) {
    const l = this.data.guilds[guildId]?.lists;
    return Array.isArray(l) ? l : [];
  }

  /** Deleted or cleared lists kept a while so they can be brought back (see lists.js). */
  listsTrash(guildId) {
    const t = this.data.guilds[guildId]?.listsTrash;
    return Array.isArray(t) ? t : [];
  }

  /** Saves the lists (and, when given, the deleted or cleared ones kept to bring back) at once. */
  setLists(guildId, lists, trash) {
    const g = this.guild(guildId);
    g.lists = lists;
    if (Array.isArray(trash)) g.listsTrash = trash;
    this.save();
  }

  /** Whether it joins voice by itself here (true/false), or null for the default (AUTO_JOIN). */
  autoJoin(guildId) {
    const v = this.data.guilds[guildId]?.autoJoin;
    return typeof v === 'boolean' ? v : null;
  }

  setAutoJoin(guildId, on) {
    this.guild(guildId).autoJoin = Boolean(on);
    this.save();
  }

  /** When it was told to leave (/leave, or disconnected): it doesn't join by itself again until voice empties. */
  autoJoinPausedAt(guildId) {
    const v = this.data.guilds[guildId]?.autoJoinPausedAt;
    return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
  }

  setAutoJoinPaused(guildId, paused) {
    const g = this.data.guilds[guildId];
    if (!paused && !g?.autoJoinPausedAt) return;
    this.guild(guildId).autoJoinPausedAt = paused ? new Date().toISOString() : null;
    this.save();
  }

  save() {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 250);
  }

  /** Writes memory.json now, if anything changed since the last save. */
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.dirty) return;
    // Never save over a file it couldn't read: that would wipe what's in it.
    if (this.unreadable && !this.retryRead()) return;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      if (this.failedSaves) log.info(`saved ${this.file} after ${this.failedSaves} failed tries`);
      this.failedSaves = 0;
    } catch (err) {
      // A sync app or virus scanner can hold the file for a moment. Keep trying,
      // because this file holds who opted out of being listened to.
      this.failedSaves++;
      if (this.failedSaves === 1) log.warn(`could not save ${this.file}: ${err.message} (will keep retrying)`);
      const delay = Math.min(60000, 2000 * 2 ** Math.min(this.failedSaves - 1, 5));
      this.saveTimer = setTimeout(() => this.flush(), delay);
      this.saveTimer.unref?.();
    }
  }
}
