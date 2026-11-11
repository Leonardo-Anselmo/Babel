// The bot's mouth. Queues lines, starts ElevenLabs early so audio is ready
// sooner, waits for a gap in the conversation, and plays into the call.

import { pipeline } from 'node:stream';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
} from '@discordjs/voice';
import { MonoToDiscordPcm } from './audio.js';
import { logger } from './log.js';

const log = logger('mouth');
const PREBUFFER_MS = 250;
const FIRST_AUDIO_TIMEOUT_MS = 4000;
// An answer waits up to this long for the person who asked to finish talking.
const HOLD_MAX_MS = 5000;
// Short fixed lines ("Yeah?", "One sec.", "Hmm.", a laugh) are replayed from memory after the first time.
const CACHED_KINDS = new Set(['ack', 'filler', 'think', 'laugh', 'intro', 'posted']);
// A line is never left paused longer than this (the brain normally decides much sooner).
const PAUSE_MAX_MS = 30000;
// Little sounds, not talking: someone starting over a "Hmm." or a laugh isn't talking over it.
const SOUNDS = new Set(['think', 'laugh']);

// How long a line stays worth saying, and how long to wait for people to pause.
const KIND_RULES = {
  quip: { maxAgeMs: 8000, gapWaitMs: 3000, dropIfNoGap: true },
  followup: { maxAgeMs: 15000, gapWaitMs: 5000, dropIfNoGap: true },
  direct: { maxAgeMs: 25000, gapWaitMs: 1200, dropIfNoGap: false },
  greet: { maxAgeMs: 15000, gapWaitMs: 1500, dropIfNoGap: false },
  roast: { maxAgeMs: 25000, gapWaitMs: 1500, dropIfNoGap: false },
  say: { maxAgeMs: 30000, gapWaitMs: 800, dropIfNoGap: false },
  // "One sec." while a slow answer (usually a web search) is on its way.
  filler: { maxAgeMs: 3000, gapWaitMs: 400, dropIfNoGap: true },
  // "Yeah?" after someone calls its name: it waits for them (only them) to pause,
  // and is skipped if they're already saying the rest.
  ack: { maxAgeMs: 4000, gapWaitMs: 1500, dropIfNoGap: true },
  // A reminder someone asked for: it waits a while for a pause, then says it anyway.
  reminder: { maxAgeMs: 60000, gapWaitMs: 8000, dropIfNoGap: false },
  // A quick "Hmm." while a question's answer is on its way: only right away, and only in a pause.
  think: { maxAgeMs: 2500, gapWaitMs: 600, dropIfNoGap: true },
  // Laughing along with the group: soon after the laugh, or not at all.
  laugh: { maxAgeMs: 3000, gapWaitMs: 1500, dropIfNoGap: true },
  // Hi to someone who just joined, bye to someone heading out.
  welcome: { maxAgeMs: 12000, gapWaitMs: 4000, dropIfNoGap: true },
  farewell: { maxAgeMs: 8000, gapWaitMs: 3000, dropIfNoGap: true },
  // "Alright, here it is." and the song someone asked for, right after it.
  intro: { maxAgeMs: 120000, gapWaitMs: 8000, dropIfNoGap: false },
  song: { maxAgeMs: 180000, gapWaitMs: 8000, dropIfNoGap: false },
  // "It's in the chat." once a picture someone asked for is posted: only in a pause.
  posted: { maxAgeMs: 6000, gapWaitMs: 2500, dropIfNoGap: true },
};

export class Speaker {
  /**
   * @param {object} opts
   * @param {import('@discordjs/voice').VoiceConnection} [opts.connection]
   * @param {{stream: Function}} opts.tts
   * @param {() => boolean} [opts.isAnyoneSpeaking]
   * @param {() => boolean} [opts.isHearing]  a finished sentence is still being transcribed
   * @param {(text: string, err: Error, kind: string) => void} [opts.onVoiceFailure]  called with the line when TTS fails
   */
  constructor({ connection, tts, volume = 1, isAnyoneSpeaking, isHearing, onVoiceFailure, clock = Date.now, player }) {
    this.tts = tts;
    this.volume = volume;
    this.isAnyoneSpeaking = isAnyoneSpeaking || (() => false);
    // Someone's sentence is still being transcribed (it might be for the bot).
    this.isHearing = isHearing || (() => false);
    this.onVoiceFailure = onVoiceFailure || (() => {});
    this.clock = clock;
    this.queue = [];
    this.current = null;
    this.busy = false;
    this.spans = []; // recent { from, to } stretches when it was actually making sound
    // maxMissedFrames: by default the player gives up after 100 ms without audio,
    // which would chop lines whenever the voice stream hiccups. Allow 2 s.
    this.player =
      player || createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 100 } });
    this.player.on('error', (err) => log.warn(`playback error: ${err.message}`));
    if (connection) this.subscription = connection.subscribe(this.player);
  }

  get speaking() {
    return this.busy;
  }

  /** True only while a line is actually coming out (not while it waits, loads or is paused; not a "Hmm." or a laugh). */
  get audible() {
    const cur = this.current;
    return Boolean(cur?.started && !cur.stopped && !cur.paused && !SOUNDS.has(cur.kind));
  }

  /** The line it has started saying (playing or paused): { kind, tag, paused }, or null. */
  nowPlaying() {
    const cur = this.current;
    if (!cur?.started || cur.stopped) return null;
    return { kind: cur.kind, tag: cur.tag, paused: Boolean(cur.paused) };
  }

  /** Pauses the line playing now, mid-word, to listen. True if it paused. */
  pause() {
    const cur = this.current;
    if (!cur?.started || cur.stopped || cur.paused) return false;
    if (!this.player.pause(true)) return false; // not actually playing yet (still buffering)
    cur.paused = true;
    cur.pausedAt = this.clock();
    this.endSpan(cur);
    return true;
  }

  /** Carries on with a paused line from where it stopped. True if it resumed. */
  resume() {
    const cur = this.current;
    if (!cur?.paused || cur.stopped) return false;
    cur.paused = false;
    cur.pausedMs = (cur.pausedMs || 0) + (this.clock() - cur.pausedAt);
    this.startSpan(cur);
    this.player.unpause();
    return true;
  }

  startSpan(item) {
    if (SOUNDS.has(item.kind)) return;
    item.span = { from: this.clock(), to: null };
    this.spans.push(item.span);
    if (this.spans.length > 20) this.spans.shift();
  }

  /** True while it's saying something, or has a line that must be said waiting (not ones it may drop). */
  get committed() {
    const due = (item) => Boolean(item && !item.stopped && !item.rules.dropIfNoGap);
    return this.audible || due(this.current) || this.queue.some(due);
  }

  /**
   * True if it was making sound for at least minOverlapMs between a and b
   * (used to tell whether someone talked over it).
   */
  wasAudibleBetween(a, b, minOverlapMs = 200) {
    const now = this.clock();
    return this.spans.some((s) => Math.min(s.to ?? now, b) - Math.max(s.from, a) >= minOverlapMs);
  }

  endSpan(item) {
    if (item.span && item.span.to === null) item.span.to = this.clock();
  }

  /**
   * Queue a line. Resolves when it has finished playing, or was dropped.
   * busy: who it has to wait for, if not everyone (a "Yeah?" only waits for the caller).
   * hold: while true, wait longer (up to HOLD_MAX_MS) before starting, say while the
   * person who asked is still talking. signal: takes the line back if it hasn't started.
   * continues: the next sentence of a reply that's already playing: it follows right
   * on (no waiting for a pause, no age limit), and its audio is fetched early.
   * tag: anything the caller wants back from nowPlaying().
   * source: audio made elsewhere (a song) instead of the voice: async ({ signal }) =>
   * { stream, sampleRate } (mono 16-bit), with durationMs, how long it plays.
   * onTurn: called when the line's turn comes (nothing of its own ahead of it any more).
   * @returns {Promise<'played'|'dropped'|'failed'|'stopped'>}
   */
  say(text, { kind = 'direct', onStart, onTurn, busy, hold, signal, continues = false, tag, source, durationMs } = {}) {
    const rules = KIND_RULES[kind] || KIND_RULES.direct;
    const item = { text, kind, rules, busy, hold, continues, tag, source, durationMs, ac: new AbortController(), onStart, onTurn, createdAt: this.clock(), audio: null, started: false, stopped: false };
    const done = new Promise((resolve) => {
      item.resolve = resolve;
    });
    if (signal?.aborted) {
      item.resolve('dropped');
      return done;
    }
    signal?.addEventListener('abort', () => this.takeBack(item), { once: true });
    this.queue.push(item);
    // Next up behind a line that's already playing: get its audio ready now.
    if (this.current?.started && this.queue[0] === item) this.prefetch(item);
    this.pump();
    return done;
  }

  /** Starts the audio for a line that's next in line (not for optional lines, which may be dropped). */
  prefetch(item) {
    if (item && !item.stopped && (item.continues || !item.rules.dropIfNoGap)) this.startAudio(item);
  }

  /** Forgets a line that hasn't started playing (one that has keeps going). */
  takeBack(item) {
    if (item.started || item.stopped) return;
    const i = this.queue.indexOf(item);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.release(item);
      item.resolve('dropped');
    } else if (this.current === item) {
      item.stopped = true; // playItem notices before it starts
      item.ac.abort();
    }
  }

  /** Stops and forgets lines of one kind, playing or not (the "Yeah?" once they've said the rest). */
  stopKind(kind) {
    this.queue = this.queue.filter((item) => {
      if (item.kind !== kind) return true;
      this.release(item);
      item.resolve('stopped');
      return false;
    });
    const cur = this.current;
    if (cur?.kind === kind && !cur.stopped) {
      cur.stopped = true;
      this.endSpan(cur);
      cur.ac.abort();
      if (cur.started) this.player.stop(true);
    }
  }

  /** Starts ElevenLabs for a line (once). Never rejects: failures come back as Error values. */
  startAudio(item) {
    if (!item.audio) {
      const audio = item.source
        ? Promise.resolve().then(() => item.source({ signal: item.ac.signal }))
        : this.tts.stream(item.text, { signal: item.ac.signal, cache: CACHED_KINDS.has(item.kind) });
      item.audio = audio.then(
        (a) => {
          // A stream we end up not playing still errors when it's aborted; keep that from crashing.
          a.stream.on('error', (e) => log.debug(`voice stream closed: ${e.message}`));
          return a;
        },
        (err) => err,
      );
    }
    return item.audio;
  }

  /** Cancels synthesis and frees the audio stream for a line that won't be played (or is done). */
  release(item) {
    item.ac.abort();
    item.audio?.then((a) => {
      if (!(a instanceof Error) && !a.stream.destroyed) a.stream.destroy();
    });
  }

  /**
   * Forget optional lines (quips, follow-ups) that haven't started playing yet,
   * so an answer someone is waiting for goes first. keep: lines to leave alone.
   */
  dropOptional(keep = null) {
    this.queue = this.queue.filter((item) => {
      if (!item.rules.dropIfNoGap || keep?.(item)) return true;
      this.release(item);
      item.resolve('dropped');
      return false;
    });
    const cur = this.current;
    if (cur && cur.rules.dropIfNoGap && !cur.started && !keep?.(cur)) {
      cur.stopped = true;
      cur.ac.abort();
    }
  }

  /** Stop talking now and forget everything queued. */
  stop() {
    for (const item of this.queue.splice(0)) {
      this.release(item);
      item.resolve('stopped');
    }
    if (this.current) {
      this.current.stopped = true;
      this.endSpan(this.current);
      this.current.ac.abort();
    }
    this.player.stop(true);
  }

  async pump() {
    if (this.busy) return;
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    this.current = item;
    item.onTurn?.();
    let outcome = 'played';
    try {
      outcome = await this.playItem(item);
    } catch (err) {
      outcome = 'failed';
      if (!item.stopped) {
        log.warn(`could not speak: ${err.message}`);
        this.onVoiceFailure(item.text, err, item.kind);
      }
    } finally {
      if (item.stopped) outcome = 'stopped';
      this.endSpan(item);
      this.release(item);
      if (item.kind === 'song' && item.started) this.afterSong(item.startedAt);
      item.resolve(outcome);
      this.current = null;
      this.busy = false;
      setImmediate(() => this.pump());
    }
  }

  /**
   * Lines that waited through a song (a reminder, say) don't count that time against
   * how long they stay worth saying.
   */
  afterSong(startedAt) {
    const now = this.clock();
    for (const q of this.queue) q.createdAt += now - Math.max(q.createdAt, startedAt);
  }

  async playItem(item) {
    const { rules } = item;
    // The rest of a reply that's already been heard goes right on: no age limit, no
    // waiting for a pause (talking over it is handled by pausing or cutting in).
    if (!item.continues) {
      if (this.clock() - item.createdAt > rules.maxAgeMs) {
        log.debug(`dropped a ${item.kind} line: too old by the time it could play`);
        return 'dropped';
      }
      // Lines that must be said start synthesizing now, while it waits for a pause.
      // Optional ones (quips, follow-ups) wait: ElevenLabs bills every request, and
      // many of them get dropped because nobody pauses.
      if (!rules.dropIfNoGap) this.startAudio(item);
      const gotGap = await this.waitForGap(rules.gapWaitMs, item);
      if (item.stopped) return 'stopped';
      if (!gotGap && rules.dropIfNoGap) {
        log.debug(`dropped a ${item.kind} line: nobody paused`);
        return 'dropped';
      }
    }

    const audio = await this.startAudio(item);
    if (audio instanceof Error) throw audio;
    if (item.stopped) return 'stopped';

    let received = 0;
    let streamError = null;
    audio.stream.on('data', (chunk) => {
      received += chunk.length;
    });
    const pcm = new MonoToDiscordPcm({ inputRate: audio.sampleRate, volume: this.volume });
    pipeline(audio.stream, pcm, (err) => {
      if (err && !item.stopped) streamError = err;
    });

    // Let a little audio pile up first so the start doesn't stutter.
    const need = Math.round((audio.sampleRate * 2 * PREBUFFER_MS) / 1000);
    await this.waitFor(() => received >= need || audio.stream.readableEnded || streamError || item.stopped, FIRST_AUDIO_TIMEOUT_MS);
    if (item.stopped) return 'stopped';
    if (streamError) throw streamError;
    if (received === 0) throw new Error('ElevenLabs sent no audio in time');
    // Someone may have started talking while the audio loaded: an optional line
    // waits for them to pause again rather than starting over them.
    if (rules.dropIfNoGap && !item.continues && this.someoneBusy(item)) {
      const again = await this.waitForGap(rules.gapWaitMs, item);
      if (item.stopped) return 'stopped';
      if (!again) {
        log.debug(`dropped a ${item.kind} line: someone started talking`);
        return 'dropped';
      }
    }

    // Fetch the next line's audio while this one plays (unless it may be dropped).
    this.prefetch(this.queue[0]);

    const resource = createAudioResource(pcm, { inputType: StreamType.Raw });
    item.started = true;
    item.startedAt = this.clock();
    this.startSpan(item);
    item.onStart?.();
    this.player.play(resource);
    await this.waitUntilIdle(item);
    if (item.stopped) return 'stopped';
    if (streamError) throw streamError;
    return 'played';
  }

  /** Someone is talking, or (for optional lines) a sentence of theirs is still being processed. */
  someoneBusy(item) {
    if (item.busy) return item.busy();
    return this.isAnyoneSpeaking() || (item.rules.dropIfNoGap && this.isHearing());
  }

  async waitForGap(maxWaitMs, item) {
    const start = this.clock();
    while (!item.stopped) {
      const waited = this.clock() - start;
      // While held (whoever asked is still talking), keep waiting past the usual limit.
      const held = waited < HOLD_MAX_MS && Boolean(item.hold?.());
      if (!held && !this.someoneBusy(item)) return true;
      if (!held && waited >= maxWaitMs) return false;
      await new Promise((r) => setTimeout(r, 80));
    }
    return false;
  }

  async waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  }

  waitUntilIdle(item) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.player.off('stateChange', onState);
        clearTimeout(safety);
        resolve();
      };
      const onState = (_old, next) => {
        if (next.status === AudioPlayerStatus.Idle) finish();
      };
      this.player.on('stateChange', onState);
      // Never hang the queue: generous ceiling based on how long the line is (time
      // spent paused doesn't count), and a pause never lasts forever. Audio made
      // elsewhere (a song) says how long it plays.
      const ceiling = item.durationMs > 0 ? item.durationMs + 15000 : Math.max(20000, item.text.length * 150);
      const startedAt = this.clock();
      const check = () => {
        if (settled) return;
        const now = this.clock();
        const pausedMs = (item.pausedMs || 0) + (item.paused ? now - item.pausedAt : 0);
        const tooLongPaused = item.paused && now - item.pausedAt >= PAUSE_MAX_MS;
        const left = startedAt + ceiling + pausedMs - now;
        if (!tooLongPaused && left > 0) {
          safety = setTimeout(check, Math.min(Math.max(250, left), item.paused ? 1000 : left));
          return;
        }
        log.warn(tooLongPaused ? 'a line stayed paused too long; dropping the rest of it' : 'playback took too long; skipping the rest of this line');
        item.ac.abort();
        this.player.stop(true);
        finish();
      };
      let safety = setTimeout(check, ceiling);
      if (this.player.state.status === AudioPlayerStatus.Idle) finish();
    });
  }

  destroy() {
    this.stop();
    this.subscription?.unsubscribe();
  }
}
