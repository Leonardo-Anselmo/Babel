// Call memory: notes kept during a call, the summary saved at the end, reading and
// forgetting them (in the bot and in the app), and how they reach the prompts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forgetCallsInFile, readCalls, readLandedJokes } from '../desktop/lib/app-data.mjs';
import { linkToApp } from '../src/app-link.js';
import { Brain } from '../src/brain.js';
import { CallNotes, cleanNotes, MAX_NOTE_CHARS, MAX_SUMMARY_CHARS, MIN_LINES_TO_REMEMBER, NOTE_EVERY_LINES, notesFrom } from '../src/callnotes.js';
import { MAX_CALLS, Memory } from '../src/memory.js';
import { buildSystem, buildUserMessage, formatEarlierCalls } from '../src/prompts.js';
import { VoiceSession } from '../src/session.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-calls-'));
const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function notesSetup({ replies = [] } = {}) {
  let now = 3_000_000;
  const calls = [];
  const queue = [...replies];
  const claude = {
    async createMessage(args) {
      calls.push(args);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next && typeof next === 'object') return { refusal: false, ...next };
      return { text: next ?? 'Notes.', refusal: false };
    },
  };
  const notes = new CallNotes({ claude, botName: 'Gremlin', timezone: 'UTC', clock: () => now, checkEveryMs: 20 });
  const lines = [];
  const say = (name, text, isBot = false, extra = {}) => {
    now += 1000;
    const line = { name, text, isBot, at: now, ...extra };
    lines.push(line);
    notes.add(line);
    return line;
  };
  return { notes, calls, lines, say, advance: (ms) => (now += ms) };
}

test('call notes: brought up to date every so many lines, each time with only the new ones', async () => {
  const t = notesSetup({ replies: ['They played Zomboid; Mike died to a door.', 'Mike died to a door, then Jess built a base.'] });
  for (let i = 1; i < NOTE_EVERY_LINES; i++) t.say('Mike', `line ${i}`);
  assert.equal(t.calls.length, 0);
  t.say('Gremlin', 'Classic.', true);
  t.say('Jess', `line ${NOTE_EVERY_LINES}`);
  await settle();
  assert.equal(t.calls.length, 1);
  assert.match(t.calls[0].user, /<notes_so_far>\n\(none yet\)/);
  assert.match(t.calls[0].user, /Gremlin \(you\): Classic\./);
  assert.equal(t.calls[0].important, false, 'never at the cost of a reply to someone');
  assert.equal(t.notes.text, 'They played Zomboid; Mike died to a door.');
  for (let i = 0; i < NOTE_EVERY_LINES; i++) t.say('Jess', `newer ${i}`);
  await settle();
  assert.equal(t.calls.length, 2);
  assert.match(t.calls[1].user, /They played Zomboid; Mike died to a door\./, 'the notes so far go along');
  assert.doesNotMatch(t.calls[1].user, /line 1\b/, 'lines already in the notes are not sent again');
  assert.equal(t.notes.text, 'Mike died to a door, then Jess built a base.');
  t.notes.close();
});

test('call notes: nothing is missed when the bot answers every line (the transcript window holds only 40)', async () => {
  const t = notesSetup();
  for (let i = 0; i < 30; i++) {
    t.say('Mike', `question ${i}`);
    t.say('Gremlin', `answer ${i}`, true);
  }
  await settle();
  assert.equal(t.calls.length, 1);
  for (let i = 0; i < NOTE_EVERY_LINES; i++) assert.match(t.calls[0].user, new RegExp(`Mike: question ${i}\\n`), `question ${i}`);
  t.notes.close();
});

test('call notes: a few lines and then a long quiet stretch are folded in without anyone talking', async () => {
  const t = notesSetup();
  for (let i = 0; i < 5; i++) t.say('Mike', `hi ${i}`);
  await settle();
  assert.equal(t.calls.length, 0);
  t.advance(11 * 60000);
  await new Promise((r) => setTimeout(r, 60)); // the minute check (shortened here)
  assert.equal(t.calls.length, 1);
  t.notes.close();
});

test('call notes: if an update fails, those lines are tried again with the next ones, a couple of minutes later', async () => {
  const t = notesSetup({ replies: [new Error('overloaded'), 'All of it.'] });
  for (let i = 0; i < NOTE_EVERY_LINES; i++) t.say('Mike', `line ${i}`);
  await settle();
  assert.equal(t.notes.text, '');
  t.say('Mike', 'one more');
  await settle();
  assert.equal(t.calls.length, 1, 'not again on every new line');
  t.advance(2 * 60000);
  t.say('Mike', 'and another');
  await settle();
  assert.equal(t.calls.length, 2);
  assert.match(t.calls[1].user, /line 0/);
  assert.match(t.calls[1].user, /one more/);
  assert.equal(t.notes.text, 'All of it.');
  t.notes.close();
});

test('call notes: lines it never got to say are left out', async () => {
  const t = notesSetup();
  const unsaid = t.say('Gremlin', 'A joke nobody heard.', true);
  unsaid.dropped = true;
  for (let i = 0; i < NOTE_EVERY_LINES; i++) t.say('Mike', `line ${i}`);
  await settle();
  assert.doesNotMatch(t.calls[0].user, /nobody heard/);
  t.notes.close();
});

test('call notes: at the end, a short summary; a call with too little in it is not kept', async () => {
  const short = notesSetup();
  for (let i = 1; i < MIN_LINES_TO_REMEMBER; i++) short.say('Mike', `hi ${i}`);
  assert.equal(await short.notes.finish(), '');
  assert.equal(short.calls.length, 0);

  const t = notesSetup({ replies: ['Played three rounds of Zomboid. Mike swore revenge on doors.'] });
  for (let i = 0; i < MIN_LINES_TO_REMEMBER; i++) t.say('Mike', `round ${i}`);
  assert.equal(await t.notes.finish(), 'Played three rounds of Zomboid. Mike swore revenge on doors.');
  assert.match(t.calls[0].user, /The call just ended/);
  assert.match(t.calls[0].user, /Leave out sensitive personal details/);
  t.say('Mike', 'after the end');
  await settle();
  assert.equal(t.calls.length, 1, 'nothing more after the call ended');
});

test('call notes: someone opting out takes their lines out, and the notes (which may hold them) start over', async () => {
  const t = notesSetup({ replies: ['Mike told everyone about his day.', 'Jess played alone.'] });
  for (let i = 0; i < NOTE_EVERY_LINES; i++) t.say('Mike', `private ${i}`, false, { userId: 'u1' });
  await settle();
  assert.equal(t.notes.text, 'Mike told everyone about his day.');
  t.say('Mike', 'one more thing', false, { userId: 'u1' });
  t.notes.forgetSpeaker('u1');
  assert.equal(t.notes.text, '');
  for (let i = 0; i < NOTE_EVERY_LINES; i++) t.say('Jess', `game ${i}`, false, { userId: 'u2' });
  await settle();
  assert.doesNotMatch(t.calls[1].user, /private \d|one more thing|Mike told/);
  t.notes.clear();
  assert.equal(t.notes.text, '');
  assert.equal(t.notes.worthKeeping, false, '/forgetcalls: this call so far is forgotten too');
  t.notes.close();
});

test('call notes: plain sentences only', () => {
  assert.equal(cleanNotes('Notes: **Mike** died.\n- Jess won.'), 'Mike died. Jess won.');
  assert.equal(cleanNotes('"They played chess."'), 'They played chess.');
  assert.equal(cleanNotes('[PASS]'), '');
  assert.equal(cleanNotes('<notes>Mike died.</notes>'), 'Mike died.');
  // Too long anyway: it ends at the last whole sentence that fits, not mid-word.
  const long = Array.from({ length: 40 }, (_, i) => `Round ${i} went to Mike.`).join(' ');
  const cut = cleanNotes(long, { maxChars: 200 });
  assert.ok(cut.length <= 200 && cut.endsWith('to Mike.'), cut);
  assert.equal(cleanNotes(long).length, long.length, 'running notes have room for more than the 150 words asked for');
  assert.ok(MAX_SUMMARY_CHARS < MAX_NOTE_CHARS);
});

test('call notes: only what is inside <notes> counts, and notes cut off by the length limit never do', () => {
  assert.equal(notesFrom('Okay, updating the notes.\n<notes>Mike died to a door.</notes>', 'end_turn'), 'Mike died to a door.', 'thinking before the tags is left out');
  assert.equal(notesFrom('<notes>Mike died.</notes> That covers it.', 'end_turn'), 'Mike died.');
  assert.equal(notesFrom('<notes>Mike died.</notes> And more thinking that ran on', 'max_tokens'), 'Mike died.', 'finished before the limit');
  assert.equal(notesFrom('Mike died to a door.', 'end_turn'), 'Mike died to a door.', 'no tags: all of it');
  assert.equal(notesFrom('<notes>Mike died to a door, then Jess', 'max_tokens'), null, 'cut off: its newest part is missing');
  assert.equal(notesFrom('Let me think about who was there and what they', 'max_tokens'), null);
  assert.equal(notesFrom('<notes>Mike died.', 'end_turn'), 'Mike died.', 'it just forgot the closing tag');
});

test('call notes: notes cut off by the length limit are asked for again, shorter, and never saved cut off', async () => {
  const t = notesSetup({
    replies: [
      { text: 'Updating.\n<notes>Mike died to a door. Then Jess built a ba', stopReason: 'max_tokens' },
      { text: '<notes>Mike died to a door; Jess built a base.</notes>', stopReason: 'end_turn' },
    ],
  });
  for (let i = 0; i < NOTE_EVERY_LINES; i++) t.say('Mike', `line ${i}`);
  await settle(8);
  assert.equal(t.calls.length, 2);
  assert.match(t.calls[0].user, /inside <notes><\/notes>/);
  assert.match(t.calls[1].user, /was cut off/);
  assert.equal(t.notes.text, 'Mike died to a door; Jess built a base.');
  t.notes.close();

  // Cut off twice: the notes stay as they were and those lines go into the next update.
  const u = notesSetup({
    replies: [
      '<notes>Mike died.</notes>',
      { text: '<notes>Mike died. Jess', stopReason: 'max_tokens' },
      { text: '<notes>Mike died. Jess', stopReason: 'max_tokens' },
      '<notes>Mike died. Jess built a base.</notes>',
    ],
  });
  for (let i = 0; i < NOTE_EVERY_LINES; i++) u.say('Mike', `line ${i}`);
  await settle(8);
  assert.equal(u.notes.text, 'Mike died.');
  for (let i = 0; i < NOTE_EVERY_LINES; i++) u.say('Jess', `base ${i}`);
  await settle(8);
  assert.equal(u.calls.length, 3);
  assert.equal(u.notes.text, 'Mike died.', 'not the cut-off version');
  u.advance(2 * 60000);
  u.say('Jess', 'done');
  await settle(8);
  assert.equal(u.calls.length, 4);
  assert.match(u.calls[3].user, /base 0/, 'the lines from the failed update come along');
  assert.equal(u.notes.text, 'Mike died. Jess built a base.');
  u.notes.close();
});

test('call notes: at the end, long notes are saved whole sentences only', async () => {
  const long = Array.from({ length: 60 }, (_, i) => `Round ${i} went to Mike.`).join(' ');
  const t = notesSetup({ replies: [long, new Error('down'), new Error('down')] });
  for (let i = 0; i < NOTE_EVERY_LINES; i++) t.say('Mike', `line ${i}`);
  await settle();
  // (Notes that run past the limit lose their older middle: the first sentence and the newest stay.)
  const words = (x) => x.split(' ').length;
  assert.ok(words(t.notes.text) <= 220 && t.notes.text.startsWith('Round 0 went') && t.notes.text.endsWith('Round 59 went to Mike.'), t.notes.text);
  assert.ok(t.notes.savable.length <= MAX_SUMMARY_CHARS && words(t.notes.savable) <= 140 && t.notes.savable.endsWith('Round 59 went to Mike.'));
  t.say('Mike', 'bye');
  const summary = await t.notes.finish();
  assert.equal(summary, t.notes.savable, "if the summary can't be written, the notes so far, trimmed the same way");
});

test('memory: saved calls are kept (newest ten), updated, forgotten, and still there after a restart', () => {
  const dir = tmp();
  const m = new Memory(dir);
  assert.equal(m.addCall('g1', { summary: '   ' }), null, 'nothing to save');
  const ids = [];
  for (let i = 0; i < MAX_CALLS + 2; i++) {
    ids.push(m.addCall('g1', { at: `2026-10-${10 + i}T20:00:00Z`, minutes: 61.4, server: 'Pressure', channel: 'Gaming', people: ['Mike', 'Mike', 'Jess'], summary: `call ${i}` }));
  }
  const calls = m.calls('g1');
  assert.equal(calls.length, MAX_CALLS);
  assert.equal(calls[0].summary, 'call 2', 'the oldest two made room');
  assert.deepEqual(calls[0].people, ['Mike', 'Jess']);
  assert.equal(calls[0].minutes, 61);
  assert.equal(m.updateCall('g1', ids.at(-1), 'the final summary'), true);
  assert.equal(m.updateCall('g1', ids[0], 'gone already'), false);
  assert.equal(m.forgetCall('g1', ids.at(-2)).summary, `call ${MAX_CALLS}`);
  assert.equal(m.forgetCall('g1', 'nope'), null);
  m.flush();
  const again = new Memory(dir);
  assert.equal(again.calls('g1').length, MAX_CALLS - 1);
  assert.equal(again.calls('g1').at(-1).summary, 'the final summary');
  assert.equal(again.forgetCalls('g1'), MAX_CALLS - 1);
  assert.deepEqual(again.calls('g1'), []);
  assert.deepEqual(again.calls('nowhere'), []);
});

test('earlier calls in the prompt: newest few, oldest first, with when, how long and who', () => {
  const calls = [
    { at: '2026-10-21T03:30:00Z', minutes: 125, people: ['Mike', 'Jess'], summary: 'Played Zomboid.' },
    { at: '2026-10-22T19:05:00Z', minutes: 12, people: ['Mike'], summary: 'Talked  about\nthe patch.' },
    { at: '2026-10-23T19:05:00Z', minutes: 0, people: [], summary: '' },
  ];
  const text = formatEarlierCalls(calls, 'America/Los_Angeles');
  assert.equal(text, '- Tue Oct 20, evening, about 2 h, with Mike and Jess: Played Zomboid.\n- Thu Oct 22, afternoon, 12 min, with Mike: Talked about the patch.');
  assert.equal(formatEarlierCalls(calls, 'UTC', { max: 1 }).split('\n').length, 1);
  const system = buildSystem({ botName: 'Gremlin', persona: 'Be fun.', earlierCalls: text })[0].text;
  assert.match(system, /<earlier_calls note="your own short notes from earlier calls[^>]*>\n- Tue Oct 20/);
  assert.doesNotMatch(buildSystem({ botName: 'Gremlin', persona: 'Be fun.' })[0].text, /earlier_calls/);
  const user = buildUserMessage({ callInfo: 'x', transcript: 'y', task: 'z', earlierThisCall: 'Mike lost his boots.' });
  assert.match(user, /<earlier_in_this_call[^>]*>\nMike lost his boots\.\n<\/earlier_in_this_call>\n\n<recent_transcript>/);
  assert.doesNotMatch(buildUserMessage({ callInfo: 'x', transcript: 'y', task: 'z' }), /earlier_in_this_call/);
});

test('the brain: every line counts toward the notes, and both kinds of memory reach the prompt', async () => {
  let added = 0;
  const prompts = [];
  const brain = new Brain({
    config: {
      botName: 'Gremlin',
      botAliases: ['gremlin'],
      timezone: 'UTC',
      defaultChattiness: 'off',
      persona: 'You are Gremlin.',
      lore: '',
      tts: { audioTags: false },
      transcript: { maxLines: 40, maxMinutes: 15 },
    },
    claude: {
      async createMessage(args) {
        prompts.push(args);
        return { text: 'Yep, same as last week.', refusal: false };
      },
    },
    speaker: { say: async () => 'played', stop() {}, wasAudibleBetween: () => false },
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike'], activities: [] }),
    callNotes: { add: (line) => (line.isBot ? null : added++), text: 'Mike has been losing all night.' },
    getEarlierCalls: () => '- Wed Oct 21, evening: Mike swore revenge on doors.',
  });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin am I still bad at this' });
  await settle();
  assert.equal(added, 1);
  assert.match(prompts[0].system[0].text, /Mike swore revenge on doors/);
  assert.match(prompts[0].user, /Mike has been losing all night\./);
});

function sessionWithNotes(notes, memory) {
  const guild = {
    id: 'g1',
    name: 'Pressure',
    channels: { cache: new Map([['B', { id: 'B', name: 'Gaming', members: new Map() }]]) },
    voiceStates: { cache: new Map() },
    members: { cache: new Map(), fetch: async () => ({}) },
  };
  const s = new VoiceSession({
    client: { user: { id: 'bot' } },
    guild,
    voiceChannel: { id: 'B' },
    textChannel: null,
    config: { botName: 'Gremlin', botAliases: ['gremlin'], stt: { extraTerms: [] }, autoLeaveSeconds: 60, callMemory: true },
    memory,
  });
  s.callNotes = notes;
  s.joinedAt = Date.now() - 45 * 60000;
  s.peopleHeard = new Set(['Mike', 'Jess']);
  return s;
}

test('end of a call: the notes so far are saved at once, then replaced by the final summary', async () => {
  const dir = tmp();
  const memory = new Memory(dir);
  let finish;
  const notes = { worthKeeping: true, text: 'Notes so far.', finish: () => new Promise((r) => (finish = r)) };
  const s = sessionWithNotes(notes, memory);
  s.saveCallNotes();
  const [saved] = memory.calls('g1');
  assert.equal(saved.summary, 'Notes so far.', 'saved right away, in case the bot is stopped now');
  assert.equal(saved.server, 'Pressure');
  assert.equal(saved.channel, 'Gaming');
  assert.deepEqual(saved.people, ['Mike', 'Jess']);
  assert.ok(saved.minutes >= 44 && saved.minutes <= 46);
  finish('The final summary.');
  await settle();
  assert.equal(memory.calls('g1').length, 1);
  assert.equal(memory.calls('g1')[0].summary, 'The final summary.');
});

test('end of a call: with no notes yet, only the final summary is saved; nothing for a call not worth keeping', async () => {
  const memory = new Memory(tmp());
  sessionWithNotes({ worthKeeping: true, text: '', finish: async () => 'Short call about pizza.', close() {} }, memory).saveCallNotes();
  await settle();
  assert.deepEqual(memory.calls('g1').map((c) => c.summary), ['Short call about pizza.']);
  const other = new Memory(tmp());
  let closed = false;
  sessionWithNotes({ worthKeeping: false, text: 'x', finish: async () => 'y', close: () => (closed = true) }, other).saveCallNotes();
  await settle();
  assert.deepEqual(other.calls('g1'), []);
  assert.equal(closed, true, 'its timer is stopped');
});

test('end of a call: a call of a couple of minutes (a restart, say) is not saved', async () => {
  const memory = new Memory(tmp());
  let closed = false;
  const s = sessionWithNotes({ worthKeeping: true, text: 'Notes so far.', finish: async () => 'A short one.', close: () => (closed = true) }, memory);
  s.joinedAt = Date.now() - 2 * 60000;
  s.saveCallNotes();
  await settle();
  assert.deepEqual(memory.calls('g1'), []);
  assert.equal(closed, true);
});

// ---------------------------------------------------------------------------
// The desktop app: reading and forgetting them, and the screen picture link
// ---------------------------------------------------------------------------

function appLink(memory) {
  const sent = [];
  const proc = Object.assign(new EventEmitter(), { send: (m) => sent.push(m) });
  const client = { isReady: () => true, user: { tag: 'Babel#2921' }, guilds: { cache: new Map([['g1', { id: 'g1', name: 'Pressure' }]]) } };
  const link = linkToApp({ proc, client, sessions: new Map(), memory, defaultChattiness: 'low', levels: ['off', 'low'], hearing: () => ({}), shutdown() {} });
  return { link, proc, sent };
}

test('app link: forgetting a call (or all of them) from the app happens in the bot, which says how many', () => {
  const memory = new Memory(tmp());
  const a = memory.addCall('g1', { summary: 'one' });
  memory.addCall('g1', { summary: 'two' });
  memory.addCall('g2', { summary: 'three' });
  memory.addLandedJoke('g2', 'That door had it coming.');
  const { link, proc, sent } = appLink(memory);
  proc.emit('message', { type: 'forget-call', guildId: 'g1', id: a, requestId: 7 });
  assert.deepEqual(sent.at(-1), { type: 'forgot-calls', requestId: 7, count: 1, jokes: 0 });
  assert.deepEqual(memory.calls('g1').map((c) => c.summary), ['two']);
  assert.equal(memory.landedJokes('g2').length, 1, 'forgetting one call keeps the jokes');
  proc.emit('message', { type: 'forget-call', requestId: 8 });
  assert.deepEqual(sent.at(-1), { type: 'forgot-calls', requestId: 8, count: 2, jokes: 1 });
  assert.deepEqual([...memory.calls('g1'), ...memory.calls('g2')], []);
  assert.deepEqual(memory.landedJokes('g2'), [], 'forget all: the kept jokes go too');
  link.stop();
});

test('app link: a picture of the screen comes back from the app, or a reason it could not', async () => {
  const { link, proc, sent } = appLink(new Memory(tmp()));
  const asked = link.requestScreenshot();
  const req = sent.find((m) => m.type === 'screenshot-request');
  assert.ok(req);
  proc.emit('message', { type: 'screenshot', id: req.id, jpeg: 'QUJD' });
  assert.deepEqual(await asked, { jpeg: 'QUJD' });
  const failed = link.requestScreenshot();
  proc.emit('message', { type: 'screenshot', id: sent.at(-1).id, error: 'no screen' });
  assert.deepEqual(await failed, { error: 'no screen' });
  assert.deepEqual(await link.requestScreenshot({ timeoutMs: 20 }), { error: "the app didn't send the screen in time" });
  link.stop();
});

test('app: reads the saved calls newest first, and forgets them in the file while the bot is off', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'data'));
  const file = path.join(dir, 'data', 'memory.json');
  assert.deepEqual(readCalls(dir), [], 'no file yet');
  const data = {
    guilds: {
      g1: { facts: [{ text: 'keep me' }], calls: [{ id: 'a', at: '2026-10-20T01:00:00Z', summary: 'old', people: ['Mike'] }, { id: 'b', at: '2026-10-22T01:00:00Z', summary: 'new' }] },
      g2: { calls: [{ id: 'c', at: '2026-10-21T01:00:00Z', summary: 'mid', minutes: 30 }] },
    },
  };
  fs.writeFileSync(file, `﻿${JSON.stringify(data)}`);
  const calls = readCalls(dir);
  assert.deepEqual(calls.map((c) => c.id), ['b', 'c', 'a']);
  assert.deepEqual(calls[2], { guildId: 'g1', id: 'a', at: '2026-10-20T01:00:00Z', minutes: 0, server: '', channel: '', people: ['Mike'], summary: 'old' });
  const one = forgetCallsInFile(fs.readFileSync(file, 'utf8'), { guildId: 'g1', id: 'a' });
  assert.equal(one.count, 1);
  const after = JSON.parse(one.text);
  assert.deepEqual(after.guilds.g1.calls.map((c) => c.id), ['b']);
  assert.deepEqual(after.guilds.g1.facts, [{ text: 'keep me' }], 'everything else is left alone');
  assert.equal(forgetCallsInFile(one.text, {}).count, 2);
  // The jokes he kept: listed newest first, and cleared by forget all (not by forgetting one call).
  data.guilds.g2.landed = [
    { text: 'Old one.', at: '2026-10-19T01:00:00Z' },
    { text: 'New one.', at: '2026-10-23T01:00:00Z', usedAt: null },
  ];
  fs.writeFileSync(file, JSON.stringify(data));
  assert.deepEqual(readLandedJokes(dir).map((j) => j.text), ['New one.', 'Old one.']);
  assert.equal(forgetCallsInFile(fs.readFileSync(file, 'utf8'), { guildId: 'g1', id: 'a' }).jokes, 0);
  const all = forgetCallsInFile(fs.readFileSync(file, 'utf8'), {});
  assert.deepEqual([all.count, all.jokes], [3, 2]);
  assert.deepEqual(JSON.parse(all.text).guilds.g2.landed, []);
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => readCalls(dir), /couldn't be read/);
});

test('call notes: an update being written when someone opts out (or /forgetcalls) is thrown away', async () => {
  let release;
  const calls = [];
  const claude = {
    createMessage: (args) => {
      calls.push(args);
      return new Promise((r) => (release = () => r({ text: 'Mike talked about something private.', refusal: false })));
    },
  };
  const notes = new CallNotes({ claude, botName: 'Gremlin', timezone: 'UTC', checkEveryMs: 1000 });
  let at = 1;
  for (let i = 0; i < NOTE_EVERY_LINES - 1; i++) notes.add({ name: 'Mike', text: `private ${i}`, isBot: false, at: at++, userId: 'u1' });
  notes.add({ name: 'Gremlin', text: 'Sorry to hear that, Mike.', isBot: true, at: at++, info: { userIds: ['u1'] } });
  notes.add({ name: 'Jess', text: 'anyway', isBot: false, at: at++, userId: 'u2' });
  await settle();
  assert.equal(calls.length, 1, 'an update is being written');
  notes.forgetSpeaker('u1');
  release();
  await settle();
  assert.equal(notes.text, '', 'what came back may hold what he said: dropped');
  assert.deepEqual(notes.waiting.map((l) => l.text), ['anyway'], 'only lines that are not his (or answers to him) wait for the next update');
  notes.clear();
  assert.deepEqual(notes.waiting, []);
  notes.close();
});

test('memory: a summary that comes back after /forgetcalls is not saved', async () => {
  const memory = new Memory(tmp());
  let finish;
  const s = sessionWithNotes({ worthKeeping: true, text: '', finish: () => new Promise((r) => (finish = r)), close() {} }, memory);
  s.saveCallNotes();
  memory.forgetCalls('g1');
  finish('A summary nobody wants any more.');
  await settle();
  assert.deepEqual(memory.calls('g1'), []);
});
