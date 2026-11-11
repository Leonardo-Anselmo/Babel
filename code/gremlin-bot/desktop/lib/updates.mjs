// Loads updates by itself (AUTO_UPDATE): while the bot runs, the app looks every few
// seconds at his code (src/, whisper/server.py, package.json), his settings (.env) and
// personality (persona.md, lore.md). Once something has changed and stayed put for a
// little while (an update writes several files), he's restarted to load it as soon as
// nobody is in a call with him. The app's own files (desktop/) can't be swapped while
// it runs: a change there only asks for the app to be closed and opened again.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export const CHECK_EVERY_MS = 5000;
// A change must hold still this long (an update writes its files one after another).
export const SETTLE_MS = 10000;
// Never more than one restart of his own in this long (a file that keeps changing can't loop him).
export const MIN_GAP_MS = 120000;
// If he doesn't come back up after a restart of its own (half an update landed, or the
// start-up check failed), it tries again a minute later, a few times, within this long.
export const RECOVER_GAP_MS = 60000;
export const RECOVER_TRIES = 3;
const RECOVER_WINDOW_MS = 15 * 60000;

const BOT_FILES = ['package.json', 'package-lock.json', '.env', 'persona.md', 'lore.md', 'whisper/server.py'];
const BOT_DIRS = ['src'];
const CODE_FILE = /\.(?:js|mjs|cjs|json|txt|md|html|css|py)$/i;

/** The files under a folder (its subfolders too), relative to botDir. */
function filesUnder(botDir, dir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(botDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = path.posix.join(rel, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(child);
      } else if (CODE_FILE.test(e.name)) out.push(child);
    }
  };
  walk(dir);
  return out;
}

/**
 * Each file's size and change time (no need to read them), by its path in the bot
 * folder: different whenever one is added, removed or saved again.
 */
export function snapshot(botDir, { files = BOT_FILES, dirs = BOT_DIRS } = {}) {
  const out = new Map();
  for (const rel of [...files, ...dirs.flatMap((d) => filesUnder(botDir, d))]) {
    try {
      const st = fs.statSync(path.join(botDir, rel));
      if (st.isFile()) out.set(rel, `${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      // not there
    }
  }
  return out;
}

/** The app's own files (desktop/), which only load when the app is opened. */
export function appSnapshot(botDir) {
  return snapshot(botDir, { files: [], dirs: ['desktop'] });
}

/** One line that's the same for the same files. */
const keyOf = (snap) =>
  snap
    ? [...snap]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    : null;

/**
 * Watches for updates while the bot runs and restarts him to load one once nobody is
 * in a call with him. Events: 'waiting' (an update is waiting, for the call to end or
 * for a restart by hand), 'restarting', 'idle' (nothing waiting any more), 'app-updated'
 * (the app's own files changed), 'restart-failed' (he didn't come back up after a
 * restart of its own; it tries again a minute later, a few times) and 'gave-up'.
 */
export class UpdateWatcher extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.botDir
   * @param {object} o.bot  the BotProcess: state, status, restart(), addLine()
   * @param {() => boolean} [o.enabled]  AUTO_UPDATE (when off, it only says an update is waiting)
   * @param {() => boolean} [o.blocked]  something else is going on (the Whisper setup)
   */
  constructor({
    botDir,
    bot,
    enabled = () => true,
    blocked = () => false,
    clock = Date.now,
    setTimer = setInterval,
    clearTimer = clearInterval,
    snapshotImpl = snapshot,
    appSnapshotImpl = appSnapshot,
    everyMs = CHECK_EVERY_MS,
    settleMs = SETTLE_MS,
    recoverGapMs = RECOVER_GAP_MS,
  }) {
    super();
    Object.assign(this, { botDir, bot, enabled, blocked, clock, setTimer, clearTimer, snapshotImpl, appSnapshotImpl, everyMs, settleMs, recoverGapMs });
    this.baseline = null; // the files as he loaded them (taken when he starts)
    this.seen = null; // the files at the last look (as a key)
    this.changedAt = 0; // when they last changed
    this.waiting = false; // an update is waiting for the call to end
    this.lastRestartAt = -Infinity;
    this.appBaseline = null;
    this.appUpdated = false;
    this.timer = null;
    this.recovery = null; // { at, tries, failedAt, lastTryAt } after a restart of its own, until he's up again
  }

  start() {
    this.appBaseline = keyOf(this.take(this.appSnapshotImpl));
    this.timer = this.setTimer(() => this.tick(), this.everyMs);
    this.timer?.unref?.();
  }

  stop() {
    this.clearTimer(this.timer);
    this.timer = null;
  }

  take(fn) {
    try {
      return fn(this.botDir);
    } catch {
      return null;
    }
  }

  /** He's being started: the files now are the ones he loads. */
  botStarting() {
    this.baseline = this.take(this.snapshotImpl);
    this.seen = keyOf(this.baseline);
    this.changedAt = 0;
    this.setWaiting(false);
  }

  /** Whether this file is still as he loaded it (so a change about to be made to it can be judged on its own). */
  matches(file) {
    if (!this.baseline) return false;
    const now = this.take(this.snapshotImpl);
    return Boolean(now) && now.get(file) === this.baseline.get(file);
  }

  /** Someone pressed Start, Stop or Restart: whatever this was trying to do, they took over. */
  takenOver() {
    this.recovery = null;
  }

  /**
   * These files were changed in a way he already took on without a restart (the app
   * applied chattiness or auto-join live): they don't count as an update. Anything
   * else that changed still does. (Only call it for a file that matched before the change.)
   */
  accept(files) {
    if (!this.baseline) return;
    const now = this.take(this.snapshotImpl);
    if (!now) return;
    for (const f of files) {
      if (now.has(f)) this.baseline.set(f, now.get(f));
      else this.baseline.delete(f);
    }
  }

  setWaiting(on, detail = {}) {
    if (this.waiting === on) return;
    this.waiting = on;
    this.emit(on ? 'waiting' : 'idle', detail);
  }

  /** Whether anyone is in a call with him (or he's joining one). */
  inCall() {
    return (this.bot.status?.calls?.length ?? 0) > 0;
  }

  tick() {
    // The app's own files: only a note (it can't swap its own code while it runs).
    if (!this.appUpdated && this.appBaseline) {
      const app = keyOf(this.take(this.appSnapshotImpl));
      if (app && app !== this.appBaseline) {
        this.appUpdated = true;
        this.emit('app-updated');
      }
    }
    if (this.bot.state !== 'running') {
      if (this.bot.state === 'stopped' || this.bot.state === 'check-failed') {
        this.baseline = null;
        this.setWaiting(false);
        this.recover();
      }
      return;
    }
    // Back up after a restart of its own.
    this.recovery = null;
    // Started some way that didn't say so: what's there now is what he has.
    if (!this.baseline) {
      this.botStarting();
      return;
    }
    const nowSnap = this.take(this.snapshotImpl);
    const now = keyOf(nowSnap);
    if (!now || now === keyOf(this.baseline)) {
      this.seen = now ?? this.seen;
      this.setWaiting(false);
      return;
    }
    if (now !== this.seen) {
      // Still changing (or just changed): wait for it to hold still.
      this.seen = now;
      this.changedAt = this.clock();
      return;
    }
    if (this.clock() - this.changedAt < this.settleMs) return;
    if (!this.enabled() || this.inCall() || this.blocked() || this.clock() - this.lastRestartAt < MIN_GAP_MS) {
      this.setWaiting(true, { automatic: this.enabled(), inCall: this.inCall() });
      return;
    }
    this.lastRestartAt = this.clock();
    this.setWaiting(false);
    this.baseline = null; // taken again as he starts
    this.recovery = { at: this.clock(), tries: 0, failedAt: null, lastTryAt: null };
    this.emit('restarting');
    this.bot.addLine?.('Loading an update: restarting him now that nobody is in a call with him.', 'app');
    try {
      Promise.resolve(this.bot.restart()).catch(() => {});
    } catch {
      // the window shows whatever went wrong with the restart
    }
  }

  /**
   * He's down after a restart of its own (the start-up check failed, or he stopped on
   * his own, maybe on half an update): once the files have held still and a minute has
   * passed, start him again the same way, up to RECOVER_TRIES times. Never after Stop.
   */
  recover() {
    const r = this.recovery;
    if (!r) return;
    const now = this.clock();
    const stoppedByHand = this.bot.state === 'stopped' && (this.bot.lastExit?.expected || this.bot.cancelled);
    if (stoppedByHand || now - r.at > RECOVER_WINDOW_MS) {
      this.recovery = null;
      return;
    }
    if (r.failedAt === null) {
      r.failedAt = now;
      this.emit('restart-failed', { tries: r.tries, state: this.bot.state });
    }
    const files = keyOf(this.take(this.snapshotImpl));
    if (files !== this.seen) {
      // Still changing (half an update?): wait for it to hold still.
      this.seen = files;
      this.changedAt = now;
      return;
    }
    if (now - this.changedAt < this.settleMs || now - (r.lastTryAt ?? r.failedAt) < this.recoverGapMs) return;
    if (r.tries >= RECOVER_TRIES) {
      this.recovery = null;
      this.emit('gave-up');
      return;
    }
    r.tries++;
    r.lastTryAt = now;
    r.failedAt = null;
    this.bot.addLine?.(`Trying to start him again after the update (try ${r.tries} of ${RECOVER_TRIES}).`, 'app');
    try {
      Promise.resolve(this.bot.start({ force: Boolean(this.bot.lastForce) })).catch(() => {});
    } catch {
      // the window shows what went wrong
    }
  }
}
