// One live voice call: connection + ears + mouth + brain, for one server.

import { VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import { ActivityType } from 'discord.js';
import { ACKS, Brain, FILLERS, replyTimeSummary } from './brain.js';
import { LAUGHS, PICTURE_POSTED, SONG_INTROS, THINKING_SOUNDS } from './human.js';
import { canPostPictures, drawAndPost, imagesNowFor, lastKey } from './images.js';
import { CallNotes } from './callnotes.js';
import { callbacksToOffer, mentionsAny } from './jokes.js';
import { Listener } from './listener.js';
import { canPostText, describeResult, formatListPosts, formatListsForPrompt, problemNote } from './lists.js';
import { logger } from './log.js';
import { cleanSpoken, formatEarlierCalls, sourceLinks, withoutHiddenTags } from './prompts.js';
import { formatIn, formatReminders, formatTime } from './reminders.js';
import { Speaker } from './speaker.js';
import { oneLine } from './usage.js';
import { Vocabulary } from './vocab.js';
import { isAddressed } from './wakeword.js';

const log = logger('call');
const CONNECT_TIMEOUT_MS = 20000;
const RECOVER_TIMEOUT_MS = 30000;
const REJOIN_ATTEMPTS = 3;
// How long to wait while reconnecting (tests use shorter ones).
const RECONNECT_TIMING = { settleMs: 5000, readyMs: 15000, backoffMs: 3000 };
const PEEK_TIMEOUT_MS = 3000; // an early name check that takes longer than this is no use
// The end-of-turn model's score (0-1) at which a short pause counts as the end of what they're saying.
export const TURN_DONE = 0.5;
// The name detector's default threshold (NAME_DETECTOR_THRESHOLD).
const NAME_THRESHOLD = 0.7;
// Get "Yeah?" and "One sec." ready a little after joining (after the hello), so even the first one is quick.
const PREWARM_AFTER_MS = 5000;
// What it made of each sentence, for data/bot.log (who spoke and what it did, never the words).
const HEARD_OUTCOMES = {
  direct: 'talking to me, answering',
  listening: 'called my name, waiting for the rest',
  acknowledged: 'called my name, quick reply and listening',
  'listening-quietly': 'maybe called my name (not sure), listening without a reply',
  'talk-less': 'told me to butt in less',
  'talking-less': "maybe replying to me, but I'm butting in less",
  hesitating: 'only an "erm", waiting for the rest',
  continued: 'more of what they just said to me, answering all of it',
  followup: 'maybe replying to me, checking',
  stop: 'told me to stop',
  echo: 'my own voice through their mic, ignored',
  'carried-on': 'only reacting while I answered them, so I carried on',
  heard: 'not for me (no name, no conversation going)',
  singing: "I'm singing a song, so I let it play",
  farewell: "they're heading out, saying bye",
  closed: 'session over',
};
// Rejoining within this long after leaving isn't a new arrival (no second hi).
const REJOIN_QUIET_MS = 10 * 60000;
// A call shorter than this isn't saved to its memory of earlier calls (restarts left
// 1 to 3 minute "calls" that pushed real ones out of the few it's shown).
const MIN_CALL_TO_REMEMBER_MS = 3 * 60000;
// Its own short sounds aren't worth posting in text when the voice fails.
const SOUND_KINDS = new Set(['ack', 'filler', 'think', 'laugh', 'intro', 'posted']);

function formatDuration(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just started';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export class VoiceSession {
  constructor({ client, guild, voiceChannel, textChannel, config, claude, claudeFast, claudeJokes = null, venice = null, stt, tts, memory, usage, onEnd, timing, isOwner, getScreenshot, reminders, songs, images, lists }) {
    this.client = client;
    // Pictures people ask for (Gemini; see images.js), posted in the call's text chat.
    this.images = images || null;
    // Songs people ask for (ElevenLabs Music; see songs.js), and the one being made now.
    this.songs = songs || null;
    this.songJob = null;
    this.songCalledOffAt = 0; // when someone last asked it to cancel the song it was making
    // For hi and bye: when each person joined this call (userId -> time), and when people
    // left (userId -> { at, joinedAt }: someone whose connection drops for a moment keeps
    // the time they first joined).
    this.joinTimes = new Map();
    this.leftAt = new Map();
    // Reminders people ask for in voice (shared by every server; see reminders.js).
    this.reminders = reminders || null;
    // The shared lists people keep with it (every server's, in memory.json; see lists.js).
    this.lists = lists || null;
    // The bot's owner (the only one who can ask it to look at the screen), and how to get a picture of it.
    this.isOwner = isOwner || (() => false);
    this.getScreenshot = getScreenshot || null;
    this.guild = guild;
    this.channelId = voiceChannel.id;
    this.textChannel = textChannel;
    this.config = config;
    this.claude = claude;
    this.claudeFast = claudeFast;
    this.claudeJokes = claudeJokes; // writes its own jokes (CLAUDE_JOKE_MODEL)
    this.venice = venice; // writes some kinds of line instead of Claude (VENICE_FOR)
    this.stt = stt;
    this.tts = tts;
    this.memory = memory;
    this.usage = usage;
    this.usageAtStart = null; // usage counters when it joined, for the end-of-call summary
    this.joinedAt = 0;
    this.onEnd = onEnd;
    this.connection = null;
    this.starting = false;
    this.ready = false;
    this.ended = false;
    this.aloneTimer = null;
    this.watchdog = null;
    this.moving = false;
    this.voiceFailureNoticeAt = 0;
    this.replyFailureNoticeAt = 0;
    this.recovering = false;
    this.timing = { ...RECONNECT_TIMING, ...timing };
    this.transcribing = 0; // sentences sent to speech-to-text and not back yet
    this.transcribingFrom = new Map(); // userId -> how many of their sentences are being transcribed
    this.names = new Map();
    this.peeking = new Set(); // users whose sentence start is being checked for the name
    this.turnChecking = new Map(); // userId -> the check of their pause running now (are they done?)
    this.nameChecking = new Set(); // users whose last few seconds are being checked for its name
    this.transcribedUpTo = new Map(); // userId -> id of their latest sentence that's fully transcribed
    this.callNotes = null; // notes on this call, with CALL_MEMORY on
    this.peopleHeard = new Set(); // names of everyone it heard this call (for the call's notes)
    this.vocab = null; // words it learned to spell for the speech-to-text (LEARN_WORDS)
  }

  get voiceChannel() {
    return this.guild.channels.cache.get(this.channelId);
  }

  /** Waits for the connection to be Ready, giving up early if the session ends. */
  async waitForReady(timeoutMs) {
    const ac = new AbortController();
    const stopIfEnded = setInterval(() => {
      if (this.ended || this.connection.state.status === VoiceConnectionStatus.Destroyed) ac.abort();
    }, 200);
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]));
      return true;
    } catch {
      return false;
    } finally {
      clearInterval(stopIfEnded);
    }
  }

  destroyConnection() {
    const c = this.connection;
    if (c && c.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        c.destroy();
      } catch {
        // already gone
      }
    }
  }

  async start() {
    const cfg = this.config;
    if (this.ended) throw new Error('the join was cancelled');
    this.starting = true;
    this.connection = joinVoiceChannel({
      channelId: this.channelId,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false, // must hear people
      selfMute: false,
      daveEncryption: true, // Discord requires end-to-end encrypted voice
      debug: cfg.debugVoice,
    });
    const conn = this.connection;
    if (cfg.debugVoice) conn.on('debug', (m) => log.info(`voice: ${m}`));
    conn.on('error', (err) => log.warn(`voice connection error: ${err.message}`));
    conn.on('stateChange', (a, b) => this.onConnectionState(a.status, b.status));

    const ok = await this.waitForReady(CONNECT_TIMEOUT_MS);
    if (!ok || this.ended) {
      this.starting = false;
      this.destroyConnection();
      if (this.ended) throw new Error('the join was cancelled');
      throw new Error(
        "couldn't connect to voice within 20 seconds. Check that the bot has Connect and Speak permission in that channel. If it keeps happening, the server's network may be blocking voice (UDP).",
      );
    }

    conn.on(VoiceConnectionStatus.Disconnected, () => {
      this.recover().catch((err) => log.debug(`reconnect attempt failed: ${err.message}`));
    });
    conn.on(VoiceConnectionStatus.Destroyed, () => this.end('connection destroyed'));

    this.listener = new Listener({
      receiver: conn.receiver,
      listen: cfg.listen,
      shouldListen: (id) => this.shouldListen(id),
      wantPeek: () => Boolean(this.speaker?.audible), // only worth it while it's making sound
      // Its name, listened for as a sound every 300 ms while it's talking (local Whisper only).
      wantNameChecks: () => this.nameChecksOn() && Boolean(this.speaker?.audible),
      wantPauses: () => this.turnChecksOn(),
    });
    this.speaker = new Speaker({
      connection: conn,
      tts: this.tts,
      volume: cfg.tts.volume,
      isAnyoneSpeaking: () => this.listener.isAnyoneSpeaking((id) => this.isHuman(id)),
      isHearing: () => this.isHearingSomething(),
      onVoiceFailure: (text, err, kind) => this.voiceFailed(text, err, kind),
    });
    // Words from their games it learned to spell, given to the speech-to-text as hints.
    // (memory.json couldn't be read: this call's learning starts from nothing, so it isn't saved over the file.)
    const keep = !this.memory.unreadable;
    if (cfg.stt.learnWords !== false) {
      this.vocab = new Vocabulary(this.memory.words(this.guild.id), { onChange: keep ? (entries) => this.memory.setWords(this.guild.id, entries) : undefined });
    }
    if (cfg.callMemory) {
      this.callNotes = new CallNotes({ claude: this.claudeFast || this.claude, botName: cfg.botName, timezone: cfg.timezone });
    }
    this.brain = new Brain({
      config: cfg,
      claude: this.claude,
      claudeFast: this.claudeFast,
      claudeJokes: this.claudeJokes,
      venice: this.venice,
      speaker: this.speaker,
      getCallInfo: () => this.callInfo(),
      getFacts: () => this.memory.facts(this.guild.id),
      isAnyoneSpeaking: () => this.listener.isAnyoneSpeaking((id) => this.isHuman(id)),
      isSpeaking: (userId) => this.listener.isSpeaking(userId),
      voicedMs: (userId) => this.listener.voicedMs(userId),
      isHearingSomething: () => this.isHearingSomething(),
      isHearingFrom: (userId) => (this.transcribingFrom.get(userId) ?? 0) > 0,
      chattiness: this.memory.chattiness(this.guild.id) || cfg.defaultChattiness,
      onReplyFailure: (kind, err) => this.replyFailed(err),
      onSources: (citations) => this.postSources(citations),
      isOwner: (userId) => this.isOwner(userId),
      getScreenshot: this.getScreenshot || undefined,
      callNotes: this.callNotes,
      getEarlierCalls: () => (cfg.callMemory ? formatEarlierCalls(this.memory.calls(this.guild.id), cfg.timezone) : ''),
      jokes: this.memory.jokes(this.guild.id),
      onJokes: keep ? (state) => this.memory.setJokes(this.guild.id, state) : undefined,
      learnWords: this.vocab ? (said, heard, opts) => this.learnWords(said, heard, opts) : undefined,
      getCallbacks: () => callbacksToOffer(this.memory.landedJokes?.(this.guild.id) ?? [], { since: this.joinedAt, avoidNames: this.optedOutNames() }),
      onJokeLanded: keep && this.memory.addLandedJoke ? (text) => this.keepJoke(text) : undefined,
      onCallbackUsed: keep && this.memory.markJokeUsed ? (text) => this.memory.markJokeUsed(this.guild.id, text) : undefined,
      getReminders: () => (this.reminders ? formatReminders(this.reminders.list(this.guild.id), cfg.timezone) : ''),
      onReminders: this.reminders && cfg.reminders !== false ? (tags, info) => this.applyReminders(tags, info) : undefined,
      getLists: () => this.listsForPrompt(),
      onLists: this.lists && cfg.lists !== false ? (tags, info) => this.applyLists(tags, info) : undefined,
      getJoinedAt: (userId) => this.joinTimes.get(userId) ?? this.joinedAt,
      onSong: this.songs?.enabled ? (tag, info) => this.makeSong(tag, info) : undefined,
      getSongsNow: () => this.songsNow(),
      isMakingSong: () => Boolean(this.songJob),
      onImage: this.images?.enabled ? (tag, info) => this.drawImage(tag, info) : undefined,
      getImagesNow: () => this.imagesNow(),
      onCancelSong: (why) => this.cancelSong(why),
    });
    this.listener.on('utterance', (u) => {
      this.onUtterance(u).catch((err) => log.warn(`utterance handling failed: ${err.message}`));
    });
    this.listener.on('peek', (p) => {
      this.onPeek(p).catch((err) => log.debug(`early name check failed: ${err.message}`));
    });
    this.listener.on('start', ({ userId, id }) => {
      if (this.shouldListen(userId)) this.brain.speechStarted(userId, id);
    });
    this.listener.on('pause', (p) => {
      this.onPause(p).catch((err) => log.debug(`end-of-turn check failed: ${err.message}`));
    });
    this.listener.on('namecheck', (c) => {
      this.onNameCheck(c).catch((err) => log.debug(`name detector check failed: ${err.message}`));
    });
    // A sound too short to be a sentence: nothing comes of it.
    this.listener.on('ignored', ({ userId, id }) => this.brain?.soundIgnored(userId, id));
    this.listener.start();
    this.starting = false;
    this.ready = true;
    this.joinedAt = Date.now();
    this.usageAtStart = this.usage?.snapshot() ?? null;
    this.checkAlone();
    for (const m of this.humans()) {
      this.joinTimes.set(m.id, this.joinedAt);
      if (!this.memory.isOptedOut(this.guild.id, m.id)) this.peopleHeard.add(m.displayName);
    }
    const extras = [this.turnChecksOn() && 'end-of-turn model', this.nameChecksOn() && 'name detector', this.callNotes && 'call memory'].filter(Boolean);
    log.info(`joined #${this.voiceChannel?.name} in ${this.guild.name}${extras.length ? ` (${extras.join(', ')} on)` : ''}`);
    this.brain.greet();
    // Its short fixed lines and sounds, made ahead of time so they play at once.
    const sounds = [
      ...ACKS,
      ...FILLERS,
      ...(cfg.thinkingSounds !== false ? THINKING_SOUNDS : []),
      ...(cfg.laughAlong !== false ? LAUGHS : []),
      ...(this.songs?.enabled ? SONG_INTROS : []),
      ...(this.images?.enabled ? PICTURE_POSTED : []),
    ];
    this.prewarmTimer = setTimeout(() => {
      if (!this.ended) this.tts.prewarm?.(sounds).catch(() => {});
    }, PREWARM_AFTER_MS);
  }

  /**
   * If the voice connection drops out of Ready and doesn't come back, try one
   * rejoin, then give up, so the bot never sits in a channel deaf and mute.
   */
  onConnectionState(from, to) {
    log.debug(`voice connection ${from} -> ${to}`);
    if (!this.ready || this.ended) return;
    if (to === VoiceConnectionStatus.Ready) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
      return;
    }
    if (from !== VoiceConnectionStatus.Ready || this.watchdog || to === VoiceConnectionStatus.Destroyed) return;
    this.watchdog = setTimeout(() => {
      if (this.ended || this.connection.state.status === VoiceConnectionStatus.Ready) return;
      if (this.recovering) {
        this.watchdog = null; // the reconnect loop is already on it
        return;
      }
      log.warn('voice connection stuck; rejoining');
      try {
        this.connection.rejoin({ channelId: this.channelId, selfDeaf: false, selfMute: false });
      } catch {
        // fall through to the final check
      }
      this.watchdog = setTimeout(() => {
        this.watchdog = null;
        if (this.ended || this.recovering || this.connection.state.status === VoiceConnectionStatus.Ready) return;
        this.post("-# (I lost the voice connection and couldn't get back in. Use /join to bring me back.)");
        this.end('voice connection lost');
      }, RECOVER_TIMEOUT_MS);
    }, RECOVER_TIMEOUT_MS);
  }

  /**
   * The voice connection dropped. A channel move or short blip usually comes
   * back by itself within a few seconds; if not, rejoin a few times before
   * giving up. (Being kicked ends the call in onVoiceStateUpdate, so this never
   * fights a kick.)
   */
  async recover() {
    if (this.recovering || this.ended || !this.ready) return;
    this.recovering = true;
    const conn = this.connection;
    try {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, this.timing.settleMs),
          entersState(conn, VoiceConnectionStatus.Connecting, this.timing.settleMs),
        ]);
        return; // it's reconnecting on its own
      } catch {
        // still down
      }
      for (let attempt = 1; attempt <= REJOIN_ATTEMPTS; attempt++) {
        if (this.ended || conn.state.status === VoiceConnectionStatus.Destroyed) return;
        if (conn.state.status === VoiceConnectionStatus.Ready) return;
        log.warn(`voice connection dropped; reconnecting (try ${attempt} of ${REJOIN_ATTEMPTS})`);
        try {
          conn.rejoin({ channelId: this.channelId, selfDeaf: false, selfMute: false });
        } catch {
          // checked below
        }
        try {
          await entersState(conn, VoiceConnectionStatus.Ready, this.timing.readyMs);
          log.info('voice connection is back');
          return;
        } catch {
          // not yet
        }
        await new Promise((r) => setTimeout(r, attempt * this.timing.backoffMs));
      }
      if (!this.ended && conn.state.status !== VoiceConnectionStatus.Ready) {
        this.post("-# (I lost the voice connection and couldn't get back in. Use /join to bring me back.)");
        this.end('voice connection lost');
      }
    } finally {
      this.recovering = false;
    }
  }

  /** Posts a short note in the text channel it was invited from. */
  post(content) {
    this.textChannel?.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
  }

  /** Where a looked-up spoken answer came from, as a small line in the text channel. */
  postSources(citations) {
    const links = sourceLinks(citations);
    if (links.length) this.post(`-# Looked that up: ${links.join(' ')}`);
  }

  /** Where Discord says the bot is right now. */
  botChannelId() {
    return this.guild.voiceStates.cache.get(this.client.user.id)?.channelId ?? null;
  }

  /** Moves the existing connection to another voice channel (used by /join). */
  async moveTo(channel, textChannel) {
    if (channel.id === this.channelId) return true;
    // One move at a time: a second one while this is waiting would fight it.
    if (this.moveInProgress) return false;
    this.moveInProgress = true;
    try {
      return await this.doMove(channel, textChannel);
    } finally {
      this.moveInProgress = false;
    }
  }

  async doMove(channel, textChannel) {
    const from = this.channelId;
    this.moving = true;
    this.listener?.dropAll();
    // A song being made for the people in the last channel is called off.
    this.cancelSong('move');
    this.brain?.shush({ fromThem: false });
    this.connection.rejoin({ channelId: channel.id, selfDeaf: false, selfMute: false });
    // rejoin() only sends the request; confirm Discord actually moved us.
    const deadline = Date.now() + 10000;
    while (this.botChannelId() !== channel.id && Date.now() < deadline && !this.ended) {
      await new Promise((r) => setTimeout(r, 200));
    }
    this.moving = false;
    if (this.ended) return false;
    if (this.botChannelId() !== channel.id) {
      // Discord ignored the move (full channel, missing permission): stay put.
      this.connection.rejoin({ channelId: from, selfDeaf: false, selfMute: false });
      return false;
    }
    this.channelId = channel.id;
    this.joinedHere();
    if (textChannel) this.textChannel = textChannel;
    if (!(await this.waitForReady(CONNECT_TIMEOUT_MS))) {
      this.end('could not move');
      return false;
    }
    this.checkAlone();
    log.info(`moved to #${channel.name}`);
    return true;
  }

  isHuman(userId) {
    if (userId === this.client.user.id) return false;
    const m = this.guild.members.cache.get(userId);
    return !m?.user?.bot;
  }

  shouldListen(userId) {
    if (!this.isHuman(userId)) return false;
    if (this.memory.isOptedOut(this.guild.id, userId)) return false;
    // Only people actually in our channel.
    const vs = this.guild.voiceStates.cache.get(userId);
    return !vs || vs.channelId === this.channelId;
  }

  async displayName(userId) {
    const cached = this.guild.members.cache.get(userId);
    if (cached) return cached.displayName;
    if (this.names.has(userId)) return this.names.get(userId);
    try {
      const m = await this.guild.members.fetch(userId);
      this.names.set(userId, m.displayName);
      return m.displayName;
    } catch {
      return 'Someone';
    }
  }

  humans() {
    const ch = this.voiceChannel;
    if (!ch) return [];
    return [...ch.members.values()].filter((m) => !m.user.bot);
  }

  /** True if this user is in the voice channel with the bot right now. */
  hasMember(userId) {
    return this.guild.voiceStates.cache.get(userId)?.channelId === this.channelId;
  }

  callInfo() {
    const people = this.humans();
    const activities = [];
    if (this.config.enablePresence) {
      for (const m of people) {
        const games = (m.presence?.activities || []).filter((a) => a.type === ActivityType.Playing);
        for (const g of games) {
          const since = g.timestamps?.start ? `, ${formatDuration(Date.now() - g.timestamps.start.getTime())}` : '';
          activities.push(`${m.displayName}: ${g.name}${since}`);
        }
      }
    }
    return {
      channelName: this.voiceChannel?.name,
      people: people.map((m) => m.displayName),
      activities,
    };
  }

  /** Someone just finished (or paused) a sentence that hasn't reached the brain yet. */
  isHearingSomething() {
    return this.transcribing > 0 || Boolean(this.listener?.hasOpenSentence());
  }

  keyterms() {
    const cfg = this.config;
    return [cfg.botName, ...cfg.botAliases, ...this.humans().map((m) => m.displayName), ...cfg.stt.extraTerms];
  }

  /**
   * An answer that agreed to set (or cancel) reminders was heard: do it. A reminder is for
   * whoever asked, unless it names someone else in the call (or everyone).
   */
  applyReminders({ set = [], cancel = [], cutOff = false } = {}, info = {}) {
    const r = this.reminders;
    if (!r) return;
    const guildId = this.guild.id;
    if (cutOff) {
      // It agreed to one but ran out of room writing it down.
      log.warn("couldn't set a reminder: the answer ran out of room in the middle of it");
      this.post("-# (I ran out of room writing that reminder down, so it isn't set. Ask me again.)");
    }
    for (const c of cancel) {
      const gone = r.cancel(guildId, c);
      log.info(gone.length ? `cancelled ${gone.length === 1 ? `reminder #${gone[0].id}` : `${gone.length} reminders`}` : 'there was no such reminder to cancel');
    }
    for (const s of set) {
      const { forName, userId } = this.reminderFor(s.for, info);
      // (A song or a picture can't be put in a reminder: any such tag in its words is left out.)
      const say = cleanSpoken(withoutHiddenTags(s.say), { botName: this.config.botName, audioTags: this.config.tts.audioTags, maxChars: 300 });
      const line = say.pass || !say.text ? `${forName ? `${forName}, ` : ''}here's the reminder you asked for.` : say.text;
      const res = r.add(guildId, { in: s.in, at: s.at, forName, userId, channelId: this.textChannel?.id ?? null, say: line });
      if (res.error) {
        log.warn(`couldn't set a reminder: ${res.error}`);
        this.post(`-# (I couldn't set that reminder: ${res.error}.)`);
        continue;
      }
      const at = Date.parse(res.reminder.at);
      log.info(`set reminder #${res.reminder.id}${forName ? ` for ${forName}` : ' for everyone'} at ${formatTime(at, this.config.timezone)} (${formatIn(at - Date.now())})`);
    }
  }

  /**
   * An answer that changes the shared lists (or wants one posted) was heard: do it, in the
   * order it was written, and post what was asked for in the call's text chat.
   */
  applyLists({ ops = [], cutOff = false, shown = null } = {}, info = {}) {
    if (!this.lists) return;
    const guildId = this.guild.id;
    if (cutOff) {
      // It ran out of room in the middle of writing a change down: none of them are made
      // (some may be missing), so asking again doesn't do any of them twice.
      log.warn("a list change didn't fit in the answer, so none of its changes were made");
      if (this.textChannel) this.post("-# (I ran out of room writing that down, so the lists didn't change. Ask me again.)");
      return;
    }
    // (Its item numbers mean the items as they were when the answer was written.)
    const { results, posts } = this.lists.apply(guildId, ops, { by: info.name || null, shown });
    // (The words of the lists only reach the log when transcripts are on.)
    for (const r of results) log.info(`list: ${describeResult(r, { words: this.config.logTranscripts })}`);
    const messages = formatListPosts(posts);
    const note = problemNote(results);
    if (note) messages.push(note);
    if (!messages.length) return;
    if (!this.textChannel) {
      log.warn("couldn't post a list: there's no text chat for this call");
      return;
    }
    this.postInOrder(messages);
  }

  /**
   * The shared lists for its prompt, and the copy its item numbers will refer to. When it
   * can't post in the call's text chat, it's told so (instead of saying a list is up).
   */
  listsForPrompt() {
    if (!this.lists) return '';
    const shown = this.lists.all(this.guild.id);
    let text = formatListsForPrompt(shown, { trash: this.lists.trash(this.guild.id) });
    if (!canPostText(this.textChannel, this.guild.members?.me)) {
      text += "\n(You can't post in the text chat right now: no text chat for this call, or no permission to send messages there. If someone wants to see a list, tell them that instead of saying it's in the chat.)";
    }
    return { text, shown };
  }

  /** Several messages in the text chat, one after the other (a long list can take a few). */
  async postInOrder(messages) {
    for (const content of messages) {
      if (!this.textChannel) return;
      await this.textChannel.send({ content, allowedMentions: { parse: [] } }).catch((err) => log.warn(`couldn't post in the text chat: ${err.message}`));
    }
  }

  /**
   * Who a reminder is for: someone by name (in the call, or anywhere in the server), the
   * person who asked (when it names no one), or everyone (no one in particular).
   */
  reminderFor(name, info = {}) {
    const n = String(name ?? '').trim();
    if (/^(?:everyone|everybody|all|us|the group|the squad|y'?all)$/i.test(n)) return { forName: null, userId: null };
    // (An answer to several people names the latest asker: it's for them unless it says otherwise.)
    const who = n && !/^(?:me|myself)$/i.test(n) ? n : info.name || '';
    if (!who) return { forName: null, userId: info.userIds?.length === 1 ? info.userIds[0] : null };
    const key = who.toLowerCase();
    const named = (m) => [m?.displayName, m?.user?.username, m?.user?.globalName].some((x) => x && x.toLowerCase() === key);
    const here = this.humans().find(named);
    if (here) return { forName: here.displayName, userId: here.id };
    const member = [...(this.guild.members?.cache?.values?.() ?? [])].find((m) => !m.user?.bot && named(m));
    if (member) return { forName: member.displayName, userId: member.id };
    // The one person who asked, by the name the transcript has for them.
    if (info.name && info.name.toLowerCase() === key && info.userIds?.length === 1) return { forName: info.name, userId: info.userIds[0] };
    return { forName: who.slice(0, 64), userId: null };
  }

  /**
   * A reminder went off while it's in this call: said out loud. One for someone who isn't
   * in the call is posted in text instead (with a mention, so they see it).
   */
  sayReminder(r, { late = false } = {}) {
    const text = late ? `${r.say} (That one was due at ${formatTime(Date.parse(r.at), this.config.timezone)}; I was offline.)` : r.say;
    return this.brain ? this.brain.sayReminder(text) : Promise.resolve({ outcome: 'dropped', heard: false });
  }

  /** The names (display, user and global) of everyone in this server who opted out. */
  optedOutNames() {
    const members = this.guild.members?.cache;
    const known = (this.memory.guild?.(this.guild.id)?.optouts ?? []).flatMap((id) => {
      const m = members?.get?.(id);
      return [m?.displayName, m?.user?.username, m?.user?.globalName, this.names.get(id)];
    });
    // (Kept with the opt-out too: Discord may not say who they are when they aren't around.)
    return [...known, ...(this.memory.optOutNames?.(this.guild.id) ?? [])].filter(Boolean);
  }

  /** One of its jokes got a laugh: kept to call back to in a later call (not one naming someone who opted out). */
  keepJoke(text) {
    if (mentionsAny(text, this.optedOutNames())) return;
    if (!this.memory.addLandedJoke(this.guild.id, text)) return;
    log.info(this.config.logTranscripts ? `kept a joke that got a laugh: "${text}"` : 'kept a joke that got a laugh, to call back to later');
  }

  /**
   * Words it answered with that the speech-to-text had heard differently (see vocab.js).
   * ownWords: names of things it had brought up itself just before (not learned from this).
   */
  learnWords(said, heard, { ownWords = [] } = {}) {
    const cfg = this.config;
    // Names of people (in the call or anywhere in the server) are never learned as words.
    const members = [...(this.guild.members?.cache?.values?.() ?? [])].flatMap((m) => [m.displayName, m.user?.username, m.user?.globalName]);
    const skip = [cfg.botName, ...(cfg.botAliases || []), ...this.humans().map((m) => m.displayName), ...this.peopleHeard, ...members].filter(Boolean);
    for (const w of this.vocab.learn(said, heard, { skip, own: ownWords })) {
      // (The words only reach the log when transcripts are on.)
      log.info(cfg.logTranscripts ? `learned a word: "${w.term}" (heard as "${w.heard}")` : 'learned a word for the speech-to-text');
    }
  }

  async onUtterance(u) {
    if (this.ended) return;
    if (!this.shouldListen(u.userId)) {
      this.brain?.dropCutIn(u.userId, u.id);
      return;
    }
    this.transcribing++;
    this.transcribingFrom.set(u.userId, (this.transcribingFrom.get(u.userId) ?? 0) + 1);
    let text = '';
    let wake = null;
    let unsureName = false;
    let name = 'Someone';
    try {
      name = await this.displayName(u.userId);
      ({ text, wake, unsureName = false } = await this.stt.transcribeDetailed(u.wav, { durationMs: u.durationMs, keyterms: this.keyterms(), hints: this.vocab?.hints() ?? [] }));
    } catch (err) {
      log.warn(`speech-to-text failed: ${err.message}`);
    } finally {
      this.transcribing--;
      const left = (this.transcribingFrom.get(u.userId) ?? 1) - 1;
      if (left > 0) this.transcribingFrom.set(u.userId, left);
      else this.transcribingFrom.delete(u.userId);
      // The whole sentence is in now, so a slower early check on it is out of date.
      const prev = this.transcribedUpTo.get(u.userId) ?? 0;
      this.transcribedUpTo.set(u.userId, Math.max(prev, u.id ?? 0));
    }
    if (this.ended) return;
    const heard = `heard ${name} (${(u.durationMs / 1000).toFixed(1)} s)`;
    // Nothing usable, or they opted out (or left) while this was being transcribed.
    if (!text || !this.shouldListen(u.userId)) {
      log.debug(`${heard}: ${text ? 'stopped listening to them' : 'no words recognized'}`);
      this.brain.dropCutIn(u.userId, u.id);
      return;
    }
    if (this.config.logTranscripts) log.info(`${name}: ${text}`);
    this.peopleHeard.add(name);
    const outcome = this.brain.hear({
      userId: u.userId,
      id: u.id,
      name,
      text,
      at: u.endedAt,
      startedAt: u.startedAt,
      spokeUntil: u.spokeUntil,
      wake,
      unsureName,
    });
    log.debug(`${heard}: ${HEARD_OUTCOMES[outcome] || outcome}`);
  }

  /** The end-of-turn model is there to ask (local Whisper, with SMART_TURN on). */
  turnChecksOn() {
    return this.config.listen.smartTurn !== false && Boolean(this.stt.extras?.turn);
  }

  /** The name detector is there to ask (local Whisper, with a model for its name). */
  nameChecksOn() {
    return Boolean(this.stt.extras?.wake);
  }

  nameThreshold() {
    return this.config.listen.nameThreshold ?? NAME_THRESHOLD;
  }

  /**
   * Someone paused for a moment mid-sentence: ask the end-of-turn model whether they
   * sound done. If so, their sentence ends now instead of after the full SILENCE_MS.
   */
  async onPause({ userId, id, pauseSeq, wav, voicedMs, again = false }) {
    if (this.ended || !this.turnChecksOn() || voicedMs < this.config.listen.minSpeechMs) return;
    if (!this.shouldListen(userId)) return;
    const running = this.turnChecking.get(userId);
    if (running) {
      // The second listen (with more quiet after the last word) waits for the first to finish.
      if (!again) return;
      await running.catch(() => {});
      if (this.ended || this.turnChecking.has(userId)) return;
    }
    const check = this.stt.checkPause(wav, { turn: true });
    this.turnChecking.set(userId, check);
    try {
      const r = await check;
      if (this.ended || typeof r?.complete !== 'number') return;
      if (r.complete >= TURN_DONE && this.listener.endSentence(userId, id, pauseSeq)) {
        log.debug(`sounded done after a short pause (${r.complete.toFixed(2)}${again ? ', on a second listen' : ''}), so I didn't wait for more`);
      } else if (again) {
        log.debug(`still not sure they were done (${r.complete.toFixed(2)}), waiting for the full pause`);
      }
    } finally {
      if (this.turnChecking.get(userId) === check) this.turnChecking.delete(userId);
    }
  }

  /**
   * While it's talking: the name detector listens to the last few seconds of someone
   * talking over it. If it hears its name, it stops and listens, like the early check
   * (onPeek) but sooner and without needing the words to come out right.
   */
  async onNameCheck({ userId, id, wav }) {
    if (this.ended || !this.nameChecksOn() || !this.speaker?.audible || !this.shouldListen(userId)) return;
    // During a song only a whole "Babel, stop" (once it's heard) stops it.
    if (this.brain?.singing?.()) return;
    if (this.nameChecking.has(userId)) return;
    // Their mic has played its voice back before: what it hears there may be itself.
    if (this.brain.echoesFrom?.(userId) > 0) return;
    // If it said its own name in the last few seconds, a mic picking that up could fool this check.
    if (this.brain.recentLines().some((line) => isAddressed(line, this.config.botAliases))) return;
    this.nameChecking.add(userId);
    try {
      const r = await this.stt.checkPause(wav, { turn: false, wake: true, seconds: 2.5 });
      if (this.ended || typeof r?.wake !== 'number' || r.wake < this.nameThreshold()) return;
      if (!this.speaker.audible || !this.shouldListen(userId)) return;
      // Their whole sentence already got handled: don't cut off the answer to it.
      if (id && (this.transcribedUpTo.get(userId) ?? 0) >= id) return;
      this.brain.cutIn(userId, id, { unsure: true });
      log.info(`${await this.displayName(userId)} said my name (name detector ${r.wake.toFixed(2)}), so I'm stopping to listen`);
    } finally {
      this.nameChecking.delete(userId);
    }
  }

  /**
   * Someone is talking over the bot: check the start of what they're saying.
   * If it has the bot's name, stop talking right away and listen.
   */
  async onPeek({ userId, id, wav, durationMs }) {
    if (this.ended || !this.speaker?.audible || !this.shouldListen(userId)) return;
    // During a song only a whole "Babel, stop" (once it's heard) stops it.
    if (this.brain?.singing?.()) return;
    if (this.peeking.has(userId)) return;
    const aliases = this.config.botAliases;
    // If it said its own name in the last few seconds, a mic picking that up could fool this check.
    if (this.brain.recentLines().some((line) => isAddressed(line, aliases))) return;
    this.peeking.add(userId);
    try {
      const { text, unsureName } = await this.stt.transcribeDetailed(wav, {
        durationMs,
        keyterms: this.keyterms(),
        signal: AbortSignal.timeout(PEEK_TIMEOUT_MS),
      });
      if (!text || this.ended || !this.speaker.speaking || !this.shouldListen(userId)) return;
      // Just its name, and Whisper far from sure of it (often noise): it keeps talking.
      // Their whole sentence still gets heard once they finish.
      if (unsureName) return;
      // Their full sentence already got handled (this check was slow): don't cut off the answer to it.
      if (id && (this.transcribedUpTo.get(userId) ?? 0) >= id) return;
      if (!isAddressed(text, aliases) || this.brain.isOwnEcho(text)) return;
      this.brain.cutIn(userId, id);
      log.info(`${await this.displayName(userId)} said my name, so I'm stopping to listen`);
    } finally {
      this.peeking.delete(userId);
    }
  }

  voiceFailed(text, err, kind) {
    // Don't lose the joke: post it in text. Explain the failure at most every 10 minutes.
    const now = Date.now();
    const explain = now - this.voiceFailureNoticeAt > 600000;
    if (explain) this.voiceFailureNoticeAt = now;
    const note = explain ? `-# (my voice isn't working: ${err.message})` : '';
    // A "Hmm." or a laugh isn't worth posting, and a song can't be posted as text.
    if (kind === 'song') {
      this.post(`-# (the song couldn't play: ${err.message})`);
      return;
    }
    const content = SOUND_KINDS.has(kind) ? note : `${text}${note ? `\n${note}` : ''}`;
    if (content) this.textChannel?.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
  }

  /** For its prompt: whether it can draw a picture right now (and if not, why), and its last one. */
  imagesNow() {
    return imagesNowFor({ images: this.images, lastKey: lastKey(this.guild.id), canPost: canPostPictures(this.textChannel, this.guild.members?.me) });
  }

  /**
   * An answer agreeing to draw a picture was heard: draw it and post it in the call's text
   * chat (a few seconds), then say it's there. Problems are posted there too. A picture
   * still being drawn when the call ends is posted anyway.
   */
  drawImage(tag, info = {}) {
    if (this.ended || !this.images) return Promise.resolve('skipped');
    return drawAndPost({
      images: this.images,
      tag,
      channel: this.textChannel,
      lastKey: lastKey(this.guild.id),
      forName: info.name || '',
      me: this.guild.members?.me,
      onPosted: () => this.brain?.picturePosted?.(),
    }).catch((err) => {
      log.warn(`picture failed: ${err.message}`);
      return 'failed';
    });
  }

  /** For its prompt: whether it can make a song right now, and if not, why. */
  songsNow() {
    const songs = this.songs;
    if (!songs?.enabled) return '';
    if (this.songJob) return "A song you agreed to make is still being made; it plays in a moment. Don't start another one yet.";
    const calledOff = Date.now() - this.songCalledOffAt < 60000 ? 'The song you were making was just called off, as they asked. ' : '';
    const st = songs.status();
    if (!st.ok) return `${calledOff}You can't make a song right now: ${st.reason}. If someone asks for one, tell them in a few words.`;
    const mins = Math.floor(st.minutesLeft);
    const left = mins >= 1 ? `about ${mins} minute${mins === 1 ? '' : 's'}` : 'under a minute';
    return `${calledOff}You can make a song if someone asks for one (${left} of songs left this month).`;
  }

  /**
   * Calls off the song being made: someone said stop ('stop'), asked it to cancel the
   * song ('asked': its answer says okay), or it moved channels ('move').
   */
  cancelSong(why) {
    const job = this.songJob;
    if (!job || job.ac.signal.aborted) return false;
    job.ac.abort();
    this.songJob = null;
    log.info(`called off the song I was making (${why === 'asked' ? 'they asked me to' : why === 'move' ? 'I moved channels' : 'I was told to stop'})`);
    if (why === 'asked') this.songCalledOffAt = Date.now();
    else this.post(`-# (I called off the song I was making, since ${why === 'move' ? 'I moved channels' : 'I was told to stop'}.)`);
    return true;
  }

  /**
   * An answer agreeing to make a song was heard: make it (it takes a while), then play
   * it in the call. Problems are posted in the text channel.
   */
  async makeSong({ song = null, cutOff = false } = {}, info = {}) {
    if (this.ended) return;
    if (!song) {
      if (cutOff) {
        log.warn("couldn't make a song: the answer ran out of room in the middle of writing it");
        this.post("-# (I ran out of room writing that song. Ask me again.)");
      }
      return;
    }
    if (!this.songs) return;
    if (this.songJob) {
      this.post('-# (One song at a time: the last one is still being made.)');
      return;
    }
    const st = this.songs.status();
    if (!st.ok) {
      this.post(`-# (I couldn't make that song: ${st.reason}.)`);
      return;
    }
    const ac = new AbortController();
    const job = { ac, by: info.name || '', startedAt: Date.now() };
    this.songJob = job;
    log.info(`making a song${info.name ? ` for ${info.name}` : ''} (${Math.round(song.seconds ?? 30)} s asked)`);
    try {
      const made = await this.songs.make(song, { signal: ac.signal });
      if (this.ended || ac.signal.aborted) return;
      this.songJob = null; // made: another can be asked for while this one plays
      const { outcome, started } = await this.brain.playSong(made, { userIds: info.userIds || [] });
      log.info(`song ${outcome === 'played' ? 'played to the end' : started ? `${outcome} partway through` : `${outcome} before it started`}`);
      // Made (and paid for) but told to stop before it played.
      if (!started && outcome === 'stopped' && !this.ended) this.post('-# (That song was ready, but I was told to stop, so it didn\'t play. Ask again if you still want it.)');
    } catch (err) {
      if (this.ended || ac.signal.aborted) return;
      log.warn(`couldn't make a song: ${err.message}`);
      this.post(`-# (I couldn't make that song: ${err.userText || err.message}.)`);
    } finally {
      if (this.songJob === job) this.songJob = null;
    }
  }

  /** It was asked something but couldn't write a reply: explain in text, at most every 10 minutes. */
  replyFailed(err) {
    const now = Date.now();
    if (now - this.replyFailureNoticeAt < 600000) return;
    this.replyFailureNoticeAt = now;
    const reason = String(err?.message || err).slice(0, 220);
    this.textChannel?.send({ content: `-# (I couldn't come up with a reply: ${reason})`, allowedMentions: { parse: [] } }).catch(() => {});
  }

  /** Called for every voice state change in this server. */
  onVoiceStateUpdate(oldState, newState) {
    if (this.ended) return;
    const botId = this.client.user.id;
    if (newState.id === botId) {
      if (!newState.channelId) {
        // Only a disconnect from OUR channel ends the call (a stale event from
        // a channel we just moved away from must not).
        if (oldState.channelId === this.channelId) this.end('removed from voice');
        return;
      }
      if (newState.channelId !== this.channelId && oldState.channelId === this.channelId) {
        if (!this.moving) {
          log.info(`dragged to #${newState.channel?.name}`);
          // Someone put it here: auto-join leaves it where it is for the rest of this call.
          this.placed = true;
        }
        this.listener?.dropAll();
        this.channelId = newState.channelId;
        this.joinedHere();
      }
    } else if (oldState.channelId === this.channelId && newState.channelId !== this.channelId) {
      this.listener?.drop(newState.id); // they left our channel
      this.leftAt.set(newState.id, { at: Date.now(), joinedAt: this.joinTimes.get(newState.id) ?? null });
      this.joinTimes.delete(newState.id);
    } else if (newState.channelId === this.channelId && oldState.channelId !== this.channelId && this.isHuman(newState.id)) {
      // Someone joined the call: a quick hi (not for someone who just stepped out and back,
      // who keeps the time they first joined).
      const now = Date.now();
      const left = this.leftAt.get(newState.id);
      const quickRejoin = Boolean(left) && now - left.at <= REJOIN_QUIET_MS;
      this.joinTimes.set(newState.id, quickRejoin && left.joinedAt ? left.joinedAt : now);
      if (this.ready && !quickRejoin && this.shouldListen(newState.id)) {
        this.displayName(newState.id)
          .then((name) => this.brain?.someoneJoined({ userId: newState.id, name }))
          .catch(() => {});
      }
    }
    this.checkAlone();
  }

  /** It's in a new channel: whoever's already here counts as joined now (or when they joined, if they came along). */
  joinedHere() {
    const now = Date.now();
    const times = new Map();
    for (const m of this.humans()) times.set(m.id, this.joinTimes.get(m.id) ?? now);
    this.joinTimes = times;
  }

  checkAlone() {
    if (!this.ready) return;
    if (this.humans().length > 0) {
      clearTimeout(this.aloneTimer);
      this.aloneTimer = null;
      return;
    }
    if (this.aloneTimer) return;
    this.aloneTimer = setTimeout(() => {
      this.aloneTimer = null;
      if (this.humans().length === 0) this.end('everyone left');
    }, this.config.autoLeaveSeconds * 1000);
  }

  /** How long it has been in this call, in words. */
  callLength() {
    const ms = this.joinedAt ? Date.now() - this.joinedAt : 0;
    return ms < 60000 ? 'under a minute' : formatDuration(ms);
  }

  /** What this call has used so far (null before it fully joined). */
  callUsage() {
    if (!this.usage || !this.usageAtStart) return null;
    return this.usage.since(this.usageAtStart);
  }

  setOptOut(userId, out, { names = [] } = {}) {
    this.memory.setOptOut(this.guild.id, userId, out, { names });
    if (!out) return;
    this.listener?.drop(userId);
    // What they said before opting out goes too: out of the transcript, and out of the call's notes.
    this.brain?.forgetSpeaker(userId);
    const name = this.guild.members.cache.get(userId)?.displayName ?? this.names.get(userId);
    if (name) this.peopleHeard.delete(name);
  }

  /**
   * CALL_MEMORY: keeps notes on this call for next time. The notes so far are saved
   * right away, then replaced by a short summary of the whole call once it's written
   * (a few seconds; shutting down waits for it: see notesSaving).
   */
  saveCallNotes() {
    const notes = this.callNotes;
    if (!notes) return;
    if (!this.joinedAt || !notes.worthKeeping || Date.now() - this.joinedAt < MIN_CALL_TO_REMEMBER_MS) {
      // (A few minutes, as when it restarts: not worth one of the earlier calls it's shown.)
      if (this.joinedAt && notes.worthKeeping) log.debug('the call was too short to remember');
      notes.close();
      return;
    }
    const guildId = this.guild.id;
    const record = {
      at: new Date(this.joinedAt).toISOString(),
      minutes: (Date.now() - this.joinedAt) / 60000,
      server: this.guild.name ?? '',
      channel: this.voiceChannel?.name ?? '',
      people: [...this.peopleHeard],
    };
    const endedAt = Date.now();
    let id = notes.text ? this.memory.addCall(guildId, { ...record, summary: notes.savable ?? notes.text }) : null;
    this.notesSaving = notes
      .finish()
      .then((summary) => {
        // Cleared (/forgetcalls, or in the app) while the summary was being written: don't bring it back.
        if (!summary || this.memory.callsForgottenSince?.(guildId, endedAt)) return;
        if (id) this.memory.updateCall(guildId, id, summary);
        else id = this.memory.addCall(guildId, { ...record, summary });
        if (id) log.info('saved notes on this call for next time (Personality > Call memory in the app)');
      })
      .catch((err) => log.debug(`couldn't sum up the call: ${err.message}`));
  }

  end(reason = 'left') {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    clearTimeout(this.aloneTimer);
    clearTimeout(this.watchdog);
    clearTimeout(this.prewarmTimer);
    this.songJob?.ac.abort();
    this.brain?.close();
    this.saveCallNotes();
    this.listener?.stop();
    this.speaker?.destroy();
    this.destroyConnection();
    log.info(`left voice in ${this.guild.name} (${reason})`);
    const used = this.callUsage();
    if (used) log.info(`while it was in the call (${this.callLength()}): ${oneLine(used)}`);
    const waits = replyTimeSummary(this.brain?.replyTimes);
    if (waits) log.info(waits);
    this.usage?.flush();
    this.onEnd?.(this.guild.id, reason);
  }
}
