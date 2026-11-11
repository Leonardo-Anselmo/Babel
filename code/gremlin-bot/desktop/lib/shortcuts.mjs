// The app's Desktop and Start menu shortcuts (Windows), named after the bot. When
// the bot gets a new name, the app's own shortcuts are renamed with it.

import fs from 'node:fs';
import path from 'node:path';

// Shortcuts made before they were tracked carried the bot's first name.
const FIRST_NAME = 'Winslow';

/** The shortcut's file name: the bot's name without characters Windows refuses in file names. */
export function shortcutFileName(name) {
  const clean = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60);
  return `${clean || 'Voice bot'}.lnk`;
}

/** True if the shortcut exists and opens this app (its arguments name the app's folder). */
function opensThisApp(file, appDir, shell) {
  try {
    const link = shell.readShortcutLink(file);
    return String(link.args || '').toLowerCase().includes(appDir.toLowerCase());
  } catch {
    return false; // not there, or not a shortcut
  }
}

function readRecord(recordFile, fsImpl) {
  try {
    const name = JSON.parse(fsImpl.readFileSync(recordFile, 'utf8')).name;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the shortcuts in step with the bot's name.
 * make: (re)create them in both places (install-app.bat asked for that).
 * Otherwise only the app's shortcuts under the previous name are renamed, so one
 * the person deleted stays deleted. A shortcut is only ever removed if it opens
 * this app. Returns how many shortcuts were made or renamed.
 */
export function syncShortcuts({ name, places, options, appDir, recordFile, make = false, shell, fsImpl = fs }) {
  const previous = readRecord(recordFile, fsImpl) ?? FIRST_NAME;
  let have = 0;
  for (const dir of places) {
    const file = path.join(dir, shortcutFileName(name));
    const oldFile = path.join(dir, shortcutFileName(previous));
    const renamed = oldFile.toLowerCase() !== file.toLowerCase() && opensThisApp(oldFile, appDir, shell);
    if (!make && !renamed) continue;
    try {
      // 'create' makes the shortcut or overwrites an old one ('replace' only overwrites).
      if (!shell.writeShortcutLink(file, 'create', options)) continue;
    } catch {
      continue; // a folder it can't write to: the other shortcut still works
    }
    have += 1;
    if (renamed) {
      try {
        fsImpl.rmSync(oldFile, { force: true });
      } catch {
        // in use or protected: the new one works anyway
      }
    }
  }
  if (have || make) {
    try {
      fsImpl.writeFileSync(recordFile, JSON.stringify({ name }));
    } catch {
      // next start just checks again
    }
  }
  return have;
}
