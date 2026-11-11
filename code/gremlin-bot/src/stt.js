// Speech-to-text. Sends one finished utterance (16 kHz mono WAV) and gets text back.
// Providers: Whisper on this PC's graphics card (free; Deepgram covers whenever it
// isn't answering), Deepgram Nova-3, or ElevenLabs Scribe.

import { logger } from './log.js';
import { fetchWithReconnect } from './net.js';
import { HINT_WORDS, MIN_HINT_CLIP_MS } from './vocab.js';

const log = logger('stt');

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const ELEVEN_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
// A sentence takes well under a second on the graphics card, even mid-game; past
// this, the server is stuck or starved and Deepgram takes the sentence instead.
export function whisperTimeoutMs(durationMs = 0) {
  return Math.min(NO_FALLBACK_TIMEOUT_MS, Math.round(3000 + 0.15 * Math.max(0, durationMs)));
}
const NO_FALLBACK_TIMEOUT_MS = 8000;
// After local Whisper fails, use Deepgram for this long before trying it again.
const LOCAL_RETRY_MS = 30000;

// Phrases speech recognizers sometimes invent from breathing, clicks or silence.
// ("Yeah." and "Okay." aren't here: they're real answers to it.)
const PHANTOM = new Set([
  'thank you', 'thanks', 'thank you so much', 'thanks for watching', 'thank you for watching',
  'bye', 'you', 'uh', 'um', 'hmm', 'mm', 'oh', 'ah', 'so',
]);

export function isPhantom(text, durationMs) {
  const t = text.toLowerCase().replace(/[^a-z' ]/g, '').trim();
  if (!t) return true;
  // Very short clips that come back as a single filler word are usually noise.
  return durationMs < 1200 && PHANTOM.has(t);
}

/** Keep keyterms to plain words/names Deepgram can use (no gamertag symbols). */
export function cleanKeyterms(terms, limit = 25) {
  const out = [];
  const seen = new Set();
  for (const raw of terms) {
    const t = String(raw).replace(/[^\p{L}\p{N}' -]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (t.length < 3 || t.length > 40 || /^\d+$/.test(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** Length of a PCM WAV in seconds, read from its header. */
export function wavSeconds(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const byteRate = wav.readUInt32LE(28);
  return byteRate > 0 ? (wav.length - 44) / byteRate : 0;
}

export function createStt(config, { fetchImpl = globalThis.fetch, onUsage, now = Date.now } = {}) {
  const sttCfg = config.stt;

  // Only the bot's own name goes to Whisper as a hint, so it's spelled right and wakes
  // the bot reliably. With more hints (people's names, game names), Whisper tends to
  // "hear" those words in noise and short replies ("Zomboid" for "Yeah."). Deepgram
  // still gets them all as keyterms: it doesn't have that problem.
  const wakeHints = cleanKeyterms([config.botName, ...(config.botAliases || [])].filter(Boolean));

  async function whisper(wav, { signal, durationMs, hints = [] } = {}) {
    const params = new URLSearchParams();
    if (sttCfg.language) params.set('language', sttCfg.language);
    // Words it learned (see vocab.js) are hints too, but only on a sentence long enough
    // that Whisper can't "hear" one in noise or in a short "Yeah." (a clip that comes
    // back as nothing but hinted words is listened to again without them anyway).
    const ms = durationMs ?? wavSeconds(wav) * 1000;
    const wakeKeys = new Set(wakeHints.map((h) => h.toLowerCase()));
    const learned = ms >= MIN_HINT_CLIP_MS ? cleanKeyterms(hints, HINT_WORDS).filter((h) => !wakeKeys.has(h.toLowerCase())) : [];
    const hotwords = [...wakeHints, ...learned];
    if (hotwords.length) params.set('hotwords', hotwords.join(', '));
    // A clip that is just its name is trusted when Whisper is sure of it, and
    // otherwise listened to again without the hint (phantom calls in noise).
    if (wakeHints.length) params.set('wake', wakeHints.join(', '));
    // Whisper's own log only shows the words when transcripts are logged.
    if (config.logTranscripts) params.set('log_text', '1');
    const res = await fetchImpl(`http://127.0.0.1:${sttCfg.whisper.port}/transcribe?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
      // Without Deepgram to take over, a late answer beats none.
      signal: withTimeout(signal, canFallBack ? whisperTimeoutMs(durationMs ?? wavSeconds(wav) * 1000) : NO_FALLBACK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`local Whisper ${res.status}: ${await safeText(res)}`);
    const json = await res.json();
    // speech_seconds: how much of the clip its voice detector thought was speech.
    // wake: the name detector's score for the clip (when it has one).
    // unsure_name: the clip was only its name, and Whisper was far from sure of it (often noise).
    return {
      text: (json?.text || '').trim(),
      confidence: null,
      speech: json?.speech_seconds,
      wake: typeof json?.wake === 'number' ? json.wake : null,
      unsureName: json?.unsure_name === true,
    };
  }

  async function deepgram(wav, { keyterms = [], hints = [], signal } = {}) {
    const params = new URLSearchParams({
      model: sttCfg.deepgramModel,
      smart_format: 'true',
      language: sttCfg.language,
    });
    if (sttCfg.useKeyterms) for (const k of cleanKeyterms([...keyterms, ...hints])) params.append('keyterm', k);
    const res = await fetchWithReconnect(fetchImpl, `${DEEPGRAM_URL}?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${sttCfg.deepgramKey}`, 'Content-Type': 'audio/wav' },
      body: wav,
      signal: withTimeout(signal, 10000),
    });
    if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await safeText(res)}`);
    const json = await res.json();
    const alt = json?.results?.channels?.[0]?.alternatives?.[0];
    return { text: (alt?.transcript || '').trim(), confidence: alt?.confidence ?? null };
  }

  // Keyterms are skipped here on purpose: ElevenLabs bills them as a surcharge.
  async function elevenlabs(wav, { signal } = {}) {
    const form = new FormData();
    form.append('model_id', sttCfg.elevenModel);
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    if (sttCfg.language) form.append('language_code', sttCfg.language);
    form.append('tag_audio_events', 'false');
    const res = await fetchWithReconnect(fetchImpl, ELEVEN_STT_URL, {
      method: 'POST',
      headers: { 'xi-api-key': config.tts.elevenKey },
      body: form,
      signal: withTimeout(signal, 15000),
    });
    if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${await safeText(res)}`);
    const json = await res.json();
    return { text: (json?.text || '').trim(), confidence: null };
  }

  const canFallBack = sttCfg.provider === 'whisper' && Boolean(sttCfg.deepgramKey);
  let localDownUntil = 0;
  let onFallback = false;

  /** Runs the configured provider; for Whisper, Deepgram answers while it's down. */
  async function run(wav, opts) {
    if (sttCfg.provider === 'elevenlabs') return { ...(await elevenlabs(wav, opts)), provider: 'elevenlabs' };
    if (sttCfg.provider !== 'whisper') return { ...(await deepgram(wav, opts)), provider: 'deepgram' };
    if (canFallBack && now() < localDownUntil) return { ...(await deepgram(wav, opts)), provider: 'deepgram' };
    try {
      const result = await whisper(wav, opts);
      if (onFallback) {
        onFallback = false;
        log.info('local Whisper is answering again');
      }
      return { ...result, provider: 'whisper' };
    } catch (err) {
      // Cancelled by the caller (it no longer needs the text): don't pay Deepgram for it.
      if (opts.signal?.aborted || !canFallBack) throw err;
      localDownUntil = now() + LOCAL_RETRY_MS;
      if (!onFallback) {
        onFallback = true;
        log.warn(`local Whisper didn't answer (${err.message}); using Deepgram until it does`);
      }
      return { ...(await deepgram(wav, opts)), provider: 'deepgram' };
    }
  }

  /**
   * The words, plus the name detector's score when local Whisper has one, and
   * whether a clip of just its name was one Whisper was far from sure of.
   * @returns {Promise<{text: string, wake: number|null, unsureName: boolean, provider: string}>}
   */
  async function transcribeDetailed(wav, { durationMs = 0, keyterms = [], hints = [], signal } = {}) {
    const started = Date.now();
    const { text, provider, speech, wake = null, unsureName = false } = await run(wav, { keyterms, hints, signal, durationMs });
    log.debug(
      `${provider} took ${Date.now() - started} ms${typeof speech === 'number' ? ` (${speech} s of it sounded like speech)` : ''}${typeof wake === 'number' ? `, name detector ${wake.toFixed(2)}` : ''}`,
    );
    onUsage?.({
      type: 'stt',
      provider,
      seconds: wavSeconds(wav) || durationMs / 1000,
      keyterms: provider === 'deepgram' && sttCfg.useKeyterms && cleanKeyterms(keyterms).length > 0,
    });
    return { text: isPhantom(text, durationMs) ? '' : text, wake, unsureName, provider };
  }

  /**
   * During a pause: is the person done talking (complete, 0-1), and did they say its
   * name (wake, 0-1)? Answered by the local Whisper server on the processor in a few
   * tens of milliseconds. Null when that isn't available (Whisper off or down).
   */
  async function checkPause(wav, { wake = false, turn = true, seconds, signal, timeoutMs = PAUSE_CHECK_TIMEOUT_MS } = {}) {
    if (sttCfg.provider !== 'whisper' || now() < localDownUntil) return null;
    const params = new URLSearchParams({ turn: turn ? '1' : '0', wake: wake ? '1' : '0' });
    if (seconds) params.set('seconds', String(seconds));
    try {
      const res = await fetchImpl(`http://127.0.0.1:${sttCfg.whisper.port}/turn?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
        signal: withTimeout(signal, timeoutMs),
      });
      if (!res.ok) return null;
      const json = await res.json();
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      return { complete: num(json?.complete), wake: num(json?.wake) };
    } catch {
      return null;
    }
  }

  // What the local Whisper server can do besides transcribing: the end-of-turn model
  // (turn) and the name detector (wake: its name). Filled in once it's running.
  const extras = { turn: false, wake: null };

  return {
    provider: sttCfg.provider,
    /** Returns transcript text ('' when nothing usable was said). */
    async transcribe(wav, opts = {}) {
      return (await transcribeDetailed(wav, opts)).text;
    },
    transcribeDetailed,
    checkPause,
    extras,
    /** From the Whisper server's /health: { turn, wake }. */
    setExtras(info) {
      extras.turn = sttCfg.provider === 'whisper' && Boolean(info?.turn);
      extras.wake = sttCfg.provider === 'whisper' && typeof info?.wake === 'string' && info.wake ? info.wake : null;
    },
  };
}

// A pause check that takes longer than this is too late to help.
const PAUSE_CHECK_TIMEOUT_MS = 400;

export function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function safeText(res) {
  try {
    const t = await res.text();
    return t.slice(0, 400);
  } catch {
    return '(no body)';
  }
}
