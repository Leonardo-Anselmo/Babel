// Reading and changing the bot's .env file without disturbing anything else in it:
// comments, blank lines, order, line endings and settings the app doesn't know
// about all stay exactly as they were.

import { parseEnv } from 'node:util';

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

/** The settings in a .env file's text, as { KEY: 'value' }. */
export function readEnv(text) {
  return parseEnv(String(text || '').replace(/^﻿/, ''));
}

/**
 * How a value has to be written so the bot reads back exactly the same string.
 * (The bot reads .env with Node's parser: an unquoted # starts a comment, single
 * quotes are taken literally, and in double quotes \n becomes a line break.)
 */
export function formatEnvValue(value) {
  const v = String(value ?? '');
  if (/[\r\n]/.test(v)) throw new Error('A setting has to fit on one line.');
  if (v === '') return '';
  const needsQuotes = /[#'"`]/.test(v) || v !== v.trim();
  if (!needsQuotes) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes('\\n')) return `"${v}"`;
  throw new Error("A setting can't contain both ' and \" quotes.");
}

/**
 * Returns the .env text with these settings changed (or added at the end).
 * Every uncommented line for a key is updated, so there's never a stale duplicate.
 */
export function setEnvValues(text, updates) {
  const src = String(text || '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.length ? src.split(/\r?\n/) : [];
  // A final newline leaves an empty last element; keep it aside so appends go before it.
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();

  for (const [key, value] of Object.entries(updates)) {
    if (!KEY_RE.test(key)) throw new Error(`Not a setting name: ${key}`);
    const line = `${key}=${formatEnvValue(value)}`;
    const re = new RegExp(`^\\s*${key}\\s*=`);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i].replace(/^﻿/, ''))) {
        lines[i] = (i === 0 && lines[i].startsWith('﻿') ? '﻿' : '') + line;
        found = true;
      }
    }
    if (!found) lines.push(line);
  }
  return lines.join(eol) + eol;
}
