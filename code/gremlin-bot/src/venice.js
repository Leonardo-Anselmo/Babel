// Venice's models as the brain for some or all of its lines (VENICE_FOR), in
// place of Claude. Venice's API is OpenAI-compatible (https://docs.venice.ai). Its models
// follow the format and tag rules less reliably than Claude (measured on real call moments,
// 2026-10-29), so each request also carries a few worked examples for that kind of line and
// a short format reminder, and what comes back is tidied into the usual format ("[say]",
// "<span id="say">" become <say>). Venice's provider guidance stays enabled. It can't
// search the web.

import { createHash } from 'node:crypto';
import { logger } from './log.js';
import { fetchWithReconnect } from './net.js';
import { LONG, PASS, TASKS, buildUserMessage, formatCallInfo, formatTranscript } from './prompts.js';

const log = logger('venice');

export const VENICE_API = 'https://api.venice.ai/api/v1';

// How long Claude takes over after Venice turns a request down (no credit, a bad key).
const BLOCKED_MS = 30 * 60000;

// What each VENICE_FOR setting hands to Venice, in words (for the log and the start-up check).
export const VENICE_FOR_WORDS = {
  off: 'nothing',
  jokes: 'its own jokes and roasts',
  answers: "its jokes, roasts, answers, hellos and byes (answers can't look things up)",
  all: "everything it says in calls (answers can't look things up)",
};

// Dollars per million tokens: input, output, and input Venice reads from its cache (for the
// models that have a price for that). Venice's model list, October 2026.
export const VENICE_PRICES = {
  'qwen-3-8-27b': [0.45, 3.2],
  'olafangensan-glm-4.7-flash-heretic': [0.07, 0.4, 0.035],
};

// Reasoning models think before they answer unless told not to, far too slow for a voice:
// their thinking is switched off (reasoning_effort "none"; disable_thinking also drops any
// that comes back anyway). Its thinking would arrive apart from the words, and is never read.
export const VENICE_THINKERS = new Set(['olafangensan-glm-4.7-flash-heretic', 'qwen-3-8-27b']);

/** The cost of one request, or null for a model without a known price. */
export function veniceDollars(model, usage) {
  const p = VENICE_PRICES[model];
  if (!p || !usage) return null;
  const input = usage.prompt_tokens || 0;
  const cached = Math.min(input, usage.prompt_tokens_details?.cached_tokens || 0);
  return ((input - cached) * p[0] + cached * (p[2] ?? p[0]) + (usage.completion_tokens || 0) * p[1]) / 1e6;
}

/** A short, stable name for a system prompt, so Venice sends requests with the same one to the same cache. */
function cacheKey(botName, text) {
  return `${String(botName).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

/**
 * A reply tidied into the usual format: "[say]...[/say]", "[says]" and
 * "<span id="say">...</span>" become <say>...</say>, <say id="1"> becomes <say>, a
 * reasoning model's <think>...</think> goes, and so does HTML like <b> inside its line.
 * Only whole tags are changed, so a reply still coming in tidies the same way as it grows.
 */
export function normalizeFormat(text) {
  // A reasoning model's thinking (shut while it's still being written) is never words.
  let t = String(text ?? '').replace(/<\s*think(?:ing)?\s*>[\s\S]*?(?:<\s*\/\s*think(?:ing)?\s*>|$)/gi, '');
  t = t.replace(/\[\s*says?\s*\]/gi, '<say>').replace(/\[\s*\/\s*says?\s*\]/gi, '</say>');
  let spans = false;
  t = t.replace(/<\s*span\b[^>]*\bsay\b[^>]*>/gi, () => {
    spans = true;
    return '<say>';
  });
  if (spans) t = t.replace(/<\s*\/\s*span\s*>/gi, '</say>');
  t = t.replace(/<\s*say\b[^>]+>/gi, (m) => (/^<\s*say\s*>$/i.test(m) ? m : '<say>'));
  // HTML inside its line ("that build is <b>wild</b>") would be read out: whole tags only go.
  return t.replace(/<\s*br\s*\/?\s*>/gi, ' ').replace(/<\s*\/?\s*(?:b|i|u|s|em|strong|span|p|mark|small|code|del|ins|sup|sub)\b[^>]*>/gi, '');
}

/** How much of a reply still coming in is safe to pass on: not a "[" or "<" that may still become a tag. */
function settledLength(text) {
  const open = Math.max(text.lastIndexOf('['), text.lastIndexOf('<'));
  if (open === -1) return text.length;
  const close = text.slice(open).search(/[\]>]/);
  return close === -1 ? open : text.length;
}

const systemText = (system) => (Array.isArray(system) ? system.map((b) => b?.text || '').join('\n\n') : String(system ?? ''));

/** The message in Venice's (OpenAI's) shape: text, or text and a picture of the screen. */
function userContent(user) {
  if (!Array.isArray(user)) return String(user ?? '');
  return user.map((b) =>
    b?.type === 'image' && b.source?.data ? { type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/jpeg'};base64,${b.source.data}` } } : { type: 'text', text: String(b?.text ?? '') },
  );
}

/** One worked example: a short made-up moment in a call, as the real prompts look, and the reply wanted. */
function example(botName, { transcript, task, listsNow = '', people = ['Mike', 'Jess'] }, reply) {
  const at = Date.UTC(2026, 0, 9, 21, 0, 0);
  const lines = transcript.map(([name, text], i) => ({ name: name === 'me' ? botName : name, text, isBot: name === 'me', at: at + i * 4000 }));
  return [
    {
      role: 'user',
      content: EXAMPLE_NOTE + buildUserMessage({
        callInfo: formatCallInfo({ channelName: 'General', people, now: at + 60000 }, 'UTC'),
        transcript: formatTranscript(lines, { botName, timezone: 'UTC' }),
        task: task,
        listsNow,
      }),
    },
    { role: 'assistant', content: reply },
  ];
}

// Each example says what it is, so nothing from it is taken for the real call.
const EXAMPLE_NOTE = '(A made-up example of how to reply, with made-up people. It is not part of the real call.)\n\n';

/**
 * Worked examples for one kind of line (made-up people and moments, never from real calls).
 * on: which tags are on (lists, songs, pictures, reminders); an answer only gets examples of those.
 */
export function examplesFor(kind, botName = 'Gremlin', on = { lists: true, songs: true, images: true, reminders: true }) {
  const ex = (spec, reply) => example(botName, spec, reply);
  const direct = (name) => TASKS.direct({ name, names: [name], botName });
  switch (kind) {
    case 'quip':
      return [
        ...ex(
          {
            transcript: [
              ['Mike', 'I just died to a minion. A caster minion.'],
              ['Jess', 'How do you even do that'],
              ['Mike', 'It had like four HP left and so did I'],
            ],
            task: TASKS.quip({}),
          },
          '<say>Somewhere a caster minion is telling its whole wave about the day it took down a legend.</say>',
        ),
        ...ex(
          {
            transcript: [
              ['Jess', "Guys my grandma's in the hospital, I might have to drop."],
              ['Mike', 'Oh no, is she okay?'],
            ],
            task: TASKS.quip({}),
          },
          PASS,
        ),
        ...ex(
          {
            transcript: [
              ['Mike', 'brb grabbing water'],
              ['Jess', 'k'],
              ['Sam', 'queue when you get back'],
            ],
            task: TASKS.quip({}),
            people: ['Mike', 'Jess', 'Sam'],
          },
          PASS,
        ),
      ];
    case 'followup':
      return [
        ...ex(
          {
            transcript: [
              ['Mike', `${botName}, who's better, Ashe or Jinx?`],
              ['me', "Jinx if your team protects you, Ashe if they don't."],
              ['Mike', 'lol true'],
            ],
            task: TASKS.followup({ name: 'Mike', partner: true }),
          },
          PASS,
        ),
        ...ex(
          {
            transcript: [
              ['Jess', `${botName}, what should I play tonight?`],
              ['me', "Go Garen, he's easy and hits hard."],
              ['Jess', "but I'm so bad at him"],
            ],
            task: TASKS.followup({ name: 'Jess', partner: true }),
          },
          '<say>Everyone is, that is the beauty of Garen, you spin and the problems go away.</say>',
        ),
        ...ex(
          {
            transcript: [
              ['Mike', `${botName}, tell me a joke`],
              ['me', "Why don't zombies ever win at poker? Every time they get a good hand, they eat it."],
              ['Mike', 'haha another one'],
            ],
            task: TASKS.followup({ name: 'Mike', partner: true }),
          },
          '<say>Why did the healer quit? Keeping a whole team alive for free is just parenting without the tax break.</say>',
        ),
        ...ex(
          {
            transcript: [
              ['Sam', `${botName}, is it gonna rain tomorrow?`],
              ['me', 'Looks dry all day, so the barbecue is on.'],
              ['Jess', 'Mike, did you queue us yet?'],
            ],
            task: TASKS.followup({ name: 'Jess' }),
            people: ['Mike', 'Jess', 'Sam'],
          },
          PASS,
        ),
      ];
    case 'roast':
      return ex(
        {
          transcript: [
            ['Jess', 'Mike went 0 and 9 last game'],
            ['Mike', 'My team was trash'],
          ],
          task: TASKS.roast({ target: 'Mike', requester: 'Jess' }),
        },
        '<say>Mike, zero and nine and still blaming the team, that is not a scoreline, that is a lifestyle.</say>',
      );
    case 'greet':
      return ex({ transcript: [['Mike', 'yo'], ['Jess', 'hey']], task: TASKS.greet() }, '<say>Mike, Jess, what did I miss?</say>');
    case 'welcome':
      return ex({ transcript: [['Mike', 'one more game?']], task: TASKS.welcome({ names: ['Sam'] }), people: ['Mike', 'Jess', 'Sam'] }, '<say>Sam! Just in time for one more game.</say>');
    case 'farewell':
      return ex({ transcript: [['Sam', 'alright guys, I gotta sleep, night']], task: TASKS.farewell({ name: 'Sam' }), people: ['Mike', 'Sam'] }, '<say>Night, Sam, sleep well.</say>');
    case 'text':
      return ex(
        { transcript: [['Mike', 'yo']], task: TASKS.text({ author: 'Jess', content: 'you awake, we need a tiebreaker on whether pineapple belongs on pizza' }) },
        "Pineapple belongs on pizza the way a clown belongs at a funeral: technically it is allowed, and everyone remembers it. It goes on.",
      );
    case 'direct':
    default:
      return [
        ...ex({ transcript: [['Sam', `${botName}, what's a good snack for a long gaming night?`]], task: direct('Sam'), people: ['Sam', 'Mike'] }, '<say>Popcorn and a big glass of water, nothing greasy on the keyboard.</say>'),
        // A joke comes whole: setup and punchline in the same reply.
        ...ex(
          { transcript: [['Jess', `${botName}, tell us a joke about Risk of Rain`]], task: direct('Jess') },
          "<say>Why does Risk of Rain need a weather app? Because the forecast is always more enemies.</say>",
        ),
        ...(!on.lists ? [] : ex(
          { transcript: [['Mike', `${botName}, put chips and salsa on the snacks list for Saturday`]], task: direct('Mike') },
          '<say>Chips and salsa are on the snacks list.</say> <list_add list="snacks for Saturday">chips</list_add> <list_add list="snacks for Saturday">salsa</list_add>',
        )),
        ...(!on.lists ? [] : ex(
          {
            transcript: [['Jess', `${botName}, take Deadlock off the games list`]],
            task: direct('Jess'),
            listsNow: '- Games to try (2):\n  1. "Hades 2"\n  2. "Deadlock"\n- Snacks for Saturday (1):\n  1. "chips"',
          },
          '<say>Deadlock is off the list.</say> <list_remove list="Games to try" item="2"/>',
        )),
        ...(!on.songs ? [] : ex(
          { transcript: [['Mike', `${botName}, make a song about Jess and her terrible luck`]], task: direct('Mike') },
          '<say>Coming right up, a sad ballad for Jess and her luck.</say> <song style="slow country ballad, steel guitar, warm male vocals" seconds="30">[Verse]\nShe queued up hoping for a win\nThe matchmaker just grinned\n[Chorus]\nOh Jess, the dice were never kind\nBut she keeps on pressing play\n</song>',
        )),
        ...(!on.images ? [] : ex(
          { transcript: [['Jess', `${botName}, draw Mike as a goblin`]], task: direct('Jess') },
          '<say>On it, goblin Mike coming right up.</say> <image aspect="1:1">A grumpy cartoon goblin in a gaming headset, hunched over a keyboard covered in snack crumbs, bright comic style.</image>',
        )),
        ...(!on.reminders ? [] : ex(
          { transcript: [['Sam', `${botName}, remind me in ten minutes to take the pizza out`]], task: direct('Sam'), people: ['Sam', 'Mike'] },
          '<say>You got it, ten minutes.</say> <reminder in="10 minutes" for="Sam">Sam, the pizza, now.</reminder>',
        )),
      ];
  }
}

// Last thing it reads before answering: how the reply must look.
const FORMAT = {
  quip: `(Reply format: your line inside <say></say>, or exactly ${PASS}. Nothing else: no notes, no labels, no other tags.)`,
  followup: `(Reply format: your line inside <say></say>, or exactly ${PASS}, or exactly ${LONG} if they want something long. Most lines after yours are people reacting or talking to each other: reply ${PASS} to those. A joke they ask for goes in whole: setup and punchline together. A list tag after </say> only if they asked about a list. Nothing else: no notes, no labels.)`,
  // The text chat is a different medium: no <say> tags, and Discord formatting is fine there.
  text: "(Reply format: just the message, the way you'd type it. This one is posted in the text chat, not spoken, so no <say> tags. Up to three sentences.)",
};
/** The format reminder for an answer: the tags it can use are only the ones that are on. */
function answerFormat(on) {
  const can = [on.lists && 'put something on a list', on.songs && 'make a song', on.images && 'draw a picture', on.reminders && 'set a reminder'].filter(Boolean);
  const tags = can.length
    ? ` If they asked you to ${can.length > 1 ? `${can.slice(0, -1).join(', ')} or ${can.at(-1)}` : can[0]}, add that tag after </say> exactly the way your instructions show, and only then${on.lists ? ': on the list that fits what they asked (one in <lists_now>, or a new one), and only what they asked for' : ''}. Never say you did one of those without its tag.`
    : ' No tags.';
  return `(Reply format: your line inside <say></say>, never [say] or any other tag for it. A joke goes in whole: setup and punchline together.${tags} Nothing else: no notes, no labels.)`;
}
const formatFor = (kind, on) => (kind === 'followup' ? FORMAT.followup : kind === 'text' ? FORMAT.text : kind === 'direct' || kind === 'roast' ? answerFormat(on) : FORMAT.quip);
/** Which tags are on, from the system prompt (it only describes the ones that are). */
const tagsOn = (systemText) => ({ lists: systemText.includes('<lists>'), songs: systemText.includes('<songs>'), images: systemText.includes('<pictures>'), reminders: systemText.includes('<reminders>') });

/**
 * A Venice client with the same createMessage as Claude's (see claude.js): returns
 * { text, refusal, stopReason, usage, searches, citations }. model: which Venice model.
 */
export function createVenice(config, { model: modelOverride, fetchImpl = globalThis.fetch, onUsage, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const v = config.venice || {};
  const model = modelOverride || v.model || 'qwen-3-8-27b';
  const temperature = Number.isFinite(v.temperature) ? v.temperature : 0.7;
  const botName = config.botName || 'Gremlin';
  let warned = false;
  // After Venice turns a request down for the key or the credit, Claude writes those lines
  // for a while (see brain.js clientFor), then Venice is tried again.
  let blockedUntil = 0;
  // Settings Venice refused for this model (a 400 naming them): never sent again.
  const refused = new Set();
  if (!VENICE_PRICES[model]) log.warn(`no price is known for VENICE_MODEL=${model}, so /usage counts what it writes as $0`);

  async function createMessage({ system, user, maxTokens = 220, signal, kind = 'direct', onText, retries = 1 }) {
    const sys = systemText(system);
    const on = tagsOn(sys);
    const messages = [{ role: 'system', content: sys }, ...examplesFor(kind, botName, on)];
    const content = userContent(user);
    const reminder = `\n\n${formatFor(kind, on)}`;
    messages.push({ role: 'user', content: Array.isArray(content) ? [...content, { type: 'text', text: reminder.trim() }] : `${content}${reminder}` });
    const body = { model, messages, max_completion_tokens: maxTokens, temperature, stream: true, stream_options: { include_usage: true }, venice_parameters: { include_venice_system_prompt: true } };
    if (VENICE_THINKERS.has(model)) {
      if (!refused.has('reasoning_effort')) body.reasoning_effort = 'none';
      if (!refused.has('disable_thinking')) body.venice_parameters.disable_thinking = true;
    }
    // Its long instructions are the same from one line to the next: models with a cache price
    // charge a sliver for them after the first time, when they land on the same cache.
    if (VENICE_PRICES[model]?.[2] !== undefined && !refused.has('prompt_cache_key')) body.prompt_cache_key = cacheKey(botName, sys);
    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now();
      const timeout = AbortSignal.timeout(25000);
      const res = await fetchWithReconnect(fetchImpl, `${VENICE_API}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${v.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        if (res.status === 400 && body.stream_options && /stream_options/i.test(detail)) {
          delete body.stream_options;
          continue;
        }
        // A setting this model doesn't take: try once more without it, and leave it off from now on.
        const unwanted =
          res.status === 400 &&
          [
            ['reasoning_effort', /reasoning/i, () => delete body.reasoning_effort],
            ['disable_thinking', /disable_thinking|thinking/i, () => delete body.venice_parameters.disable_thinking],
            ['prompt_cache_key', /cache/i, () => delete body.prompt_cache_key],
          ].find(([name, re]) => (name === 'disable_thinking' ? body.venice_parameters.disable_thinking : body[name]) !== undefined && re.test(detail));
        if (unwanted) {
          unwanted[2]();
          refused.add(unwanted[0]);
          log.warn(`Venice's ${model} doesn't take ${unwanted[0]}, so it's left off: ${detail}`);
          continue;
        }
        if (res.status === 401 || res.status === 402 || res.status === 403) {
          blockedUntil = Date.now() + BLOCKED_MS;
          if (!warned) log.error(`Venice turned down the request (${res.status}): ${res.status === 402 ? 'the account is out of credit' : 'check VENICE_API_KEY'}. Claude writes its lines for the next ${BLOCKED_MS / 60000} minutes. ${detail}`);
          warned = true;
        }
        const err = new Error(`Venice ${res.status}: ${detail}`);
        err.status = res.status;
        throw err;
      }
      const out = await readVeniceStream(res, onText);
      // No token counts came back (it can happen without stream_options): about 4 characters a token.
      if (!out.usage) out.usage = { prompt_tokens: Math.round(JSON.stringify(messages).length / 4), completion_tokens: Math.round(out.text.length / 4), estimated: true };
      const dollars = veniceDollars(model, out.usage);
      const u = out.usage;
      const first = out.firstAt ? `, first words ${out.firstAt - startedAt} ms` : '';
      const cached = u.prompt_tokens_details?.cached_tokens ? ` (cached ${u.prompt_tokens_details.cached_tokens})` : '';
      const thought = u.completion_tokens_details?.reasoning_tokens ? `, ${u.completion_tokens_details.reasoning_tokens} of them thinking` : '';
      log.debug(`${model} ${Date.now() - startedAt} ms${first}, in ${u.prompt_tokens ?? '?'}${cached}, out ${u.completion_tokens ?? '?'}${thought}${u.estimated ? ' (estimated)' : ''}, stop ${out.finish || '?'}`);
      onUsage?.({ type: 'venice', model, usage: out.usage, dollars });
      return {
        text: out.text,
        refusal: out.finish === 'content_filter',
        stopReason: out.finish === 'content_filter' ? 'refusal' : out.finish === 'length' ? 'max_tokens' : 'end_turn',
        usage: out.usage ? { input_tokens: out.usage.prompt_tokens || 0, output_tokens: out.usage.completion_tokens || 0 } : null,
        dollars,
        searches: 0,
        citations: [],
      };
    }
  }

  return {
    model,
    provider: 'venice',
    canSearchNow: false,
    /** False for a while after Venice turned a request down for the key or the credit. */
    get usable() {
      return Date.now() >= blockedUntil;
    },
    createMessage,
  };
}

/** Reads a streamed reply, passing on tidied text as it settles. Returns { text, finish, usage, firstAt }. */
export async function readVeniceStream(res, onText) {
  let raw = '';
  let sent = 0;
  let finish = null;
  let usage = null;
  let firstAt = 0; // when its first words came in
  let buf = '';
  const pass = (final) => {
    if (typeof onText !== 'function') return;
    const tidy = normalizeFormat(raw);
    const upTo = final ? tidy.length : settledLength(tidy);
    if (upTo > sent) {
      onText(tidy.slice(sent, upTo));
      sent = upTo;
    }
  };
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      const piece = j.choices?.[0]?.delta?.content;
      if (piece) {
        if (!firstAt) firstAt = Date.now();
        raw += piece;
        pass(false);
      }
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      if (j.usage) usage = j.usage;
    }
  }
  pass(true);
  return { text: normalizeFormat(raw), finish, usage, firstAt };
}
