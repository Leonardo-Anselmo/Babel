// The settings the app shows, with the same defaults and limits as src/config.js.
// Anything else in .env is left alone. Keys (secrets) are never sent to the window:
// it only learns whether each one is set.

export const SECRET_KEYS = ['DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'DEEPGRAM_API_KEY', 'GEMINI_API_KEY'];

const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];
const EFFORTS = ['low', 'medium', 'high'];
// Venice's models that were tested with this bot (see src/venice.js).
const VENICE_MODELS = ['qwen-3-8-27b', 'olafangensan-glm-4.7-flash-heretic'];

export const GROUPS = [
  {
    id: 'keys',
    title: 'Keys',
    blurb: "Passwords to the services the bot uses. Saved keys are never shown, only whether they're set.",
    fields: [
      { key: 'DISCORD_TOKEN', label: 'Discord bot token', type: 'secret', help: 'Discord Developer Portal > your app > Bot > Reset Token' },
      { key: 'ANTHROPIC_API_KEY', label: 'Claude (Anthropic) API key', type: 'secret', help: 'Claude Console > Settings > API keys' },
      { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key', type: 'secret', help: 'elevenlabs.io > Developers > API Keys' },
      { key: 'DEEPGRAM_API_KEY', label: 'Deepgram API key', type: 'secret', help: "Backup hearing for when Whisper isn't running. console.deepgram.com > API Keys" },
      {
        key: 'GEMINI_API_KEY',
        label: 'Google Gemini API key (pictures)',
        type: 'secret',
        help: 'For drawing pictures. aistudio.google.com/apikey > Create API key, then Set up billing for its project (pictures are not on the free tier).',
      },
      {
        key: 'VENICE_API_KEY',
        label: 'Venice API key (optional provider)',
        type: 'secret',
        help: 'Needed when routing selected voice replies through Venice. Generate an inference API key in your Venice account settings. The account needs credit.',
      },
    ],
  },
  {
    id: 'personality',
    title: 'Personality and behavior',
    fields: [
      { key: 'BOT_NAME', label: 'Name', type: 'text', default: 'Gremlin', help: 'What he answers to in voice. Keep it the same as his name in Discord.' },
      { key: 'BOT_ALIASES', label: 'Other spellings of his name', type: 'text', default: '', help: 'Comma separated, in case speech recognition hears his name differently.' },
      {
        key: 'CHATTINESS',
        label: 'Chattiness',
        type: 'select',
        options: ['off', 'low', 'medium', 'high'],
        default: 'low',
        live: true,
        help: 'How often he jumps in without being called by name, and how long he keeps answering without it after he talks. Applies right away to every server, like /chattiness.',
      },
      { key: 'BOT_TIMEZONE', label: 'Time zone', type: 'text', check: 'timezone', default: 'America/Los_Angeles', help: 'For knowing what time it is, like America/Los_Angeles.' },
      { key: 'ENABLE_PRESENCE', label: 'See what everyone is playing', type: 'toggle', default: 'false', help: 'Needs Presence Intent turned on in the Discord Developer Portal (Bot page).' },
      { key: 'AUTO_LEAVE_SECONDS', label: 'Leave an empty call after (seconds)', type: 'number', min: 10, max: 3600, step: 5, default: '60' },
      {
        key: 'AUTO_JOIN',
        label: 'Join calls by himself',
        type: 'toggle',
        default: 'false',
        live: true,
        help: 'He hops into a voice channel once two or more people are in it, and follows if everyone moves. /leave sends him away until everyone has left voice. Applies right away to every server, like /autojoin.',
      },
      {
        key: 'REMINDERS',
        label: 'Reminders and timers',
        type: 'toggle',
        default: 'true',
        help: '"Remind me in ten minutes to queue" or "set a timer for five minutes", up to a day ahead. He says it in the call when it goes off, or posts it in the text chat if he isn\'t in a call with them.',
      },
      {
        key: 'LISTS',
        label: 'Shared lists',
        type: 'toggle',
        default: 'true',
        help: '"Add Hades 2 to the games list", "take Deadlock off", "post the shopping list": lists for the whole server that he keeps between calls, by voice or by @mentioning him. He posts a list in the text chat when asked. Up to 20 lists of 50 items each.',
      },
      {
        key: 'AUTO_UPDATE',
        label: 'Load updates by himself',
        type: 'toggle',
        default: 'true',
        live: true,
        help: 'When his code, a setting or a personality file changes, the app restarts him to load it as soon as nobody is in a call with him.',
      },
      {
        key: 'CALL_MEMORY',
        label: 'Remember calls',
        type: 'toggle',
        default: 'false',
        help: 'Keeps short notes on each call so he can bring things up next time. /join tells everyone. Read or delete them under Personality > Call memory.',
      },
      {
        key: 'SCREEN_LOOKS',
        label: 'Look at your screen when you ask',
        type: 'toggle',
        default: 'true',
        help: 'Only you (the bot owner) can say "look at this". He sees a picture of your main screen, sent to Claude with that answer. Only when started from this app.',
      },
      {
        key: 'JOKE_TUNING',
        label: 'Learn how his jokes land',
        type: 'toggle',
        default: 'true',
        help: 'A laugh after one of his own jokes makes him joke a bit more often; "shut up" or being talked over makes him wait longer and be pickier. Kept per server, and fades over a week or two.',
      },
      {
        key: 'JOKE_CALLBACKS',
        label: 'Call back to jokes that got a laugh',
        type: 'toggle',
        default: 'true',
        help: 'He keeps his last dozen jokes that got a laugh and may call back to one in a later call when something sets it up. Listed under Personality > Call memory; Forget all and /forgetcalls clear them.',
      },
      {
        key: 'THINKING_SOUNDS',
        label: 'A quick "hmm" before slow answers',
        type: 'toggle',
        default: 'true',
        help: 'Now and then, when a question takes him a moment, he says "Hmm." or "Ooh." right away instead of leaving dead air. At most every couple of minutes.',
      },
      {
        key: 'LAUGH_ALONG',
        label: 'Laugh along with the group',
        type: 'toggle',
        default: 'true',
        help: 'Sometimes, when people crack up at something one of them said, he laughs too (never at his own lines, at most every few minutes). Off when chattiness is off.',
      },
      {
        key: 'HELLO_GOODBYE',
        label: 'Say hi and bye',
        type: 'toggle',
        default: 'true',
        help: 'A quick hi when someone joins a call he is in, and bye when someone says they are heading out. Off when chattiness is off.',
      },
      {
        key: 'SONGS',
        label: 'Make songs on request',
        type: 'toggle',
        default: 'true',
        help: 'Ask him for a song ("make a song about...") and he makes a real one with ElevenLabs Music and plays it in the call. Your ElevenLabs key needs access to Music (ElevenLabs > Developers > API Keys). About 15 cents a minute of song.',
      },
      { key: 'SONG_MINUTES_PER_MONTH', label: 'Song minutes per month (cap)', type: 'number', min: 0, max: 600, step: 1, default: '10', help: 'Once used up, he says he is out of songs until next month. Your ElevenLabs plan may allow fewer.' },
      { key: 'SONG_MAX_SECONDS', label: 'Longest song (seconds)', type: 'number', min: 15, max: 120, step: 5, default: '60' },
      {
        key: 'IMAGES',
        label: 'Draw pictures on request',
        type: 'toggle',
        default: 'true',
        help: 'Ask him for a picture ("draw us a goblin playing League") and he posts one in the text chat, drawn by Google Gemini. Needs the Gemini key under Keys, and the Attach Files permission for his Discord role. About 3 cents a picture.',
      },
      { key: 'IMAGES_PER_MONTH', label: 'Pictures per month (cap)', type: 'number', min: 0, max: 1000, step: 10, default: '100', help: 'Once used up, he says he is out of pictures until next month.' },
    ],
  },
  {
    id: 'brain',
    title: 'Brain (Claude)',
    fields: [
      { key: 'CLAUDE_MODEL', label: 'Main model', type: 'select', options: CLAUDE_MODELS, default: 'claude-sonnet-5-5', help: 'Answers people, roasts and text replies.' },
      { key: 'CLAUDE_FAST_MODEL', label: 'Fast model', type: 'select', options: CLAUDE_MODELS, default: 'claude-haiku-5-5', help: 'Quick back-and-forth (replies without his name) and notes on calls.' },
      {
        key: 'CLAUDE_JOKE_MODEL',
        label: 'Joke model',
        type: 'select',
        options: CLAUDE_MODELS,
        default: 'claude-sonnet-5-5',
        help: 'Writes his own jokes when there is a pause. Sonnet\'s are much funnier (about half a cent a try); Haiku is cheaper but almost never jumps in.',
      },
      { key: 'CLAUDE_EFFORT', label: 'Main model effort', type: 'select', options: EFFORTS, default: 'high', help: 'Higher is more careful and more willing to look things up, a little slower.' },
      { key: 'CLAUDE_FAST_EFFORT', label: 'Fast model effort', type: 'select', options: EFFORTS, default: 'medium' },
      { key: 'WEB_SEARCH', label: 'Look things up on the web', type: 'toggle', default: 'true', help: 'For current questions like patch notes and news. About 2 to 5 cents a search.' },
      { key: 'WEB_SEARCH_MAX_USES', label: 'Searches per answer', type: 'number', min: 1, max: 5, step: 1, default: '2' },
      { key: 'WEB_SEARCH_DAILY_LIMIT', label: 'Searches per day (cap)', type: 'number', min: 0, max: 10000, step: 10, default: '100' },
      { key: 'CLAUDE_MAX_CALLS_PER_MINUTE', label: 'Spending cap: checks per minute', type: 'number', min: 1, max: 200, step: 1, default: '20' },
    ],
  },
  {
    id: 'venice',
    title: 'Brain (Venice)',
    fields: [
      {
        key: 'VENICE_FOR',
        label: 'What Venice writes',
        type: 'select',
        options: ['off', 'jokes', 'answers', 'all'],
        default: '',
        help: "Lines Venice's models write instead of Claude. jokes: his own jokes and roasts. answers: also his answers, hellos and byes (answers can't look things up on the web, and choosing this turns web search off for answers). all: also his replies without its name (Claude decides with a quick yes or no whether those get a reply, since Venice replies to almost everything). Left empty, Venice writes no lines of its own. Needs the Venice key and credit on the account.",
      },
      { key: 'VENICE_MODEL', label: 'Venice model', type: 'select', options: VENICE_MODELS, default: 'qwen-3-8-27b', help: 'Select a model available in your Venice account.' },
      { key: 'VENICE_TEMPERATURE', label: 'Venice randomness', type: 'number', min: 0, max: 2, step: 0.1, default: '0.7', help: 'Lower follows the rules more closely; higher is wilder.' },
    ],
  },
  {
    id: 'voice',
    title: 'Voice (ElevenLabs)',
    fields: [
      { key: 'ELEVENLABS_VOICE_ID', label: 'Voice ID', type: 'text', default: '', help: "ElevenLabs > My Voices > the voice's menu > Copy voice ID." },
      {
        key: 'ELEVENLABS_MODEL',
        label: 'Voice model',
        type: 'text',
        suggestions: ['eleven_v4_turbo', 'eleven_flash_v2_5', 'eleven_v4', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'],
        default: 'eleven_flash_v2_5',
        help: 'eleven_v4_turbo is fast, more expressive and costs the same as eleven_flash_v2_5 (falls back to Flash if your account can\'t use it). eleven_v4 is richer but twice the price.',
      },
      { key: 'ELEVENLABS_STABILITY', label: 'Stability', type: 'number', min: 0, max: 1, step: 0.05, default: '0.4', help: 'Lower is more expressive and less predictable.' },
      { key: 'ELEVENLABS_SIMILARITY', label: 'Similarity', type: 'number', min: 0, max: 1, step: 0.05, default: '0.75' },
      { key: 'ELEVENLABS_STYLE', label: 'Style', type: 'number', min: 0, max: 1, step: 0.05, default: '0' },
      { key: 'ELEVENLABS_SPEED', label: 'Speed', type: 'number', min: 0.7, max: 1.2, step: 0.05, default: '1.0' },
      { key: 'BOT_VOLUME', label: 'Volume', type: 'number', min: 0.1, max: 2, step: 0.1, default: '1.0' },
      { key: 'ELEVENLABS_AUDIO_TAGS', label: 'Audio tags like [laughs]', type: 'toggle', default: 'false', help: 'For eleven_v4_turbo and eleven_v4. Other models get the words without the tags.' },
    ],
  },
  {
    id: 'hearing',
    title: 'Hearing',
    fields: [
      {
        key: 'STT_PROVIDER',
        label: 'Speech-to-text',
        type: 'select',
        options: ['whisper', 'deepgram', 'elevenlabs'],
        default: 'deepgram',
        help: 'whisper is free on your graphics card (Deepgram covers when it is not running).',
      },
      {
        key: 'WHISPER_MODEL',
        label: 'Whisper model',
        type: 'select',
        options: ['large-v3-turbo', 'large-v3', 'distil-large-v3.5'],
        default: 'large-v3',
        help: 'large-v3-turbo uses about 2.5 GB of graphics memory, large-v3 about 4.5 GB. A new model needs the Whisper setup run again.',
      },
      { key: 'STT_EXTRA_TERMS', label: 'Words to recognize', type: 'text', default: '', help: 'Game names and nicknames, comma separated (used by Deepgram).' },
      {
        key: 'LEARN_WORDS',
        label: 'Learn words he mishears',
        type: 'toggle',
        default: 'true',
        help: 'When he answers with a game word spelled differently from what he heard (Malenia for "melania") twice, he learns it and listens for it on longer sentences. Turn it off if he starts hearing those words where they weren\'t said.',
      },
      { key: 'SILENCE_MS', label: 'Pause that ends a sentence (ms)', type: 'number', min: 250, max: 3000, step: 50, default: '700', help: 'Raise it if he cuts people off.' },
      { key: 'MIN_SPEECH_MS', label: 'Ignore sounds shorter than (ms)', type: 'number', min: 100, max: 3000, step: 50, default: '300' },
      { key: 'VOICE_RMS_THRESHOLD', label: 'Loudness that counts as speech', type: 'number', min: 1, max: 10000, step: 10, default: '200', help: 'Lower it if quiet friends get ignored.' },
      { key: 'NOISE_MARGIN', label: 'Louder than background noise by', type: 'number', min: 0, max: 10, step: 0.5, default: '2', help: "So an open mic's hiss or keyboard doesn't count as talking. Lower it (0 is off) if a quiet friend in a noisy room gets ignored." },
      {
        key: 'SMART_TURN',
        label: 'Answer as soon as they sound done',
        type: 'toggle',
        default: 'true',
        help: 'With Whisper: a small model on your processor listens for the end of a sentence, so he answers without waiting the full pause. Turn it off if he cuts people off.',
      },
      {
        key: 'TALK_OVER_PAUSE',
        label: 'Pause when the person he answers talks over him',
        type: 'toggle',
        default: 'true',
        help: 'He carries on after a laugh or "yeah", and answers anything else.',
      },
      {
        key: 'NAME_DETECTOR_THRESHOLD',
        label: 'Name detector sureness',
        type: 'number',
        min: 0.3,
        max: 0.99,
        step: 0.05,
        default: '0.7',
        help: 'With Whisper and a name detector (whisper/extras): how sure it must be that his name was said. Raise it if he reacts to words that only sound like his name.',
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    fields: [
      { key: 'LOG_TRANSCRIPTS', label: 'Record what people say in the log', type: 'toggle', default: 'false', help: 'Lets the weekly review of his log see what was said and what he wrote to himself. /join tells everyone when it is on.' },
      { key: 'LOG_LEVEL', label: 'Detail in the live output', type: 'select', options: ['debug', 'info', 'warn', 'error'], default: 'info', help: 'The activity log always keeps the full detail.' },
      { key: 'DEBUG_VOICE', label: 'Voice connection details', type: 'toggle', default: 'false' },
    ],
  },
];

export const FIELDS = new Map(GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f])));

/** True for a time zone name the clock knows, like America/Los_Angeles or UTC. */
export function isTimeZone(name) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** What the window gets: groups with current values, and only set/not set for keys. */
export function settingsView(env) {
  return GROUPS.map((g) => ({
    ...g,
    fields: g.fields.map((f) => {
      const raw = env[f.key];
      const value = raw === undefined || String(raw).trim() === '' ? '' : String(raw).trim();
      if (f.type === 'secret') return { ...f, isSet: value !== '' };
      // Keep a value the app doesn't list (e.g. another Claude model) instead of hiding it.
      const options = f.options && value && !f.options.includes(value) ? [...f.options, value] : f.options;
      return { ...f, options, value };
    }),
  }));
}

/** Checks one change from the window and returns the text to save, or throws a friendly error. */
export function cleanValue(key, value) {
  const f = FIELDS.get(key);
  if (!f) throw new Error(`The app doesn't manage ${key}.`);
  const v = String(value ?? '').trim();
  switch (f.type) {
    case 'secret':
      if (!v) throw new Error(`${f.label}: paste the new key, or leave it as it is.`);
      if (/\s/.test(v)) throw new Error(`${f.label}: a key has no spaces in it. Check what you pasted.`);
      return v;
    case 'toggle':
      if (v !== 'true' && v !== 'false') throw new Error(`${f.label}: on or off only.`);
      return v;
    case 'select':
      if (v === '' || f.options.includes(v)) return v;
      throw new Error(`${f.label}: pick one of ${f.options.join(', ')}.`);
    case 'number': {
      if (v === '') return '';
      const n = Number(v);
      if (!Number.isFinite(n) || n < f.min || n > f.max) throw new Error(`${f.label}: a number from ${f.min} to ${f.max}.`);
      return v;
    }
    default:
      if (/[\r\n]/.test(v)) throw new Error(`${f.label}: one line only.`);
      if (f.check === 'timezone' && v && !isTimeZone(v)) {
        throw new Error(`${f.label}: "${v}" isn't a time zone name. Use one like America/Los_Angeles, America/New_York or Europe/London.`);
      }
      return v;
  }
}
