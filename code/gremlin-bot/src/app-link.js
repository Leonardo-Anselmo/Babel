// The link to the desktop app (desktop/), used when the app started the bot.
// Reports status every few seconds, takes its commands (stop, chattiness, forget a
// saved call), asks it for a picture of the screen when the owner wants the bot to
// look, and stops the bot cleanly if the app goes away, so it never keeps running orphaned.

const REPORT_EVERY_MS = 3000;
// How long to wait for the app to send back a picture of the screen.
const SCREENSHOT_TIMEOUT_MS = 4000;

/**
 * @param {object} o
 * @param {NodeJS.Process} o.proc   this process (has send() when the app started it)
 * @param {import('discord.js').Client} o.client
 * @param {Map<string, any>} o.sessions   voice sessions by server id
 * @param {{ chattiness(id: string): string|null, setChattiness(id: string, level: string): void, guildIds?(): string[], flush?(): void, forgetCall?(guildId: string, id: string): object|null, forgetCalls?(guildId: string): number }} o.memory
 * @param {string} o.defaultChattiness
 * @param {string[]} o.levels   the valid chattiness levels
 * @param {() => object} o.hearing   what it's listening with right now
 * @param {(reason: string) => void} o.shutdown
 * @returns {null | { report: () => void, requestScreenshot: (o?: { timeoutMs?: number }) => Promise<{ jpeg?: string, error?: string }>, ready: () => void, stop: () => void }}
 */
export function linkToApp({ proc = process, client, sessions, memory, defaultChattiness, levels, hearing, shutdown, log, autoJoiner = null }) {
  if (typeof proc.send !== 'function') return null;

  // Chattiness (or auto-join) that came in before it was logged in to Discord, when it
  // doesn't know all its servers yet. The rest of them get it once it's ready.
  let pendingLevel = null;
  let pendingAutoJoin = null;

  const status = () => {
    const servers = [...client.guilds.cache.values()];
    return {
      type: 'status',
      ready: client.isReady(),
      user: client.user?.tag ?? null,
      servers: servers.map((g) => ({
        name: g.name,
        chattiness: memory.chattiness(g.id) || defaultChattiness,
        ...(autoJoiner ? { autoJoin: autoJoiner.enabled(g.id) } : {}),
      })),
      calls: [...sessions.values()].map((s) => ({
        server: s.guild.name,
        channel: s.voiceChannel?.name ?? null,
        people: s.humans().map((m) => m.displayName),
        since: s.joinedAt || null,
      })),
      hearing: hearing(),
    };
  };

  const report = () => {
    try {
      proc.send(status());
    } catch {
      // the app is gone; 'disconnect' takes care of it
    }
  };

  /** Every server it's in or has saved settings for, and the call if there is one. */
  const applyChattiness = (level) => {
    const ids = new Set([...client.guilds.cache.keys(), ...(memory.guildIds?.() || [])]);
    for (const id of ids) {
      memory.setChattiness(id, level);
      sessions.get(id)?.brain?.setChattiness(level);
    }
    memory.flush?.(); // saved now, in case it's stopped right after
  };

  /** Auto-join on or off in every server it's in or has saved settings for. */
  const applyAutoJoin = (on) => {
    const ids = new Set([...client.guilds.cache.keys(), ...(memory.guildIds?.() || [])]);
    for (const id of ids) autoJoiner.set(id, on);
    memory.flush?.();
  };

  // Screenshots asked for and not back yet: id -> resolve.
  const waiting = new Map();
  let nextId = 0;

  /** A picture of this PC's screen, from the app: { jpeg } (base64) or { error }. */
  const requestScreenshot = ({ timeoutMs = SCREENSHOT_TIMEOUT_MS } = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ error: "the app didn't send the screen in time" });
      }, timeoutMs);
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(reply);
      });
      try {
        proc.send({ type: 'screenshot-request', id });
      } catch {
        waiting.get(id)?.({ error: 'the app is gone' });
      }
    });

  /** Forgets one saved call (id) or all of them (and the jokes it kept), for one server or every server. */
  const forgetCalls = ({ guildId, id } = {}) => {
    const ids = guildId ? [guildId] : memory.guildIds?.() || [];
    let n = 0;
    let jokes = 0;
    for (const g of ids) {
      if (!id) jokes += memory.landedJokes?.(g).length || 0;
      n += id ? (memory.forgetCall?.(g, id) ? 1 : 0) : memory.forgetCalls?.(g) || 0;
    }
    memory.flush?.();
    if (n) log?.info(`forgot ${n === 1 && id ? 'a saved call' : `${n} saved call${n === 1 ? '' : 's'}`} (from the app)`);
    if (jokes) log?.info(`forgot ${jokes} kept joke${jokes === 1 ? '' : 's'} (from the app)`);
    return { count: n, jokes };
  };

  const onMessage = (m) => {
    if (m?.type === 'shutdown') shutdown('stop request from the app');
    else if (m?.type === 'screenshot' && waiting.has(m.id)) {
      waiting.get(m.id)(typeof m.jpeg === 'string' && m.jpeg ? { jpeg: m.jpeg } : { error: String(m.error || "the screen couldn't be captured").slice(0, 200) });
    } else if (m?.type === 'forget-call') {
      const r = forgetCalls({ guildId: typeof m.guildId === 'string' ? m.guildId : null, id: typeof m.id === 'string' ? m.id : null });
      try {
        proc.send({ type: 'forgot-calls', requestId: m.requestId ?? null, count: r.count, jokes: r.jokes });
      } catch {
        // the app is gone
      }
    } else if (m?.type === 'set-chattiness' && levels.includes(m.level)) {
      applyChattiness(m.level);
      if (client.isReady()) log?.info(`chattiness set to ${m.level} from the app`);
      else {
        pendingLevel = m.level;
        log?.info(`chattiness set to ${m.level} from the app (for the rest of the servers once it's logged in)`);
      }
      report();
    } else if (m?.type === 'set-auto-join' && typeof m.on === 'boolean' && autoJoiner) {
      if (client.isReady()) {
        applyAutoJoin(m.on);
        log?.info(`auto-join turned ${m.on ? 'on' : 'off'} from the app`);
      } else {
        pendingAutoJoin = m.on;
        log?.info(`auto-join turned ${m.on ? 'on' : 'off'} from the app (once it's logged in)`);
      }
      report();
    } else if (m?.type === 'status') report();
  };
  const onDisconnect = () => shutdown('the app closed');

  proc.on('message', onMessage);
  proc.on('disconnect', onDisconnect);
  const timer = setInterval(report, REPORT_EVERY_MS);
  timer.unref?.();

  return {
    report,
    requestScreenshot,
    /** Call once logged in to Discord: applies chattiness that came in before, then reports. */
    ready() {
      if (pendingLevel) {
        applyChattiness(pendingLevel);
        pendingLevel = null;
      }
      if (pendingAutoJoin !== null && autoJoiner) {
        applyAutoJoin(pendingAutoJoin);
        pendingAutoJoin = null;
      }
      report();
    },
    stop() {
      clearInterval(timer);
      proc.off('message', onMessage);
      proc.off('disconnect', onDisconnect);
      for (const resolve of [...waiting.values()]) resolve({ error: 'the app link closed' });
    },
  };
}
