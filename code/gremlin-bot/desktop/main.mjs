// The bot's desktop app: one window to start and stop the bot, change its settings,
// personality and keys, and see usage and logs, without opening the bot folder.
// Started from the shortcut (named after the bot) that install-app.bat creates.

import { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, Notification, screen, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  autoUpdateOn,
  botRunningElsewhere,
  credits,
  dataDir,
  forgetCallsInFile,
  loadEnv,
  readCalls,
  readLandedJokes,
  readTail,
  screenLooksOn,
  stopWhisper,
  usageReport,
  whisperHealth,
} from './lib/app-data.mjs';
import { BotProcess } from './lib/bot-process.mjs';
import { setEnvValues } from './lib/envfile.mjs';
import { writeFileSafely } from './lib/safe-write.mjs';
import { cleanValue, FIELDS, settingsView } from './lib/settings.mjs';
import { syncShortcuts } from './lib/shortcuts.mjs';
import { UpdateWatcher } from './lib/updates.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The bot folder is the one this app lives in (tests point it somewhere else).
const botDir = process.env.WINSLOW_BOT_DIR ? path.resolve(process.env.WINSLOW_BOT_DIR) : path.resolve(here, '..');
const uiFile = path.join(here, 'ui', 'index.html');

const EDITABLE_FILES = { persona: 'persona.md', lore: 'lore.md' };
const LOG_FILES = { activity: 'bot.log', whisper: 'whisper.log', setup: 'whisper-setup.log' };
const MAX_FILE_CHARS = 100_000;

// The app's own identity stays fixed (its settings folder, taskbar grouping);
// everything people see uses the bot's current name.
app.setName('Winslow');
const APP_ID = 'Winslow.ControlPanel';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

/** The bot's name from its settings (what it answers to in voice). */
function botName() {
  const fallback = FIELDS.get('BOT_NAME')?.default || 'the bot';
  try {
    return (loadEnv(botDir).BOT_NAME || '').trim() || fallback;
  } catch {
    return fallback;
  }
}

const bot = new BotProcess({ botDir, node: process.env.WINSLOW_NODE || 'node', name: botName });
let win = null;
let quitting = false;
let closePrompt = false; // a question about closing is on screen
let setupRunning = false; // the Whisper setup
let unsaved = ''; // pages with unsaved edits, as the window reports them

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// New code, a changed setting or personality file: he's restarted to load it once
// nobody is in a call with him (AUTO_UPDATE), or the window says an update is waiting.
const updateWatcher = new UpdateWatcher({
  botDir,
  bot,
  enabled: () => {
    try {
      return autoUpdateOn(loadEnv(botDir));
    } catch {
      return false;
    }
  },
  blocked: () => setupRunning,
});
const updateState = () => ({
  waiting: updateWatcher.waiting,
  automatic: updateWatcher.enabled(),
  inCall: updateWatcher.inCall(),
  appUpdated: updateWatcher.appUpdated,
});
for (const event of ['waiting', 'idle', 'restarting', 'app-updated']) updateWatcher.on(event, () => send('app:update', updateState()));
// He didn't come back up after restarting for an update: say so (it tries again a minute later).
updateWatcher.on('restart-failed', ({ tries } = {}) => {
  if (tries > 0) return; // (said once; the later tries show in the live output)
  const failed = bot.check?.items?.filter((i) => i.result === 'fail').map((i) => `${i.label}${i.detail ? `: ${i.detail}` : ''}`) ?? [];
  const why = bot.state === 'check-failed' && failed.length ? `the start-up check failed (${failed.join('; ')})` : bot.lastExit?.reason || 'he stopped right away';
  notify(`${botName()} is offline`, `He couldn't restart to load an update: ${why}. The app tries again in a minute.`);
});
updateWatcher.on('gave-up', () => {
  bot.addLine("Gave up restarting him after the update. Press Start when you're back.", 'app', { problem: true });
  notify(`${botName()} is still offline`, "He couldn't restart after an update, even after a few tries. Open the app to see why, then press Start.");
});

bot.on('state', (s) => {
  send('bot:state', s);
  if (s.state === 'starting') updateWatcher.botStarting();
  if (s.state === 'stopped' && s.lastExit && !s.lastExit.expected) tellAboutStop(s.lastExit);
});
bot.on('status', (s) => send('bot:state', s));
bot.on('line', (l) => send('bot:line', l));
bot.on('message', (m) => {
  if (m.type === 'screenshot-request') {
    captureScreen().then((shot) => bot.send({ type: 'screenshot', id: m.id, ...shot }));
  } else if (m.type === 'forgot-calls') {
    forgetting.get(m.requestId)?.({ count: Number(m.count) || 0, jokes: Number(m.jokes) || 0 });
  }
});

// The longest side of the picture of the screen sent to Claude (what it reads best).
const SHOT_LONG_EDGE = 1568;

/**
 * A picture of the main screen for the bot (the owner said "look at this"), as a
 * base64 JPEG: { jpeg } or { error }. Taken only when the bot asks, never kept.
 */
async function captureScreen() {
  try {
    // Turned off in Settings since he started: no picture.
    if (!screenLooksOn(loadEnv(botDir))) return { error: 'looking at the screen is turned off in Settings' };
    const display = screen.getPrimaryDisplay();
    const scale = display.scaleFactor || 1;
    const width = Math.round(display.size.width * scale);
    const height = Math.round(display.size.height * scale);
    const k = Math.min(1, SHOT_LONG_EDGE / Math.max(width, height));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * k), height: Math.round(height * k) },
    });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) return { error: "the screen couldn't be captured" };
    return { jpeg: source.thumbnail.toJPEG(80).toString('base64') };
  } catch (err) {
    return { error: `the screen couldn't be captured (${String(err?.message || err).slice(0, 120)})` };
  }
}

// "Forget this call" requests sent to the running bot, waiting for its answer: requestId -> resolve.
const forgetting = new Map();
let forgetCount = 0;

/**
 * He stopped on his own: if the window isn't in front, flash it on the taskbar and
 * show a Windows notification, so it doesn't go unnoticed while you're in a game.
 */
let toldAbout = null;
function tellAboutStop(exit) {
  if (toldAbout === exit.at) return;
  toldAbout = exit.at;
  notify(`${botName()} stopped`, exit.reason ? `He stopped on his own: ${exit.reason}` : 'He stopped on his own. Open the app to see why.');
}

/** Flashes the taskbar button and shows a Windows notification, unless the window is in front. */
function notify(title, body) {
  if (!win || win.isDestroyed() || win.isFocused()) return;
  win.flashFrame(true);
  try {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title, body: body.slice(0, 250) });
    note.on('click', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    note.show();
  } catch {
    // the taskbar flash still says it
  }
}

/** Only our own page may use the app's functions. */
function fromOurPage(frame) {
  try {
    const u = new URL(frame?.url || '');
    if (u.protocol !== 'file:') return false;
    const p = path.normalize(fileURLToPath(u));
    return process.platform === 'win32' ? p.toLowerCase() === uiFile.toLowerCase() : p === uiFile;
  } catch {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromOurPage(event.senderFrame)) throw new Error('Not allowed.');
    return fn(...args);
  });
}

/**
 * A file's text, or null only if it doesn't exist. Any other problem (OneDrive not
 * synced, the file in use) is an error, so a save can never start from a blank copy.
 */
function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Couldn't open ${path.basename(file)} (${err.code || err.message}). If it's in OneDrive, check that it's synced, then try again.`);
  }
}

// Saves run one at a time, so two quick changes can't both start from the same old file.
let saving = Promise.resolve();
function oneAtATime(fn) {
  const run = saving.then(fn, fn);
  saving = run.catch(() => {});
  return run;
}

/** The .env to change: the current one, or the example one for a first save. */
function readEnvText() {
  return readTextFile(path.join(botDir, '.env')) ?? readTextFile(path.join(botDir, '.env.example')) ?? '';
}

/** Chattiness for every server, saved where the bot keeps it (only while the bot is off). */
async function saveChattinessForServers(level) {
  const file = path.join(dataDir(botDir), 'memory.json');
  const text = readTextFile(file);
  if (!text?.trim()) return; // no servers remembered yet: the default in .env covers them
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Saved as the default, but data/memory.json couldn't be read, so each server keeps its own chattiness.");
  }
  for (const g of Object.values(data.guilds || {})) g.chattiness = level;
  await writeFileSafely(file, JSON.stringify(data, null, 2));
}

/** Auto-join on or off for every server, saved where the bot keeps it (only while the bot is off). */
async function saveAutoJoinForServers(on) {
  const file = path.join(dataDir(botDir), 'memory.json');
  const text = readTextFile(file);
  if (!text?.trim()) return; // no servers remembered yet: the default in .env covers them
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Saved as the default, but data/memory.json couldn't be read, so each server keeps its own auto-join setting.");
  }
  for (const g of Object.values(data.guilds || {})) {
    // Turning it on also undoes a /leave from before (someone just asked for it).
    if (on && g.autoJoin !== true) g.autoJoinPausedAt = null;
    g.autoJoin = on;
  }
  await writeFileSafely(file, JSON.stringify(data, null, 2));
}

handle('bot:get', () => ({ ...bot.snapshot(), lines: bot.lines.slice(-1500) }));
handle('app:update-state', () => updateState());
handle('bot:start', (force) => {
  if (setupRunning) throw new Error('Wait for the Whisper setup to finish.');
  updateWatcher.takenOver();
  return bot.start({ force: force === true });
});
handle('bot:stop', () => {
  updateWatcher.takenOver();
  return bot.stop();
});
handle('bot:restart', () => {
  if (setupRunning) throw new Error('Wait for the Whisper setup to finish.');
  updateWatcher.takenOver();
  return bot.restart();
});

handle('settings:get', () => ({ groups: settingsView(loadEnv(botDir)), hasEnv: fs.existsSync(path.join(botDir, '.env')) }));
handle('settings:save', (changes) =>
  oneAtATime(async () => {
    if (!changes || typeof changes !== 'object') throw new Error('Nothing to save.');
    const updates = {};
    for (const [key, value] of Object.entries(changes)) updates[key] = cleanValue(key, value);
    const keys = Object.keys(updates);
    if (!keys.length) return { saved: [], restartNeeded: false };
    // (Whether .env was still as he loaded it: an earlier change waiting for a restart must stay waiting.)
    const envWasLoaded = updateWatcher.matches('.env');
    await writeFileSafely(path.join(botDir, '.env'), setEnvValues(readEnvText(), updates));
    if ('BOT_NAME' in updates) updateShortcuts();
    // Chattiness and auto-join change on the spot. Running or still connecting: he takes
    // them right away (holding them until he's logged in). Stopping: wait until he has
    // saved and exited, then save them for him. Off, or still getting ready: saved where
    // he reads them when he starts.
    const applied = new Set();
    const live = async (key, message, saveForServers) => {
      if (bot.state === 'stopping') await bot.stop();
      if (bot.state === 'running' || bot.state === 'starting') {
        if (bot.send(message)) applied.add(key);
        return;
      }
      await saveForServers();
      // He may have been launched while that was saved.
      if ((bot.state === 'starting' || bot.state === 'running') && bot.send(message)) applied.add(key);
    };
    const level = updates.CHATTINESS;
    if ('CHATTINESS' in updates && level) await live('CHATTINESS', { type: 'set-chattiness', level }, () => saveChattinessForServers(level));
    if (updates.AUTO_JOIN === 'true' || updates.AUTO_JOIN === 'false') {
      const on = updates.AUTO_JOIN === 'true';
      await live('AUTO_JOIN', { type: 'set-auto-join', on }, () => saveAutoJoinForServers(on));
    }
    // Loading updates by himself is the app's own setting: it applies right away.
    if ('AUTO_UPDATE' in updates) applied.add('AUTO_UPDATE');
    // Everything else is read when the bot starts.
    const needsRestart = keys.some((k) => !(FIELDS.get(k)?.live && applied.has(k)));
    // He took all of it on the spot: that change to .env isn't an update to restart him for.
    if (!needsRestart && envWasLoaded) updateWatcher.accept(['.env']);
    return { saved: keys, restartNeeded: bot.running && needsRestart };
  }),
);

handle('files:get', (name) => {
  const file = EDITABLE_FILES[name];
  if (!file) throw new Error('Unknown file.');
  return readTextFile(path.join(botDir, file)) ?? '';
});
handle('files:save', (name, text) =>
  oneAtATime(async () => {
    const file = EDITABLE_FILES[name];
    if (!file) throw new Error('Unknown file.');
    if (typeof text !== 'string') throw new Error('Nothing to save.');
    if (text.length > MAX_FILE_CHARS) throw new Error('That is too long to be a personality file.');
    await writeFileSafely(path.join(botDir, file), text);
    return { saved: true, restartNeeded: bot.running };
  }),
);

handle('calls:get', () => readCalls(botDir));
handle('calls:forget', (guildId, id) =>
  oneAtATime(async () => {
    const which = { guildId: typeof guildId === 'string' ? guildId : null, id: typeof id === 'string' ? id : null };
    // While he runs, he holds memory.json and would save over a change made here: he does it.
    if (bot.running) {
      const requestId = ++forgetCount;
      const answer = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 4000);
        forgetting.set(requestId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
      const sent = bot.send({ type: 'forget-call', requestId, ...which });
      const result = sent ? await answer : null;
      forgetting.delete(requestId);
      if (result === null) throw new Error("He didn't answer. Try again in a moment, or stop him first.");
      return result;
    }
    if (await botRunningElsewhere()) {
      throw new Error("He's running outside the app (start-windows.bat), so he'd save over this. Stop him there first, or use /forgetcalls in Discord.");
    }
    const file = path.join(dataDir(botDir), 'memory.json');
    const text = readTextFile(file);
    if (!text?.trim()) return { count: 0, jokes: 0 };
    let result;
    try {
      result = forgetCallsInFile(text, which);
    } catch {
      throw new Error("data/memory.json couldn't be read, so nothing was deleted.");
    }
    if (result.count || result.jokes) await writeFileSafely(file, result.text);
    return { count: result.count, jokes: result.jokes };
  }),
);
handle('calls:jokes', () => readLandedJokes(botDir));
handle('usage:get', () => usageReport(botDir));
handle('usage:credits', () => credits(botDir));

handle('logs:get', (which) => {
  const file = LOG_FILES[which];
  if (!file) throw new Error('Unknown log.');
  return readTail(path.join(dataDir(botDir), file));
});

handle('whisper:health', () => whisperHealth(botDir));
handle('whisper:stop', async () => {
  if (bot.running) throw new Error(`Stop ${botName()} first: he restarts Whisper while he runs.`);
  return stopWhisper(botDir);
});
handle('whisper:setup', async () => {
  if (bot.running || bot.busy) throw new Error(`Stop ${botName()} first, then run the setup.`);
  if (setupRunning) throw new Error('The setup is already running.');
  const script = path.join(botDir, 'whisper', 'setup-whisper.ps1');
  const shellExe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  setupRunning = true;
  try {
    bot.addLine('Setting up Whisper (this can take a few minutes)...', 'setup');
    const r = await bot.runCaptured(shellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { source: 'setup' });
    return { ok: r.code === 0 };
  } finally {
    setupRunning = false;
  }
});

handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron, botDir, botName: botName() }));
handle('app:open-external', (url) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new Error('Only web links can be opened.');
  return shell.openExternal(url);
});
handle('app:copy', (text) => {
  if (typeof text !== 'string') throw new Error('Nothing to copy.');
  clipboard.writeText(text.slice(0, 2_000_000));
  return true;
});
// Which pages have unsaved edits ('' for none), so closing the window can warn first.
handle('app:unsaved', (where) => {
  unsaved = typeof where === 'string' ? where.slice(0, 60) : '';
  return true;
});

/**
 * Desktop and Start menu shortcuts (Windows), named after the bot. install-app.bat
 * starts the app once with --install-shortcuts. Made here rather than by the
 * installer so they carry the app's taskbar identity: a pinned app stays one icon.
 * When the bot is renamed, the app renames its own shortcuts to match.
 */
function updateShortcuts({ make = false } = {}) {
  if (process.platform !== 'win32') return;
  const name = botName();
  const made = syncShortcuts({
    name,
    make,
    shell,
    appDir: here,
    places: [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')],
    recordFile: path.join(app.getPath('userData'), 'shortcuts.json'),
    options: {
      target: process.execPath,
      args: `"${here}"`,
      cwd: botDir,
      description: `Start, stop and set up ${name}`,
      icon: path.join(here, 'ui', 'icon.ico'),
      iconIndex: 0,
      appUserModelId: APP_ID,
    },
  });
  if (make && !made) {
    dialog.showErrorBox(name, "The app couldn't add its shortcuts. You can open it by running install-app.bat in the bot folder again.");
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1140,
    height: 800,
    minWidth: 920,
    minHeight: 640,
    title: botName(),
    backgroundColor: '#0f1116',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(here, 'ui', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.loadFile(uiFile);
  win.on('focus', () => win.flashFrame(false));

  // If the window's page crashes (or runs out of memory), load it again: the bot
  // keeps running meanwhile, and the page picks up where things are. Not in a loop, though.
  let crashes = [];
  win.webContents.on('render-process-gone', (_event, details) => {
    if (quitting || !win || win.isDestroyed() || details.reason === 'clean-exit') return;
    unsaved = ''; // whatever was being edited went with the page
    const now = Date.now();
    crashes = [...crashes.filter((t) => now - t < 60000), now];
    if (crashes.length > 3) {
      dialog.showErrorBox(botName(), `The window keeps crashing (${details.reason}). Close the app and open it again.`);
      return;
    }
    win.loadFile(uiFile);
  });

  // Closing the app stops the bot (he only runs while the app is open). It asks first
  // if that would lose unsaved edits, stop the bot, or cut the Whisper setup short.
  win.on('close', async (event) => {
    if (quitting) return;
    const botBusy = () => bot.running || Boolean(bot.busy);
    if (!unsaved && !botBusy() && !setupRunning) return;
    event.preventDefault();
    if (closePrompt) return;
    closePrompt = true;
    try {
      if (unsaved) {
        const pages = unsaved.includes(' and ') ? 'pages' : 'page';
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['Close without saving', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          title: botName(),
          message: 'You have unsaved changes.',
          detail: `Your changes on the ${unsaved} ${pages} haven't been saved.`,
        });
        if (response !== 0) return;
      }
      if (botBusy() || setupRunning) {
        const { response } = await dialog.showMessageBox(
          win,
          botBusy()
            ? {
                type: 'question',
                buttons: [`Stop ${botName()} and close`, 'Cancel'],
                defaultId: 0,
                cancelId: 1,
                title: botName(),
                message: `${botName()} is running.`,
                detail: 'Closing the app stops him, and he leaves the call.',
              }
            : {
                type: 'question',
                buttons: ['Stop the setup and close', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
                title: botName(),
                message: 'The Whisper setup is still running.',
                detail: 'Closing now stops it partway. Running it again later picks up where it stopped.',
              },
        );
        if (response !== 0) return;
      }
      if (quitting) return;
      quitting = true;
      if (botBusy()) await bot.stop();
      if (setupRunning) await bot.stopHelper();
      win.destroy();
      app.quit();
    } finally {
      closePrompt = false;
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

// One copy of the app at a time: opening it again brings the window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // install-app.bat run again while the app is open: still (re)make the shortcuts.
    if (argv.includes('--install-shortcuts')) updateShortcuts({ make: true });
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    // Links open in the normal browser; the app window never navigates away.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    // Made on request (install-app.bat), and renamed to match if the bot was renamed.
    updateShortcuts({ make: process.argv.includes('--install-shortcuts') });
    createWindow();
    updateWatcher.start();
  });

  // Any other way the app quits: stop the bot and the setup cleanly first. (Windows
  // shutting down or signing out skips this; Windows then ends the bot with the app.)
  app.on('before-quit', (event) => {
    updateWatcher.stop();
    if (quitting || (!bot.running && !bot.busy && !setupRunning)) return;
    event.preventDefault();
    quitting = true;
    Promise.allSettled([bot.stop(), setupRunning ? bot.stopHelper() : null]).finally(() => app.quit());
  });

  app.on('window-all-closed', () => app.quit());
}
