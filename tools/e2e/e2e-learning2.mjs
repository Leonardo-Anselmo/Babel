// End-to-end run of the app window for: the auto-join switch on Home (bot off and on),
// the jokes he kept under Call memory, and loading an update by itself once the call ends.
// Run: sh reset-bot.sh && xvfb-run -a node e2e-learning2.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('/opt/npm-tools/node_modules/playwright');

const here = path.dirname(new URL(import.meta.url).pathname);
const botDir = path.join(here, 'bot');
const shots = path.join(here, 'shots');
const electronExe = path.join(here, '..', 'electron-44.9.3', 'electron');
const appDir = '/home/claude/gremlin-bot/desktop';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (name) => console.log(`- ${name}`);
const memoryFile = path.join(botDir, 'data', 'memory.json');
const received = () => JSON.parse(fs.readFileSync(path.join(botDir, 'data', 'received.json'), 'utf8')).filter((m) => m.type !== 'screenshot');
const G = '230425884790620160';

// Two jokes he kept, and a desktop folder so a change to "the app's own files" can be seen.
const mem = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
mem.guilds[G].landed = [
  { text: 'Weevil and that door: still the best rivalry in gaming.', at: '2026-10-24T03:00:00.000Z', usedAt: null },
  { text: 'Mike carries like a grocery bag with a hole in it.', at: '2026-10-25T03:00:00.000Z', usedAt: null },
];
fs.writeFileSync(memoryFile, JSON.stringify(mem, null, 2));
fs.mkdirSync(path.join(botDir, 'desktop'), { recursive: true });
fs.writeFileSync(path.join(botDir, 'desktop', 'main.mjs'), '// v1\n');
fs.rmSync(path.join(botDir, 'data', 'no-call'), { force: true });
fs.rmSync(path.join(botDir, 'src', 'update-test.js'), { force: true });

const app = await electron.launch({ executablePath: electronExe, args: [appDir, '--no-sandbox'], env: { ...process.env, WINSLOW_BOT_DIR: botDir } });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await page.setViewportSize({ width: 1140, height: 800 }).catch(() => {});
  await page.waitForSelector('#heroTitle');
  await wait(600);

  step('auto-join switch: off by default; turning it on while he is off saves it for the server');
  assert.equal(await page.getAttribute('#autoJoinControl button[data-on="false"]', 'aria-checked'), 'true');
  await page.click('#autoJoinControl button[data-on="true"]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'He joins calls by himself now.');
  assert.match(fs.readFileSync(path.join(botDir, '.env'), 'utf8'), /^AUTO_JOIN=true$/m);
  assert.equal(JSON.parse(fs.readFileSync(memoryFile, 'utf8')).guilds[G].autoJoin, true);
  assert.equal(await page.getAttribute('#autoJoinControl button[data-on="true"]', 'aria-checked'), 'true');
  await page.screenshot({ path: path.join(shots, '20-autojoin-off-bot.png') });

  step('start: he reports it on; turning it off goes straight to him, no restart');
  await page.click('#btnStart');
  await page.waitForFunction(() => document.querySelector('#statusText').textContent.startsWith('Online'), null, { timeout: 20000 });
  assert.equal(await page.getAttribute('#autoJoinControl button[data-on="true"]', 'aria-checked'), 'true');
  await page.click('#autoJoinControl button[data-on="false"]');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'He joins only with /join now.');
  await wait(400);
  assert.deepEqual(received().at(-1), { type: 'set-auto-join', on: false });
  assert.match(fs.readFileSync(path.join(botDir, '.env'), 'utf8'), /^AUTO_JOIN=false$/m);
  assert.equal(await page.isVisible('#restartBanner'), false, 'no restart needed');
  await page.screenshot({ path: path.join(shots, '21-autojoin-running.png') });

  step('call memory lists the jokes he kept; forget all (while he runs) clears them too');
  await page.click('.nav-item[data-page="personality"]');
  await page.click('#fileTabs .tab[data-file="calls"]');
  await page.waitForSelector('#callsList .saved-call');
  const list = await page.textContent('#callsList');
  assert.match(list, /Jokes that got a laugh/);
  assert.ok(list.indexOf('Mike carries') < list.indexOf('Weevil and that door'), 'newest first');
  await page.screenshot({ path: path.join(shots, '22-kept-jokes.png') });
  page.once('dialog', (d) => d.accept());
  await page.click('#btnForgetAllCalls');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Forgot 2 calls and 2 jokes.', null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('#callsList').textContent.includes('Nothing saved yet.'), null, { timeout: 5000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(memoryFile, 'utf8')).guilds[G].landed, []);
  await page.click('.nav-item[data-page="home"]');

  step('an update while he is in a call waits, and the window says so');
  fs.writeFileSync(path.join(botDir, 'src', 'update-test.js'), '// new code\n');
  await page.waitForSelector('#updateBanner:not([hidden])', { timeout: 40000 });
  assert.match(await page.textContent('#updateText'), /Winslow has an update waiting\. He restarts to load it once nobody is in a call with him\./);
  await page.screenshot({ path: path.join(shots, '23-update-waiting.png') });

  step('the call ends: he restarts by himself to load it');
  const startsBefore = (await page.textContent('#logView').catch(() => '')) || '';
  fs.writeFileSync(path.join(botDir, 'data', 'no-call'), '');
  await page.waitForFunction(() => document.querySelector('#updateBanner').hidden, null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#statusText').textContent.startsWith('Online'), null, { timeout: 30000 });
  await page.click('.nav-item[data-page="logs"]');
  await page.waitForFunction(() => document.querySelector('#logView').textContent.includes('Loading an update: restarting him'), null, { timeout: 10000 });
  assert.ok(startsBefore !== null);
  await page.click('.nav-item[data-page="home"]');
  await wait(16000);
  assert.equal(await page.isVisible('#updateBanner'), false, 'loaded: nothing waiting any more');

  step("the app's own files change: only a note to reopen it");
  fs.writeFileSync(path.join(botDir, 'desktop', 'main.mjs'), '// v2\n');
  await page.waitForSelector('#updateBanner:not([hidden])', { timeout: 15000 });
  assert.match(await page.textContent('#updateText'), /The app itself was updated\. Close it and open it again/);
  assert.equal(await page.isVisible('#btnUpdateRestart'), false);
  await page.screenshot({ path: path.join(shots, '24-app-updated.png') });

  assert.deepEqual(errors, [], 'no errors in the window');
  console.log('E2E learning2 OK');
} catch (err) {
  console.error('E2E FAILED:', err);
  console.error('window errors:', errors);
  process.exitCode = 1;
} finally {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  }).catch(() => {});
  await app.close().catch(() => {});
  fs.rmSync(path.join(botDir, 'data', 'no-call'), { force: true });
  fs.rmSync(path.join(botDir, 'src', 'update-test.js'), { force: true });
  fs.rmSync(path.join(botDir, 'desktop'), { recursive: true, force: true });
}
