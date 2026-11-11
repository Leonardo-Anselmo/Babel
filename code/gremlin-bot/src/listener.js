// The bot's ears. Subscribes to each person's audio in the voice channel,
// decodes Opus, cuts it into utterances on pauses, and emits finished
// utterances as 16 kHz mono WAV ready for speech-to-text.

import { EventEmitter } from 'node:events';
import { EndBehaviorType } from '@discordjs/voice';
import { createOpusDecoder, pcmToWav, rms, stereo48kToMono16k, STEREO_BYTES_PER_MS } from './audio.js';
import { logger } from './log.js';

const log = logger('ears');

const FRAME_MS = 20;
const FRAME_BYTES = Math.round(STEREO_BYTES_PER_MS * FRAME_MS); // one 20 ms frame of 48 kHz stereo
const PREROLL_FRAMES = 8; // keep 160 ms before speech starts so first syllables aren't clipped
const KEEP_TRAILING_FRAMES = 10; // keep 200 ms after speech ends
const GARBAGE_RMS = 26000;
// A sentence starts after 60 ms of sound loud enough to be speech, so a key click
// or a bump doesn't start one; once started, a lone loud frame doesn't keep it going.
const ONSET_FRAMES = 3;
const KEEP_GOING_FRAMES = 2;
// Background noise level per person: the quiet end (10th percentile) of the last
// 4 s of their audio, refreshed every 100 ms once there's half a second of it.
const NOISE_WINDOW_FRAMES = 200;
const NOISE_MIN_FRAMES = 25;
const NOISE_EVERY_FRAMES = 5;
// Sound this loud always counts as speech, however steady (a mic this noisy is unusable anyway).
const NOISE_LEVEL_CAP = 1500;
// Frames still end-to-end encrypted (DAVE keys not ready yet, for a moment after
// joining or when someone joins) end in this marker. They decode to noise.
const DAVE_MARKER = 0xfa;
// While the bot is talking, peek at what someone is saying after this much
// speech, so "Gremlin, ..." can stop it before they've even finished.
const PEEK_AT_MS = [900, 2000];
// How often to check for people who are talking but not being listened to.
const RESUBSCRIBE_CHECK_MS = 2000;
// After this much quiet in the middle of a sentence, ask whether they're done
// talking (and whether that was its name), instead of always waiting SILENCE_MS.
export const PAUSE_CHECK_MS = 200;
// ...and once more after this much, if they didn't sound done at first (a longer
// quiet makes the end of a sentence clearer), before the full SILENCE_MS.
export const PAUSE_RECHECK_MS = 420;
const TURN_AUDIO_FRAMES = 400; // the last 8 s, all the end-of-turn model looks at
// While the bot is talking, how often to check the last few seconds for its name.
const NAME_CHECK_EVERY_MS = 300;
const NAME_CHECK_FRAMES = 125; // 2.5 s

export class Listener extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('@discordjs/voice').VoiceReceiver} opts.receiver
   * @param {{silenceMs:number,minSpeechMs:number,maxUtteranceMs:number,voiceRms:number,noiseMargin?:number}} opts.listen
   *   noiseMargin: how many times louder than someone's background noise speech must be (0: off)
   * @param {(userId: string) => boolean} opts.shouldListen
   */
  /**
   * wantPeek: whether to hand out the start of a long sentence for a full listen (the bot is talking).
   * wantNameChecks: whether to hand out the last few seconds every 300 ms for the name detector.
   * wantPauses: whether short pauses are worth a clip for the end-of-turn model (it's on).
   */
  constructor({ receiver, listen, shouldListen, wantPeek = () => false, wantNameChecks = () => false, wantPauses = () => true, clock = Date.now, createDecoder = createOpusDecoder }) {
    super();
    this.receiver = receiver;
    this.cfg = listen;
    this.shouldListen = shouldListen;
    this.wantPeek = wantPeek;
    this.wantNameChecks = wantNameChecks;
    this.wantPauses = wantPauses;
    this.clock = clock;
    this.createDecoder = createDecoder;
    this.users = new Map();
    this.lastId = 0; // each sentence gets an id, shared by its peeks and the final utterance
    this.resubscribes = new Map(); // userId -> recent resubscribe timestamps
    this.onSpeakingStart = this.onSpeakingStart.bind(this);
    this.tick = null;
    this.stopped = false;
    this.lastResubscribeCheck = 0;
  }

  start() {
    this.receiver.speaking.on('start', this.onSpeakingStart);
    // Every 20 ms (one audio frame), so a pause is noticed as soon as it's long enough.
    this.tick = setInterval(() => this.sweep(), FRAME_MS);
  }

  stop() {
    this.stopped = true;
    this.receiver.speaking.off('start', this.onSpeakingStart);
    clearInterval(this.tick);
    this.dropAll();
  }

  /** True while someone's sentence is still open (they may have just paused mid-thought). */
  hasOpenSentence() {
    for (const st of this.users.values()) if (st.active) return true;
    return false;
  }

  /**
   * True while any human in the call is mid-sentence (music bots don't count).
   * Discord says who is sending audio, but an open mic sends its background noise
   * all the time, which would mean the bot never finds a pause. So for people it
   * listens to, their own sentence detection decides: sending, but nothing as loud
   * as speech since their last sentence ended, doesn't count as talking.
   */
  isAnyoneSpeaking(isHuman = () => true) {
    for (const userId of this.receiver.speaking.users.keys()) {
      if (!isHuman(userId)) continue;
      const st = this.users.get(userId);
      if (!st || st.active) return true;
    }
    return false;
  }

  /** True while this person is mid-sentence. */
  isSpeaking(userId) {
    return Boolean(this.users.get(userId)?.active);
  }

  /** How much of this person's current sentence has been actual talking, in ms (0 if none). */
  voicedMs(userId) {
    const st = this.users.get(userId);
    return st?.active ? st.voicedFrames * FRAME_MS : 0;
  }

  onSpeakingStart(userId) {
    if (this.stopped || this.users.has(userId)) return;
    if (!this.shouldListen(userId)) return;
    this.subscribe(userId);
  }

  subscribe(userId) {
    const stream = this.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const st = {
      userId,
      stream,
      decoder: this.createDecoder(),
      active: false,
      id: 0,
      frames: [],
      preroll: [],
      startedAt: 0,
      lastVoiceAt: 0,
      voicedFrames: 0,
      trailing: 0,
      peeks: 0,
      run: 0, // loud frames in a row
      levels: [], // recent frame loudness, for their background noise level
      noise: 0,
      sinceNoise: 0,
      pauseSeq: 0, // pauses within the sentence so far
      pauseOpen: false, // a pause is under way and was handed out for a check
      pauseChecks: 0, // checks handed out for this pause (at most two)
      nameChecks: 0,
      dropped: false,
    };
    this.users.set(userId, st);
    stream.on('data', (packet) => this.onPacket(st, packet));
    stream.on('error', (err) => log.debug(`receive stream error for ${userId}: ${err.message}`));
    stream.once('close', () => this.onStreamClosed(st));
    log.debug(`listening to ${userId} (decoder: ${st.decoder.name})`);
  }

  onPacket(st, packet) {
    // Still end-to-end encrypted: it would decode to noise that looks like talking.
    if (packet?.length >= 2 && packet[packet.length - 1] === DAVE_MARKER && packet[packet.length - 2] === DAVE_MARKER) return;
    let pcm;
    try {
      pcm = st.decoder.decode(packet);
    } catch {
      return; // corrupt or undecryptable packet: skip it
    }
    if (!pcm || pcm.length === 0) return;
    const now = this.clock();
    const level = rms(pcm);
    // Near full-scale noise is a frame that couldn't be decrypted yet (happens for
    // a moment while encryption keys change), not someone talking. Skip it.
    if (level > GARBAGE_RMS) return;
    st.run = level >= this.speechLevel(st, level) ? st.run + 1 : 0;

    if (!st.active) {
      st.preroll.push(pcm);
      if (st.preroll.length > PREROLL_FRAMES) st.preroll.shift();
      if (st.run < ONSET_FRAMES) return;
      // Sustained sound loud enough to be speech: a sentence starts (with what led up to it).
      st.active = true;
      st.id = ++this.lastId;
      st.startedAt = now;
      st.frames = st.preroll;
      st.preroll = [];
      st.voicedFrames = ONSET_FRAMES;
      st.lastVoiceAt = now;
      st.trailing = 0;
      st.peeks = 0;
      st.pauseSeq = 0;
      st.pauseOpen = false;
      st.pauseChecks = 0;
      st.nameChecks = 0;
      this.emit('start', { userId: st.userId, id: st.id, at: now });
      return;
    }

    st.frames.push(pcm);
    const voiced = st.run >= KEEP_GOING_FRAMES;
    if (voiced) {
      st.lastVoiceAt = now;
      st.voicedFrames++;
      st.trailing = 0;
      st.pauseOpen = false;
      st.pauseChecks = 0;
      if (st.peeks < PEEK_AT_MS.length && st.voicedFrames * FRAME_MS >= Math.max(PEEK_AT_MS[st.peeks], this.cfg.minSpeechMs)) {
        st.peeks++;
        if (this.wantPeek(st.userId)) this.emitPeek(st);
      }
      const voicedMs = st.voicedFrames * FRAME_MS;
      if (voicedMs >= (st.nameChecks + 1) * NAME_CHECK_EVERY_MS) {
        st.nameChecks = Math.floor(voicedMs / NAME_CHECK_EVERY_MS);
        // (Not before it's long enough to count as a sentence at all.)
        if (voicedMs >= this.cfg.minSpeechMs && this.wantNameChecks(st.userId)) this.emitNameCheck(st);
      }
    } else {
      st.trailing++;
      const quietMs = st.trailing * FRAME_MS;
      if (!st.pauseOpen && quietMs >= PAUSE_CHECK_MS && quietMs < this.cfg.silenceMs) this.emitPause(st);
      else if (st.pauseOpen && st.pauseChecks === 1 && quietMs >= PAUSE_RECHECK_MS && quietMs < this.cfg.silenceMs) this.emitPause(st, { again: true });
    }
    // Count audio frames rather than wall-clock time here, so bursts of
    // late-arriving packets are measured correctly.
    if (st.trailing * FRAME_MS >= this.cfg.silenceMs) this.finalize(st, 'quiet');
    else if (st.frames.length * FRAME_MS >= this.cfg.maxUtteranceMs) this.finalize(st, 'max length');
  }

  /**
   * How loud a frame must be to count as speech for this person: at least
   * VOICE_RMS_THRESHOLD, and noiseMargin times their background noise, so an open
   * mic's hiss, fan or keyboard doesn't look like someone talking all the time.
   */
  speechLevel(st, level) {
    const margin = this.cfg.noiseMargin ?? 2;
    if (!(margin > 0)) return this.cfg.voiceRms;
    // Digital silence (what Discord sends at the end of talking) isn't background noise.
    if (level >= 1) {
      st.levels.push(level);
      if (st.levels.length > NOISE_WINDOW_FRAMES) st.levels.shift();
    }
    if (st.levels.length >= NOISE_MIN_FRAMES && ++st.sinceNoise >= NOISE_EVERY_FRAMES) {
      st.sinceNoise = 0;
      const sorted = [...st.levels].sort((a, b) => a - b);
      st.noise = sorted[Math.floor(sorted.length * 0.1)];
    }
    return Math.max(this.cfg.voiceRms, Math.min(margin * st.noise, NOISE_LEVEL_CAP));
  }

  /**
   * Mid-sentence pause: hands out the sentence so far, to ask whether they're done (see
   * endSentence). again: the same pause, a little later, asked once more.
   */
  emitPause(st, { again = false } = {}) {
    if (again) {
      st.pauseChecks = 2;
    } else {
      st.pauseOpen = true;
      st.pauseSeq++;
      st.pauseChecks = 1;
    }
    // (Making the clip takes a few milliseconds of the listener's 20 ms: not when nothing uses it.)
    if (!this.wantPauses(st.userId)) return;
    const frames = st.frames.slice(-TURN_AUDIO_FRAMES);
    // Discord stops sending audio when someone goes quiet: add the quiet the end-of-turn
    // model expects to hear after the last word (it was trained with it).
    const missing = Math.max(0, Math.round((again ? PAUSE_RECHECK_MS : PAUSE_CHECK_MS) / FRAME_MS) - st.trailing);
    const pcm = Buffer.concat(missing ? [...frames, Buffer.alloc(missing * FRAME_BYTES)] : frames);
    const wav = pcmToWav(stereo48kToMono16k(pcm), 16000, 1);
    this.emit('pause', {
      userId: st.userId,
      id: st.id,
      pauseSeq: st.pauseSeq,
      wav,
      durationMs: Math.round(pcm.length / STEREO_BYTES_PER_MS),
      voicedMs: st.voicedFrames * FRAME_MS,
      again,
    });
  }

  /**
   * They sound done: end their sentence now instead of after the full SILENCE_MS.
   * Only if it's the same sentence and the same pause (they haven't started again).
   */
  endSentence(userId, id, pauseSeq) {
    const st = this.users.get(userId);
    if (!st || !st.active || st.id !== id || !st.pauseOpen || st.pauseSeq !== pauseSeq) return false;
    this.finalize(st, 'done talking');
    return true;
  }

  /** The last few seconds of what they're saying, for the name detector (while the bot talks). */
  emitNameCheck(st) {
    const pcm = Buffer.concat(st.frames.slice(-NAME_CHECK_FRAMES));
    const wav = pcmToWav(stereo48kToMono16k(pcm), 16000, 1);
    this.emit('namecheck', { userId: st.userId, id: st.id, wav });
  }

  /** Hands out the start of a sentence that's still in progress. */
  emitPeek(st) {
    const pcm = Buffer.concat(st.frames);
    const wav = pcmToWav(stereo48kToMono16k(pcm), 16000, 1);
    this.emit('peek', { userId: st.userId, id: st.id, wav, durationMs: Math.round(pcm.length / STEREO_BYTES_PER_MS) });
  }

  /** Runs every frame: closes utterances once someone has been quiet long enough. */
  sweep() {
    const now = this.clock();
    for (const st of this.users.values()) {
      if (!st.active) continue;
      const quiet = now - st.lastVoiceAt;
      if (quiet >= this.cfg.silenceMs) this.finalize(st, 'pause');
      // Their audio stopped coming (Discord stops sending when they go quiet).
      else if (!st.pauseOpen && quiet >= PAUSE_CHECK_MS) this.emitPause(st);
      else if (st.pauseOpen && st.pauseChecks === 1 && quiet >= PAUSE_RECHECK_MS) this.emitPause(st, { again: true });
    }
    if (now - this.lastResubscribeCheck >= RESUBSCRIBE_CHECK_MS) {
      this.lastResubscribeCheck = now;
      this.resubscribeTalkers(now);
    }
  }

  /**
   * Discord only says someone started talking after a pause in their audio, so a
   * person who never pauses (an open mic) and lost their subscription (errors, a
   * channel move) would go unheard for good. Pick them back up.
   */
  resubscribeTalkers(now) {
    if (this.stopped) return;
    for (const userId of this.receiver.speaking.users.keys()) {
      if (this.users.has(userId) || !this.shouldListen(userId)) continue;
      const recent = (this.resubscribes.get(userId) || []).filter((t) => now - t < 10000);
      if (recent.length >= 5) continue; // it keeps failing: give it a rest
      recent.push(now);
      this.resubscribes.set(userId, recent);
      log.debug(`picking ${userId} back up: they're talking but I wasn't listening`);
      this.subscribe(userId);
    }
  }

  finalize(st, why) {
    const frames = st.frames;
    const trailing = st.trailing;
    const voicedMs = st.voicedFrames * FRAME_MS;
    const startedAt = st.startedAt;
    const spokeUntil = st.lastVoiceAt;
    const id = st.id;
    st.active = false;
    st.frames = [];
    st.preroll = [];
    st.voicedFrames = 0;
    st.trailing = 0;
    st.peeks = 0;
    st.pauseOpen = false;

    if (voicedMs < this.cfg.minSpeechMs) {
      log.debug(`ignored a sound from ${st.userId}: ${voicedMs} ms, under MIN_SPEECH_MS`);
      // Anything waiting on this sentence (a pause, a cut-in) needn't wait any more.
      this.emit('ignored', { userId: st.userId, id });
      return;
    }
    const keep = frames.length - Math.max(0, trailing - KEEP_TRAILING_FRAMES);
    const pcm = Buffer.concat(frames.slice(0, Math.max(1, keep)));
    const durationMs = Math.round(pcm.length / STEREO_BYTES_PER_MS);
    const wav = pcmToWav(stereo48kToMono16k(pcm), 16000, 1);
    log.debug(`utterance from ${st.userId}: ${durationMs} ms (${why})`);
    this.emit('utterance', { userId: st.userId, id, wav, durationMs, voicedMs, startedAt, spokeUntil, endedAt: this.clock() });
  }

  onStreamClosed(st) {
    if (this.users.get(st.userId) !== st) return;
    if (st.active) this.finalize(st, 'stream closed');
    st.decoder.destroy();
    this.users.delete(st.userId);
    if (st.dropped || this.stopped) return;
    // The library closes a stream when decryption keeps failing. Re-subscribe,
    // but not in a tight loop.
    const now = this.clock();
    const recent = (this.resubscribes.get(st.userId) || []).filter((t) => now - t < 10000);
    if (recent.length >= 5) {
      log.warn(`audio from ${st.userId} keeps failing; will retry when they next speak`);
      return;
    }
    recent.push(now);
    this.resubscribes.set(st.userId, recent);
    setTimeout(() => {
      if (!this.stopped && !this.users.has(st.userId) && this.shouldListen(st.userId)) this.subscribe(st.userId);
    }, 50);
  }

  /** Stop listening to everyone (used when moving channels); they resubscribe when they talk. */
  dropAll() {
    for (const userId of [...this.users.keys()]) this.drop(userId);
  }

  /** Stop listening to someone right away and throw away anything buffered. */
  drop(userId) {
    const st = this.users.get(userId);
    if (!st) return;
    st.dropped = true;
    st.active = false;
    st.frames = [];
    st.decoder.destroy();
    this.users.delete(userId);
    st.stream.destroy();
  }
}
