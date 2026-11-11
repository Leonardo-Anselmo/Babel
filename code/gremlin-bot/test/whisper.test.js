// Free hearing on the graphics card: the local Whisper client, the Deepgram backup,
// and starting/keeping the local server alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createStt } from '../src/stt.js';
import { costOf } from '../src/usage.js';
import { createWhisperManager, whisperPaths } from '../src/whisper.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wav = () => {
  const b = Buffer.alloc(44 + 32000);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32000, 28); // byte rate: 1 s of 16 kHz 16-bit mono
  return b;
};

function sttConfig(over = {}) {
  return {
    botName: 'Winslow',
    botAliases: ['winslow', 'winnie'],
    stt: {
      provider: 'whisper',
      deepgramKey: 'dg-test',
      deepgramModel: 'nova-3',
      language: 'en',
      useKeyterms: true,
      whisper: { port: 8178, model: 'large-v3', home: '/w', computeType: 'float16', beamSize: 5 },
      ...over,
    },
  };
}

/** Routes requests: the local server (127.0.0.1) and Deepgram, each recorded. */
function router({ local, deepgram = () => json(200, { results: { channels: [{ alternatives: [{ transcript: 'from deepgram' }] }] } }) }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('http://127.0.0.1')) return local(u, init);
    if (u.startsWith('https://api.deepgram.com')) return deepgram(u, init);
    throw new Error(`unexpected ${u}`);
  };
  return { calls, fetchImpl };
}

const refused = () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
};

test('whisper: sends the clip to the local server with only its own name as a hint, and it costs nothing', async () => {
  const events = [];
  let sent;
  const { fetchImpl } = router({
    local: (u, init) => {
      sent = { url: new URL(u), body: init.body, type: init.headers['Content-Type'] };
      return json(200, { text: ' Winslow, who won? ' });
    },
  });
  const stt = createStt(sttConfig(), { fetchImpl, onUsage: (e) => events.push(e) });
  const text = await stt.transcribe(wav(), { durationMs: 1000, keyterms: ['Winslow', 'Mike', 'x'] });
  assert.equal(text, 'Winslow, who won?');
  assert.equal(sent.url.pathname, '/transcribe');
  assert.equal(sent.url.port, '8178');
  assert.equal(sent.url.searchParams.get('language'), 'en');
  // People's names and game names would make Whisper "hear" them in noise, so only its own name (and aliases).
  assert.equal(sent.url.searchParams.get('hotwords'), 'Winslow, winnie');
  assert.equal(sent.url.searchParams.get('wake'), 'Winslow, winnie');
  assert.equal(sent.type, 'audio/wav');
  assert.equal(events[0].provider, 'whisper');
  assert.equal(costOf(events[0]).sttDollars, 0);
  assert.equal(costOf(events[0]).sttSeconds, 1);
});

test('whisper: if it is not running, Deepgram answers instead, and Whisper is retried later', async () => {
  let t = 1_000_000;
  const events = [];
  let localUp = false;
  const { calls, fetchImpl } = router({ local: () => (localUp ? json(200, { text: 'local again' }) : refused()) });
  const stt = createStt(sttConfig(), { fetchImpl, onUsage: (e) => events.push(e), now: () => t });

  assert.equal(await stt.transcribe(wav(), { durationMs: 1000 }), 'from deepgram');
  assert.equal(events.at(-1).provider, 'deepgram');
  assert.ok(costOf(events.at(-1)).sttDollars > 0, 'the backup is billed as Deepgram');

  calls.length = 0;
  t += 10_000;
  localUp = true;
  assert.equal(await stt.transcribe(wav(), { durationMs: 1000 }), 'from deepgram');
  assert.ok(!calls.some((c) => c.startsWith('http://127.0.0.1')), "doesn't keep knocking on a server that just failed");

  t += 30_000;
  assert.equal(await stt.transcribe(wav(), { durationMs: 1000 }), 'local again');
  assert.equal(events.at(-1).provider, 'whisper');
});

test('whisper: a server error also falls back to Deepgram', async () => {
  const { fetchImpl } = router({ local: () => json(500, { error: 'CUDA failed with error out of memory' }) });
  const stt = createStt(sttConfig(), { fetchImpl });
  assert.equal(await stt.transcribe(wav(), { durationMs: 1000 }), 'from deepgram');
});

test('whisper: no Deepgram key means no backup, so the error comes through', async () => {
  const { fetchImpl } = router({ local: refused });
  const stt = createStt(sttConfig({ deepgramKey: '' }), { fetchImpl });
  await assert.rejects(() => stt.transcribe(wav(), { durationMs: 1000 }), /fetch failed/);
});

test('whisper: a request the caller gave up on is not sent to Deepgram', async () => {
  const ac = new AbortController();
  const { calls, fetchImpl } = router({
    local: () => {
      ac.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  const stt = createStt(sttConfig(), { fetchImpl });
  await assert.rejects(() => stt.transcribe(wav(), { durationMs: 1000, signal: ac.signal }));
  assert.ok(!calls.some((c) => c.includes('deepgram')));
});

test('whisper: phantom words from noise are still dropped', async () => {
  const { fetchImpl } = router({ local: () => json(200, { text: 'Thank you.' }) });
  const stt = createStt(sttConfig(), { fetchImpl });
  assert.equal(await stt.transcribe(wav(), { durationMs: 600 }), '');
});

// ---- the local server manager ----------------------------------------------

// server.py as it is on disk, and the version id the server reports for it.
const SERVER_CODE = 'print("server, current version")\n';
const CODE = createHash('sha256').update(SERVER_CODE).digest('hex').slice(0, 12);

function managerSetup({ installed = true, healthy = () => false, onSpawn, running = {} } = {}) {
  const config = {
    rootDir: '/bot',
    dataDir: '/bot/data',
    stt: { language: 'en', whisper: { port: 8178, model: 'large-v3', home: '/w', computeType: 'float16', beamSize: 5 } },
  };
  const p = whisperPaths(config);
  const files = new Set(installed ? [p.python, path.join(p.modelDir, 'model.bin'), '/w'] : []);
  const fsImpl = {
    existsSync: (f) => files.has(f),
    mkdirSync() {},
    statSync() {
      throw new Error('no log');
    },
    truncateSync() {},
    readFileSync: (f) =>
      f === p.server
        ? SERVER_CODE
        : '[12:00:01] loading large-v3 on cuda\n[12:00:03] could not load the model: RuntimeError(CUDA driver version is insufficient)\n',
  };
  const spawned = [];
  const spawnImpl = (exe, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => {};
    spawned.push({ exe, args, opts, child });
    onSpawn?.(child);
    return child;
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(`${init?.method || 'GET'} ${new URL(url).pathname}`);
    if (new URL(url).pathname === '/shutdown') {
      running.shutdown?.();
      return json(200, { ok: true });
    }
    return healthy()
      ? json(200, { ok: true, model: 'large-v3', device: 'cuda', compute_type: 'float16', beam_size: 5, language: 'en', code: CODE, ...running.info })
      : refused();
  };
  let t = 0;
  const manager = createWhisperManager(config, {
    fetchImpl,
    spawnImpl,
    fsImpl,
    sleep: async (ms) => {
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
    now: () => t,
  });
  return { manager, spawned, paths: p, requests };
}

test('manager: an already running server is used as is', async () => {
  const { manager, spawned } = managerSetup({ healthy: () => true });
  const r = await manager.ensure();
  assert.equal(r.status, 'running');
  assert.equal(spawned.length, 0);
});

test('manager: not set up yet is reported, nothing is started', async () => {
  const { manager, spawned } = managerSetup({ installed: false });
  assert.equal((await manager.ensure()).status, 'not-installed');
  assert.equal(spawned.length, 0);
});

test('manager: starts the server hidden and detached, with the settings, and waits for it', async () => {
  let up = false;
  const { manager, spawned, paths } = managerSetup({ healthy: () => up, onSpawn: () => setImmediate(() => (up = true)) });
  const r = await manager.ensure();
  assert.equal(r.status, 'started');
  assert.equal(spawned.length, 1);
  const { args, opts } = spawned[0];
  assert.deepEqual(args.slice(0, 3), ['-E', '-s', paths.server], 'ignores stray Python settings on the PC');
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag('--model'), 'large-v3');
  assert.equal(flag('--port'), '8178');
  assert.equal(flag('--home'), '/w');
  assert.equal(flag('--idle-exit'), '300');
  assert.equal(flag('--log'), paths.logFile);
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.stdio, 'ignore');
  assert.equal(opts.cwd, '/w', 'runs outside the OneDrive bot folder');
});

test('manager: a copy running with other settings (e.g. an old model) is restarted with yours', async () => {
  let up = true;
  let old = true;
  const running = { info: { model: 'large-v3-turbo' }, shutdown: () => (up = false) };
  const { manager, spawned, requests } = managerSetup({
    healthy: () => up,
    running,
    onSpawn: () =>
      setImmediate(() => {
        old = false;
        running.info = {};
        up = true;
      }),
  });
  const r = await manager.ensure();
  assert.ok(requests.includes('POST /shutdown'));
  assert.equal(spawned.length, 1);
  assert.equal(r.status, 'started');
  assert.equal(old, false);
});

test('manager: a copy running an older version of the server code is restarted with the new one', async () => {
  let up = true;
  const running = { info: { code: 'older0000000' }, shutdown: () => (up = false) };
  const { manager, spawned, requests } = managerSetup({
    healthy: () => up,
    running,
    onSpawn: () =>
      setImmediate(() => {
        running.info = {};
        up = true;
      }),
  });
  const r = await manager.ensure();
  assert.ok(requests.includes('POST /shutdown'));
  assert.equal(spawned.length, 1);
  assert.equal(r.status, 'started');
});

test('manager: if the server dies while starting, the reason from its log is reported', async () => {
  const { manager } = managerSetup({ onSpawn: (child) => setImmediate(() => child.emit('exit', 3)) });
  const r = await manager.ensure();
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /CUDA driver version is insufficient/);
});

test('manager: two callers at once start it only once', async () => {
  let up = false;
  const { manager, spawned } = managerSetup({ healthy: () => up, onSpawn: () => setImmediate(() => (up = true)) });
  const [a, b] = await Promise.all([manager.ensure(), manager.ensure()]);
  assert.equal(spawned.length, 1);
  assert.equal(a.status, 'started');
  assert.equal(b.status, 'started');
});

test('manager: gives up after the wait and says where to look', async () => {
  const { manager } = managerSetup();
  const r = await manager.ensure({ waitMs: 2000 });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /whisper\.log/);
});
