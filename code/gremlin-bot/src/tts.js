// Text-to-speech via ElevenLabs streaming. Returns a stream of raw mono PCM
// that starts arriving within a few hundred milliseconds.

import { Readable } from 'node:stream';
import { sampleRateFromFormat } from './audio.js';
import { logger } from './log.js';
import { fetchWithReconnect } from './net.js';
import { safeText } from './stt.js';

const log = logger('voice');
const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';
// Short fixed lines ("Yeah?", "One sec.") are kept after they're first synthesized
// and replayed from memory: they start at once and don't cost credits again.
const CACHE_MAX_BYTES = 400_000; // per line (about 8 s of audio); longer ones aren't kept
const CACHE_MAX_LINES = 40;
// Used for the rest of the run if the chosen model can't be used (not on this
// account, or doesn't take the audio format): the fast model every account has.
export const FALLBACK_MODEL = 'eleven_flash_v2_5';

/** Eleven v3 and v4 take delivery tags like [laughs] and only stability and similarity settings. */
export function isExpressiveModel(model) {
  return /^eleven_v[34]/i.test(String(model || ''));
}

/** Delivery tags ("[laughs]") taken out, for a model that would read them aloud. */
export function stripAudioTags(text) {
  return String(text).replace(/\[[^\]]{0,40}\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Whether an ElevenLabs error could be the model's fault (not on this account, not for
 * this voice or audio format), as opposed to credits, the key, the voice or rate limits.
 * Such an error gets one try with the fallback model, which is kept only if it works.
 */
export function isModelProblem(status, code) {
  if (![400, 403, 404, 422].includes(status)) return false;
  return !/quota|credit|payment|api_key|unauthori[sz]ed|voice_not_found|unusual_activity|rate|concurrent|too_many/i.test(code || '');
}

export class TtsError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Turns an ElevenLabs error body into a short, readable reason. */
export function describeElevenError(status, bodyText) {
  let code = '';
  let message = bodyText;
  try {
    const json = JSON.parse(bodyText);
    const d = json.detail ?? json;
    code = d.status || d.code || '';
    message = d.message || (typeof d === 'string' ? d : JSON.stringify(d));
  } catch {
    // not JSON
  }
  const outOfCredits = 'out of ElevenLabs credits until the plan renews (or add credits in ElevenLabs)';
  const hints = {
    quota_exceeded: outOfCredits,
    insufficient_credits: outOfCredits,
    payment_required: outOfCredits,
    voice_not_found: "the voice ID (Settings > Voice, or ELEVENLABS_VOICE_ID) isn't on this ElevenLabs account",
    invalid_api_key: 'ELEVENLABS_API_KEY is wrong',
    detected_unusual_activity: 'ElevenLabs flagged the free account; a paid plan or VPN-free signup fixes it',
  };
  const hint =
    hints[code] ||
    (status === 402 ? outOfCredits : '') ||
    (status === 401 ? 'ElevenLabs rejected the API key or the plan' : '') ||
    (status === 429 ? 'ElevenLabs is busy or the plan allows fewer requests at once' : '');
  return { code, text: `ElevenLabs TTS ${status}${code ? ` (${code})` : ''}: ${hint || message}`.slice(0, 300) };
}

export function createTts(config, { fetchImpl = globalThis.fetch, onUsage } = {}) {
  const t = config.tts;
  const sampleRate = sampleRateFromFormat(t.outputFormat);
  // The model in use: the chosen one, or the fallback once that failed.
  let model = t.model;

  function voiceSettings(use = model) {
    const s = { stability: t.stability, similarity_boost: t.similarity };
    // v3 and v4 take only these two.
    if (isExpressiveModel(use)) return s;
    if (t.style > 0) s.style = t.style;
    if (t.speed !== 1) s.speed = t.speed;
    return s;
  }

  /** The words as this model should get them: tags only for a model that performs them. */
  const forModel = (text, use = model) => (isExpressiveModel(use) ? text : stripAudioTags(text));

  const cache = new Map(); // line + voice settings -> its audio (mono PCM)
  // A change of voice or voice settings makes the old recordings useless, so they're part of the key.
  const cacheKey = (text) => JSON.stringify([t.voiceId, model, t.outputFormat, voiceSettings(), text]);
  function keep(key, chunks, size) {
    if (!size || size > CACHE_MAX_BYTES) return;
    if (cache.size >= CACHE_MAX_LINES) cache.delete(cache.keys().next().value);
    cache.set(key, Buffer.concat(chunks));
  }
  /** Copies a line's audio into the cache as it plays, if it plays to the end. */
  function record(body, key) {
    const chunks = [];
    let size = 0;
    body.on('data', (c) => {
      size += c.length;
      if (size <= CACHE_MAX_BYTES) chunks.push(c);
    });
    body.once('end', () => keep(key, chunks, size));
  }

  /**
   * Starts synthesis. Resolves once ElevenLabs answers (audio still streaming).
   * cache: a short fixed line, worth keeping to replay from memory next time.
   * @returns {Promise<{stream: Readable, sampleRate: number, cached?: boolean}>}
   */
  async function stream(text, { signal, cache: useCache = false } = {}) {
    const key = useCache ? cacheKey(text) : null;
    const kept = key ? cache.get(key) : null;
    if (kept) return { stream: Readable.from([kept], { objectMode: false }), sampleRate, cached: true };
    const audio = await synthesize(text, { signal });
    if (key) record(audio.stream, key);
    return audio;
  }

  /** Synthesizes short fixed lines ahead of time, one at a time, skipping ones already kept. */
  async function prewarm(texts, { signal } = {}) {
    for (const text of texts) {
      const key = cacheKey(text);
      if (signal?.aborted) return;
      if (cache.has(key)) continue;
      try {
        const { stream: body } = await synthesize(text, { signal });
        const chunks = [];
        let size = 0;
        for await (const c of body) {
          size += c.length;
          if (size > CACHE_MAX_BYTES) break;
          chunks.push(c);
        }
        keep(key, chunks, size);
      } catch {
        return; // offline or out of credits: the lines get synthesized when they're needed
      }
    }
  }

  return {
    sampleRate,
    stream,
    prewarm,
    /** The model it's speaking with right now. */
    get model() {
      return model;
    },
  };

  /**
   * One request to ElevenLabs. Resolves once it answers (audio still streaming).
   * If the chosen model turns out not to be usable, switches to the fallback for
   * the rest of the run and tries again with it.
   */
  async function synthesize(text, { signal } = {}) {
    const use = model;
    try {
      return await request(text, { signal, use });
    } catch (err) {
      if (!(err instanceof TtsError) || !err.modelProblem || use === FALLBACK_MODEL || signal?.aborted) throw err;
      // Maybe this model can't be used here: try the fast one, and keep it only if it works.
      let audio;
      try {
        audio = await request(text, { signal, use: FALLBACK_MODEL });
      } catch {
        throw err; // it wasn't the model
      }
      if (model === use) {
        model = FALLBACK_MODEL;
        log.warn(`ElevenLabs couldn't use ${use} (${err.message}); using ${FALLBACK_MODEL} for the rest of this run. Check ELEVENLABS_MODEL in Settings > Voice.`);
      }
      return audio;
    }
  }

  async function request(raw, { signal, use = model } = {}) {
    const text = forModel(raw, use);
    if (!text) throw new TtsError('nothing to say once the delivery tags were taken out');
    const url = `${ELEVEN_BASE}/text-to-speech/${encodeURIComponent(t.voiceId)}/stream?output_format=${encodeURIComponent(t.outputFormat)}`;
    // The audio body is read at playback speed, so only the wait for the first
    // response gets a timeout. After that, only the caller's signal can cancel it.
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ac.abort(new TtsError('ElevenLabs took too long to answer')), 12000);
    try {
      const res = await fetchWithReconnect(fetchImpl, url, {
        method: 'POST',
        headers: { 'xi-api-key': t.elevenKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: use, voice_settings: voiceSettings(use) }),
        signal: ac.signal,
      });
      if (!res.ok) {
        // Still under the timeout, so a stalled error body can't hang us.
        const body = await safeText(res);
        const { code, text: reason } = describeElevenError(res.status, body);
        const err = new TtsError(reason, { status: res.status, code });
        err.modelProblem = isModelProblem(res.status, code);
        throw err;
      }
      if (!res.body) throw new TtsError('ElevenLabs returned no audio');
      // Billed once accepted, even if the line is cut off before it finishes.
      onUsage?.({ type: 'tts', chars: text.length, model: use });
      // Keep the caller's abort hooked up: it's how a line gets cut off mid-stream.
      return { stream: Readable.fromWeb(res.body), sampleRate };
    } catch (err) {
      signal?.removeEventListener('abort', onAbort);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
