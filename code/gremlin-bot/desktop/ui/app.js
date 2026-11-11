// The app window. Everything it does on the PC goes through window.winslow
// (preload.cjs); this file only draws the screens and reacts to clicks.

const api = window.winslow;
const $ = (id) => document.getElementById(id);

const state = {
  bot: null, // { state, startedAt, lastExit, check, status }
  page: 'home',
  settings: null, // groups from the app
  dirty: new Map(), // setting key -> new value
  revealed: new Set(), // secret fields with the "replace" box open
  file: 'persona',
  fileOriginal: '',
  logTab: 'live',
  lines: [],
  whisper: null,
  setupRunning: false,
  unsavedReported: '', // what the app was last told has unsaved edits
  name: 'the bot', // the bot's name from its settings
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function cleanError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

let toastTimer = null;
function toast(text, bad = false, ms = bad ? 6000 : 2600) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

async function attempt(fn, okText) {
  try {
    const r = await fn();
    if (okText) toast(okText);
    return r;
  } catch (err) {
    toast(cleanError(err), true);
    return undefined;
  }
}

/** Hint text with {bot} filled in with the bot's name. */
function withName(text) {
  return text.replaceAll('{bot}', state.name);
}

/** The bot's name (from Settings) everywhere the window shows it. */
function applyName(name) {
  state.name = name || 'the bot';
  document.title = state.name;
  for (const node of document.querySelectorAll('.bot-name')) node.textContent = state.name;
  if (state.bot) renderHome();
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function showRestartBanner() {
  $('restartBanner').hidden = !isRunning() || Boolean(state.update?.waiting);
}

function isRunning() {
  return state.bot && ['starting', 'running'].includes(state.bot.state);
}

function isBusy() {
  return state.bot && ['preparing', 'checking', 'starting', 'stopping'].includes(state.bot.state);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const TITLES = { home: 'Home', settings: 'Settings', personality: 'Personality', usage: 'Usage', logs: 'Logs' };

function showPage(page) {
  if (state.page === 'personality' && page !== 'personality' && fileChanged()) {
    if (!confirm('Leave without saving your changes?')) return;
    $('fileEditor').value = state.fileOriginal; // dropped, as asked
    $('fileStatus').textContent = '';
    reportUnsaved();
  }
  state.page = page;
  for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.page === page);
  for (const p of document.querySelectorAll('.page')) p.classList.toggle('active', p.id === `page-${page}`);
  $('pageTitle').textContent = TITLES[page];
  if (page === 'settings' && !state.dirty.size) loadSettings();
  if (page === 'personality') loadFile(state.file);
  if (page === 'usage') loadUsage();
  if (page === 'logs') refreshLog();
  if (page === 'home') refreshWhisper();
}

for (const b of document.querySelectorAll('.nav-item')) b.addEventListener('click', () => showPage(b.dataset.page));

// ---------------------------------------------------------------------------
// Status bar and Home
// ---------------------------------------------------------------------------

const STATE_TEXT = {
  stopped: ['Offline', ''],
  preparing: ['Getting ready...', 'busy'],
  checking: ['Running the start-up check...', 'busy'],
  'check-failed': ['Start-up check found problems', 'bad'],
  starting: ['Connecting to Discord...', 'busy'],
  running: ['Online', 'ok'],
  stopping: ['Stopping...', 'busy'],
};

function applyBotState(s) {
  state.bot = s;
  renderStatusBar();
  renderHome();
}

// How long a warning or error keeps the Online pill amber.
const RECENT_PROBLEM_MS = 5 * 60 * 1000;

/** The latest warning or error, if it came in the last few minutes. */
function recentProblem() {
  const last = state.bot?.problems?.last;
  return last && Date.now() - last.at < RECENT_PROBLEM_MS ? last : null;
}

function renderStatusBar() {
  const s = state.bot?.state || 'stopped';
  let [text, tone] = STATE_TEXT[s] || [s, ''];
  const calls = state.bot?.status?.calls || [];
  if (s === 'running' && calls.length) text = `Online, in a call`;
  const problem = s === 'running' && recentProblem();
  if (problem) tone = 'warn';
  $('statusText').textContent = text;
  $('statusPill').className = `pill ${tone}`;
  $('statusPill').title = problem ? `A warning or error at ${clock(problem.at)}. Home shows it.` : '';
  $('btnStart').hidden = !(s === 'stopped' || s === 'check-failed');
  $('btnStart').textContent = s === 'check-failed' ? 'Check again' : 'Start';
  $('btnStop').hidden = s === 'stopped' || s === 'check-failed';
  $('btnStop').disabled = s === 'stopping';
  $('btnRestart').hidden = s !== 'running';
  if (!isRunning()) $('restartBanner').hidden = true;
}

/** The newest line from the app or the start-up check since a time: what it's doing right now. */
function newestStep(since) {
  if (!since) return '';
  for (let i = state.lines.length - 1; i >= 0 && state.lines[i].at >= since; i--) {
    const e = state.lines[i];
    if ((e.source === 'app' || e.source === 'check') && e.text.trim()) return e.text.replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return '';
}

function renderHero() {
  const b = state.bot || { state: 'stopped' };
  const st = b.status;
  let title = `${state.name} is offline`;
  let sub = 'Press Start to bring him online.';
  if (b.state === 'running') {
    title = `${state.name} is online`;
    const servers = st?.servers?.length || 0;
    sub = `Logged in as ${st?.user || state.name}, in ${servers} server${servers === 1 ? '' : 's'}.`;
  } else if (b.state === 'preparing') {
    title = 'Getting ready...';
    sub = newestStep(b.runStartedAt) || 'Checking Node.js and the libraries.';
  } else if (b.state === 'checking') {
    title = 'Running the start-up check...';
    sub = newestStep(b.runStartedAt) || 'Testing every key and the voice.';
  } else if (b.state === 'starting') {
    title = 'Connecting to Discord...';
    sub = newestStep(b.startedAt) || 'Almost there.';
  } else if (b.state === 'stopping') {
    title = 'Stopping...';
    sub = 'Leaving the call and saving.';
  } else if (b.state === 'check-failed') {
    title = `${state.name} didn't start`;
    sub = 'The start-up check below found a problem.';
  } else if (b.lastExit && !b.lastExit.expected) {
    sub = b.lastExit.reason ? `He stopped on his own: ${b.lastExit.reason}` : 'He stopped on his own. Logs > Live output shows why.';
  }
  $('heroTitle').textContent = title;
  $('heroSub').textContent = sub;
  $('heroMeta').textContent = b.state === 'running' && b.startedAt ? `Up ${duration(Date.now() - b.startedAt)}` : '';
}

/** The latest warning or error since the last start, with how many there were. */
function renderProblems() {
  const p = state.bot?.problems;
  $('problemCard').hidden = !p?.count;
  if (!p?.count) return;
  const isError = p.last.source !== 'bot' || /^\S+ \S+ ERROR\s/.test(p.last.text);
  $('problemCard').classList.toggle('error', isError);
  $('problemHead').textContent = `${p.count === 1 ? '1 warning or error' : `${p.count} warnings or errors`} since the last start`;
  $('problemLine').replaceChildren(el('span', { class: 'log-time', text: clock(p.last.at) }), p.last.text.replace(/^\S+ \S+ (WARN|ERROR)\s+/, ''));
}

function renderHome() {
  const b = state.bot || { state: 'stopped' };
  const st = b.status;
  const icon = document.querySelector('.hero-icon');
  icon.classList.toggle('off', b.state !== 'running');
  renderHero();
  renderProblems();
  $('checkFailedCard').hidden = b.state !== 'check-failed';

  // Calls
  const callsBody = $('callsBody');
  callsBody.replaceChildren();
  const calls = st?.calls || [];
  if (b.state !== 'running') {
    callsBody.append(el('span', { class: 'muted', text: 'He can join a call once he is online.' }));
  } else if (!calls.length) {
    const text = currentAutoJoin()
      ? 'Not in a call. He joins by himself once two or more people are in a voice channel, or type /join in Discord.'
      : 'Not in a call. Type /join in Discord to bring him in.';
    callsBody.append(el('span', { class: 'muted', text }));
  } else {
    for (const c of calls) {
      callsBody.append(
        el(
          'div',
          { class: 'call' },
          el('div', { class: 'call-title', text: `${c.server} · ${c.channel || 'voice'}` }),
          el('div', { class: 'muted small', text: c.since ? `For ${duration(Date.now() - c.since)}` : 'Joining...' }),
          el('div', { class: 'chips' }, c.people.length ? c.people.map((p) => el('span', { class: 'chip', text: p })) : el('span', { class: 'muted small', text: 'Nobody else is there.' })),
        ),
      );
    }
  }

  renderChattiness();
  renderAutoJoin();
  renderHearing();
  renderCheck();
}

function currentChattiness() {
  const servers = state.bot?.status?.servers;
  if (servers?.length) return servers[0].chattiness;
  const f = findField('CHATTINESS');
  return f ? f.value || f.default : 'low';
}

function renderChattiness() {
  const level = currentChattiness();
  for (const b of $('chattinessControl').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.level === level));
  }
}

for (const b of $('chattinessControl').querySelectorAll('button')) {
  b.addEventListener('click', async () => {
    const level = b.dataset.level;
    const r = await attempt(() => api.settings.save({ CHATTINESS: level }), `Chattiness: ${level}`);
    if (!r) return;
    const f = findField('CHATTINESS');
    if (f) f.value = level;
    if (state.bot?.status?.servers) for (const s of state.bot.status.servers) s.chattiness = level;
    renderChattiness();
  });
}

/** Whether he joins calls by himself: what he reports (servers share it), or the setting. */
function currentAutoJoin() {
  const servers = state.bot?.status?.servers;
  if (servers?.length && typeof servers[0].autoJoin === 'boolean') return servers[0].autoJoin;
  const f = findField('AUTO_JOIN');
  return (f ? f.value || f.default : 'false') === 'true';
}

function renderAutoJoin() {
  const on = currentAutoJoin();
  for (const b of $('autoJoinControl').querySelectorAll('button')) b.setAttribute('aria-checked', String((b.dataset.on === 'true') === on));
}

for (const b of $('autoJoinControl').querySelectorAll('button')) {
  b.addEventListener('click', async () => {
    const on = b.dataset.on === 'true';
    if (on === currentAutoJoin()) return;
    const r = await attempt(() => api.settings.save({ AUTO_JOIN: String(on) }), on ? 'He joins calls by himself now.' : 'He joins only with /join now.');
    if (!r) return;
    const f = findField('AUTO_JOIN');
    if (f) f.value = String(on);
    if (state.bot?.status?.servers) for (const s of state.bot.status.servers) s.autoJoin = on;
    renderHome();
  });
}

function renderHearing() {
  const body = $('hearingBody');
  body.replaceChildren();
  const st = state.bot?.status;
  const provider = findField('STT_PROVIDER');
  const LABELS = { whisper: 'Whisper on your graphics card', deepgram: 'Deepgram', elevenlabs: 'ElevenLabs' };
  const configured = provider ? provider.value || provider.default : '';
  const using = st?.hearing?.detail || LABELS[configured] || configured;
  const w = state.whisper;
  const rows = [
    ['Listening with', using || 'unknown'],
    ['Whisper', w ? `${w.model} running, up ${duration((w.uptime_s || 0) * 1000)}` : 'not running'],
  ];
  for (const [k, v] of rows) body.append(el('span', { class: 'k', text: k }), el('span', { text: v }));
  const offline = !isRunning() && !isBusy();
  $('btnWhisperSetup').disabled = !offline || state.setupRunning;
  $('btnWhisperStop').disabled = !offline || !w;
  $('hearingHint').textContent = offline
    ? w
      ? `Whisper frees its graphics memory 5 minutes after ${state.name} stops, or right away with the button.`
      : `Whisper starts with ${state.name}.`
    : `Stop ${state.name} to run the setup or free the graphics memory.`;
}

function renderCheck() {
  const check = state.bot?.check;
  $('checkCard').hidden = !check;
  if (!check) return;
  $('checkWhen').textContent = `Ran at ${clock(check.at)}`;
  const list = $('checkList');
  list.replaceChildren();
  const marks = { ok: '✓', fail: '✗', skip: '–' };
  for (const item of check.items) {
    list.append(
      el(
        'li',
        { class: item.result },
        el('span', { class: 'mark', text: marks[item.result] || '?' }),
        el('div', {}, el('div', { text: item.label }), item.detail ? el('div', { class: 'detail', text: item.detail }) : null),
      ),
    );
  }
}

async function refreshWhisper() {
  state.whisper = await api.whisper.health().catch(() => null);
  renderHearing();
}

/** Today's and this month's spending on Home. If usage.json can't be read, it says so instead of $0.00. */
async function refreshSpend() {
  let r = null;
  let problem = '';
  try {
    r = await api.usage.get();
  } catch (err) {
    problem = cleanError(err);
  }
  $('spendNote').hidden = Boolean(r);
  if (!r) {
    $('spendToday').textContent = '–';
    $('spendMonth').textContent = '–';
    $('spendNote').textContent = `Couldn't read usage: ${problem}`;
    return { problem };
  }
  $('spendToday').textContent = r.today.total;
  $('spendMonth').textContent = r.month.total;
  $('spendMonthLabel').textContent = r.monthName;
  return r;
}

$('btnStart').addEventListener('click', () => attempt(() => api.bot.start(false)));
$('btnStop').addEventListener('click', () => attempt(() => api.bot.stop()));
$('btnRestart').addEventListener('click', () => attempt(() => api.bot.restart()));
$('btnStartAnyway').addEventListener('click', () => attempt(() => api.bot.start(true)));
$('btnGoKeys').addEventListener('click', () => showPage('settings'));
$('btnBannerRestart').addEventListener('click', () => {
  $('restartBanner').hidden = true;
  attempt(() => api.bot.restart());
});
$('btnBannerClose').addEventListener('click', () => ($('restartBanner').hidden = true));
$('spendCard').addEventListener('click', () => showPage('usage'));
$('btnSeeLogs').addEventListener('click', () => {
  state.logTab = 'live';
  for (const x of $('logTabs').querySelectorAll('.tab')) x.classList.toggle('active', x.dataset.log === 'live');
  $('logView').dataset.scrolled = '';
  showPage('logs');
});

$('btnWhisperStop').addEventListener('click', async () => {
  const ok = await attempt(() => api.whisper.stop());
  if (ok) toast('Whisper stopped. Its graphics memory is free.');
  setTimeout(refreshWhisper, 800);
});

$('btnWhisperSetup').addEventListener('click', () => {
  if (confirm('Run the Whisper setup now? It can download a few GB and takes a few minutes.')) runWhisperSetup();
});

async function runWhisperSetup() {
  state.setupRunning = true;
  renderHearing();
  $('setupLog').replaceChildren();
  $('setupState').textContent = 'Running...';
  $('btnSetupClose').disabled = true;
  $('setupModal').hidden = false;
  let r;
  try {
    r = await api.whisper.setup();
  } catch (err) {
    appendSetupLine(cleanError(err));
  }
  state.setupRunning = false;
  $('setupState').textContent = r?.ok ? 'Done. Whisper is ready.' : 'Stopped with a problem (see the lines above).';
  $('btnSetupClose').disabled = false;
  renderHearing();
  refreshWhisper();
}

/** A new Whisper model has to be downloaded by the setup before he can use it. */
function offerWhisperSetup() {
  if (!isRunning() && !isBusy() && !state.setupRunning) {
    if (confirm('The new Whisper model needs the Whisper setup to download it (a few GB; if it is already there, the setup only checks it). Run the setup now?')) runWhisperSetup();
  } else {
    toast(`The new Whisper model needs the Whisper setup: stop ${state.name}, then press Run Whisper setup on Home.`, false, 8000);
  }
}
$('btnSetupClose').addEventListener('click', () => ($('setupModal').hidden = true));

function appendSetupLine(text) {
  const log = $('setupLog');
  log.append(el('span', { class: 'log-line', text }));
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function findField(key) {
  for (const g of state.settings || []) for (const f of g.fields) if (f.key === key) return f;
  return null;
}

async function loadSettings() {
  const r = await attempt(() => api.settings.get());
  if (!r) return;
  state.settings = r.groups;
  state.dirty.clear();
  state.revealed.clear();
  renderSettings();
  renderChattiness();
  renderAutoJoin();
  renderHearing();
}

function shown(f) {
  return f.value !== '' && f.value !== undefined ? f.value : f.default ?? '';
}

function setDirty(f, value) {
  if (f.type === 'secret' ? value === '' : value === shown(f)) state.dirty.delete(f.key);
  else state.dirty.set(f.key, value);
  document.querySelector(`[data-field="${f.key}"]`)?.classList.toggle('changed', state.dirty.has(f.key));
  const n = state.dirty.size;
  $('settingsSavebar').hidden = n === 0;
  $('settingsDirtyText').textContent = `${n} unsaved change${n === 1 ? '' : 's'}`;
  reportUnsaved();
}

// Tells the app which pages have unsaved edits, so closing the window can warn first.
function reportUnsaved() {
  const where = [state.dirty.size ? 'Settings' : '', fileChanged() ? 'Personality' : ''].filter(Boolean).join(' and ');
  if (where === state.unsavedReported) return;
  state.unsavedReported = where;
  api.app.setUnsaved(where).catch(() => {});
}

function control(f) {
  const id = `set-${f.key}`;
  const current = state.dirty.has(f.key) ? state.dirty.get(f.key) : shown(f);
  switch (f.type) {
    case 'select':
      return el(
        'select',
        { id, onchange: (e) => setDirty(f, e.target.value) },
        f.options.map((o) => el('option', { value: o, text: o === f.default ? `${o} (default)` : o, selected: o === current })),
      );
    case 'toggle': {
      const btn = el('button', { class: 'switch', id, role: 'switch', type: 'button', 'aria-checked': String(current === 'true'), 'aria-label': f.label });
      btn.addEventListener('click', () => {
        const next = btn.getAttribute('aria-checked') === 'true' ? 'false' : 'true';
        btn.setAttribute('aria-checked', next);
        setDirty(f, next);
      });
      return btn;
    }
    case 'number':
      return el('input', { id, type: 'number', min: String(f.min), max: String(f.max), step: String(f.step), value: current, placeholder: f.default, oninput: (e) => setDirty(f, e.target.value) });
    case 'secret': {
      const wrap = el('div', { class: 'field-control' });
      const status = el('span', { class: `secret-state ${f.isSet ? 'set' : 'unset'}`, text: f.isSet ? 'Saved' : 'Not set' });
      if (!state.revealed.has(f.key)) {
        wrap.append(
          status,
          el('button', {
            class: 'btn btn-small',
            type: 'button',
            text: f.isSet ? 'Replace' : 'Add',
            onclick: () => {
              state.revealed.add(f.key);
              wrap.replaceWith(control(f));
              document.getElementById(id)?.focus();
            },
          }),
        );
        return wrap;
      }
      const input = el('input', { id, type: 'password', placeholder: 'Paste the new key', autocomplete: 'off', spellcheck: 'false', oninput: (e) => setDirty(f, e.target.value.trim()) });
      const show = el('button', {
        class: 'btn btn-small',
        type: 'button',
        text: 'Show',
        onclick: () => {
          input.type = input.type === 'password' ? 'text' : 'password';
          show.textContent = input.type === 'password' ? 'Show' : 'Hide';
        },
      });
      wrap.append(input, show);
      return wrap;
    }
    default: {
      const input = el('input', { id, type: 'text', value: current, placeholder: f.default || '', spellcheck: 'false', oninput: (e) => setDirty(f, e.target.value) });
      if (f.suggestions) {
        const listId = `${id}-list`;
        input.setAttribute('list', listId);
        return el('div', { class: 'field-control' }, input, el('datalist', { id: listId }, f.suggestions.map((s) => el('option', { value: s }))));
      }
      return input;
    }
  }
}

function renderSettings() {
  const root = $('settingsGroups');
  root.replaceChildren();
  for (const g of state.settings || []) {
    root.append(
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-head' }, el('h2', { text: g.title })),
        g.blurb ? el('p', { class: 'muted small group-blurb', text: g.blurb }) : null,
        g.fields.map((f) =>
          el(
            'div',
            { class: `field${state.dirty.has(f.key) ? ' changed' : ''}`, 'data-field': f.key },
            el('div', {}, el('label', { class: 'field-label', for: `set-${f.key}`, text: f.label }), f.help ? el('div', { class: 'field-help', text: f.help }) : null),
            el('div', { class: 'field-control' }, control(f)),
          ),
        ),
      ),
    );
  }
  $('settingsSavebar').hidden = state.dirty.size === 0;
  reportUnsaved();
}

$('btnSettingsDiscard').addEventListener('click', () => {
  state.dirty.clear();
  state.revealed.clear();
  renderSettings();
});

$('btnSettingsSave').addEventListener('click', async () => {
  const changes = Object.fromEntries(state.dirty);
  const r = await attempt(() => api.settings.save(changes));
  if (!r) return;
  toast(r.saved.length === 1 ? 'Saved.' : `Saved ${r.saved.length} settings.`);
  if (r.restartNeeded) showRestartBanner();
  if (r.saved.includes('BOT_NAME')) applyName((await api.app.info().catch(() => null))?.botName);
  await loadSettings();
  if (r.saved.includes('WHISPER_MODEL')) offerWhisperSetup();
});

// ---------------------------------------------------------------------------
// Personality and lore
// ---------------------------------------------------------------------------

// Bits in {code} show as code, so the comment marks read right.
const FILE_HINTS = {
  persona: ['How {bot} talks and acts, written as instructions to him ("You are...", "Never..."). ', { code: '{name}' }, ' becomes his name, and notes between ', { code: '<!--' }, ' and ', { code: '-->' }, ' are ignored. Changes apply when he restarts.'],
  lore: ['Facts about your group he should always know, one per line: who is who, running jokes, the games you play. Friends can also teach him things live with ', { code: '/remember' }, '. Notes between ', { code: '<!--' }, ' and ', { code: '-->' }, ' are ignored.'],
};

function fileChanged() {
  return $('fileEditor').value !== state.fileOriginal;
}

function setFileEditable(on) {
  for (const id of ['fileEditor', 'btnFileSave', 'btnFileRevert']) $(id).disabled = !on;
}

async function loadFile(name) {
  if (name === 'calls') return loadCalls();
  state.file = name;
  for (const t of $('fileTabs').querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.file === name);
  $('editorCard').hidden = false;
  $('callsCard').hidden = true;
  $('fileHint').replaceChildren(...FILE_HINTS[name].map((part) => (typeof part === 'string' ? withName(part) : el('code', { text: part.code }))));
  // Nothing can be saved until this file has really been read, so a failed read can't
  // end with another file's text (or nothing) saved over it.
  setFileEditable(false);
  state.fileOriginal = '';
  $('fileEditor').value = '';
  $('fileStatus').textContent = 'Opening...';
  reportUnsaved();
  const text = await attempt(() => api.files.get(name));
  if (state.file !== name) return; // switched to the other file meanwhile
  if (text === undefined) {
    $('fileStatus').textContent = "Couldn't open it";
    return;
  }
  state.fileOriginal = text;
  $('fileEditor').value = text;
  $('fileStatus').textContent = '';
  setFileEditable(true);
}

// ---------------------------------------------------------------------------
// Call memory: his notes on recent calls (CALL_MEMORY), to read and delete
// ---------------------------------------------------------------------------

async function loadCalls() {
  state.file = 'calls';
  for (const t of $('fileTabs').querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.file === 'calls');
  $('editorCard').hidden = true;
  $('callsCard').hidden = false;
  // No file is open on this tab, so nothing here counts as unsaved.
  state.fileOriginal = '';
  $('fileEditor').value = '';
  reportUnsaved();
  const on = settingValue('CALL_MEMORY') === 'true';
  $('callsHint').textContent = withName(
    on
      ? "{bot} keeps short notes on each call (at most 10 per server) and reads them at the start of the next one, so he can bring things up later. /join tells everyone it's on. Forget any of them here."
      : 'Call memory is off (Settings > Personality and behavior > Remember calls), so no new notes are kept. Notes from before are below until you forget them.',
  );
  $('callsList').replaceChildren(el('p', { class: 'muted small', text: 'Opening...' }));
  const [calls, jokes] = await Promise.all([attempt(() => api.calls.get()), attempt(() => api.calls.jokes())]);
  if (state.file !== 'calls') return;
  renderCalls(calls, jokes || []);
}

/** A setting's saved value from the Settings page data ('' if it isn't loaded or set). */
function settingValue(key) {
  for (const g of state.settings || []) for (const f of g.fields) if (f.key === key) return f.value || f.default || '';
  return '';
}

function callWhen(c) {
  const d = new Date(c.at);
  if (Number.isNaN(d.getTime())) return 'A call';
  return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderCalls(calls, jokes = []) {
  const list = $('callsList');
  $('btnForgetAllCalls').disabled = !calls?.length && !jokes.length;
  if (calls === undefined) {
    list.replaceChildren(el('p', { class: 'muted small', text: "Couldn't read them." }));
    return;
  }
  // The jokes of his that got a laugh, which he may call back to in a later call.
  const kept = jokes.length
    ? el(
        'div',
        { class: 'saved-call' },
        el('div', { class: 'saved-call-head' }, el('strong', { text: 'Jokes that got a laugh' })),
        el('p', { class: 'muted small', text: withName('{bot} may call back to these in a later call. Forget all clears them too.') }),
        ...jokes.map((j) => el('p', { class: 'saved-call-summary', text: `"${j.text}"` })),
      )
    : null;
  if (!calls.length) {
    list.replaceChildren(el('p', { class: 'muted small', text: kept ? 'No notes on calls saved yet.' : 'Nothing saved yet.' }), ...(kept ? [kept] : []));
    return;
  }
  list.replaceChildren(
    ...(kept ? [kept] : []),
    ...calls.map((c) => {
      const where = [c.server, c.channel && `#${c.channel}`].filter(Boolean).join(' ');
      const length = c.minutes >= 1 ? duration(c.minutes * 60000) : '';
      const meta = [where, length, c.people.length ? `with ${c.people.join(', ')}` : ''].filter(Boolean).join(' · ');
      return el(
        'div',
        { class: 'saved-call' },
        el(
          'div',
          { class: 'saved-call-head' },
          el('strong', { text: callWhen(c) }),
          el('button', { class: 'btn btn-small', text: 'Forget', onclick: () => forgetCalls(c) }),
        ),
        meta ? el('p', { class: 'muted small', text: meta }) : null,
        el('p', { class: 'saved-call-summary', text: c.summary }),
      );
    }),
  );
}

async function forgetCalls(call = null) {
  const question = call ? `Forget the notes on the call from ${callWhen(call)}?` : 'Forget the notes on every saved call, and the jokes he kept?';
  if (!confirm(question)) return;
  const r = await attempt(() => (call ? api.calls.forget(call.guildId, call.id) : api.calls.forget(null, null)));
  if (!r) return;
  const what = [r.count ? (r.count === 1 && call ? 'it' : `${r.count} call${r.count === 1 ? '' : 's'}`) : '', r.jokes ? `${r.jokes} joke${r.jokes === 1 ? '' : 's'}` : ''].filter(Boolean);
  toast(what.length ? `Forgot ${what.join(' and ')}.` : 'Nothing to forget.');
  if (state.file === 'calls') loadCalls();
}

$('btnForgetAllCalls').addEventListener('click', () => forgetCalls());

for (const t of $('fileTabs').querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    if (t.dataset.file === state.file) return;
    if (fileChanged() && !confirm('Switch without saving your changes?')) return;
    loadFile(t.dataset.file);
  });
}

$('fileEditor').addEventListener('input', () => {
  $('fileStatus').textContent = fileChanged() ? 'Unsaved changes' : '';
  reportUnsaved();
});

$('btnFileRevert').addEventListener('click', () => {
  $('fileEditor').value = state.fileOriginal;
  $('fileStatus').textContent = '';
  reportUnsaved();
});

$('btnFileSave').addEventListener('click', async () => {
  const file = state.file;
  const text = $('fileEditor').value;
  const r = await attempt(() => api.files.save(file, text), 'Saved.');
  if (!r || state.file !== file) return;
  state.fileOriginal = text;
  $('fileStatus').textContent = fileChanged() ? 'Unsaved changes' : '';
  reportUnsaved();
  if (r.restartNeeded) showRestartBanner();
});

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function fillUsage(listId, view) {
  const list = $(listId);
  list.replaceChildren();
  for (const line of view.lines.filter((l) => !l.startsWith('Total'))) list.append(el('li', { text: line }));
}

async function loadUsage() {
  const r = await refreshSpend();
  $('usageErrorCard').hidden = !r.problem;
  if (r.problem) {
    $('usageError').textContent = `Couldn't read usage: ${r.problem}`;
    for (const id of ['usageTodayTotal', 'usageMonthTotal']) $(id).textContent = '–';
    for (const id of ['usageTodayLines', 'usageMonthLines']) $(id).replaceChildren();
    return;
  }
  $('usageTodayTotal').textContent = r.today.total;
  $('usageMonthTotal').textContent = r.month.total;
  $('usageMonthTitle').textContent = r.monthName;
  fillUsage('usageTodayLines', r.today);
  fillUsage('usageMonthLines', r.month);
}

$('btnCredits').addEventListener('click', async () => {
  const body = $('creditsBody');
  body.replaceChildren(el('span', { class: 'muted', text: 'Asking...' }));
  const r = await attempt(() => api.usage.credits());
  body.replaceChildren();
  body.classList.remove('muted');
  if (!r) return;
  const rows = [];
  rows.push([
    'ElevenLabs',
    r.eleven
      ? `${r.eleven.left.toLocaleString()} of ${r.eleven.limit.toLocaleString()} credits left${r.eleven.resets ? `, renews ${r.eleven.resets}` : ''}`
      : "Couldn't check (the key needs User read permission).",
  ]);
  rows.push(['Deepgram', r.deepgram ? `${r.deepgram.dollars} left` : "Couldn't check (no key, or it can't read balances)."]);
  for (const [k, v] of rows) body.append(el('span', { class: 'k', text: k }), el('span', { text: v }));
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

const LOG_HINTS = {
  live: 'What {bot} and the start-up check print, since the app opened.',
  activity: 'Who spoke, how long, and what {bot} did about it (no words, unless you turned that on in Settings). Times are yours.',
  whisper: 'The speech server on your graphics card: loading, and short clips it double-checked.',
};

let logText = []; // lines of the file tabs

function levelClass(text) {
  if (/\bERROR\b|^FAIL\b|\bFAIL\s/.test(text)) return 'lvl-error';
  if (/\bWARN\b/.test(text)) return 'lvl-warn';
  if (/^OK\s/.test(text)) return 'lvl-ok';
  return '';
}

/** Activity log lines start with a UTC time: show it in the PC's own time. */
function localizeActivity(line) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (.*)$/.exec(line);
  if (!m) return { time: '', text: line };
  const t = Date.parse(`${m[1]}T${m[2]}Z`);
  return { time: Number.isNaN(t) ? '' : clock(t), text: m[3] };
}

function liveNode(entry) {
  return el(
    'span',
    { class: `log-line src-${entry.source} ${levelClass(entry.text)}` },
    el('span', { class: 'log-time', text: clock(entry.at) }),
    el('span', { class: 'log-src', text: entry.source }),
    entry.text,
  );
}

function matchesFilter(text) {
  const f = $('logFilter').value.trim().toLowerCase();
  return !f || text.toLowerCase().includes(f);
}

function renderLog() {
  const view = $('logView');
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 30;
  view.replaceChildren();
  $('logHint').textContent = withName(LOG_HINTS[state.logTab]);
  const frag = document.createDocumentFragment();
  if (state.logTab === 'live') {
    const entries = state.lines.filter((e) => matchesFilter(e.text)).slice(-2000);
    for (const e of entries) frag.append(liveNode(e));
    if (!entries.length) frag.append(el('span', { class: 'muted', text: 'Nothing yet. Press Start and his output shows up here.' }));
  } else {
    const lines = logText.filter(matchesFilter).slice(-2500);
    for (const line of lines) {
      if (state.logTab === 'activity') {
        const { time, text } = localizeActivity(line);
        frag.append(el('span', { class: `log-line ${levelClass(text)}` }, time ? el('span', { class: 'log-time', text: time }) : null, text));
      } else {
        frag.append(el('span', { class: `log-line ${levelClass(line)}`, text: line }));
      }
    }
    if (!lines.length) frag.append(el('span', { class: 'muted', text: 'Nothing here yet.' }));
  }
  view.append(frag);
  if (atBottom || !view.dataset.scrolled) view.scrollTop = view.scrollHeight;
}

async function refreshLog() {
  if (state.logTab !== 'live') {
    const text = await api.logs.get(state.logTab).catch(() => '');
    logText = text.split(/\r?\n/).filter(Boolean);
  }
  renderLog();
}

for (const t of $('logTabs').querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    state.logTab = t.dataset.log;
    for (const x of $('logTabs').querySelectorAll('.tab')) x.classList.toggle('active', x === t);
    $('logView').dataset.scrolled = '';
    refreshLog();
  });
}

$('logFilter').addEventListener('input', () => renderLog());
$('logView').addEventListener('scroll', (e) => (e.target.dataset.scrolled = '1'));
$('btnLogCopy').addEventListener('click', () => {
  const text = [...$('logView').querySelectorAll('.log-line')].map((n) => n.textContent).join('\n');
  attempt(() => api.app.copy(text), 'Copied.');
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

api.bot.onState((s) => applyBotState(s));
// Lines drawn in Logs > Live output at most (the same as a fresh draw), so a long run stays quick.
const MAX_LIVE_NODES = 2000;

api.bot.onLine((entry) => {
  state.lines.push(entry);
  if (state.lines.length > 3000) state.lines.splice(0, state.lines.length - 3000);
  if (entry.source === 'setup' && state.setupRunning) appendSetupLine(entry.text);
  if (state.page === 'logs' && state.logTab === 'live' && matchesFilter(entry.text)) {
    const view = $('logView');
    const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 30;
    view.querySelector('.muted')?.remove();
    view.append(liveNode(entry));
    while (view.childElementCount > MAX_LIVE_NODES) view.firstElementChild.remove();
    if (atBottom) view.scrollTop = view.scrollHeight;
  }
  if (state.page === 'home' && isBusy() && entry.source !== 'bot') renderHero();
});

/**
 * An update waiting to load (he restarts for it once nobody is in a call with him, or by
 * hand if that's turned off), or the app itself was updated (close and open it again).
 */
function renderUpdate(u) {
  if (u) state.update = u;
  const w = state.update || {};
  const banner = $('updateBanner');
  if (w.waiting) {
    // (This says it all: no second banner asking for a restart.)
    $('restartBanner').hidden = true;
    $('updateText').textContent = withName(
      w.automatic ? '{bot} has an update waiting. He restarts to load it once nobody is in a call with him.' : '{bot} has an update waiting. Restart him to load it.',
    );
    $('btnUpdateRestart').hidden = false;
    banner.hidden = false;
  } else if (w.appUpdated) {
    $('updateText').textContent = 'The app itself was updated. Close it and open it again to load the new version.';
    $('btnUpdateRestart').hidden = true;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}
api.app.onUpdate(renderUpdate);
$('btnUpdateRestart').addEventListener('click', () => {
  $('updateBanner').hidden = true;
  attempt(() => api.bot.restart());
});

async function init() {
  const info = await api.app.info().catch(() => null);
  if (info) $('appVersion').textContent = `App ${info.version}`;
  applyName(info?.botName);
  const bot = await api.bot.get();
  state.lines = bot.lines || [];
  await loadSettings();
  applyBotState(bot);
  refreshSpend();
  refreshWhisper();
  renderUpdate(await api.app.updateState().catch(() => null));
}

// Keep the live bits fresh: uptime, Whisper, spending, and file logs while visible.
setInterval(() => {
  renderStatusBar();
  if (state.page === 'home') {
    renderHome();
    refreshWhisper();
  }
  if (state.page === 'logs' && state.logTab !== 'live') refreshLog();
}, 4000);
setInterval(() => {
  if (state.page === 'home') refreshSpend();
  if (state.page === 'usage') loadUsage();
}, 60000);

init();
