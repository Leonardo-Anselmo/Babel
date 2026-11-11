// Auto-join (AUTO_JOIN, /autojoin, or the switch on the desktop app's Home): it joins
// a voice channel by itself once two or more people have been hanging out there for a
// few seconds, and follows them if they all move to another channel. /leave (or being
// disconnected) sends it away until everyone has left voice; after a join that failed,
// it waits ten minutes before trying by itself again. /join always works.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { logger } from './log.js';

const log = logger('autojoin');

export const MIN_PEOPLE = 2;
// The group has to be together this long first (people hop in and out).
export const JOIN_DELAY_MS = 20000;
const RETRY_AFTER_FAILURE_MS = 10 * 60000;
// How a call ended that means "not now": it stays out until everyone has left voice.
const SENT_AWAY = new Set(['asked to leave', 'removed from voice']);
// ...and ways it ended because something went wrong.
const FAILED = new Set(['failed to start', 'voice connection lost', 'could not move', 'connection destroyed']);

/** The people in a voice channel who count: not bots, not deafened, not opted out. */
export function peopleIn(channel, { isOptedOut = () => false } = {}) {
  return [...(channel?.members?.values?.() ?? [])].filter((m) => !m.user?.bot && !m.voice?.deaf && !isOptedOut(m.id));
}

/** Whether anyone (not a bot) is in any voice channel in this server. */
export function anyoneInVoice(guild) {
  return [...(guild.voiceStates?.cache?.values?.() ?? [])].some((vs) => vs.channelId && !vs.member?.user?.bot);
}

/**
 * The voice channel it should be in: the one with the most people (at least minPeople)
 * that it can join. A tie goes to `prefer` (where it already is). Not the AFK channel
 * or a stage, nor one that's full or that it has no permission to talk in.
 */
export function pickChannel(guild, { me = guild.members?.me, isOptedOut, prefer = null, minPeople = MIN_PEOPLE } = {}) {
  let best = null;
  let bestCount = 0;
  for (const ch of guild.channels?.cache?.values?.() ?? []) {
    if (ch.type !== ChannelType.GuildVoice || ch.id === guild.afkChannelId) continue;
    const n = peopleIn(ch, { isOptedOut }).length;
    if (n < minPeople) continue;
    const perms = me && ch.permissionsFor ? ch.permissionsFor(me) : null;
    if (perms && !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) continue;
    if (ch.full && !perms?.has(PermissionFlagsBits.MoveMembers)) continue;
    if (ch.joinable === false) continue;
    if (n > bestCount || (n === bestCount && ch.id === prefer)) {
      best = ch;
      bestCount = n;
    }
  }
  return best;
}

export class AutoJoiner {
  /**
   * @param {object} o
   * @param {import('discord.js').Client} o.client
   * @param {object} o.config     loaded config (autoJoin is the default for every server)
   * @param {object} o.memory     autoJoin(id), setAutoJoin(id, on), autoJoinPausedAt(id), setAutoJoinPaused(id, paused), isOptedOut(id, userId)
   * @param {Map<string, any>} o.sessions   voice sessions by server id
   * @param {(guild: object, channel: object) => Promise<void>} o.join   joins a channel (throws if it can't)
   */
  constructor({ client, config, memory, sessions, join, clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, delayMs = JOIN_DELAY_MS }) {
    this.client = client;
    this.config = config;
    this.memory = memory;
    this.sessions = sessions;
    this.join = join;
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.delayMs = delayMs;
    this.timers = new Map(); // guildId -> { timer, channelId }: waiting to join (or move to) there
    this.failedAt = new Map(); // guildId -> when its last try failed
  }

  /** Whether it joins by itself in this server (its own setting, or AUTO_JOIN). */
  enabled(guildId) {
    const v = this.memory.autoJoin?.(guildId);
    return typeof v === 'boolean' ? v : Boolean(this.config.autoJoin);
  }

  /**
   * Turns it on or off for one server. Turning it on (or undoLeave: someone typed
   * /autojoin on) also undoes a /leave, since someone just asked for it.
   */
  set(guildId, on, { undoLeave = false } = {}) {
    const was = this.enabled(guildId);
    this.memory.setAutoJoin(guildId, on);
    if (on && (undoLeave || !was)) {
      this.memory.setAutoJoinPaused?.(guildId, false);
      this.failedAt.delete(guildId);
    }
    const guild = this.client.guilds?.cache?.get(guildId);
    if (on && guild) this.check(guild);
    else this.cancel(guildId);
  }

  /** A call in this server ended: why decides whether it may come back by itself. */
  sessionEnded(guildId, reason) {
    this.cancel(guildId);
    const guild = this.client.guilds?.cache?.get(guildId);
    if (SENT_AWAY.has(reason)) {
      this.memory.setAutoJoinPaused?.(guildId, true);
      if (this.enabled(guildId)) log.info(`won't join by myself in ${guild?.name ?? 'that server'} until everyone has left voice (${reason})`);
      return;
    }
    if (FAILED.has(reason)) this.failedAt.set(guildId, this.clock());
    // Everyone moved somewhere else: it may follow.
    if (guild) this.check(guild);
  }

  /** Someone joined, left or moved between voice channels in this server. */
  onVoiceStateUpdate(oldState, newState) {
    const guild = newState?.guild ?? oldState?.guild;
    if (guild) this.check(guild);
  }

  /** Every server, once logged in (people may already be in a call). */
  checkAll() {
    for (const guild of this.client.guilds?.cache?.values?.() ?? []) this.check(guild);
  }

  isOptedOut(guildId) {
    return (userId) => Boolean(this.memory.isOptedOut?.(guildId, userId));
  }

  /** Looks at who's where, and joins (or moves) once the group has been together a little while. */
  check(guild) {
    if (this.stopped || (this.client.isReady && !this.client.isReady())) return;
    const id = guild.id;
    // Everyone left voice: a /leave from before no longer holds.
    if (this.memory.autoJoinPausedAt?.(id) && !anyoneInVoice(guild)) {
      this.memory.setAutoJoinPaused(id, false);
      log.info(`everyone left voice in ${guild.name}, so I can join by myself again`);
    }
    if (!this.enabled(id) || this.memory.autoJoinPausedAt?.(id) || this.clock() - (this.failedAt.get(id) ?? -Infinity) < RETRY_AFTER_FAILURE_MS) {
      this.cancel(id);
      return;
    }
    const s = this.sessions.get(id);
    const live = s && !s.ended ? s : null;
    // Connecting or moving already: look again once that's done.
    if (live && (live.starting || live.moving || live.moveInProgress || live.moveRequested || !live.ready)) return;
    const isOptedOut = this.isOptedOut(id);
    // Already with people, or someone dragged it where it is: nothing to do.
    if (live && (live.placed || peopleIn(live.voiceChannel, { isOptedOut }).length > 0)) {
      this.cancel(id);
      return;
    }
    const target = pickChannel(guild, { isOptedOut, prefer: live?.channelId ?? null });
    if (!target || target.id === live?.channelId) {
      this.cancel(id);
      return;
    }
    if (this.timers.get(id)?.channelId === target.id) return; // already waiting to go there
    this.cancel(id);
    const timer = this.setTimer(() => {
      this.go(guild, target.id).catch((err) => log.warn(`auto-join failed: ${err.message}`));
    }, this.delayMs);
    timer?.unref?.();
    this.timers.set(id, { timer, channelId: target.id });
  }

  cancel(guildId) {
    const p = this.timers.get(guildId);
    if (!p) return;
    this.clearTimer(p.timer);
    this.timers.delete(guildId);
  }

  /** The wait is over: if that's still where the group is, join it (or move there). */
  async go(guild, channelId) {
    this.timers.delete(guild.id);
    const id = guild.id;
    if (this.stopped || !this.enabled(id) || this.memory.autoJoinPausedAt?.(id)) return;
    const s = this.sessions.get(id);
    const live = s && !s.ended ? s : null;
    if (live && (live.starting || live.moving || live.moveInProgress || live.moveRequested || !live.ready)) return;
    const isOptedOut = this.isOptedOut(id);
    if (live && (live.placed || peopleIn(live.voiceChannel, { isOptedOut }).length > 0)) return;
    const target = pickChannel(guild, { isOptedOut, prefer: live?.channelId ?? null });
    // People moved again meanwhile: start the wait over for wherever they are now.
    if (!target || target.id !== channelId) {
      this.check(guild);
      return;
    }
    try {
      if (live) {
        live.moveRequested = true;
        let moved = false;
        try {
          moved = await live.moveTo(target, target);
        } finally {
          live.moveRequested = false;
        }
        if (!moved) throw new Error(`couldn't move to #${target.name}`);
        log.info(`followed everyone to #${target.name} (auto-join)`);
      } else {
        log.info(`${peopleIn(target, { isOptedOut }).length} people are in #${target.name}, so I'm joining (auto-join)`);
        await this.join(guild, target);
      }
      this.failedAt.delete(id);
    } catch (err) {
      this.failedAt.set(id, this.clock());
      log.warn(`couldn't join #${target.name} by myself (${err.message}); trying again in 10 minutes at the earliest`);
    }
  }

  /** Shutting down: no more joining. */
  stop() {
    this.stopped = true;
    for (const p of this.timers.values()) this.clearTimer(p.timer);
    this.timers.clear();
  }
}
