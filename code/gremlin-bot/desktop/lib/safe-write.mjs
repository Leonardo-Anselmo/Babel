// Saving the bot's files without ever leaving a half-written one behind.

import fsPromises from 'node:fs/promises';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Writes text to a temporary file next to the target, then swaps it in. OneDrive or a
 * virus scanner can hold the target for a moment, so the swap is retried for about a
 * second before writing the file directly. The temporary file never outlives the call
 * (it can hold API keys).
 */
export async function writeFileSafely(file, text, { fsp = fsPromises, wait = sleep, tries = 6 } = {}) {
  const tmp = `${file}.saving`;
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    for (let i = 1; ; i++) {
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (err) {
        if (!BUSY.has(err.code) || i >= tries) break;
        await wait(200);
      }
    }
    await fsp.writeFile(file, text, 'utf8');
  } finally {
    for (let i = 0; i < 5; i++) {
      try {
        await fsp.rm(tmp, { force: true });
        break;
      } catch {
        await wait(200); // held for a moment too: try again
      }
    }
  }
}
