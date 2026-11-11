// Slash commands: definitions and handlers.
// Commands are registered per server, so they only ever appear inside servers.

import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { CHATTINESS_LEVELS } from './config.js';
import { logger } from './log.js';
import { MAX_FACT_CHARS, MAX_FACTS } from './memory.js';
import { canPostPictures, cutOffInImage, imageTags, imagesNowFor, lastKey, withoutImageTags } from './images.js';
import { changeNote, describeResult, formatListPosts, formatListsForPrompt, listTags, problemNote } from './lists.js';
import { buildSystem, buildUserMessage, cleanText, formatCallInfo, sayContent, sourceLinks, TASKS, withoutHiddenTags } from './prompts.js';
import { withoutReminderTags } from './reminders.js';
import { withoutSongTags } from './songs.js';
import { VoiceSession } from './session.js';
import { looksLikeSoftRefusal } from './refusals.js';
import { deepgramBalance, describeBucket, elevenLabsQuota, money, shortDate } from './usage.js';

const log = logger('commands');
const EPHEMERAL = MessageFlags.Ephemeral;

export function commandDefinitions(botName) {
  return [
    new SlashCommandBuilder().setName('join').setDescription(`Bring ${botName} into your voice channel`),
    new SlashCommandBuilder().setName('leave').setDescription(`Kick ${botName} out of voice`),
    new SlashCommandBuilder()
      .setName('autojoin')
      .setDescription(`Let ${botName} join voice by itself when two or more people are in a channel`)
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('on or off')
          .setRequired(true)
          .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
      ),
    new SlashCommandBuilder()
      .setName('chattiness')
      .setDescription('How often it jumps in without being called by name')
      .addStringOption((o) =>
        o
          .setName('level')
          .setDescription('off = only when called by name')
          .setRequired(true)
          .addChoices(...CHATTINESS_LEVELS.map((l) => ({ name: l, value: l }))),
      ),
    new SlashCommandBuilder().setName('shush').setDescription('Stop talking right now'),
    new SlashCommandBuilder()
      .setName('say')
      .setDescription('Make it say something out loud')
      .addStringOption((o) => o.setName('text').setDescription('Exact words').setRequired(true).setMaxLength(300)),
    new SlashCommandBuilder()
      .setName('roast')
      .setDescription('Playfully roast someone, all in good fun')
      .addUserOption((o) => o.setName('who').setDescription('The victim').setRequired(true)),
    new SlashCommandBuilder()
      .setName('remember')
      .setDescription('Teach it an inside joke or fact about the group')
      .addStringOption((o) =>
        o
          .setName('fact')
          .setDescription('e.g. "Mike always volunteers to scout"')
          .setRequired(true)
          .setMaxLength(MAX_FACT_CHARS),
      ),
    new SlashCommandBuilder().setName('memories').setDescription('List what it remembers about this server'),
    new SlashCommandBuilder()
      .setName('forget')
      .setDescription('Forget one remembered fact (number from /memories)')
      .addIntegerOption((o) => o.setName('number').setDescription('Fact number').setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName('optout').setDescription("Stop the bot from listening to you (it won't hear you at all)"),
    new SlashCommandBuilder().setName('optin').setDescription('Let the bot listen to you again'),
    new SlashCommandBuilder()
      .setName('usage')
      .setDescription('What it has used and roughly what it cost (only you see the answer)')
      // Server managers only by default; change it in Server Settings > Integrations.
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('forgetcalls')
      .setDescription('Forget its notes on recent calls here (call memory) and the jokes it kept to call back to')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ].map((b) => b.toJSON());
}

export async function registerCommands(guild, botName) {
  try {
    await guild.commands.set(commandDefinitions(botName));
    log.info(`slash commands ready in ${guild.name}`);
  } catch (err) {
    log.warn(
      `couldn't register commands in ${guild.name}: ${err.message}. Re-invite the bot with the link printed at startup (it needs the applications.commands scope).`,
    );
  }
}

/** The session for this server, only once it's fully connected. */
function readySession(ctx, guildId) {
  const s = ctx.sessions.get(guildId);
  return s && s.ready && !s.ended ? s : null;
}

/**
 * ctx: { client, config, claude, claudeFast, venice, stt, tts, memory, sessions: Map<guildId, VoiceSession> }
 */
export async function handleInteraction(interaction, ctx) {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;
  const name = interaction.commandName;
  try {
    switch (name) {
      case 'join':
        return await join(interaction, ctx);
      case 'leave':
        return await leave(interaction, ctx);
      case 'autojoin':
        return await autoJoin(interaction, ctx);
      case 'chattiness':
        return await chattiness(interaction, ctx);
      case 'shush':
        return await shush(interaction, ctx);
      case 'say':
        return await say(interaction, ctx);
      case 'roast':
        return await roast(interaction, ctx);
      case 'remember':
        return await remember(interaction, ctx);
      case 'memories':
        return await memories(interaction, ctx);
      case 'forget':
        return await forget(interaction, ctx);
      case 'optout':
      case 'optin':
        return await opt(interaction, ctx, name === 'optout');
      case 'usage':
        return await usage(interaction, ctx);
      case 'forgetcalls':
        return await forgetCalls(interaction, ctx);
      default:
        return undefined;
    }
  } catch (err) {
    log.error(`/${name} failed:`, err);
    const content = `Something broke: ${String(err.message).slice(0, 300)}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => {});
    else await interaction.reply({ content, flags: EPHEMERAL }).catch(() => {});
  }
}

async function join(interaction, ctx) {
  const { config, sessions } = ctx;
  const guildId = interaction.guildId;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const channel = member.voice?.channel;
  if (!channel) {
    return interaction.reply({ content: 'Hop into a voice channel first, then run /join.', flags: EPHEMERAL });
  }
  if (channel.type === ChannelType.GuildStageVoice) {
    return interaction.reply({ content: "Stage channels aren't supported. Use a regular voice channel.", flags: EPHEMERAL });
  }
  const perms = channel.permissionsFor(interaction.guild.members.me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    return interaction.reply({ content: `I need **View Channel**, **Connect** and **Speak** permissions in ${channel}.`, flags: EPHEMERAL });
  }
  if (channel.full && !perms.has(PermissionFlagsBits.MoveMembers)) {
    return interaction.reply({ content: `${channel} is full, so I can't get in.`, flags: EPHEMERAL });
  }
  if (channel.joinable === false) {
    return interaction.reply({ content: `I can't get into ${channel}.`, flags: EPHEMERAL });
  }

  const existing = sessions.get(guildId);
  if (existing && !existing.ended) {
    if (existing.starting) {
      return interaction.reply({ content: 'Still connecting, give it a few seconds.', flags: EPHEMERAL });
    }
    if (existing.moving || existing.moveInProgress || existing.moveRequested) {
      return interaction.reply({ content: 'Still moving channels, give it a few seconds.', flags: EPHEMERAL });
    }
    if (existing.channelId === channel.id) {
      return interaction.reply({ content: `Already in ${channel}.`, flags: EPHEMERAL });
    }
    // Claim the move before the first await, so a second /join right after this
    // one says "still moving" instead of starting a competing move.
    existing.moveRequested = true;
    let moved = false;
    try {
      await interaction.deferReply();
      moved = await existing.moveTo(channel, interaction.channel);
    } finally {
      existing.moveRequested = false;
    }
    return interaction.editReply(moved ? `Moved to ${channel}.` : `Couldn't move to ${channel}. Try /join again.`);
  }

  // Claimed before the first await, so a second /join right after this one sees
  // "still connecting" instead of starting a second copy.
  const session = newSession(ctx, { guild: interaction.guild, guildId, channel, textChannel: interaction.channel });
  try {
    await interaction.deferReply();
  } catch (err) {
    session.end('could not answer /join');
    if (sessions.get(guildId) === session) sessions.delete(guildId);
    throw err;
  }
  try {
    await session.start();
  } catch (err) {
    session.end('failed to start');
    if (sessions.get(guildId) === session) sessions.delete(guildId);
    return interaction.editReply(`Couldn't join: ${err.message}`);
  }
  return interaction.editReply(joinNotice(config, channel, session.brain.chattiness));
}

/**
 * A voice session for this server, claimed in ctx.sessions right away (marked as
 * starting): /join and joining by itself both make them this way. Call start() next.
 */
export function newSession(ctx, { guild, guildId = guild.id, channel, textChannel }) {
  const { sessions } = ctx;
  const session = new VoiceSession({
    client: ctx.client,
    guild,
    voiceChannel: channel,
    textChannel,
    config: ctx.config,
    claude: ctx.claude,
    claudeFast: ctx.claudeFast,
    claudeJokes: ctx.claudeJokes,
    venice: ctx.venice,
    stt: ctx.stt,
    tts: ctx.tts,
    memory: ctx.memory,
    usage: ctx.usage,
    reminders: ctx.reminders,
    songs: ctx.songs,
    images: ctx.images,
    lists: ctx.lists,
    isOwner: ctx.isOwner,
    getScreenshot: ctx.getScreenshot,
    onEnd: (id, reason) => {
      if (sessions.get(id) === session) sessions.delete(id);
      ctx.onSessionEnd?.(id, reason);
      ctx.onSessionChange?.();
    },
  });
  session.starting = true;
  sessions.set(guildId, session);
  // (The desktop app hears about it right away: it never restarts him for an update mid-call.)
  ctx.onSessionChange?.();
  return session;
}

/** What it says in text when it joins: that it's listening, what's kept, and how to talk to it or opt out. */
export function joinNotice(config, channel, level, { auto = false } = {}) {
  // Be straight about it when what people say is being written down.
  const privacy = config.logTranscripts
    ? "It listens to the call so it can talk back. Audio isn't recorded, but transcript logging is on, so what people say is saved as text in its log."
    : "It listens to the call so it can talk back; audio isn't recorded or saved.";
  const notes = config.callMemory ? ' Call memory is on: it keeps short notes on each call to remember next time (**/forgetcalls** clears them).' : '';
  const start = auto
    ? `**${config.botName}** joined ${channel} by itself (auto-join: **/leave** sends it away until everyone has left voice, **/autojoin off** turns it off).`
    : `**${config.botName}** is in ${channel}.`;
  return `${start} ${privacy}${notes} Say "${config.botName}" to talk to it. Chattiness: **${level}**. Don't want it hearing you? **/optout**`;
}

async function forgetCalls(interaction, ctx) {
  const jokes = ctx.memory.landedJokes?.(interaction.guildId).length ?? 0;
  const n = ctx.memory.forgetCalls(interaction.guildId);
  ctx.memory.flush?.();
  // The call going on now starts its notes over too.
  const s = ctx.sessions.get(interaction.guildId);
  const current = Boolean(s?.callNotes && !s.ended);
  if (current) s.callNotes.clear();
  log.info(`forgot ${n} saved call${n === 1 ? '' : 's'}${jokes ? ` and ${jokes} kept joke${jokes === 1 ? '' : 's'}` : ''} (/forgetcalls)`);
  const what = n ? `Forgot my notes on ${n === 1 ? 'the last call' : `the last ${n} calls`}` : 'I had no saved notes on calls here';
  const kept = jokes ? `, and the ${jokes === 1 ? 'joke' : `${jokes} jokes`} I kept to call back to` : '';
  return interaction.reply({ content: `${what}${kept}${current ? ", and started this call's notes over" : ''}.`, flags: EPHEMERAL });
}

async function leave(interaction, ctx) {
  const s = ctx.sessions.get(interaction.guildId);
  if (!s || s.ended) return interaction.reply({ content: "I'm not in voice.", flags: EPHEMERAL });
  s.end('asked to leave');
  const auto = ctx.autoJoiner?.enabled(interaction.guildId) ? " I won't hop back in by myself until everyone has left voice." : '';
  return interaction.reply(`Heading out. Catch you next time!${auto}`);
}

async function autoJoin(interaction, ctx) {
  const on = interaction.options.getString('mode', true) === 'on';
  if (ctx.autoJoiner) ctx.autoJoiner.set(interaction.guildId, on, { undoLeave: true });
  else ctx.memory.setAutoJoin(interaction.guildId, on);
  ctx.memory.flush?.();
  log.info(`auto-join turned ${on ? 'on' : 'off'} (/autojoin)`);
  return interaction.reply(
    on
      ? "Auto-join is **on**: I'll hop into a voice channel by myself once two or more people are in it, and follow you if you all move. **/leave** sends me away until everyone has left voice."
      : 'Auto-join is **off**. Use **/join** to bring me in.',
  );
}

async function chattiness(interaction, ctx) {
  const level = interaction.options.getString('level', true);
  ctx.memory.setChattiness(interaction.guildId, level);
  readySession(ctx, interaction.guildId)?.brain.setChattiness(level);
  const blurb = {
    off: 'Only talks when someone says its name.',
    low: 'Jumps in now and then, and keeps follow-ups short.',
    medium: 'Jumps in regularly.',
    high: 'Chimes in a lot.',
  }[level];
  return interaction.reply(`Chattiness set to **${level}**. ${blurb}`);
}

async function shush(interaction, ctx) {
  const s = readySession(ctx, interaction.guildId);
  s?.brain.shush();
  return interaction.reply({ content: s ? 'Shushed.' : "I'm not in voice.", flags: EPHEMERAL });
}

const SAY_COOLDOWN_MS = 15000;
const lastSay = new Map(); // userId -> when they last used /say

async function say(interaction, ctx) {
  const s = readySession(ctx, interaction.guildId);
  if (!s) return interaction.reply({ content: 'Use /join first (or wait for it to finish connecting).', flags: EPHEMERAL });
  // Every line costs voice credits, so only people in the call can use it, and not back to back.
  if (!s.hasMember(interaction.user.id)) {
    return interaction.reply({ content: 'Join the voice channel first, then use /say.', flags: EPHEMERAL });
  }
  const now = Date.now();
  const wait = SAY_COOLDOWN_MS - (now - (lastSay.get(interaction.user.id) || 0));
  if (wait > 0) {
    return interaction.reply({ content: `One moment. Try again in ${Math.ceil(wait / 1000)} s.`, flags: EPHEMERAL });
  }
  lastSay.set(interaction.user.id, now);
  const text = interaction.options.getString('text', true);
  s.brain.sayExactly(text);
  return interaction.reply({ content: 'Saying it.', flags: EPHEMERAL });
}

async function roast(interaction, ctx) {
  const user = interaction.options.getUser('who', true);
  const member = interaction.options.getMember('who');
  const targetName = member?.displayName ?? user.globalName ?? user.username;
  const requester = interaction.member?.displayName ?? interaction.user.username;
  const s = readySession(ctx, interaction.guildId);
  if (s) {
    s.brain.roast({ target: targetName, requester });
    return interaction.reply({ content: `Roasting ${targetName} in voice.`, flags: EPHEMERAL });
  }
  // Not in voice: roast in text instead.
  await interaction.deferReply();
  const text = await textReply(ctx, {
    guildId: interaction.guildId,
    authorId: interaction.user.id,
    author: requester,
    content: `Playfully roast ${targetName}: gentle, affectionate and specific, something they'll laugh at too.`,
  });
  return interaction.editReply({ content: text || "I've got nothing. They're too nice to roast.", allowedMentions: { parse: [] } });
}

async function remember(interaction, { memory }) {
  const fact = interaction.options.getString('fact', true);
  const { text, dropped } = memory.remember(interaction.guildId, fact, interaction.user.id);
  if (!text) return interaction.reply({ content: 'That one was empty. Try again with a fact.', flags: EPHEMERAL });
  // The list holds MAX_FACTS; say which old one made room, so it isn't lost without a word.
  const full = dropped.length
    ? `\nThe list was full (${MAX_FACTS} facts), so I forgot the oldest one: ${dropped[0].text}${dropped.length > 1 ? ` (and ${dropped.length - 1} more)` : ''}`
    : '';
  return interaction.reply({ content: `Noted: ${text}${full}`, allowedMentions: { parse: [] } });
}

async function memories(interaction, { memory }) {
  const facts = memory.facts(interaction.guildId);
  if (!facts.length) {
    return interaction.reply({ content: 'Nothing yet. Teach me with /remember.', flags: EPHEMERAL });
  }
  // Split into messages that fit Discord's limit, so the newest facts aren't cut off.
  const chunks = [''];
  for (const line of facts.map((f, i) => `${i + 1}. ${f.text}`)) {
    if (chunks.at(-1).length + line.length + 1 > 1900) chunks.push('');
    chunks[chunks.length - 1] += (chunks.at(-1) ? '\n' : '') + line;
  }
  await interaction.reply({ content: chunks[0], flags: EPHEMERAL, allowedMentions: { parse: [] } });
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, flags: EPHEMERAL, allowedMentions: { parse: [] } });
  }
  return undefined;
}

async function forget(interaction, { memory }) {
  const n = interaction.options.getInteger('number', true);
  const removed = memory.removeFact(interaction.guildId, n);
  return interaction.reply({
    content: removed ? `Forgot: ${removed.text}` : `There's no fact #${n}. Check /memories.`,
    flags: EPHEMERAL,
    allowedMentions: { parse: [] },
  });
}

async function usage(interaction, ctx) {
  const { config } = ctx;
  await interaction.deferReply({ flags: EPHEMERAL });
  const count = (n) => Math.round(n).toLocaleString('en-US');
  const lines = [];
  // Real balances first, straight from the providers (skipped if a key can't read them).
  const [eleven, deepgram] = await Promise.all([elevenLabsQuota(config), deepgramBalance(config)]);
  if (eleven) {
    const left = Math.max(0, eleven.limit - eleven.used);
    const resets = eleven.resetsAt ? `, resets ${shortDate(eleven.resetsAt, config.timezone)}` : '';
    lines.push(`**ElevenLabs:** ${count(eleven.used)} of ${count(eleven.limit)} credits used, ${count(left)} left${resets}`);
  }
  if (deepgram) lines.push(`**Deepgram:** ${money(deepgram.dollars)} of credit left`);
  const bullets = (b) => describeBucket(b).map((l) => `- ${l}`);
  const session = readySession(ctx, interaction.guildId);
  const call = session?.callUsage();
  // Everything the bot used since it joined (text replies included).
  if (call) lines.push('', `**Since it joined the call** (${session.callLength()}):`, ...bullets(call));
  if (ctx.usage) {
    lines.push('', '**Today:**', ...bullets(ctx.usage.today()));
    lines.push('', '**This calendar month:**', ...bullets(ctx.usage.thisMonth()));
  }
  lines.push('', '-# Dollar amounts are estimates from list prices. The ElevenLabs, Deepgram and Anthropic dashboards have the exact numbers.');
  return interaction.editReply({ content: lines.join('\n').trim().slice(0, 1900), allowedMentions: { parse: [] } });
}

async function opt(interaction, ctx, out) {
  const s = ctx.sessions.get(interaction.guildId);
  // What they're called, so jokes it kept that name them go too (and none are kept later).
  const names = [interaction.member?.displayName, interaction.user.username, interaction.user.globalName].filter(Boolean);
  if (s && !s.ended) s.setOptOut(interaction.user.id, out, { names });
  else ctx.memory.setOptOut(interaction.guildId, interaction.user.id, out, { names });
  return interaction.reply({
    content: out
      ? "Done. I won't listen to you in voice in this server (your audio is ignored before it's transcribed). /optin to undo."
      : "Welcome back. I'll hear you again.",
    flags: EPHEMERAL,
  });
}

/** The words of a reply: what's inside <say></say> when it used the tags, otherwise all of it. */
const sayContentOrAll = (text) => sayContent(text) ?? text;

/**
 * Generates a text-chat reply (used for @mentions and /roast outside voice).
 * The live voice transcript is only shared with people who are in the call.
 * onImage: gets a picture it agreed to draw. onLists: gets the messages to post after
 * the reply (lists someone asked to see, or what didn't work); the changes are already made.
 */
export async function textReply(ctx, { guildId, authorId, author, content, channel = null, onImage = null, onLists = null }) {
  const { config, claude, memory } = ctx;
  const session = readySession(ctx, guildId);
  const inCall = Boolean(session && authorId && session.hasMember(authorId));
  const webSearch = Boolean(config.anthropic?.webSearch?.enabled);
  // Pictures too, when the caller can post one (an @mention: drawn and posted after this reply).
  const images = onImage && ctx.images?.enabled ? ctx.images : null;
  // ...and the shared lists (an @mention: changed now, posted after this reply).
  const lists = onLists && ctx.lists && config.lists !== false ? ctx.lists : null;
  const systemOpts = {
    botName: config.botName,
    persona: config.persona,
    lore: config.lore,
    facts: memory.facts(guildId),
    audioTags: false,
    webSearch,
    images: Boolean(images),
    lists: Boolean(lists),
  };
  const system = buildSystem(systemOpts);
  let transcript = '(you are not in a voice call right now)';
  if (session && inCall) {
    transcript =
      session.brain.transcript
        .recent()
        .map((l) => `${l.isBot ? `${config.botName} (you)` : l.name}: ${l.text}`)
        .join('\n') || '(quiet so far)';
  } else if (session) {
    transcript = "(you're in a voice call, but this person isn't in it, so don't reveal anything said there)";
  }
  const callInfo = session && inCall ? formatCallInfo({ ...session.callInfo(), now: Date.now() }, config.timezone) : '';
  const imagesNow = images ? imagesNowFor({ images, lastKey: lastKey(guildId, channel?.id ?? 'text'), canPost: canPostPictures(channel, channel?.guild?.members?.me) }) : '';
  // (Its item numbers mean the items in this copy, whatever changes before the reply is done.)
  const listsShown = lists ? lists.all(guildId) : null;
  const listsNow = lists ? formatListsForPrompt(listsShown, { trash: lists.trash(guildId) }) : '';
  const user = buildUserMessage({ callInfo, transcript, task: TASKS.text({ author, content }), imagesNow, listsNow });
  const maxTokens = 400 + (images ? 150 : 0) + (lists ? 80 : 0);
  const res = await claude.createMessage({ system, user, maxTokens, retries: 2, search: webSearch });
  if (res.refusal || looksLikeSoftRefusal(res.text)) return 'I cannot help with that request. Try another question.';
  const cleaned = cleanText(res.text, { botName: config.botName });
  // It chose to stay quiet: "[PASS]" anywhere, or a reply that is only "PASS" (tags aside).
  const visible = withoutHiddenTags(res.text);
  const passed = /\[\s*pass\s*\]/i.test(visible) || /^[\s"'*_(]*pass[\s.!"')]*$/i.test(sayContentOrAll(visible));
  // (A reply that passed draws nothing either.)
  if (images && !passed) {
    // (Not one inside a reminder or a song's words.)
    const outside = withoutSongTags(withoutReminderTags(res.text));
    const tags = imageTags(outside);
    const cutOff = res.stopReason === 'max_tokens' && cutOffInImage(outside);
    if (tags.length || cutOff) onImage({ image: tags[0] ?? null, cutOff });
  }
  // Changes to the lists (not with a reply that passed).
  if (lists && !passed) {
    // (Not ones inside a reminder, a song's words or a picture's description.)
    const outside = withoutImageTags(withoutSongTags(withoutReminderTags(res.text)));
    const tags = listTags(outside, { cutOff: res.stopReason === 'max_tokens' });
    if (tags.cutOff) {
      // It ran out of room in the middle of a change: none of them are made (some may be missing).
      log.warn("a list change didn't fit in the text reply, so none of its changes were made");
      onLists(["-# (I ran out of room writing that down, so the lists didn't change. Ask me again.)"]);
    } else if (tags.ops.length) {
      const { results, posts } = lists.apply(guildId, tags.ops, { by: author || null, shown: listsShown });
      for (const r of results) log.info(`list (text): ${describeResult(r, { words: config.logTranscripts })}`);
      const messages = formatListPosts(posts);
      // (A reply that was only tags: what changed is said here, so nothing changes unseen.)
      const changed = cleaned.pass ? changeNote(results) : '';
      if (changed) messages.unshift(changed);
      const note = problemNote(results);
      if (note) messages.push(note);
      if (messages.length) onLists(messages);
    }
  }
  if (cleaned.pass) return res.searches ? 'Sorry, I came up empty on that one. Try asking a different way.' : '';
  // Show where a looked-up answer came from.
  const sources = sourceLinks(res.citations);
  return sources.length ? `${cleaned.text}\n-# Sources: ${sources.join(' ')}` : cleaned.text;
}
