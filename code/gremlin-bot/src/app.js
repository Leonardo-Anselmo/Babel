// The bot itself. Started by src/index.js after it checks the Node.js version.

import path from 'node:path';
import { Client, Events, GatewayIntentBits, cleanContent } from 'discord.js';
import { linkToApp } from './app-link.js';
import { createClaude } from './claude.js';
import { AutoJoiner } from './autojoin.js';
import { handleInteraction, joinNotice, newSession, registerCommands, textReply } from './commands.js';
import { CHATTINESS_LEVELS, loadConfig, validateConfig } from './config.js';
import { holdInstanceLock } from './instance-lock.js';
import { logger, setLogFile, setLogLevel } from './log.js';
import { Memory } from './memory.js';
import { Reminders, postReminder } from './reminders.js';
import { createStt } from './stt.js';
import { createTts } from './tts.js';
import { createSongs } from './songs.js';
import { createImages, drawAndPost, lastKey } from './images.js';
import { Lists } from './lists.js';
import { Usage } from './usage.js';
import { VENICE_FOR_WORDS, createVenice } from './venice.js';
import { keepConnectionsOpen } from './net.js';
import { createWhisperManager } from './whisper.js';

const log = logger('bot');

// View Channel, Send Messages, Attach Files (for pictures), Read Message History, Connect, Speak, Use Voice Activity
export const INVITE_PERMISSIONS = (1n << 10n) | (1n << 11n) | (1n << 15n) | (1n << 16n) | (1n << 20n) | (1n << 21n) | (1n << 25n);

// Saved on the way out if something unexpected stops the bot.
let memory = null;
let usage = null;
let crashing = false;

/** The first place in the bot's own code an error came from, like "src/session.js:212". */
function whereFrom(err) {
  for (const line of String(err?.stack || '').split('\n').slice(1)) {
    if (/node_modules|\(node:|at node:/.test(line)) continue;
    const m = /[\\/]src[\\/]([^()\s\\/]+\.js):(\d+)/.exec(line);
    if (m) return `src/${m[1]}:${m[2]}`;
  }
  return '';
}

/**
 * Something nothing else caught. Says what in one clear line (the full details go to
 * data/bot.log), saves memory and usage, and exits with an error code, so the app or
 * the start-windows.bat window shows that it stopped and why.
 */
function crash(kind) {
  return (err) => {
    if (crashing) return;
    crashing = true;
    const what = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const at = whereFrom(err);
    log.error(`unexpected ${kind}: ${what}${at ? ` (at ${at})` : ''}. Details are in data/bot.log (Logs > Activity in the app).`);
    log.debug(err?.stack || what);
    for (const store of [memory, usage]) {
      try {
        store?.flush();
      } catch {
        // already on the way out
      }
    }
    // Right away, so nothing else runs in a broken state (and the line above stays the last word).
    process.exit(1);
  };
}
process.on('uncaughtException', crash('error'));
// A promise nobody waited on failed (usually a Discord or network call that was fire
// and forget). Worth an error in the log, not worth hanging up on everyone mid-call.
process.on('unhandledRejection', (err) => {
  const what = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const at = whereFrom(err);
  log.error(`a background task failed: ${what}${at ? ` (at ${at})` : ''}`);
  log.debug(err?.stack || what);
});

async function main() {
  const config = loadConfig();
  if (process.env.LOG_LEVEL) setLogLevel(process.env.LOG_LEVEL);
  const problems = validateConfig(config);
  if (problems.length) {
    // The last line is what the desktop app shows as the reason, so it's a problem, not advice.
    console.error(`${config.botName} can't start yet. Fix these in Settings in the desktop app (or in the .env file), then start it again:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  // A fuller record than the window shows (who spoke and what it did about it, not
  // what they said) goes to data/bot.log, for figuring out why it missed someone.
  setLogFile(path.join(config.dataDir, 'bot.log'));
  if (!(await holdInstanceLock())) {
    log.error(`${config.botName} is already running, from the desktop app or another start-windows.bat window. Stop that one first.`);
    process.exit(1);
  }

  keepConnectionsOpen();
  memory = new Memory(config.dataDir);
  usage = new Usage({ dataDir: config.dataDir, timezone: config.timezone });
  const onUsage = (event) => usage.record(event);
  const claude = createClaude(config, { onUsage });
  const fastModel = config.anthropic.fastModel;
  const claudeFast = fastModel && fastModel !== claude.model ? createClaude(config, { model: fastModel, effort: config.anthropic.fastEffort, onUsage }) : claude;
  // Its own jokes: the main model unless CLAUDE_JOKE_MODEL says otherwise.
  const jokeModel = config.anthropic.jokeModel;
  const claudeJokes = !jokeModel || jokeModel === claude.model ? claude : jokeModel === claudeFast.model ? claudeFast : createClaude(config, { model: jokeModel, onUsage });
  // Build the optional provider only when routing is enabled.
  const venice = config.venice.apiKey && config.venice.kinds.length ? createVenice(config, { onUsage }) : null;
  if (venice) log.info(`Venice (${config.venice.model}) writes: ${VENICE_FOR_WORDS[config.venice.for]}; Claude writes the rest`);
  else if (config.venice.kinds.length) log.warn('VENICE_FOR is set but VENICE_API_KEY is empty, so Claude writes everything');
  const stt = createStt(config, { onUsage });
  const tts = createTts(config, { onUsage });
  // Songs on request (ElevenLabs Music), counted in usage.json against the month's minutes.
  const songs = createSongs(config, { usage });
  // Pictures on request (Gemini), counted in usage.json against the month's cap.
  const images = createImages(config, { usage });
  // Each distinct client once (the joke and fast clients are often the main one).
  await Promise.all([...new Set([claude, claudeFast, claudeJokes])].map((c) => c.init()));

  // What it's listening with, for the desktop app's status screen.
  let hearing = { provider: config.stt.provider, detail: config.stt.provider === 'whisper' ? 'starting Whisper' : '' };

  // Free hearing on this PC's graphics card. The start-up check usually started it
  // already; if not, it loads in the background and Deepgram (with a key) covers until it's ready.
  if (config.stt.provider === 'whisper') {
    const whisper = createWhisperManager(config);
    whisper.ensure({ waitMs: 180000 }).then((r) => {
      const model = config.stt.whisper.model;
      if (r.status === 'running' || r.status === 'started') {
        stt.setExtras(r.info);
        // The small models it runs on the processor next to Whisper.
        const extras = [
          stt.extras.turn && (config.listen.smartTurn ? 'end-of-turn model' : 'end-of-turn model (off in settings)'),
          stt.extras.wake && `name detector (${stt.extras.wake})`,
        ].filter(Boolean);
        log.info(`hearing: Whisper ${model} on your graphics card (${r.info.device}, ${r.info.compute_type})${extras.length ? `, with the ${extras.join(' and ')}` : ''}`);
        hearing = { provider: 'whisper', detail: `Whisper ${model} on your graphics card${stt.extras.wake ? ', with its name detector' : ''}` };
        return;
      }
      const problem =
        r.status === 'not-installed'
          ? `the Whisper model ${model} isn't set up yet (Run Whisper setup on Home in the app, or setup-whisper.bat)`
          : `Whisper couldn't start (${r.reason})`;
      if (config.stt.deepgramKey) {
        log.warn(`hearing: ${problem}; using Deepgram`);
        hearing = { provider: 'deepgram', detail: r.status === 'not-installed' ? "Deepgram (Whisper isn't set up yet)" : "Deepgram (Whisper couldn't start)" };
      } else {
        log.error(`hearing: ${problem}, and there's no Deepgram key to cover, so it can't hear anyone. Fix Whisper, or add a Deepgram key in Settings.`);
        hearing = { provider: 'none', detail: r.status === 'not-installed' ? "Nothing: Whisper isn't set up and there's no Deepgram key" : "Nothing: Whisper couldn't start and there's no Deepgram key" };
      }
    });
    whisper.keepAlive();
  }

  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages];
  if (config.enablePresence) intents.push(GatewayIntentBits.GuildPresences);
  const client = new Client({ intents, allowedMentions: { parse: [], repliedUser: false } });

  const sessions = new Map();
  // Who owns the bot (from Discord, once logged in): the only one who can ask it to look at the screen.
  let ownerId = null;
  // The desktop app link (set below), which can take a picture of this PC's screen.
  let app = null;
  const ctx = {
    client,
    config,
    claude,
    claudeFast,
    claudeJokes,
    venice,
    stt,
    tts,
    songs,
    images,
    memory,
    usage,
    sessions,
    isOwner: (userId) => Boolean(ownerId) && userId === ownerId,
    getScreenshot: async () => {
      if (!app) return { error: "it can only see the screen when it's started from the desktop app" };
      return app.requestScreenshot();
    },
    // A call ended (auto-join decides whether it may come back by itself).
    onSessionEnd: (guildId, reason) => autoJoiner.sessionEnded(guildId, reason),
    // A call started or ended: the desktop app hears about it now, not up to 3 s later.
    onSessionChange: () => app?.report(),
  };

  // Reminders people asked for in voice: said in the call when due, or posted in text.
  const reminders = new Reminders({
    memory,
    timezone: config.timezone,
    onDue: (guildId, r, { late }) => {
      const post = () => postReminder(client, guildId, r, { late, timezone: config.timezone }).catch((err) => log.warn(`couldn't post a reminder: ${err.message}`));
      const s = sessions.get(guildId);
      // In a call with whoever it's for (or everyone): said out loud. If nobody got to
      // hear it (stopped before it started, or the call ended), it's posted instead.
      // (When the voice fails, the line is already posted in text.)
      if (s && s.ready && !s.ended && (!r.userId || s.hasMember(r.userId))) {
        s.sayReminder(r, { late })
          .then(({ outcome, heard } = {}) => {
            if (!heard && outcome !== 'failed') post();
          })
          .catch(() => post());
        return;
      }
      post();
    },
  });
  ctx.reminders = config.reminders ? reminders : null;
  // Shared lists people keep with it (kept in memory.json between calls), changed by voice or @mention.
  ctx.lists = config.lists ? new Lists({ memory }) : null;

  // Joining a voice channel by itself when people gather (AUTO_JOIN, /autojoin, the app's Home).
  const autoJoiner = new AutoJoiner({
    client,
    config,
    memory,
    sessions,
    join: async (guild, channel) => {
      const session = newSession(ctx, { guild, channel, textChannel: channel });
      try {
        await session.start();
      } catch (err) {
        session.end('failed to start');
        if (sessions.get(guild.id) === session) sessions.delete(guild.id);
        throw err;
      }
      // Tell everyone in the channel's chat, the way /join does (or in the server's system channel).
      const content = joinNotice(config, channel, session.brain.chattiness, { auto: true });
      const sent =
        (await channel.send({ content, allowedMentions: { parse: [] } }).catch(() => null)) ||
        (await guild.systemChannel?.send({ content, allowedMentions: { parse: [] } }).catch(() => null));
      if (!sent) log.warn(`couldn't post the auto-join notice in #${channel.name} or the server's system channel (no permission to send messages there?)`);
    },
  });
  ctx.autoJoiner = autoJoiner;

  client.once(Events.ClientReady, async (c) => {
    const invite = `https://discord.com/oauth2/authorize?client_id=${c.application.id}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;
    log.info(`logged in as ${c.user.tag}. Answers to: ${config.botAliases.join(', ')}`);
    log.info(`invite link: ${invite}`);
    if (c.guilds.cache.size === 0) log.warn('not in any servers yet: open the invite link above to add it to yours');
    try {
      // A team-owned app answers to the team's owner.
      const owner = (await c.application.fetch()).owner;
      ownerId = owner?.ownerId ?? owner?.id ?? null;
    } catch (err) {
      log.warn(`couldn't look up who owns the bot (${err.message}), so nobody can ask it to look at the screen`);
    }
    for (const guild of c.guilds.cache.values()) await registerCommands(guild, config.botName);
    if (config.reminders) reminders.start();
    // People may already be hanging out in voice.
    autoJoiner.checkAll();
  });
  client.on(Events.GuildCreate, (guild) => registerCommands(guild, config.botName));
  client.on(Events.GuildDelete, (guild) => sessions.get(guild.id)?.end('removed from server'));

  client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction, ctx));

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    sessions.get(newState.guild.id)?.onVoiceStateUpdate(oldState, newState);
    autoJoiner.onVoiceStateUpdate(oldState, newState);
  });

  // @mention the bot (or its auto-created role) in a text channel and it answers in text.
  const recentMentions = new Map();
  client.on(Events.MessageCreate, async (message) => {
    if (!message.inGuild() || message.author.bot) return;
    const botRole = message.guild.roles.botRoleFor(client.user);
    const mentioned = message.mentions.users.has(client.user.id) || (botRole && message.mentions.roles.has(botRole.id));
    if (!mentioned) return;
    const last = recentMentions.get(message.author.id) || 0;
    if (Date.now() - last < 3000) return; // light spam guard
    recentMentions.set(message.author.id, Date.now());
    try {
      await message.channel.sendTyping().catch(() => {});
      let raw = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '');
      if (botRole) raw = raw.replace(new RegExp(`<@&${botRole.id}>`, 'g'), '');
      const content = cleanContent(raw.trim(), message.channel) || '(just pinged you)';
      const author = message.member?.displayName ?? message.author.username;
      // A picture it agreed to draw is drawn once its reply is up, and posted as a reply too.
      let picture = null;
      // A list someone asked to see goes up right after the reply.
      let listPosts = [];
      const text = await textReply(ctx, {
        guildId: message.guildId,
        authorId: message.author.id,
        author,
        content: content.slice(0, 600),
        channel: message.channel,
        onImage: (tag) => {
          picture = tag;
        },
        onLists: (messages) => {
          listPosts = messages;
        },
      });
      if (text) {
        // (The message may be gone, or replying not allowed: then it's posted plainly, so the list posts still follow.)
        await message.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } }).catch(async (err) => {
          log.debug(`couldn't reply to the message (${err.message}); posting it instead`);
          await message.channel.send({ content: text, allowedMentions: { parse: [] } }).catch((e) => log.warn(`text reply failed: ${e.message}`));
        });
      }
      for (const post of listPosts) await message.channel.send({ content: post, allowedMentions: { parse: [] } }).catch((err) => log.warn(`couldn't post a list: ${err.message}`));
      if (picture) {
        drawAndPost({ images, tag: picture, channel: message.channel, lastKey: lastKey(message.guildId, message.channelId), forName: author, me: message.guild.members.me, replyTo: message }).catch((err) =>
          log.warn(`picture failed: ${err.message}`),
        );
      }
    } catch (err) {
      log.warn(`text reply failed: ${err.message}`);
    }
  });

  client.on(Events.Error, (err) => log.error('discord client error:', err.message));
  client.on(Events.Warn, (msg) => log.warn(msg));

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, leaving voice and shutting down`);
    autoJoiner.stop();
    reminders.stop();
    const saving = [];
    for (const s of sessions.values()) {
      s.end('shutting down');
      if (s.notesSaving) saving.push(s.notesSaving);
    }
    const exit = () => {
      memory.flush();
      usage.flush();
      client.destroy().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    if (!saving.length) return exit();
    // The summary of the call that just ended takes a few seconds to write (the app waits 10).
    log.info('saving notes on the call first');
    Promise.race([Promise.allSettled(saving), new Promise((r) => setTimeout(r, 6000).unref())]).then(exit);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Closing the window on Windows sends SIGHUP: leave voice and save before exiting.
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // Started by the desktop app (desktop/): report status to it, take its commands,
  // and stop cleanly when it asks, or if the app goes away.
  app = linkToApp({
    client,
    sessions,
    memory,
    defaultChattiness: config.defaultChattiness,
    levels: CHATTINESS_LEVELS,
    hearing: () => hearing,
    shutdown,
    log,
    autoJoiner,
  });
  if (app) client.once(Events.ClientReady, app.ready);

  try {
    await client.login(config.discordToken);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/disallowed intents/i.test(msg)) {
      log.error(
        'Discord refused the Presence intent. Either turn off "See what everyone is playing" in Settings (ENABLE_PRESENCE in .env), or turn on "Presence Intent" under Developer Portal > your app > Bot > Privileged Gateway Intents.',
      );
    } else if (/token/i.test(msg)) {
      log.error('Discord rejected the bot token. Reset it in the Developer Portal (your app > Bot > Reset Token), then save the new one under Settings > Keys in the desktop app (DISCORD_TOKEN in .env).');
    } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(msg)) {
      log.error(`Could not reach Discord (${msg}). Is this computer online? The bot needs internet access to discord.com.`);
    } else {
      log.error(`Could not log in to Discord: ${msg}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  // The details first, then the one line that says what happened (the app shows the last one).
  if (err?.stack) console.error(err.stack);
  console.error(`Fatal error: ${err?.message || err}`);
  process.exit(1);
});
