// Runs the bot (src/index.js) under the PC's own Node.js, the same way
// start-windows.bat does: install libraries if they're missing, run the start-up
// check, then start it with a private channel for status reports and a clean stop.

import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINES = 3000;
const STOP_WAIT_MS = 10000;
const MIN_NODE = [22, 12];

/** Splits a stream into lines and calls onLine for each complete one. */
function lineReader(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  stream.on('end', () => {
    if (buf) onLine(buf.replace(/\r$/, ''));
    buf = '';
  });
}

export function parseCheckLine(text) {
  const m = /^(OK|FAIL|SKIP)\s+(.*)$/.exec(text.trim());
  if (!m) return null;
  const [label, ...rest] = m[2].split(': ');
  return { result: m[1].toLowerCase(), label, detail: rest.join(': ') };
}

/** A warning or error from the bot's log (its lines start with the time and the level). */
export function isProblemLine(text) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (WARN|ERROR)\s/.test(text);
}

// Lines that never explain anything: stack frames, Node's version footer, the ^ under a code line.
const NOISE = /^(at\s|Node\.js v\d|\^+$)/;
const ERRORISH = /\bERROR\b|\w*Error\b|\bFatal\b/;

/**
 * Why he stopped, from his last lines: the last one that names an error, or else the
 * last one that says anything. The log's time and level are left off.
 */
export function stopReason(texts) {
  const useful = texts.map((t) => t.trim()).filter((t) => t && !NOISE.test(t));
  const line = useful.findLast((t) => ERRORISH.test(t)) ?? useful.at(-1) ?? '';
  return line
    .replace(/^\S+ \S+ (INFO|WARN|ERROR|DEBUG)\s+\[[^\]]+\]\s*/, '')
    .replace(/^[-*]\s+/, '')
    .slice(0, 300);
}

export class BotProcess extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.botDir   the bot folder (package.json, src/, .env)
   * @param {string} [o.node]   the Node.js program to use
   * @param {() => string} [o.name]  the bot's current name, for messages
   */
  constructor({ botDir, node = 'node', name = () => 'The bot', spawn = nodeSpawn, platform = process.platform, stopWaitMs = STOP_WAIT_MS } = {}) {
    super();
    this.botDir = botDir;
    this.name = name;
    this.node = node;
    this.spawnImpl = spawn;
    this.platform = platform;
    this.stopWaitMs = stopWaitMs;
    // stopped | preparing | checking | check-failed | starting | running | stopping
    this.state = 'stopped';
    this.child = null;
    this.lines = [];
    this.status = null; // the bot's latest report (logged in, calls, hearing)
    this.check = null; // { ok, items, at } from the last start-up check
    this.startedAt = null;
    this.lastExit = null; // { code, at, expected }
    this.busy = null; // the running start(), so double clicks don't start two
    this.helper = null; // npm or the start-up check while they run
    this.cancelled = false; // Stop was pressed while it was still getting ready
    this.lastForce = false; // the last start skipped the start-up check ("Start anyway"): restarts do too
    this.runStartedAt = null; // when Start was last pressed (kept after he stops)
    this.problems = { count: 0, last: null }; // warnings and errors since then
  }

  snapshot() {
    return {
      state: this.state,
      startedAt: this.startedAt,
      runStartedAt: this.runStartedAt,
      lastExit: this.lastExit,
      check: this.check,
      status: this.status,
      problems: this.problems,
    };
  }

  setState(state) {
    this.state = state;
    this.emit('state', this.snapshot());
  }

  /**
   * Keeps one line of output. Warnings and errors (the bot's own, or the app's when
   * he couldn't start) are counted, and the window hears about each one right away.
   */
  addLine(text, source = 'bot', { problem = source === 'bot' && isProblemLine(text) } = {}) {
    const entry = { at: Date.now(), source, text };
    if (problem) entry.problem = true;
    this.lines.push(entry);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.emit('line', entry);
    if (problem) {
      this.problems = { count: this.problems.count + 1, last: entry };
      this.emit('status', this.snapshot());
    }
  }

  /** Runs a helper program in the bot folder, showing its output (unless quiet). Resolves to { code, lines }. */
  runCaptured(cmd, args, { source = 'check', shell = false, quiet = false } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl(cmd, args, { cwd: this.botDir, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } });
      } catch (err) {
        reject(err);
        return;
      }
      const lines = [];
      const onLine = (text) => {
        lines.push(text);
        if (!quiet) this.addLine(text, source);
      };
      this.helper = child;
      lineReader(child.stdout, onLine);
      lineReader(child.stderr, onLine);
      child.on('error', (err) => {
        if (this.helper === child) this.helper = null;
        reject(err);
      });
      child.on('close', (code) => {
        if (this.helper === child) this.helper = null;
        resolve({ code: code ?? 1, lines });
      });
    });
  }

  async ensureNode() {
    let out;
    try {
      // Quiet: a bare "v22.12.0" says nothing, and the start-up check shows the version anyway.
      out = await this.runCaptured(this.node, ['-v'], { source: 'app', quiet: true });
    } catch {
      throw new Error("Node.js isn't installed. Get the LTS version from nodejs.org, install it, then press Start again.");
    }
    const [major, minor] = (out.lines.join('').trim().replace(/^v/, '') || '0.0').split('.').map(Number);
    if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
      throw new Error(`Node.js ${out.lines.join('').trim()} is too old. Install the LTS version from nodejs.org, then press Start again.`);
    }
  }

  async ensureLibraries() {
    // npm writes this file last, so it's only there after an install that finished.
    if (fs.existsSync(path.join(this.botDir, 'node_modules', '.package-lock.json'))) return;
    this.addLine('Installing libraries, one moment...', 'app');
    const args = ['ci', '--omit=dev', '--no-audit', '--no-fund'];
    // npm is a .cmd script on Windows, which needs a shell, and a shell takes one command line.
    const r =
      this.platform === 'win32'
        ? await this.runCaptured(`npm ${args.join(' ')}`, [], { source: 'app', shell: true })
        : await this.runCaptured('npm', args, { source: 'app' });
    if (r.code !== 0) throw new Error('Installing the libraries failed (see the lines above).');
  }

  /**
   * Ends a helper and everything it started. On Windows a plain kill would end only
   * the shell around npm, and npm would carry on (holding its output open). Resolves
   * once that's done, so the app doesn't quit while taskkill is still at work.
   */
  killTree(child) {
    if (!child) return Promise.resolve();
    if (this.platform === 'win32' && child.pid) {
      return new Promise((resolve) => {
        const plainKill = () => {
          try {
            child.kill();
          } catch {
            // already gone
          }
          resolve();
        };
        let killer;
        try {
          killer = this.spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } catch {
          plainKill();
          return;
        }
        const timer = setTimeout(plainKill, 5000);
        killer.on('error', () => {
          clearTimeout(timer);
          plainKill();
        });
        killer.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    child.kill();
    return Promise.resolve();
  }

  /** Stops the running helper (npm, the start-up check or the Whisper setup), if any. */
  stopHelper() {
    return this.killTree(this.helper);
  }

  /** Runs the start-up check (src/check.js): tests every key, like start-windows.bat does. */
  async runCheck() {
    const r = await this.runCaptured(this.node, ['src/check.js'], { source: 'check' });
    this.check = { ok: r.code === 0, items: r.lines.map(parseCheckLine).filter(Boolean), at: Date.now() };
    return this.check;
  }

  /**
   * Prepares and starts the bot. With force, skips the start-up check (after it
   * failed and you chose to start anyway). Never throws: problems become log lines.
   */
  start({ force = false } = {}) {
    if (this.busy) return this.busy;
    if (this.state !== 'stopped' && this.state !== 'check-failed') return Promise.resolve(this.snapshot());
    this.busy = (async () => {
      try {
        this.lastExit = null;
        this.cancelled = false;
        this.lastForce = force;
        this.runStartedAt = Date.now();
        this.problems = { count: 0, last: null };
        this.setState('preparing');
        await this.ensureNode();
        await this.ensureLibraries();
        if (!force && !this.cancelled) {
          this.setState('checking');
          const check = await this.runCheck();
          if (!check.ok && !this.cancelled) {
            this.setState('check-failed');
            return this.snapshot();
          }
        }
        if (this.cancelled) {
          this.addLine('Start cancelled.', 'app');
          this.setState('stopped');
          return this.snapshot();
        }
        this.launch();
      } catch (err) {
        this.addLine(`Couldn't start: ${err.message}`, 'app', { problem: true });
        this.setState('stopped');
      } finally {
        this.busy = null;
      }
      return this.snapshot();
    })();
    return this.busy;
  }

  launch() {
    this.setState('starting');
    this.status = null;
    this.startedAt = Date.now();
    const child = this.spawnImpl(this.node, ['src/index.js'], {
      cwd: this.botDir,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    this.child = child;
    lineReader(child.stdout, (t) => this.addLine(t, 'bot'));
    lineReader(child.stderr, (t) => this.addLine(t, 'bot'));
    child.on('message', (m) => {
      if (this.child !== child || !m || typeof m !== 'object') return;
      // Anything else (a request for a picture of the screen, an answer to "forget a call") is for main.mjs.
      if (m.type !== 'status') {
        this.emit('message', m);
        return;
      }
      this.status = m;
      if (m.ready && this.state === 'starting') this.setState('running');
      else this.emit('status', this.snapshot());
    });
    child.on('error', (err) => {
      this.addLine(`Couldn't run the bot: ${err.message}`, 'app', { problem: true });
      if (this.child === child) {
        this.child = null;
        this.startedAt = null;
        this.setState('stopped');
      }
    });
    // 'close' comes after the last output line, so the reason he stopped is in by then.
    child.on('close', (code, signal) => {
      if (this.child !== child) return;
      const expected = this.state === 'stopping';
      const reason = expected ? '' : stopReason(this.lines.filter((l) => l.source === 'bot' && l.at >= this.startedAt).map((l) => l.text));
      this.child = null;
      this.status = null;
      this.startedAt = null;
      this.lastExit = { code: code ?? null, signal: signal ?? null, at: Date.now(), expected, reason };
      if (!expected) this.addLine(`${this.name()} stopped on his own (exit code ${code ?? signal}). The lines above say why.`, 'app');
      this.setState('stopped');
    });
  }

  /** Asks the bot to leave voice, save and exit; forces it after a few seconds. */
  async stop() {
    const child = this.child;
    if (!child) {
      if (this.busy) {
        // Still installing or checking: cancel, and stop whatever helper is running.
        this.cancelled = true;
        this.stopHelper();
        await this.busy;
      } else if (this.state === 'check-failed') this.setState('stopped');
      return this.snapshot();
    }
    if (this.state !== 'stopping') {
      this.setState('stopping');
      try {
        child.send({ type: 'shutdown' });
      } catch {
        child.kill();
      }
    }
    await new Promise((resolve) => {
      if (this.child !== child) return resolve();
      const timer = setTimeout(() => child.kill(), this.stopWaitMs);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.snapshot();
  }

  /** Stops and starts him again, the way he was last started (with or without the start-up check). */
  async restart({ force = this.lastForce } = {}) {
    await this.stop();
    return this.start({ force });
  }

  /** Sends a command to the running bot (e.g. chattiness). False if it isn't running. */
  send(message) {
    if (!this.child?.connected) return false;
    try {
      this.child.send(message);
      return true;
    } catch {
      return false;
    }
  }

  get running() {
    return Boolean(this.child);
  }
}
