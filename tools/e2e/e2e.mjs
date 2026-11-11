// End-to-end run of the real Winslow app window against a fake bot folder.
// Run: xvfb-run -a node e2e.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('/opt/npm-tools/node_modules/playwright');

const here = path.dirname(new URL(import.meta.url).pathname);
const botDir = path.join(here, 'bot');
const shots = path.join(here, 'shots');
const electronExe = path.join(here, '..', 'electron-44.9.3', 'electron');
const appDir = '/home/claude/gremlin-bot/desktop';

// A stand-in for the local Whisper server. It notes how the app asks after it.
let whisperUp = true;
const healthAsks = [];
const whisper = http
  .createServer((req, res) => {
    if (req.url.startsWith('/health')) healthAsks.push(req.url);
    if (req.url.split('?')[0] === '/health' && whisperUp) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, model: 'large-v3-turbo', uptime_s: 1234, requests: 340 }));
    } else if (req.url === '/shutdown' && req.method === 'POST') {
      whisperUp = false;
      res.writeHead(200);
      res.end('{"ok":true}');
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(8199, '127.0.0.1');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name) => console.log(`- ${name}`);

/** The process id of the (fake) bot the app started: node src/index.js in the bot folder. */
function botPid() {
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (argv.includes('src/index.js') && fs.readlinkSync(`/proc/${pid}/cwd`) === botDir) return Number(pid);
    } catch {
      // gone, or not ours
    }
  }
  return 0;
}

const app = await electron.launch({
  executablePath: electronExe,
  args: [appDir, '--no-sandbox'],
  env: { ...process.env, WINSLOW_BOT_DIR: botDir },
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await page.setViewportSize({ width: 1140, height: 800 }).catch(() => {});
  await page.waitForSelector('#heroTitle');
  await wait(600);

  step('home, offline');
  assert.equal(await page.textContent('#statusText'), 'Offline');
  assert.equal(await page.textContent('#heroTitle'), 'Winslow is offline');
  await page.screenshot({ path: path.join(shots, '01-home-offline.png') });
  // The chattiness saved for the server (memory.json says medium) isn't known until he runs:
  // the control shows the .env default meanwhile.
  assert.equal(await page.getAttribute('#chattinessControl button[data-level="low"]', 'aria-checked'), 'true');
  assert.match(await page.textContent('#hearingBody'), /large-v3-turbo running/);

  step('start: check (Home shows each step), then online with the call');
  await page.click('#btnStart');
  await page.waitForFunction(
    () => document.querySelector('#heroTitle').textContent === 'Running the start-up check...' && /^OK Node\.js version: 22\.22\.0$|^OK Settings|^OK Discord/.test(document.querySelector('#heroSub').textContent),
    null,
    { timeout: 10000 },
  );
  await page.screenshot({ path: path.join(shots, '02a-checking.png') });

  step('chattiness while he is still connecting goes to him (no restart needed)');
  await page.waitForFunction(() => document.querySelector('#statusText').textContent === 'Connecting to Discord...', null, { timeout: 10000 });
  await page.click('#chattinessControl button[data-level="medium"]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Chattiness: medium');
  await wait(400);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'received.json'), 'utf8')).at(-1), { type: 'set-chattiness', level: 'medium' });
  assert.equal(await page.isVisible('#restartBanner'), false);

  await page.waitForFunction(() => document.querySelector('#statusText').textContent.startsWith('Online'), null, { timeout: 15000 });
  assert.equal(await page.textContent('#statusText'), 'Online, in a call');
  assert.match(await page.textContent('#callsBody'), /The Pressure Chamber · Gaming/);
  assert.match(await page.textContent('#callsBody'), /Daniel/);
  assert.equal(await page.isVisible('#checkCard'), true);
  assert.equal(await page.locator('#checkList li.ok').count(), 4);
  assert.equal(await page.locator('#checkList li.skip').count(), 1);
  assert.match(await page.textContent('#hearingBody'), /Whisper large-v3-turbo on your graphics card/);
  assert.equal(await page.isDisabled('#btnWhisperSetup'), true, 'no setup while he runs');
  assert.match(await page.textContent('#spendToday'), /^\$0\.52$/);

  step('home shows the latest warning, with a count, and the pill is amber');
  await page.waitForSelector('#problemCard:not([hidden])');
  assert.equal(await page.textContent('#problemHead'), '1 warning or error since the last start');
  assert.match(await page.textContent('#problemLine'), /\[whisper\] local Whisper is running an older version; restarting it$/);
  assert.match(await page.getAttribute('#statusPill', 'class'), /\bwarn\b/);
  await page.screenshot({ path: path.join(shots, '02-home-online.png') });
  await page.click('#btnSeeLogs');
  assert.equal(await page.getAttribute('.nav-item[data-page="logs"]', 'class'), 'nav-item active');
  assert.equal(await page.getAttribute('#logTabs .tab[data-log="live"]', 'class'), 'tab active');
  await page.waitForFunction(() => document.querySelector('#logView').textContent.includes('local Whisper is running an older version'));
  await page.click('.nav-item[data-page="home"]');

  step('chattiness goes straight to the running bot');
  await page.click('#chattinessControl button[data-level="high"]');
  await page.waitForFunction(() => document.querySelector('#chattinessControl button[data-level="high"]').getAttribute('aria-checked') === 'true');
  await wait(400);
  // (The screen picture he asked for at start-up can arrive in between.)
  const received = JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'received.json'), 'utf8')).filter((m) => m.type !== 'screenshot');
  assert.deepEqual(received.at(-1), { type: 'set-chattiness', level: 'high' });
  assert.match(fs.readFileSync(path.join(botDir, '.env'), 'utf8'), /^CHATTINESS=high$/m);
  assert.equal(await page.isVisible('#restartBanner'), false, 'chattiness needs no restart');

  step('the app sends him a picture of the screen when he asks (the owner said "look at this")');
  const shot = JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'received.json'), 'utf8')).find((m) => m.type === 'screenshot');
  assert.ok(shot, 'answered');
  assert.equal(shot.id, 1);
  assert.ok(typeof shot.jpeg === 'string' && shot.jpeg.startsWith('/9j/'), `a JPEG came back (${shot.error || 'no error'})`);
  const jpeg = Buffer.from(shot.jpeg, 'base64');
  fs.writeFileSync(path.join(shots, '13-screen-for-the-bot.jpg'), jpeg);
  console.log(`  screen picture: ${jpeg.length} bytes`);

  step('call memory: his notes on recent calls, newest first; forgetting one while he runs goes through him');
  await page.click('.nav-item[data-page="personality"]');
  await page.click('#fileTabs .tab[data-file="calls"]');
  await page.waitForSelector('#callsList .saved-call');
  assert.equal(await page.isVisible('#editorCard'), false);
  assert.equal(await page.locator('#callsList .saved-call').count(), 2);
  assert.match(await page.textContent('#callsList .saved-call:first-child'), /Talked about the new patch and who carries\./);
  assert.match(await page.textContent('#callsList .saved-call:first-child'), /The Pressure Chamber #Gaming · 40 min · with Daniel, Mike/);
  assert.match(await page.textContent('#callsHint'), /Call memory is off/);
  await page.screenshot({ path: path.join(shots, '14-call-memory.png') });
  page.once('dialog', (d) => d.accept());
  await page.click('#callsList .saved-call:first-child button');
  await page.waitForFunction(() => document.querySelectorAll('#callsList .saved-call').length === 1, null, { timeout: 5000 });
  assert.equal(await page.textContent('#toast'), 'Forgot it.');
  const askedToForget = JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'received.json'), 'utf8')).find((m) => m.type === 'forget-call');
  assert.equal(askedToForget.id, 'c2');
  assert.equal(askedToForget.guildId, '230425884790620160');
  assert.equal(JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'memory.json'), 'utf8')).guilds['230425884790620160'].calls.length, 1);
  await page.click('#fileTabs .tab[data-file="persona"]');
  await page.waitForFunction(() => document.querySelector('#fileEditor').value.includes('Gremlin') || document.querySelector('#fileEditor').value.length > 0);
  assert.equal(await page.isVisible('#callsCard'), false);
  await page.click('.nav-item[data-page="home"]');

  step('settings: change a few, replace a key, save');
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForSelector('#set-CLAUDE_EFFORT');
  const pageText = await page.textContent('body');
  assert.ok(!pageText.includes('OLD-SECRET'), 'saved keys never reach the window');
  await page.screenshot({ path: path.join(shots, '03-settings.png'), fullPage: false });
  await page.selectOption('#set-CLAUDE_EFFORT', 'medium');
  await page.click('#set-WEB_SEARCH');
  await page.fill('#set-ELEVENLABS_SPEED', '1.1');
  await page.click('[data-field="DISCORD_TOKEN"] button');
  await page.fill('#set-DISCORD_TOKEN', 'NEW-TOKEN-ABC.def');
  assert.match(await page.textContent('#settingsDirtyText'), /4 unsaved changes/);
  await page.screenshot({ path: path.join(shots, '04-settings-dirty.png') });
  await page.click('#btnSettingsSave');
  await page.waitForSelector('#settingsSavebar', { state: 'hidden' });
  const env = fs.readFileSync(path.join(botDir, '.env'), 'utf8');
  assert.match(env, /^CLAUDE_EFFORT=medium$/m);
  assert.match(env, /^WEB_SEARCH=false$/m);
  assert.match(env, /^ELEVENLABS_SPEED=1\.1$/m);
  assert.match(env, /^DISCORD_TOKEN=NEW-TOKEN-ABC\.def$/m);
  assert.match(env, /^CUSTOM_UNKNOWN=keep me$/m, 'unknown settings untouched');
  assert.match(env, /^# How often it jumps in$/m, 'comments untouched');
  assert.equal(await page.isVisible('#restartBanner'), true, 'asks for a restart while he runs');
  assert.match(await page.textContent('[data-field="DISCORD_TOKEN"]'), /Saved/);

  step('a bad value is refused with a clear message');
  await page.fill('#set-WEB_SEARCH_MAX_USES', '9');
  await page.click('#btnSettingsSave');
  await page.waitForSelector('#toast:not([hidden])');
  assert.match(await page.textContent('#toast'), /from 1 to 5/);
  await page.click('#btnSettingsDiscard');

  step('personality: edit and save');
  await page.click('.nav-item[data-page="personality"]');
  await page.waitForFunction(() => document.querySelector('#fileEditor').value.includes('cheerful'));
  await page.screenshot({ path: path.join(shots, '05-personality.png') });
  const edited = (await page.inputValue('#fileEditor')).replace('cheerful', 'witty');
  await page.fill('#fileEditor', edited);
  assert.equal(await page.textContent('#fileStatus'), 'Unsaved changes');
  await page.click('#btnFileSave');
  await page.waitForFunction(() => document.querySelector('#fileStatus').textContent === '');
  assert.match(fs.readFileSync(path.join(botDir, 'persona.md'), 'utf8'), /witty/);
  await page.click('#fileTabs .tab[data-file="lore"]');
  await page.waitForFunction(() => document.querySelector('#fileEditor').value.includes('Inside jokes'));

  step('usage');
  await page.click('.nav-item[data-page="usage"]');
  await page.waitForFunction(() => document.querySelector('#usageTodayTotal').textContent === '$0.52');
  assert.match(await page.textContent('#usageTodayLines'), /6,053 characters spoken/);
  assert.match(await page.textContent('#usageMonthTotal'), /^\$3\.81$/);
  await page.screenshot({ path: path.join(shots, '06-usage.png') });

  step('logs: live output, activity (local times), filter');
  await page.click('.nav-item[data-page="logs"]');
  await page.waitForSelector('#logView .log-line');
  const live = await page.textContent('#logView');
  assert.match(live, /OK {4}Discord: logged in as Winslow#2921/);
  assert.match(live, /chattiness set to high from the app/);
  await page.screenshot({ path: path.join(shots, '07-logs-live.png') });
  await page.click('#logTabs .tab[data-log="activity"]');
  await page.waitForFunction(() => document.querySelector('#logView').textContent.includes('heard Daniel'));
  await page.fill('#logFilter', 'daniel');
  await wait(200);
  assert.equal(await page.locator('#logView .log-line').count(), 4);
  assert.ok(!(await page.textContent('#logView')).includes('2026-10-23 06:22:02'), 'UTC stamp replaced by local time');
  await page.screenshot({ path: path.join(shots, '08-logs-activity.png') });
  await page.fill('#logFilter', '');

  step('stop: asks the bot to leave and save; chattiness picked meanwhile is saved after he exits');
  await page.click('.nav-item[data-page="home"]');
  await page.click('#btnStop');
  await page.waitForFunction(() => document.querySelector('#statusText').textContent === 'Stopping...', null, { timeout: 5000 });
  await page.click('#chattinessControl button[data-level="off"]');
  await page.waitForFunction(() => document.querySelector('#statusText').textContent === 'Offline', null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Chattiness: off');
  const got = JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'received.json'), 'utf8')).filter((m) => m.type !== 'screenshot');
  assert.deepEqual(got.at(-1), { type: 'shutdown' }, 'not sent to a bot that is on his way out');
  assert.equal(JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'memory.json'), 'utf8')).guilds['230425884790620160'].chattiness, 'off');

  step('chattiness while he is off is saved for the server too');
  await page.click('#chattinessControl button[data-level="medium"]');
  await wait(400);
  const memory = JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'memory.json'), 'utf8'));
  assert.equal(memory.guilds['230425884790620160'].chattiness, 'medium');

  step('call memory while he is off: forgetting all of them changes the file directly');
  await page.click('.nav-item[data-page="personality"]');
  await page.click('#fileTabs .tab[data-file="calls"]');
  await page.waitForSelector('#callsList .saved-call');
  page.once('dialog', (d) => d.accept());
  await page.click('#btnForgetAllCalls');
  await page.waitForFunction(() => document.querySelector('#callsList').textContent.includes('Nothing saved yet.'), null, { timeout: 5000 });
  const afterForget = JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'memory.json'), 'utf8')).guilds['230425884790620160'];
  assert.deepEqual(afterForget.calls, []);
  assert.equal(afterForget.chattiness, 'medium', 'everything else is left alone');
  assert.equal(await page.isDisabled('#btnForgetAllCalls'), true);
  await page.click('.nav-item[data-page="home"]');

  step('free graphics memory (Whisper) while he is off');
  assert.equal(await page.isDisabled('#btnWhisperStop'), false);
  await page.click('#btnWhisperStop');
  await page.waitForFunction(() => /not running/.test(document.querySelector('#hearingBody').textContent), null, { timeout: 5000 });
  assert.equal(whisperUp, false);

  step('he stops on his own: Home says why, and the taskbar flashes with a notification');
  whisperUp = true;
  await page.click('#btnStart');
  await page.waitForFunction(() => document.querySelector('#statusText').textContent.startsWith('Online'), null, { timeout: 15000 });
  await app.evaluate(({ BrowserWindow, Notification }) => {
    const w = BrowserWindow.getAllWindows()[0];
    globalThis.__flashes = [];
    globalThis.__notes = [];
    w.isFocused = () => false; // as if he's in a game
    w.flashFrame = (on) => globalThis.__flashes.push(on);
    Notification.isSupported = () => true;
    Notification.prototype.show = function () {
      globalThis.__notes.push({ title: this.title, body: this.body });
    };
  });
  const pid = botPid();
  assert.ok(pid > 0, 'found the bot process');
  process.kill(pid, 'SIGTERM');
  await page.waitForFunction(() => document.querySelector('#statusText').textContent === 'Offline', null, { timeout: 10000 });
  const reason = 'unexpected error: TypeError: boom (at src/session.js:212). Details are in data/bot.log (Logs > Activity in the app).';
  assert.equal(await page.textContent('#heroSub'), `He stopped on his own: ${reason}`);
  assert.equal(await page.textContent('#problemHead'), '2 warnings or errors since the last start');
  assert.match(await page.textContent('#problemLine'), /\[bot\] unexpected error: TypeError: boom/);
  assert.equal(await page.getAttribute('#problemCard', 'class'), 'card problem-card error');
  assert.ok((await app.evaluate(() => globalThis.__flashes)).includes(true), 'the taskbar button flashes');
  assert.deepEqual(await app.evaluate(() => globalThis.__notes), [{ title: 'Winslow stopped', body: `He stopped on his own: ${reason}` }]);
  await page.screenshot({ path: path.join(shots, '11-stopped-on-his-own.png') });
  assert.ok(healthAsks.length > 0 && healthAsks.every((u) => u === '/health?peek=1'), `the window only peeks at Whisper: ${[...new Set(healthAsks)]}`);

  step('closing while he runs stops him first');
  await page.click('#btnStart');
  await page.waitForFunction(() => document.querySelector('#statusText').textContent.startsWith('Online'), null, { timeout: 15000 });
  await app.evaluate(({ dialog }) => {
    globalThis.__asked = [];
    dialog.showMessageBox = async (_win, opts) => {
      globalThis.__asked.push(opts.message);
      await new Promise((r) => setTimeout(r, 1000)); // time to read what was asked
      return { response: 0 };
    };
  });
  fs.writeFileSync(path.join(botDir, 'data', 'received.json'), '[]');
  const closed = new Promise((r) => app.process().once('exit', r));
  // The same as clicking the window's X.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await wait(300);
  assert.deepEqual(await app.evaluate(() => globalThis.__asked), ['Winslow is running.']);
  // (He asks for a picture of the screen each time he starts; its answer can land here.)
  const beforeAnswer = JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'received.json'), 'utf8')).filter((m) => m.type !== 'screenshot');
  assert.deepEqual(beforeAnswer, [], 'nothing is stopped before the answer');
  await Promise.race([closed, wait(15000)]);
  const final = JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'received.json'), 'utf8'));
  assert.deepEqual(final.at(-1), { type: 'shutdown' }, 'the bot was asked to stop before the app quit');

  assert.deepEqual(errors, [], 'no errors in the window');
  console.log('phase 1 OK');
} catch (err) {
  console.error('E2E FAILED:', err);
  console.error('window errors:', errors);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
}

// Phase 2: the Whisper setup. Start is refused while it runs, and closing the app
// mid-setup asks first, then ends the setup instead of leaving it running.
if (!process.exitCode) {
  const pwshDir = path.join(here, '..', 'pwsh', 'bin');
  const app2 = await electron.launch({
    executablePath: electronExe,
    args: [appDir, '--no-sandbox'],
    env: { ...process.env, WINSLOW_BOT_DIR: botDir, PATH: `${pwshDir}:${process.env.PATH}` },
  });
  const errors2 = [];
  try {
    const page = await app2.firstWindow();
    page.on('pageerror', (e) => errors2.push(`pageerror: ${e.message}`));
    await page.waitForSelector('#heroTitle');
    await wait(600);

    step('closing with unsaved edits asks first, and Cancel keeps the window');
    await page.click('.nav-item[data-page="personality"]');
    await page.waitForFunction(() => document.querySelector('#fileEditor').value.includes('witty') && !document.querySelector('#fileEditor').disabled);
    await page.fill('#fileEditor', (await page.inputValue('#fileEditor')) + '\nA new line.');
    // Leaving the page asks too (confirm); say no, so the edit stays.
    await page.evaluate(() => {
      window.confirm = () => false;
    });
    await page.click('.nav-item[data-page="settings"]');
    assert.equal(await page.getAttribute('.nav-item[data-page="personality"]', 'class'), 'nav-item active', 'stayed on the page');
    await wait(200);
    await app2.evaluate(({ dialog }) => {
      globalThis.__asked = [];
      dialog.showMessageBox = async (_win, opts) => {
        globalThis.__asked.push(`${opts.message} ${opts.detail}`);
        return { response: 1 }; // Cancel
      };
    });
    await app2.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await wait(400);
    assert.deepEqual(await app2.evaluate(() => globalThis.__asked), ["You have unsaved changes. Your changes on the Personality page haven't been saved."]);
    assert.equal(await page.isVisible('#fileEditor'), true, 'still open');
    await page.click('#btnFileRevert');
    await wait(200);

    step('renaming the bot in Settings renames it everywhere in the window');
    assert.equal(await page.textContent('#heroTitle'), 'Winslow is offline');
    await page.click('.nav-item[data-page="settings"]');
    await page.waitForSelector('#set-BOT_NAME');
    await page.fill('#set-BOT_NAME', 'Babel');
    await page.click('#btnSettingsSave');
    await page.waitForSelector('#settingsSavebar', { state: 'hidden' });
    assert.match(fs.readFileSync(path.join(botDir, '.env'), 'utf8'), /^BOT_NAME=Babel$/m);
    await page.click('.nav-item[data-page="home"]');
    await page.waitForFunction(() => document.querySelector('#heroTitle').textContent === 'Babel is offline');
    assert.equal(await page.title(), 'Babel');
    assert.equal(await page.textContent('.brand-name'), 'Babel');
    await page.screenshot({ path: path.join(shots, '10-renamed.png') });

    step('a new Whisper model offers to run the setup (he is off)');
    await page.evaluate(() => {
      window.__asked = [];
      window.confirm = (q) => {
        window.__asked.push(q);
        return false;
      };
    });
    await page.click('.nav-item[data-page="settings"]');
    await page.waitForSelector('#set-WHISPER_MODEL');
    await page.selectOption('#set-WHISPER_MODEL', 'large-v3');
    await page.click('#btnSettingsSave');
    await page.waitForSelector('#settingsSavebar', { state: 'hidden' });
    await page.waitForFunction(() => window.__asked.length > 0);
    assert.match((await page.evaluate(() => window.__asked))[0], /^The new Whisper model needs the Whisper setup to download it .*Run the setup now\?$/);
    assert.match(fs.readFileSync(path.join(botDir, '.env'), 'utf8'), /^WHISPER_MODEL=large-v3$/m);
    assert.equal(await page.isVisible('#setupModal'), false, 'not run when the answer is no');

    step('usage that cannot be read says so instead of $0.00');
    const usageFile = path.join(botDir, 'data', 'usage.json');
    fs.renameSync(usageFile, `${usageFile}.bak`);
    fs.mkdirSync(usageFile); // unreadable, like a file OneDrive is holding
    try {
      await page.click('.nav-item[data-page="usage"]');
      await page.waitForSelector('#usageErrorCard:not([hidden])');
      assert.match(await page.textContent('#usageError'), /^Couldn't read usage: Couldn't open usage\.json \(EISDIR\)/);
      assert.equal(await page.textContent('#usageTodayTotal'), '–');
      await page.screenshot({ path: path.join(shots, '12-usage-unreadable.png') });
      await page.click('.nav-item[data-page="home"]');
      assert.equal(await page.textContent('#spendToday'), '–');
      assert.match(await page.textContent('#spendNote'), /^Couldn't read usage:/);
    } finally {
      fs.rmdirSync(usageFile);
      fs.renameSync(`${usageFile}.bak`, usageFile);
    }
    await page.click('.nav-item[data-page="usage"]');
    await page.waitForFunction(() => document.querySelector('#usageTodayTotal').textContent === '$0.52');
    assert.equal(await page.isVisible('#usageErrorCard'), false);

    step('whisper setup: runs, shows its lines, blocks Start');
    await page.click('.nav-item[data-page="home"]');
    await page.evaluate(() => {
      window.confirm = () => true;
    });
    assert.equal(await page.isDisabled('#btnWhisperSetup'), false);
    await page.click('#btnWhisperSetup');
    await page.waitForSelector('#setupModal:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#setupLog').textContent.includes('Downloading the model'), null, { timeout: 20000 });
    await page.screenshot({ path: path.join(shots, '09-whisper-setup.png') });
    const refused = await page.evaluate(() => window.winslow.bot.start(false).then(() => 'started', (e) => String(e.message)));
    assert.match(refused, /Wait for the Whisper setup to finish/);
    const again = await page.evaluate(() => window.winslow.whisper.setup().then(() => 'ran', (e) => String(e.message)));
    assert.match(again, /already running/);

    step('closing mid-setup asks first, then ends the setup');
    // The PowerShell process running the setup script (by its own argument list).
    const script = path.join(botDir, 'whisper', 'setup-whisper.ps1');
    const setupPid = Number(
      fs.readdirSync('/proc').find((pid) => {
        try {
          const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
          return /^\d+$/.test(pid) && path.basename(argv[0]) === 'pwsh' && argv.includes(script);
        } catch {
          return false;
        }
      }),
    );
    assert.ok(setupPid > 0, 'found the setup process');
    assert.ok(setupPid > 0, 'the setup is running');
    await app2.evaluate(({ dialog }) => {
      globalThis.__asked = [];
      dialog.showMessageBox = async (_win, opts) => {
        globalThis.__asked.push(opts.message);
        await new Promise((r) => setTimeout(r, 1000)); // time to read what was asked
        return { response: 0 };
      };
    });
    const closed = new Promise((r) => app2.process().once('exit', r));
    await app2.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await wait(300);
    const messages = await app2.evaluate(() => globalThis.__asked);
    assert.deepEqual(messages, ['The Whisper setup is still running.']);
    await Promise.race([closed, wait(15000)]);
    // Gone, or a zombie waiting to be reaped (nothing left running).
    const running = () => {
      try {
        return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${setupPid}/status`, 'utf8'));
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && running(); i++) await wait(100);
    assert.equal(running(), false, 'the setup was ended with the app');
    assert.deepEqual(errors2, [], 'no errors in the window');
    console.log('E2E OK');
  } catch (err) {
    console.error('E2E FAILED (phase 2):', err);
    console.error('window errors:', errors2);
    process.exitCode = 1;
  } finally {
    await app2.close().catch(() => {});
  }
}
// Phase 3: if the window's page crashes, the app loads it again.
if (!process.exitCode) {
  const app3 = await electron.launch({ executablePath: electronExe, args: [appDir, '--no-sandbox'], env: { ...process.env, WINSLOW_BOT_DIR: botDir } });
  try {
    const page = await app3.firstWindow();
    await page.waitForSelector('#heroTitle');
    await wait(600);
    step('a crashed window page is loaded again');
    await app3.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    let title = '';
    for (let i = 0; i < 50 && !title; i++) {
      await wait(200);
      title = await app3
        .evaluate(({ BrowserWindow }) => {
          const wc = BrowserWindow.getAllWindows()[0].webContents;
          if (wc.isCrashed() || wc.isLoading()) return '';
          return Promise.race([wc.executeJavaScript("document.querySelector('#heroTitle')?.textContent || ''"), new Promise((r) => setTimeout(() => r(''), 500))]);
        })
        .catch(() => '');
    }
    assert.match(title, /^(Winslow|Babel) is offline$/);
    console.log('E2E phase 3 OK');
  } catch (err) {
    console.error('E2E FAILED (phase 3):', err);
    process.exitCode = 1;
  } finally {
    await app3.close().catch(() => {});
  }
}
whisper.close();
