// Minimal Claude Messages API client (plain fetch, no SDK), tuned for a live
// call: thinking only between web searches (or off), effort set per model,
// prompt caching on the big system prompt, quick retries for overload errors,
// and optional server-side web search for answers that need current facts.

import { logger } from './log.js';
import { fetchWithReconnect } from './net.js';
import { safeText } from './stt.js';

const log = logger('claude');

const API = 'https://api.anthropic.com/v1';
export const API_VERSION = '2026-10-21';
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export class ClaudeError extends Error {
  constructor(message, { status, type } = {}) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

// One spending limit shared by every Claude client in this process.
const callTimes = [];

/** Order in which we try to switch thinking off, best first. */
const THINKING_FALLBACKS = ['disabled', 'between_tools', 'omit'];

// Server-side web search, newest version first. The 2026 versions run searches
// through code execution by default, so ask for direct searches only.
export const SEARCH_TOOLS = [
  (maxUses) => ({ type: 'web_search_20260318', name: 'web_search', max_uses: maxUses, allowed_callers: ['direct'] }),
  (maxUses) => ({ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses, allowed_callers: ['direct'] }),
  (maxUses) => ({ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }),
];
// Extra output room when it may search: the search calls and the thinking it
// does between the results and the answer count as output (more at higher
// effort). Spoken replies are still trimmed to a sentence or two elsewhere; this
// is only a ceiling, and only what it actually writes is billed.
const SEARCH_EXTRA_TOKENS = 1500;
const SEARCH_MIN_MAX_TOKENS = 2048;
const SEARCH_ERROR = /web_search|web search|server_tool|allowed_callers|max_uses/i;

// Searches made today by any client in this process (a safety cap on search fees).
const searchDay = { key: '', count: 0, warned: false };

/** For tests: forget today's search count. */
export function resetSearchCount() {
  searchDay.key = '';
  searchDay.count = 0;
  searchDay.warned = false;
}

/**
 * The answer is what it wrote after its last search. Anything before that is
 * "let me look that up" narration, which shouldn't be spoken.
 */
export function answerFrom(blocks) {
  let start = 0;
  blocks.forEach((b, i) => {
    if (b.type === 'server_tool_use' || /_tool_result$/.test(b.type || '')) start = i + 1;
  });
  const parts = [];
  const citations = [];
  for (const b of blocks.slice(start)) {
    if (b.type !== 'text') continue;
    parts.push(b.text);
    for (const c of b.citations || []) {
      if (c.url && !citations.some((x) => x.url === c.url)) citations.push({ url: c.url, title: c.title || '' });
    }
  }
  return { text: parts.join('').trim(), citations };
}

/**
 * Reads a streamed Messages API response (server-sent events) into the same shape
 * as a plain response ({ content, usage, stop_reason }), calling onText with each
 * piece of answer text as it arrives and onToolStart when it starts a web search.
 */
export async function readStream(res, { onText, onToolStart } = {}) {
  const blocks = [];
  const partialJson = new Map(); // block index -> tool input JSON so far
  let usage = {};
  let stopReason = null;
  let buffer = '';
  const decoder = new TextDecoder();
  const handle = (event, data) => {
    switch (data.type || event) {
      case 'message_start':
        usage = { ...(data.message?.usage || {}) };
        break;
      case 'content_block_start': {
        const block = structuredClone(data.content_block || {});
        blocks[data.index] = block;
        if (block.type === 'server_tool_use') onToolStart?.();
        break;
      }
      case 'content_block_delta': {
        const block = blocks[data.index];
        const d = data.delta || {};
        if (!block) break;
        if (d.type === 'text_delta') {
          block.text = (block.text || '') + d.text;
          onText?.(d.text);
        } else if (d.type === 'input_json_delta') {
          partialJson.set(data.index, (partialJson.get(data.index) || '') + (d.partial_json || ''));
        } else if (d.type === 'thinking_delta') {
          block.thinking = (block.thinking || '') + d.thinking;
        } else if (d.type === 'signature_delta') {
          block.signature = d.signature;
        } else if (d.type === 'citations_delta' && d.citation) {
          (block.citations ||= []).push(d.citation);
        }
        break;
      }
      case 'content_block_stop':
        if (partialJson.has(data.index) && blocks[data.index]) {
          try {
            blocks[data.index].input = JSON.parse(partialJson.get(data.index) || '{}');
          } catch {
            blocks[data.index].input = {};
          }
          partialJson.delete(data.index);
        }
        break;
      case 'message_delta':
        if (data.delta?.stop_reason !== undefined) stopReason = data.delta.stop_reason;
        usage = { ...usage, ...(data.usage || {}) };
        break;
      case 'error':
        throw new ClaudeError(`Claude API stream ${data.error?.type || 'error'}: ${data.error?.message || ''}`.slice(0, 400), {
          status: data.error?.type === 'overloaded_error' ? 529 : 500,
          type: data.error?.type || 'stream_error',
        });
      default:
        break; // ping, message_stop
    }
  };
  const flushEvents = () => {
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = '';
      const data = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      let parsed;
      try {
        parsed = JSON.parse(data.join('\n'));
      } catch {
        continue;
      }
      handle(event, parsed);
    }
  };
  for await (const chunk of res.body) {
    // (Normalized after joining, so a \r\n split across two chunks is caught too.)
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    flushEvents();
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    buffer += '\n\n';
    flushEvents();
  }
  return { content: blocks.filter(Boolean), usage, stop_reason: stopReason };
}

export function guessThinkingMode(model) {
  if (/haiku/i.test(model)) return 'disabled';
  if (/sonnet/i.test(model)) return 'between_tools';
  return 'omit';
}

export function createClaude(
  config,
  {
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    model: modelOverride,
    effort: effortOverride,
    onUsage,
  } = {},
) {
  const a = config.anthropic;
  const model = modelOverride || a.model;
  const effort = effortOverride || a.effort;
  let thinkingMode = a.thinking === 'auto' ? null : a.thinking; // resolved lazily
  const searchCfg = a.webSearch || { enabled: false, maxUses: 1, dailyLimit: 0 };
  let searchVersion = 0; // index into SEARCH_TOOLS
  // Why search is unavailable (null = available).
  let searchOff = !searchCfg.enabled
    ? 'turned off in .env (WEB_SEARCH)'
    : searchCfg.dailyLimit <= 0
      ? 'WEB_SEARCH_DAILY_LIMIT is 0'
      : null;

  function headers() {
    const h = {
      authorization: `Bearer ${a.apiKey}`,
      'anthropic-version': API_VERSION,
      'content-type': 'application/json',
    };
    if (a.workspaceId) h['anthropic-workspace-id'] = a.workspaceId;
    return h;
  }

  /** Asks the Models API which "thinking off" setting this model accepts. */
  async function init() {
    if (thinkingMode) return thinkingMode;
    try {
      const res = await fetchImpl(`${API}/models/${encodeURIComponent(model)}`, {
        headers: headers(),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const info = await res.json();
        const types = info?.capabilities?.thinking?.types;
        if (types?.disabled?.supported === true) thinkingMode = 'disabled';
        else if (types?.between_tools?.supported === true) thinkingMode = 'between_tools';
        if (!searchOff && info?.capabilities?.server_tools?.web_search?.supported === false) {
          searchOff = `${model} doesn't support web search`;
        }
      } else if (res.status === 401 || res.status === 403) {
        log.error(`Anthropic rejected ANTHROPIC_API_KEY (${res.status}). The bot can't think until that's fixed: ${await safeText(res)}`);
      } else if (res.status === 404) {
        log.warn(`Anthropic doesn't recognize the model "${model}". Check CLAUDE_MODEL / CLAUDE_FAST_MODEL in .env.`);
      } else {
        log.debug(`models lookup ${res.status}: ${await safeText(res)}`);
      }
    } catch (err) {
      log.debug(`models lookup failed: ${err.message}`);
    }
    // Docs: Haiku 5.5 accepts "disabled"; Sonnet 5.5 rejects it and wants "between_tools".
    const guess = guessThinkingMode(model);
    if (!thinkingMode || (thinkingMode === 'disabled' && guess === 'between_tools')) thinkingMode = guess;
    log.info(`model ${model}, thinking: ${thinkingMode}, effort: ${effort}`);
    return thinkingMode;
  }

  function buildBody({ system, messages, maxTokens, search, stream }) {
    const body = {
      model,
      max_tokens: search ? Math.max(maxTokens + SEARCH_EXTRA_TOKENS, SEARCH_MIN_MAX_TOKENS) : maxTokens,
      system,
      messages,
    };
    if (stream) body.stream = true;
    if (search) body.tools = [SEARCH_TOOLS[searchVersion](searchCfg.maxUses)];
    if (effort) body.output_config = { effort };
    if (thinkingMode && thinkingMode !== 'omit') body.thinking = { type: thinkingMode };
    return body;
  }

  // Unprompted chatter is capped at the configured rate; replies people asked
  // for get 3x headroom so they're never starved by quip checks.
  function underRateLimit(important) {
    const now = Date.now();
    while (callTimes.length && now - callTimes[0] > 60000) callTimes.shift();
    const cap = important ? a.maxCallsPerMinute * 3 : a.maxCallsPerMinute;
    if (callTimes.length >= cap) return false;
    callTimes.push(now);
    return true;
  }

  /** Whether this request may search: allowed for this model, and under today's cap. */
  function searchAllowed() {
    if (searchOff) return false;
    const today = new Date().toISOString().slice(0, 10);
    if (searchDay.key !== today) {
      searchDay.key = today;
      searchDay.count = 0;
      searchDay.warned = false;
    }
    if (searchDay.count >= searchCfg.dailyLimit) {
      if (!searchDay.warned) log.info(`reached ${searchCfg.dailyLimit} web searches today (WEB_SEARCH_DAILY_LIMIT); answering without searching until tomorrow (UTC)`);
      searchDay.warned = true;
      return false;
    }
    return true;
  }

  /**
   * One message. Returns { text, refusal, stopReason, usage, searches, citations }.
   * user: the message text, or content blocks (text and images).
   * search: true lets the model look things up on the web first (when it's on).
   * onText: streams the reply, calling onText(piece) as it's written (and
   * onToolStart() when it starts a search), so speaking can start early. If it's
   * overloaded partway, it's sent again only if onRetry() says that's fine (nothing
   * of it was said yet).
   * Throws ClaudeError on hard failures.
   */
  async function createMessage({ system, user, maxTokens = 220, signal, retries = 1, important = true, search = false, onText, onToolStart, onRetry }) {
    if (!thinkingMode) await init();
    if (!underRateLimit(important)) throw new ClaudeError('local rate limit reached (CLAUDE_MAX_CALLS_PER_MINUTE)', { type: 'local_rate_limit' });

    let attempt = 0;
    let adaptedThinking = false;
    let useSearch = search && searchAllowed();
    const messages = [{ role: 'user', content: user }];
    let resumed = 0;
    let searches = 0;
    const blocks = []; // everything it wrote, across a paused turn
    const stream = typeof onText === 'function';
    let streamed = false; // some of the answer already went out: a retry would repeat it
    const onPiece = (piece) => {
      streamed = true;
      onText(piece);
    };
    for (;;) {
      const started = Date.now();
      const timeout = AbortSignal.timeout(useSearch ? 30000 : 20000);
      const res = await fetchWithReconnect(fetchImpl, `${API}/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(buildBody({ system, messages, maxTokens, search: useSearch, stream })),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });

      if (res.ok) {
        let json;
        if (stream && res.body && /event-stream/i.test(res.headers.get('content-type') || '')) {
          try {
            json = await readStream(res, { onText: onPiece, onToolStart });
          } catch (err) {
            // Overloaded mid-answer: try again only if nothing was said yet.
            if (err instanceof ClaudeError && RETRYABLE.has(err.status) && attempt < retries && !signal?.aborted && (!streamed || onRetry?.() === true)) {
              attempt++;
              streamed = false;
              log.debug(`stream ${err.type}; retrying`);
              await sleep(350 * 2 ** (attempt - 1));
              continue;
            }
            throw err;
          }
        } else {
          json = await res.json();
          // Asked to stream but got a plain answer: hand the answer over in one piece.
          if (stream) {
            const content = json.content || [];
            if (content.some((b) => b.type === 'server_tool_use')) onToolStart?.();
            const { text } = answerFrom(content);
            if (text) onPiece(text);
          }
        }
        const content = json.content || [];
        blocks.push(...content);
        const u = json.usage || {};
        const searched = u.server_tool_use?.web_search_requests || 0;
        searches += searched;
        searchDay.count += searched;
        onUsage?.({ type: 'claude', model, usage: u });
        log.debug(
          `${Date.now() - started} ms, in ${u.input_tokens ?? '?'} (cache read ${u.cache_read_input_tokens ?? 0}, write ${u.cache_creation_input_tokens ?? 0}), out ${u.output_tokens ?? '?'}${searched ? `, ${searched} web search` : ''}, stop ${json.stop_reason}`,
        );
        // A long search loop can pause mid-turn: send it back once to let it finish.
        if (json.stop_reason === 'pause_turn' && resumed < 1 && !signal?.aborted) {
          resumed++;
          messages.push({ role: 'assistant', content });
          continue;
        }
        const { text, citations } = answerFrom(blocks);
        return { text, refusal: json.stop_reason === 'refusal', stopReason: json.stop_reason, usage: u, searches, citations };
      }

      const bodyText = await safeText(res);
      let type = '';
      let message = bodyText;
      try {
        const e = JSON.parse(bodyText).error;
        type = e?.type || '';
        message = e?.message || bodyText;
      } catch {
        // not JSON
      }

      // If this model rejects our "thinking off" setting, step to the next option once.
      if (res.status === 400 && /thinking/i.test(message) && !adaptedThinking) {
        const next = THINKING_FALLBACKS[THINKING_FALLBACKS.indexOf(thinkingMode) + 1];
        if (next) {
          log.warn(`model rejected thinking "${thinkingMode}", switching to "${next}"`);
          thinkingMode = next;
          adaptedThinking = true;
          continue;
        }
      }

      // Web search rejected: try an older tool version, or answer without searching.
      if (res.status === 400 && useSearch && SEARCH_ERROR.test(message)) {
        if (/not enabled|disabled|not allowed/i.test(message)) {
          searchOff = 'turned off for your Anthropic organization (an admin can turn it on at platform.claude.com/settings/capabilities)';
          log.warn(`web search is ${searchOff}; answering without it`);
          useSearch = false;
        } else if (searchVersion < SEARCH_TOOLS.length - 1) {
          searchVersion++;
          log.warn(`model rejected that web search version; trying ${SEARCH_TOOLS[searchVersion](1).type}`);
        } else {
          searchOff = `rejected by the API (${message.slice(0, 160)})`;
          log.warn(`web search ${searchOff}; answering without it`);
          useSearch = false;
        }
        continue;
      }

      if (RETRYABLE.has(res.status) && attempt < retries && !signal?.aborted) {
        attempt++;
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 && ra <= 5 ? ra * 1000 : 350 * 2 ** (attempt - 1);
        log.debug(`retrying after ${res.status} in ${wait} ms`);
        await sleep(wait);
        continue;
      }
      throw new ClaudeError(`Claude API ${res.status}${type ? ` ${type}` : ''}: ${message}`.slice(0, 400), {
        status: res.status,
        type,
      });
    }
  }

  return {
    init,
    createMessage,
    model,
    effort,
    get thinkingMode() {
      return thinkingMode;
    },
    /** 'on', or why web search is unavailable. */
    get searchStatus() {
      return searchOff ? `off: ${searchOff}` : 'on';
    },
    /** Whether an answer written now could search (available, and under today's cap). */
    get canSearchNow() {
      if (searchOff) return false;
      const today = new Date().toISOString().slice(0, 10);
      return searchDay.key !== today || searchDay.count < searchCfg.dailyLimit;
    },
  };
}
