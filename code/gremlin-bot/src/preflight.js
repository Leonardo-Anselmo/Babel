// The start-up check (started by src/check.js, which the desktop app and
// start-windows.bat run before the bot). Tests every key and library before you go
// live, and saves a voice sample to data/voice-test.wav so you can hear the voice you picked.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { MonoToDiscordPcm, createOpusDecoder, pcmToWav, stereo48kToMono16k } from './audio.js';
import { createClaude } from './claude.js';
import { imageError } from './images.js';
import { loadConfig, validateConfig } from './config.js';
import { buildSystem, sayContent } from './prompts.js';
import { createStt } from './stt.js';
import { createTts } from './tts.js';
import { VENICE_API, VENICE_FOR_WORDS } from './venice.js';
import { createWhisperManager, wakeModelName } from './whisper.js';

const results = [];
function report(ok, label, detail = '') {
  const tag = ok === null ? 'SKIP' : ok ? 'OK  ' : 'FAIL';
  results.push(ok);
  console.log(`${tag}  ${label}${detail ? `: ${detail}` : ''}`);
}

// "fetch failed" alone is useless; add the network reason (ENOTFOUND, ECONNRESET, ...).
const why = (err) => `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`;

async function timed(fn) {
  const t = Date.now();
  const v = await fn();
  return [v, Date.now() - t];
}

async function main() {
  console.log('Pre-flight check\n');

  const [major, minor] = process.versions.node.split('.').map(Number);
  report(major > 22 || (major === 22 && minor >= 12), 'Node.js version', process.versions.node + (major < 22 ? ' (need 22.12+)' : ''));

  const config = loadConfig();
  const problems = validateConfig(config);
  report(problems.length === 0, 'Settings (.env, persona.md)', problems.length ? problems.join(' | ') : `name "${config.botName}", model ${config.anthropic.model}`);

  // Voice libraries
  try {
    const voice = await import('@discordjs/voice');
    const dep = voice.generateDependencyReport();
    const dave = /@snazzah\/davey:\s*(\S+)/.exec(dep)?.[1];
    report(Boolean(dave) && dave !== 'not', 'DAVE encryption library', dave ? `@snazzah/davey ${dave}` : 'missing. Delete the node_modules folder in the bot folder, then start again: the libraries reinstall.');
    const dec = createOpusDecoder();
    report(true, 'Opus codec', dec.name);
    dec.destroy();
  } catch (err) {
    report(false, 'Voice libraries', err.message);
  }

  // Discord
  if (config.discordToken) {
    try {
      const headers = { Authorization: `Bot ${config.discordToken}` };
      const me = await fetch('https://discord.com/api/v10/users/@me', { headers, signal: AbortSignal.timeout(10000) });
      if (!me.ok) throw new Error(`HTTP ${me.status} (token is wrong or was reset)`);
      const user = await me.json();
      const appRes = await fetch('https://discord.com/api/v10/applications/@me', { headers, signal: AbortSignal.timeout(10000) });
      const app = appRes.ok ? await appRes.json() : {};
      const servers = app.approximate_guild_count ?? '?';
      report(true, 'Discord bot token', `${user.username} (in ${servers} server${servers === 1 ? '' : 's'})`);
      if (config.enablePresence) {
        const flags = Number(app.flags || 0);
        const presenceOn = (flags & (1 << 12)) !== 0 || (flags & (1 << 13)) !== 0;
        report(presenceOn, 'Presence intent (ENABLE_PRESENCE=true)', presenceOn ? 'enabled' : 'turn on "Presence Intent" in the Developer Portal Bot tab, or set ENABLE_PRESENCE=false');
      }
    } catch (err) {
      report(false, 'Discord bot token', why(err));
    }
  } else report(null, 'Discord bot token', 'DISCORD_TOKEN not set');

  // Claude
  if (config.anthropic.apiKey) {
    const models = [...new Set([config.anthropic.model, config.anthropic.fastModel, config.anthropic.jokeModel].filter(Boolean))];
    const system = buildSystem({ botName: config.botName, persona: config.persona, lore: config.lore });
    for (const model of models) {
      try {
        const effort = model === config.anthropic.model ? config.anthropic.effort : config.anthropic.fastEffort;
        const claude = createClaude(config, { model, effort });
        await claude.init();
        // The main model gets the search tool too (it won't need to search for this):
        // that is how a search turned off for the organization shows up.
        const withSearch = model === config.anthropic.model && Boolean(config.anthropic.webSearch?.enabled);
        const [res, ms] = await timed(() =>
          claude.createMessage({
            system,
            user: "Pre-flight test, no need to look anything up. Say one short in-character line announcing you're online.",
            maxTokens: 120,
            retries: 1,
            search: withSearch,
          }),
        );
        const line = (sayContent(res.text) ?? res.text).trim();
        report(Boolean(line), `Claude ${model} (thinking: ${claude.thinkingMode}, effort: ${claude.effort})`, `${ms} ms: "${line.slice(0, 140)}"`);
        if (model === config.anthropic.model) {
          const ws = config.anthropic.webSearch;
          const on = claude.searchStatus === 'on';
          report(
            on ? true : null,
            'Web search',
            on ? `on (up to ${ws.maxUses} per answer, ${ws.dailyLimit} a day; only when a question needs it)` : claude.searchStatus,
          );
        }
      } catch (err) {
        report(false, `Claude ${model}`, why(err));
      }
    }
  } else report(null, 'Claude API', 'ANTHROPIC_API_KEY not set');

  // ElevenLabs voice
  let sampleWav16k = null;
  if (config.tts.elevenKey && config.tts.voiceId) {
    try {
      const sub = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': config.tts.elevenKey },
        signal: AbortSignal.timeout(10000),
      });
      if (sub.ok) {
        const s = await sub.json();
        const used = s.character_count ?? '?';
        const limit = s.character_limit ?? '?';
        report(true, 'ElevenLabs account', `plan "${s.tier ?? '?'}", ${used} of ${limit} credits used this month`);
      }
    } catch {
      // optional info only
    }
    try {
      const tts = createTts(config);
      const t0 = Date.now();
      const { stream, sampleRate } = await tts.stream(
        `Testing, testing. This is ${config.botName}, and I am already disappointed in all of you.`,
      );
      let firstByteMs = null;
      const chunks = [];
      for await (const c of stream) {
        if (firstByteMs === null) firstByteMs = Date.now() - t0;
        chunks.push(c);
      }
      const pcm = Buffer.concat(chunks);
      const seconds = pcm.length / 2 / sampleRate;
      fs.mkdirSync(config.dataDir, { recursive: true });
      const out = path.join(config.dataDir, 'voice-test.wav');
      fs.writeFileSync(out, pcmToWav(pcm, sampleRate, 1));
      report(seconds > 0.5, `ElevenLabs voice (${tts.model}, ${config.tts.outputFormat})`, `first audio in ${firstByteMs} ms, ${seconds.toFixed(1)} s of speech saved to ${path.relative(config.rootDir, out)}`);
      if (tts.model !== config.tts.model) {
        report(null, 'Voice model', `ElevenLabs couldn't use ${config.tts.model} (see above), so it uses ${tts.model}. Check ELEVENLABS_MODEL in Settings > Voice.`);
      }

      // Reuse the sample to test speech-to-text with real speech.
      const stereo = [];
      const converter = Readable.from([pcm]).pipe(new MonoToDiscordPcm({ inputRate: sampleRate, leadingSilenceMs: 0 }));
      for await (const c of converter) stereo.push(c);
      sampleWav16k = pcmToWav(stereo48kToMono16k(Buffer.concat(stereo)), 16000, 1);
    } catch (err) {
      report(false, 'ElevenLabs voice', why(err));
    }
  } else report(null, 'ElevenLabs voice', 'ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID not set');

  // Pictures (Gemini): the key and the model, without drawing anything (that would cost).
  // Never a FAIL: he runs fine without pictures.
  const im = config.images;
  if (im.enabled === false) report(null, 'Pictures', 'off (IMAGES=false)');
  else if (!im.key) report(null, 'Pictures', "no GEMINI_API_KEY, so he can't draw (the app: Settings > Keys)");
  else {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(im.model)}`, {
        headers: { 'x-goog-api-key': im.key },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        report(true, `Pictures (${im.model})`, `the Gemini key works; up to ${im.perMonth} pictures a month (its Google project needs billing on)`);
      } else if (res.status === 404) {
        report(null, `Pictures (${im.model})`, "the Gemini key works, but Google didn't list that model; he'll still try it");
      } else {
        const err = imageError(res.status, await res.text().catch(() => ''), { model: im.model });
        report(null, `Pictures (${im.model})`, `${err.userText}. He runs without pictures until that's fixed.`);
      }
    } catch (err) {
      report(null, 'Pictures', `couldn't reach Google: ${why(err)}`);
    }
  }

  // Venice (VENICE_FOR): the key and the balance, without writing anything. Never a FAIL:
  // without it, Claude writes everything.
  const ve = config.venice;
  if (ve.kinds.length) {
    const label = `Venice (${ve.model})`;
    if (!ve.apiKey) report(null, label, `VENICE_FOR is ${ve.for} but there's no VENICE_API_KEY, so Claude writes everything (the app: Settings > Keys)`);
    else {
      try {
        const res = await fetch(`${VENICE_API}/api_keys/rate_limits`, { headers: { authorization: `Bearer ${ve.apiKey}` }, signal: AbortSignal.timeout(10000) });
        if (res.ok) report(true, label, `the key works; Venice writes ${VENICE_FOR_WORDS[ve.for]} (it needs credit on the account)`);
        else report(null, label, `Venice turned the key down (${res.status}), so Claude writes those lines until that's fixed`);
      } catch (err) {
        report(null, label, `couldn't reach Venice: ${why(err)}`);
      }
    }
  }

  // Speech-to-text
  const wav = sampleWav16k || pcmToWav(Buffer.alloc(16000 * 2), 16000, 1);
  const testStt = async (label, sttConfig) => {
    try {
      const stt = createStt({ ...config, stt: sttConfig });
      const [text, ms] = await timed(() => stt.transcribe(wav, { durationMs: 4000, keyterms: [config.botName] }));
      const detail = sampleWav16k ? `${ms} ms, heard: "${text}"` : `${ms} ms (it answers; sent silence since the voice test failed)`;
      report(sampleWav16k ? text.length > 0 : true, label, detail);
      return true;
    } catch (err) {
      report(false, label, why(err));
      return false;
    }
  };

  if (config.stt.provider === 'whisper') {
    const w = config.stt.whisper;
    const label = `Speech-to-text (Whisper ${w.model} on your graphics card)`;
    const whisper = createWhisperManager(config);
    const setup = 'Run Whisper setup on Home in the desktop app, or setup-whisper.bat';
    const hasBackup = Boolean(config.stt.deepgramKey);
    // Without a Deepgram key there's nothing to hear with until Whisper works, so that's a problem, not a skip.
    const cover = hasBackup ? 'Until then it uses Deepgram.' : "There's no Deepgram key to cover, so the bot can't hear anyone until it's fixed.";
    let usable = false;
    if (!whisper.installed() && !(await whisper.health())) {
      report(hasBackup ? null : false, label, `the Whisper model ${w.model} isn't set up yet (${setup}). ${cover}`);
    } else {
      console.log('      starting Whisper (the first start after a reboot can take up to a minute)...');
      const r = await whisper.ensure({ waitMs: 180000 });
      if (r.status === 'running' || r.status === 'started') {
        // No Deepgram fallback here, so this really tests Whisper.
        usable = await testStt(label, { ...config.stt, deepgramKey: '' });
        await checkExtras(r.info);
      } else if (r.status === 'not-installed') {
        report(false, label, `the Whisper model ${w.model} needs the Whisper setup (${setup}). ${cover}`);
      } else {
        report(false, label, `couldn't start (${r.reason || r.status}). ${cover} Details: data/whisper.log`);
      }
    }
    if (hasBackup) await testStt('Speech-to-text backup (Deepgram)', { ...config.stt, provider: 'deepgram' });
    else if (usable) report(null, 'Speech-to-text backup', "no Deepgram key, so if Whisper stops the bot can't hear until it's back");
  } else {
    const sttReady = config.stt.provider === 'deepgram' ? config.stt.deepgramKey : config.tts.elevenKey;
    if (sttReady) await testStt(`Speech-to-text (${config.stt.provider})`, config.stt);
    else report(null, 'Speech-to-text', `no key for ${config.stt.provider}`);
  }

  /** The small models next to Whisper: the end-of-turn model and the name detector. */
  async function checkExtras(info) {
    const extrasDir = path.join('whisper', 'extras');
    if (info?.turn) report(true, 'End-of-turn model', config.listen.smartTurn ? 'on: it answers as soon as people sound done' : 'there, but SMART_TURN is off');
    else report(null, 'End-of-turn model', `not loaded (${path.join(extrasDir, 'smart-turn-v3.2-cpu.onnx')} missing?), so it waits the full pause`);
    if (!info?.wake) {
      report(null, 'Name detector', `none for "${config.botName}" (${path.join(extrasDir, `${wakeModelName(config.botName)}.onnx`)}), so its name is only heard as a word`);
      return;
    }
    if (!sampleWav16k) {
      report(true, `Name detector (${info.wake})`, 'loaded (not tested: the voice test failed)');
      return;
    }
    // The voice test says its name ("This is <name>"), so the detector should hear it.
    const stt = createStt(config);
    // (A longer wait than in a call: the whole voice test is scored, on a possibly busy processor.)
    const r = await stt.checkPause(sampleWav16k, { turn: false, wake: true, timeoutMs: 5000 });
    const score = typeof r?.wake === 'number' ? r.wake : null;
    const threshold = config.listen.nameThreshold;
    if (score === null) report(null, `Name detector (${info.wake})`, "loaded, but it didn't answer the test in time");
    else report(score >= threshold ? true : null, `Name detector (${info.wake})`, `heard its name in the voice test at ${score.toFixed(2)} (needs ${threshold})`);
  }

  const failed = results.filter((r) => r === false).length;
  console.log(failed ? `\n${failed} problem(s) to fix before starting.` : '\nAll good.');
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('Check crashed:', err?.stack || err);
  process.exit(1);
});
