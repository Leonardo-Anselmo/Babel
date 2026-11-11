// Free speech-to-text on this PC's graphics card. Starts the local Whisper server
// (whisper/server.py, installed by setup-whisper.bat) when it's needed, and keeps it
// running while the bot runs. When nothing has used it for 5 minutes it exits by
// itself and frees the graphics memory.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('whisper');

const IDLE_EXIT_SECONDS = 300;
const LOG_MAX_BYTES = 1_000_000;

export function whisperPaths(config) {
  const w = config.stt.whisper;
  const win = process.platform === 'win32';
  const venv = path.join(w.home, 'venv');
  const python = win ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  // pythonw has no console window at all, which suits a background server.
  const pythonw = win ? path.join(venv, 'Scripts', 'pythonw.exe') : python;
  return {
    python,
    pythonw,
    modelDir: path.join(w.home, 'models', w.model.replace(/[^A-Za-z0-9._-]/g, '_')),
    server: path.join(config.rootDir, 'whisper', 'server.py'),
    logFile: path.join(config.dataDir, 'whisper.log'),
    // The bot's own name detector, if one was trained for its name (whisper/extras/babel.onnx).
    wakeModel: path.join(config.rootDir, 'whisper', 'extras', `${wakeModelName(config.botName)}.onnx`),
  };
}

/** The file name (without .onnx) of the name detector for a bot name: "Babel" -> "babel". */
export function wakeModelName(botName) {
  return String(botName || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '') || 'bot';
}

export function createWhisperManager(
  config,
  { fetchImpl = globalThis.fetch, spawnImpl = spawn, fsImpl = fs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {},
) {
  const w = config.stt.whisper;
  const base = `http://127.0.0.1:${w.port}`;
  const p = whisperPaths(config);
  let starting = null;
  let lastStartAt = 0;
  let timer = null;

  function installed() {
    return fsImpl.existsSync(p.python) && fsImpl.existsSync(path.join(p.modelDir, 'model.bin'));
  }

  /** The server's status, or null if nothing (or something else) answers on the port. */
  async function health() {
    try {
      const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const json = await res.json();
      return json?.ok ? json : null;
    } catch {
      return null;
    }
  }

  function lastLogLines(n = 3) {
    try {
      return fsImpl.readFileSync(p.logFile, 'utf8').trim().split(/\r?\n/).slice(-n).join(' | ');
    } catch {
      return '';
    }
  }

  function launch() {
    fsImpl.mkdirSync(path.dirname(p.logFile), { recursive: true });
    try {
      if (fsImpl.statSync(p.logFile).size > LOG_MAX_BYTES) fsImpl.truncateSync(p.logFile, 0);
    } catch {
      // no log yet
    }
    const exe = fsImpl.existsSync(p.pythonw) ? p.pythonw : p.python;
    const args = [
      // -E -s: ignore any Python settings on this PC that could pull in other packages
      '-E',
      '-s',
      p.server,
      '--home', w.home,
      '--model', w.model,
      '--port', String(w.port),
      '--compute-type', w.computeType,
      '--beam-size', String(w.beamSize),
      '--language', config.stt.language || 'en',
      '--idle-exit', String(IDLE_EXIT_SECONDS),
      '--log', p.logFile,
    ];
    if (fsImpl.existsSync(p.wakeModel)) args.push('--wake-model', p.wakeModel);
    // Detached and hidden: it outlives the start-up check so the bot can reuse it
    // instead of loading the model twice, and it never shows a window.
    // Its working folder is outside the bot folder, so OneDrive can still move or sync it freely.
    const cwd = fsImpl.existsSync(w.home) ? w.home : undefined;
    const child = spawnImpl(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd });
    child.on?.('error', (err) => log.warn(`could not start local Whisper: ${err.message}`));
    child.unref?.();
    return child;
  }

  /** Which version of whisper/server.py is on disk (the server reports the same for itself). */
  function codeOnDisk() {
    try {
      return createHash('sha256').update(fsImpl.readFileSync(p.server)).digest('hex').slice(0, 12);
    } catch {
      return null; // can't tell: don't restart over it
    }
  }

  /** True if a running server uses the settings in .env and the current server code (an older copy may not). */
  function matches(info, code = codeOnDisk()) {
    // A name detector added (or removed) since it started needs a fresh copy too.
    const wake = fsImpl.existsSync(p.wakeModel) ? wakeModelName(config.botName) : null;
    return (
      info.model === w.model &&
      info.compute_type === w.computeType &&
      Number(info.beam_size) === w.beamSize &&
      (info.language || '') === (config.stt.language || 'en') &&
      (!code || info.code === code) &&
      // (wake_model: the detector it was asked to load, loaded or not; older copies only say wake.)
      (info.wake_model ?? info.wake ?? null) === wake
    );
  }

  /** Asks a running server to quit and waits until the port is free. */
  async function shutdown() {
    try {
      await fetchImpl(`${base}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    } catch {
      // already gone
    }
    for (let i = 0; i < 20; i++) {
      if (!(await health())) return true;
      await sleep(500);
    }
    return false;
  }

  /**
   * Makes sure the server is up. Resolves to { status: 'running' | 'started' |
   * 'not-installed' | 'failed', info?, reason? }. Never throws.
   */
  async function ensure({ waitMs = 120000 } = {}) {
    const h = await health();
    if (h && matches(h)) return { status: 'running', info: h };
    if (h) {
      log.info(`local Whisper is running an older version or other settings (${h.model}, ${h.compute_type}); restarting it`);
      if (!(await shutdown())) return { status: 'failed', reason: 'an older copy is running and would not stop' };
    }
    if (!installed()) return { status: 'not-installed' };
    if (!starting) {
      starting = (async () => {
        lastStartAt = now();
        let exited = null;
        try {
          const child = launch();
          child.on?.('exit', (code) => (exited = code ?? 'killed'));
        } catch (err) {
          return { status: 'failed', reason: err.message };
        }
        const deadline = now() + waitMs;
        while (now() < deadline) {
          await sleep(500);
          const h2 = await health();
          if (h2) return { status: 'started', info: h2 };
          if (exited !== null) return { status: 'failed', reason: lastLogLines() || `it exited (code ${exited})` };
        }
        return { status: 'failed', reason: `it didn't answer within ${Math.round(waitMs / 1000)} s (see data/whisper.log)` };
      })().finally(() => {
        starting = null;
      });
    }
    return starting;
  }

  /** While the bot runs: ping it (which also keeps it from idling out) and restart it if it died. */
  function keepAlive({ everyMs = 60000, retryAfterMs = 300000 } = {}) {
    clearInterval(timer);
    timer = setInterval(async () => {
      if (await health()) return;
      if (!installed() || now() - lastStartAt < retryAfterMs) return;
      log.warn(`local Whisper stopped answering; restarting it${config.stt.deepgramKey ? ' (Deepgram covers in the meantime)' : " (nothing can hear until it's back: there's no Deepgram key)"}`);
      const r = await ensure();
      log.info(`local Whisper ${r.status}${r.reason ? `: ${r.reason}` : ''}`);
    }, everyMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { base, paths: p, installed, health, ensure, keepAlive, stop, lastLogLines };
}
