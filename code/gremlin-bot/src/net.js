// Network helpers shared by the Claude, ElevenLabs and Deepgram clients.

import { createRequire } from 'node:module';
import { logger } from './log.js';

const log = logger('net');
const require = createRequire(import.meta.url);

/**
 * Node's fetch closes a connection after 4 s without use unless the server says
 * otherwise, so almost every reply in a call paid for a new connection (TCP and TLS,
 * tens of milliseconds or more). Keep them open for 30 s instead. Uses the undici
 * that discord.js already installs, and only when it's the same major version as the
 * one inside this Node (a mismatch could break every request, so then it does nothing).
 */
export function keepConnectionsOpen({ timeoutMs = 30000 } = {}) {
  try {
    const undici = require('undici');
    const mine = Number(String(require('undici/package.json').version).split('.')[0]);
    const nodes = Number(String(process.versions.undici || '').split('.')[0]);
    if (!mine || mine !== nodes) {
      log.debug(`left connection reuse as it is (undici ${mine || '?'} here, ${nodes || '?'} in Node)`);
      return false;
    }
    undici.setGlobalDispatcher(new undici.Agent({ keepAliveTimeout: timeoutMs, keepAliveMaxTimeout: timeoutMs * 2 }));
    return true;
  } catch (err) {
    log.debug(`left connection reuse as it is: ${err.message}`);
    return false;
  }
}

/**
 * True when a request failed before any answer came back because the connection
 * dropped (say, the server closed a reused connection just as it was sent), so
 * sending it again is safe. Never true for a timeout or a cancel.
 */
export function isDroppedConnection(err) {
  if (!err || err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const code = err.cause?.code || err.code || '';
  if (['UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(code)) return true;
  return err.name === 'TypeError' && /fetch failed/i.test(err.message) && /other side closed|socket|reset/i.test(String(err.cause?.message || ''));
}

/** fetch, sent once more if the connection dropped before any answer came back. */
export async function fetchWithReconnect(fetchImpl, url, init = {}, { retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      if (attempt >= retries || init.signal?.aborted || !isDroppedConnection(err)) throw err;
      log.debug(`the connection to ${new URL(url).host} dropped; sending again`);
    }
  }
}
