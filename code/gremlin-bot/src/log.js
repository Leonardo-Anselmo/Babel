// Tiny timestamped logger. LOG_LEVEL = debug | info | warn | error (default info).
// With setLogFile, every line (debug and up) is also kept in a file, so you can
// see afterwards what the bot heard and did, without the console window.

import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

// The log file: started fresh (the previous one kept as *.old.log) when it gets big.
const FILE_MAX_BYTES = 5_000_000;
let file = null;
let fileThreshold = LEVELS.debug;
let writes = 0;

export function setLogLevel(level) {
  threshold = LEVELS[String(level).toLowerCase()] ?? threshold;
}

/** Also write log lines (at `level` and up) to this file. Never throws. */
export function setLogFile(filePath, { level = 'debug' } = {}) {
  file = filePath;
  fileThreshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.debug;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // the first write will fail quietly instead
  }
  rotateIfBig();
}

function rotateIfBig() {
  try {
    if (fs.statSync(file).size > FILE_MAX_BYTES) fs.renameSync(file, file.replace(/\.log$/, '') + '.old.log');
  } catch {
    // no file yet
  }
}

function stamp() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, tag, args) {
  const toConsole = LEVELS[level] >= threshold;
  const toFile = Boolean(file) && LEVELS[level] >= fileThreshold;
  if (!toConsole && !toFile) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} [${tag}]`;
  if (toConsole) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(line, ...args);
  }
  if (toFile) {
    try {
      fs.appendFileSync(file, `${line} ${format(...args)}\n`);
      if (++writes % 500 === 0) rotateIfBig();
    } catch {
      // logging must never break the bot
    }
  }
}

export function logger(tag) {
  return {
    debug: (...a) => emit('debug', tag, a),
    info: (...a) => emit('info', tag, a),
    warn: (...a) => emit('warn', tag, a),
    error: (...a) => emit('error', tag, a),
  };
}
