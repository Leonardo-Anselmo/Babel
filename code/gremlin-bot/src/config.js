// Loads settings from the .env file next to package.json, applies defaults,
// and reports anything missing in plain language.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CHATTINESS_LEVELS = ['off', 'low', 'medium', 'high'];
const EFFORTS = ['low', 'medium', 'high'];
export const STT_PROVIDERS = ['whisper', 'deepgram', 'elevenlabs'];
// Which kinds of line Venice writes for each VENICE_FOR setting.
// (Follow-ups stay with Claude unless it's all: Venice replied to nearly every line after
// its own in testing, even ones Claude rightly let pass.)
export const VENICE_KINDS = {
  off: [],
  jokes: ['quip', 'roast'],
  answers: ['quip', 'roast', 'direct', 'greet', 'welcome', 'farewell'],
  all: ['quip', 'roast', 'direct', 'greet', 'welcome', 'farewell', 'followup'],
};

/** Where setup-whisper.bat puts Python and the model: outside the (OneDrive) bot folder. */
function defaultWhisperHome() {
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'WinslowWhisper');
  return path.join(os.homedir(), '.local', 'share', 'winslow-whisper');
}
const THINKING_MODES = ['auto', 'disabled', 'between_tools', 'adaptive', 'omit'];

/**
 * Reads .env. Filled-in values in .env win over anything already in the
 * computer's environment, so a stray system variable (some tools set
 * ANTHROPIC_* or CLAUDE_* globally) can't silently replace your settings.
 */
function loadEnvFile() {
  const file = path.join(ROOT_DIR, '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Could not read ${file}: ${err.message}`);
  }
  const parsed = parseEnv(text.replace(/^﻿/, ''));
  for (const [key, value] of Object.entries(parsed)) {
    if (String(value).trim() !== '') process.env[key] = value;
  }
  return file;
}

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

const str = (name, fallback = '') => {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
};

const num = (name, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const raw = str(name);
  if (raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
};

const bool = (name, fallback) => {
  const raw = str(name).toLowerCase();
  if (raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
};

const list = (name, fallback = []) => {
  const raw = str(name);
  if (raw === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

function readTextFile(fileName, fallback = '') {
  const file = path.join(ROOT_DIR, fileName);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/** Strips the "how to edit this file" comment blocks (<!-- ... -->) from persona/lore files. */
export function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*[-*][ \t]*$/gm, '') // empty list items left in a template
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function loadConfig() {
  const envFile = loadEnvFile();

  const botName = str('BOT_NAME', 'Gremlin');
  const aliases = list('BOT_ALIASES', []);

  const config = {
    envFile,
    rootDir: ROOT_DIR,
    dataDir: path.resolve(ROOT_DIR, str('DATA_DIR', 'data')),

    discordToken: str('DISCORD_TOKEN'),

    botName,
    botAliases: [...new Set([botName, ...aliases].map((s) => s.toLowerCase()))],
    timezone: str('BOT_TIMEZONE', 'America/Los_Angeles'),
    defaultChattiness: CHATTINESS_LEVELS.includes(str('CHATTINESS').toLowerCase())
      ? str('CHATTINESS').toLowerCase()
      : 'low',
    enablePresence: bool('ENABLE_PRESENCE', false),
    autoLeaveSeconds: num('AUTO_LEAVE_SECONDS', 60, { min: 10 }),
    // Join a voice channel by itself when two or more people are in it (each server can
    // switch it with /autojoin; this is the default for the ones that haven't).
    autoJoin: bool('AUTO_JOIN', false),
    // Reminders and timers people ask for in voice ("remind me in ten minutes").
    reminders: bool('REMINDERS', true),
    // Shared lists people keep with it between calls ("add Hades 2 to the games list"), posted in text on request.
    lists: bool('LISTS', true),

    // Venice's models write some of its lines instead of Claude (see venice.js):
    // off, jokes (its own jokes and roasts), answers (also its answers, hellos and byes; those
    // can't look things up) or all (also its replies without its name). Needs VENICE_API_KEY;
    // without it, Claude does it all.
    venice: (() => {
      const apiKey = str('VENICE_API_KEY');
      const asked = str('VENICE_FOR').toLowerCase();
      // Provider routing is opt-in; Claude remains the default.
      const mode = oneOf(asked || 'off', Object.keys(VENICE_KINDS), 'off');
      return {
        apiKey,
        for: mode,
        kinds: VENICE_KINDS[mode],
        model: str('VENICE_MODEL', 'qwen-3-8-27b'),
        temperature: num('VENICE_TEMPERATURE', 0.7, { min: 0, max: 2 }),
      };
    })(),

    anthropic: {
      apiKey: str('ANTHROPIC_API_KEY'),
      workspaceId: str('ANTHROPIC_WORKSPACE_ID'),
      model: str('CLAUDE_MODEL', 'claude-sonnet-5-5'),
      // Used for quick back-and-forth (replies without its name) and call notes.
      fastModel: str('CLAUDE_FAST_MODEL', 'claude-haiku-5-5'),
      // Writes its own jokes ("anything funny to add?" in a pause). Sonnet's were much funnier
      // in testing; Haiku almost never jumped in with the same prompt.
      jokeModel: str('CLAUDE_JOKE_MODEL', 'claude-sonnet-5-5'),
      // How hard each model works on a reply: low, medium or high. Higher is more
      // careful and more willing to look things up, but a little slower.
      effort: oneOf(str('CLAUDE_EFFORT', str('GREMLIN_CLAUDE_EFFORT', 'high')).toLowerCase(), EFFORTS, 'high'),
      fastEffort: oneOf(str('CLAUDE_FAST_EFFORT', 'medium').toLowerCase(), EFFORTS, 'medium'),
      thinking: oneOf(str('GREMLIN_CLAUDE_THINKING', 'auto').toLowerCase(), THINKING_MODES, 'auto'),
      maxCallsPerMinute: num('CLAUDE_MAX_CALLS_PER_MINUTE', 20, { min: 1 }),
      // Lets it look things up (patch notes, metas, release dates) when someone asks.
      webSearch: {
        enabled: bool('WEB_SEARCH', true),
        maxUses: num('WEB_SEARCH_MAX_USES', 2, { min: 1, max: 5 }),
        dailyLimit: num('WEB_SEARCH_DAILY_LIMIT', 100, { min: 0 }),
      },
    },

    stt: {
      provider: str('STT_PROVIDER', 'deepgram').toLowerCase(),
      deepgramKey: str('DEEPGRAM_API_KEY'),
      deepgramModel: str('DEEPGRAM_MODEL', 'nova-3'),
      language: str('STT_LANGUAGE', 'en'),
      useKeyterms: bool('STT_KEYTERMS', true),
      extraTerms: list('STT_EXTRA_TERMS', []),
      // Words from their games it learned to spell (it answered with a word the
      // speech-to-text had heard differently) are given to it as hints.
      learnWords: bool('LEARN_WORDS', true),
      elevenModel: str('ELEVENLABS_STT_MODEL', 'scribe_v2'),
      // Whisper on this PC's graphics card (STT_PROVIDER=whisper). Deepgram covers if it isn't running.
      whisper: {
        model: str('WHISPER_MODEL', 'large-v3'),
        port: num('WHISPER_PORT', 8178, { min: 1024, max: 65535 }),
        home: str('WHISPER_HOME', defaultWhisperHome()),
        computeType: str('WHISPER_COMPUTE_TYPE', 'float16'),
        beamSize: num('WHISPER_BEAM_SIZE', 5, { min: 1, max: 10 }),
      },
    },

    tts: {
      elevenKey: str('ELEVENLABS_API_KEY'),
      voiceId: str('ELEVENLABS_VOICE_ID'),
      model: str('ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
      outputFormat: str('ELEVENLABS_OUTPUT_FORMAT', 'pcm_24000'),
      stability: num('ELEVENLABS_STABILITY', 0.4, { min: 0, max: 1 }),
      similarity: num('ELEVENLABS_SIMILARITY', 0.75, { min: 0, max: 1 }),
      style: num('ELEVENLABS_STYLE', 0, { min: 0, max: 1 }),
      speed: num('ELEVENLABS_SPEED', 1.0, { min: 0.7, max: 1.2 }),
      audioTags: bool('ELEVENLABS_AUDIO_TAGS', false),
      volume: num('BOT_VOLUME', 1.0, { min: 0.1, max: 2 }),
    },

    listen: {
      silenceMs: num('SILENCE_MS', 700, { min: 250, max: 3000 }),
      minSpeechMs: num('MIN_SPEECH_MS', 300, { min: 100, max: 3000 }),
      maxUtteranceMs: num('MAX_UTTERANCE_MS', 20000, { min: 3000, max: 60000 }),
      voiceRms: num('VOICE_RMS_THRESHOLD', 200, { min: 1, max: 10000 }),
      noiseMargin: num('NOISE_MARGIN', 2, { min: 0, max: 10 }),
      // With local Whisper: after a short pause, a small model judges from the sound
      // whether they're done talking, so it answers without waiting the full SILENCE_MS.
      smartTurn: bool('SMART_TURN', true),
      // With local Whisper and a name detector for its name: how sure (0-1) the detector
      // must be that its name was said (to stop mid-sentence, or to treat a sentence as for it).
      nameThreshold: num('NAME_DETECTOR_THRESHOLD', 0.7, { min: 0.3, max: 0.99 }),
      // Pause when the person it's answering talks over it (and carry on after a laugh or "yeah").
      talkOverPause: bool('TALK_OVER_PAUSE', true),
    },

    // Short notes on each call, kept for next time (data/memory.json; readable and
    // deletable in the app under Personality > Call memory). /join says when it's on.
    callMemory: bool('CALL_MEMORY', false),
    // The owner can say "<name>, look at this" and it sees a picture of this PC's main
    // screen (only when started from the desktop app). Nobody else can.
    screenLooks: bool('SCREEN_LOOKS', true),
    // How its jokes land in each server (laughs vs "shut up") sets how often it tries one.
    jokeTuning: bool('JOKE_TUNING', true),
    // Its jokes that got a laugh are kept, to call back to in later calls.
    jokeCallbacks: bool('JOKE_CALLBACKS', true),
    // A quick "hmm" or "ooh" when a question's answer takes a moment (now and then, not every time).
    thinkingSounds: bool('THINKING_SOUNDS', true),
    // Laughing along now and then when the group cracks up at something someone else said.
    laughAlong: bool('LAUGH_ALONG', true),
    // A quick hi when someone joins the call, and bye when someone says they're heading out.
    helloGoodbye: bool('HELLO_GOODBYE', true),
    // Songs on request ("make a song about..."), made with ElevenLabs Music. The key needs
    // access to Music; minutes per month is a cap so songs can't run up the bill.
    songs: {
      enabled: bool('SONGS', true),
      minutesPerMonth: num('SONG_MINUTES_PER_MONTH', 10, { min: 0, max: 600 }),
      maxSeconds: num('SONG_MAX_SECONDS', 60, { min: 15, max: 120 }),
      model: str('SONG_MODEL', 'music_v2_5'),
    },
    // Pictures on request ("draw us a goblin playing League"), made with Google's Gemini
    // image model and posted in the text chat. Needs a Gemini API key whose Google project
    // has billing on; pictures per month is a cap so they can't run up the bill.
    images: {
      enabled: bool('IMAGES', true),
      key: str('GEMINI_API_KEY'),
      perMonth: num('IMAGES_PER_MONTH', 100, { min: 0, max: 1000 }),
      model: str('IMAGE_MODEL', 'gemini-nano-banana-2.1'),
    },

    transcript: {
      maxLines: num('TRANSCRIPT_LINES', 40, { min: 5, max: 200 }),
      maxMinutes: num('TRANSCRIPT_MINUTES', 15, { min: 1, max: 240 }),
    },

    logTranscripts: bool('LOG_TRANSCRIPTS', false),
    debugVoice: bool('DEBUG_VOICE', false),

    // "{name}" in these files becomes BOT_NAME, so renaming the bot is one setting.
    persona: stripComments(readTextFile('persona.md')).replaceAll('{name}', botName),
    lore: stripComments(readTextFile('lore.md')).replaceAll('{name}', botName),
  };

  return config;
}

/** Returns a list of human-readable problems. Empty list means good to go. */
export function validateConfig(config) {
  const problems = [];
  if (!config.envFile && !config.discordToken) problems.push('No .env file found. Copy .env.example to .env and fill it in.');
  if (!config.discordToken) problems.push('DISCORD_TOKEN is empty (Discord Developer Portal > your app > Bot > Reset Token).');
  if (!config.anthropic.apiKey) problems.push('ANTHROPIC_API_KEY is empty (console.anthropic.com > API keys).');
  if (!STT_PROVIDERS.includes(config.stt.provider)) {
    problems.push(`STT_PROVIDER must be "whisper", "deepgram" or "elevenlabs" (got "${config.stt.provider}").`);
  }
  if (config.stt.provider === 'deepgram' && !config.stt.deepgramKey) {
    problems.push('DEEPGRAM_API_KEY is empty (console.deepgram.com > API Keys), or set STT_PROVIDER=elevenlabs.');
  }
  if (!config.tts.elevenKey) problems.push('ELEVENLABS_API_KEY is empty (elevenlabs.io > Developers > API Keys).');
  if (!config.tts.voiceId) problems.push('ELEVENLABS_VOICE_ID is empty. In the app: Settings > Voice > Voice ID (ElevenLabs > My Voices > the voice\'s menu > Copy voice ID).');
  if (!/^pcm_\d+$/.test(config.tts.outputFormat)) {
    problems.push(`ELEVENLABS_OUTPUT_FORMAT must be a raw PCM format like pcm_24000 (got "${config.tts.outputFormat}").`);
  }
  if (!config.persona) problems.push('persona.md is missing or empty.');
  return problems;
}
