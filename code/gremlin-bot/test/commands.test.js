import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { commandDefinitions, handleInteraction } from '../src/commands.js';
import { MAX_FACTS, Memory } from '../src/memory.js';
import { VoiceSession } from '../src/session.js';
import { Usage } from '../src/usage.js';

function interaction(commandName) {
  const out = { deferred: null, replies: [] };
  return {
    out,
    isChatInputCommand: () => true,
    inGuild: () => true,
    commandName,
    guildId: 'g1',
    user: { id: 'u1' },
    deferred: false,
    replied: false,
    async deferReply(opts) {
      this.deferred = true;
      out.deferred = opts;
    },
    async editReply(m) {
      out.replies.push(typeof m === 'string' ? m : m.content);
    },
    async reply(m) {
      this.replied = true;
      out.replies.push(typeof m === 'string' ? m : m.content);
    },
  };
}

test('/usage is registered for server managers only', () => {
  const usage = commandDefinitions('Gremlin').find((c) => c.name === 'usage');
  assert.ok(usage);
  assert.equal(usage.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
});

test('/usage answers privately with this call, today and the month', async () => {
  const usage = new Usage({ timezone: 'UTC' });
  const snap = usage.snapshot();
  usage.record({ type: 'tts', chars: 2340, model: 'eleven_flash_v2_5' });
  usage.record({ type: 'stt', provider: 'deepgram', seconds: 1800, keyterms: true });
  const session = {
    ready: true,
    ended: false,
    callUsage: () => usage.since(snap),
    callLength: () => '1h 5m',
  };
  const i = interaction('usage');
  await handleInteraction(i, {
    config: { timezone: 'UTC', tts: {}, stt: { provider: 'deepgram' } }, // no keys: skips the live balance lookups
    usage,
    sessions: new Map([['g1', session]]),
  });
  assert.ok(i.out.deferred.flags, 'only the person who asked sees it');
  const text = i.out.replies.at(-1);
  assert.match(text, /\*\*Since it joined the call\*\* \(1h 5m\)/);
  assert.match(text, /2,340 characters spoken \(about 468 ElevenLabs credits/);
  assert.match(text, /30 min of audio transcribed/);
  assert.match(text, /\*\*Today:\*\*/);
  assert.match(text, /\*\*This calendar month:\*\*/);
  assert.match(text, /estimates/);
});

test('/remember says which old fact it forgot when the list was full', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-cmd-'));
  try {
    const memory = new Memory(dir);
    for (let i = 1; i <= MAX_FACTS; i++) memory.remember('g1', `Fact ${i}`, 'u1');
    const i = interaction('remember');
    i.options = { getString: () => 'Weevil only plays support' };
    await handleInteraction(i, { memory });
    assert.match(i.out.replies[0], /^Noted: Weevil only plays support\nThe list was full \(40 facts\), so I forgot the oldest one: Fact 1$/);
    const j = interaction('remember');
    j.options = { getString: () => 'One more' };
    memory.removeFact('g1', 1);
    await handleInteraction(j, { memory });
    assert.equal(j.out.replies[0], 'Noted: One more', 'room left: nothing forgotten');
    clearTimeout(memory.saveTimer);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/join says so when what people say is written to the log', async () => {
  const realStart = VoiceSession.prototype.start;
  VoiceSession.prototype.start = async function () {
    this.starting = false;
    this.ready = true;
    this.brain = { chattiness: 'low' };
  };
  try {
    const channel = { id: 'B', type: 2, joinable: true, full: false, permissionsFor: () => ({ has: () => true }), toString: () => '#B' };
    const guild = { members: { fetch: async () => ({ voice: { channel } }), me: { id: 'bot' } } };
    for (const logTranscripts of [false, true]) {
      const i = interaction('join');
      i.guild = guild;
      const sessions = new Map();
      await handleInteraction(i, { sessions, config: { botName: 'Gremlin', logTranscripts }, memory: {}, usage: null });
      const text = i.out.replies.at(-1);
      if (logTranscripts) assert.match(text, /Audio isn't recorded, but transcript logging is on, so what people say is saved as text in its log\./);
      else assert.match(text, /audio isn't recorded or saved\./);
      for (const s of sessions.values()) s.ended = true;
    }
  } finally {
    VoiceSession.prototype.start = realStart;
  }
});
