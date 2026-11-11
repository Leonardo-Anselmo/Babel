// Reminders and timers people ask for in voice: the answer carries a <reminder> tag
// (never spoken), which is set once that answer is heard, saved in memory.json, and
// said in the call when it's due (or posted in text when it isn't in a call with them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { Memory } from '../src/memory.js';
import { buildSystem, buildUserMessage, sayContent } from '../src/prompts.js';
import {
  LATE_OK_MS,
  MAX_REMINDERS,
  Reminders,
  formatIn,
  formatReminders,
  nextClockTime,
  parseClock,
  parseDuration,
  postReminder,
  reminderTags,
  withoutReminderTags,
} from '../src/reminders.js';
import { VoiceSession } from '../src/session.js';

const MIN = 60000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-reminders-'));

test('how long from now: minutes, hours, seconds, words, and a bare number of minutes', () => {
  assert.equal(parseDuration('10 minutes'), 10 * MIN);
  assert.equal(parseDuration('10 min'), 10 * MIN);
  assert.equal(parseDuration('10m'), 10 * MIN);
  assert.equal(parseDuration('10'), 10 * MIN);
  assert.equal(parseDuration('1h30m'), 90 * MIN);
  assert.equal(parseDuration('1 hour 30 minutes'), 90 * MIN);
  assert.equal(parseDuration('an hour and a half'), 90 * MIN);
  assert.equal(parseDuration('half an hour'), 30 * MIN);
  assert.equal(parseDuration('90 seconds'), 90000);
  assert.equal(parseDuration('five minutes'), 5 * MIN);
  assert.equal(parseDuration('1.5 hours'), 90 * MIN);
  for (const bad of ['', 'soon', 'later tonight', '0 minutes']) assert.equal(parseDuration(bad), null, bad);
});

test('a clock time is the next time the clock in the bot time zone shows it (daylight saving included)', () => {
  assert.deepEqual(parseClock('21:30'), { h: 21, m: 30 });
  assert.deepEqual(parseClock('9:30 pm'), { h: 21, m: 30 });
  assert.deepEqual(parseClock('9pm'), { h: 21, m: 0 });
  assert.deepEqual(parseClock('12 a.m.'), { h: 0, m: 0 });
  assert.deepEqual(parseClock('noon'), { h: 12, m: 0 });
  for (const bad of ['25:00', '9:75', '13pm', 'tonight']) assert.equal(parseClock(bad), null, bad);
  const tz = 'America/Los_Angeles';
  const now = Date.UTC(2026, 9, 26, 21, 16); // Mon Oct 26, 2:16 PM in Los Angeles
  assert.equal(new Date(nextClockTime({ h: 21, m: 30 }, tz, now)).toISOString(), '2026-10-27T04:30:00.000Z', 'tonight');
  assert.equal(new Date(nextClockTime({ h: 9, m: 0 }, tz, now)).toISOString(), '2026-10-27T16:00:00.000Z', 'tomorrow morning');
  // Clocks go back on Sunday Nov 1 at 2 AM: 9 AM that day is 8 hours behind UTC, not 7.
  const saturdayNight = Date.UTC(2026, 10, 1, 4, 0); // Sat Oct 31, 9 PM in Los Angeles
  assert.equal(new Date(nextClockTime({ h: 9, m: 0 }, tz, saturdayNight)).toISOString(), '2026-11-01T17:00:00.000Z');
  assert.equal(formatIn(30000), 'in under a minute');
  assert.equal(formatIn(12 * MIN), 'in 12 min');
  assert.equal(formatIn(65 * MIN), 'in 1 h 5 min');
});

test('the tags in an answer: set and cancel, and they are never said', () => {
  const reply =
    'Mike wants a timer. <say>Got it, ten minutes.</say> <reminder in="10 minutes" for="Mike">Mike, ten minutes are up. Time to queue.</reminder> <cancel_reminder id="#2"/> <cancel_reminder all="yes"></cancel_reminder>';
  assert.deepEqual(reminderTags(reply), {
    set: [{ in: '10 minutes', at: null, for: 'Mike', say: 'Mike, ten minutes are up. Time to queue.' }],
    cancel: [
      { id: 2, all: false },
      { id: null, all: true },
    ],
  });
  assert.equal(sayContent(reply), 'Got it, ten minutes.');
  // Written inside the words by mistake: still never said.
  assert.equal(sayContent('<say>Got it. <reminder at="21:30">Raid time.</reminder> See you then.</say>').replace(/\s+/g, ' '), 'Got it. See you then.');
  assert.equal(withoutReminderTags('Sure. <reminder in="5 minutes">Mike, ti').trim(), 'Sure.', 'one still being written');
  // Streamed a piece at a time, the words only ever grow (so nothing said is taken back).
  const full = '<say>Okay, five minutes. <reminder in="5 minutes" for="Jess">Jess, time.</reminder> Anything else?</say>';
  let prev = '';
  for (let i = 1; i <= full.length; i++) {
    const words = sayContent(full.slice(0, i)) ?? '';
    assert.ok(words.startsWith(prev), `at ${i}: "${prev}" then "${words}"`);
    assert.doesNotMatch(words, /Jess, time|<re/);
    prev = words;
  }
});

/** Fake timers: run(ms) moves time on and fires what's due. */
function fakeTimers(start = Date.UTC(2026, 9, 26, 21, 0)) {
  let now = start;
  const timers = new Set();
  return {
    clock: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms };
      timers.add(t);
      return t;
    },
    clearTimer: (t) => timers.delete(t),
    run(ms) {
      const end = now + ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= end && timers.has(t)) {
          now = Math.max(now, t.at); // each one fires on time
          timers.delete(t);
          t.fn();
        }
      }
      now = end;
    },
    get pending() {
      return timers.size;
    },
  };
}

test('reminders are saved, numbered, cancelled, and go off on time (and after a restart)', () => {
  const dir = tmp();
  const memory = new Memory(dir);
  const t = fakeTimers();
  const due = [];
  const r = new Reminders({ memory, timezone: 'America/Los_Angeles', onDue: (g, rem, o) => due.push([g, rem.say, o.late]), ...t });
  const a = r.add('g1', { in: '10 minutes', forName: 'Mike', userId: 'u1', channelId: 'c1', say: 'Mike, time to queue.' }).reminder;
  const b = r.add('g1', { at: '21:30', forName: null, say: 'Raid time, everyone.' }).reminder;
  const c = r.add('g1', { in: '30 minutes', say: 'Check the oven.' }).reminder;
  assert.deepEqual([a.id, b.id, c.id], [1, 2, 3]);
  assert.match(r.add('g1', { in: 'whenever', say: 'x' }).error, /couldn't tell when/);
  assert.match(r.add('g1', { in: '30 hours', say: 'x' }).error, /more than a day/);
  assert.equal(r.list('g1').length, 3);
  assert.match(formatReminders(r.list('g1'), 'America/Los_Angeles', t.clock()), /- #1 for Mike at 2:10 PM \(in 10 min\): "Mike, time to queue\."/);
  assert.match(formatReminders(r.list('g1'), 'America/Los_Angeles', t.clock()), /- #2 for everyone at 9:30 PM \(in 7 h 30 min\)/);
  // "Cancel that" (no number): the newest one. Then by number.
  assert.deepEqual(r.cancel('g1', {}).map((x) => x.id), [3]);
  assert.deepEqual(r.cancel('g1', { id: 7 }), []);
  t.run(10 * MIN);
  assert.deepEqual(due, [['g1', 'Mike, time to queue.', false]]);
  assert.deepEqual(r.list('g1').map((x) => x.id), [2], 'gone once it went off');
  memory.flush();

  // Restarted later: #2 is still saved and goes off when due.
  const t2 = fakeTimers(t.clock() + 60 * MIN);
  const due2 = [];
  const r2 = new Reminders({ memory: new Memory(dir), timezone: 'America/Los_Angeles', onDue: (g, rem, o) => due2.push([rem.id, o.late]), ...t2 });
  r2.start();
  t2.run(7 * 60 * MIN);
  assert.deepEqual(due2, [[2, false]]);
  for (let i = 0; i < MAX_REMINDERS; i++) r2.add('g1', { in: `${i + 1} minutes`, say: 'x' });
  assert.match(r2.add('g1', { in: '1 minute', say: 'x' }).error, /already set/);
  r2.stop();
});

test('after a restart, one that came due while it was off is said late, and one long past is dropped', () => {
  const memory = new Memory(tmp());
  const now = Date.UTC(2026, 9, 26, 21, 0);
  const at = (ms) => new Date(now + ms).toISOString();
  memory.setReminders('g1', [
    { key: 'a', id: 1, at: at(-10 * MIN), say: 'Ten minutes late.', setAt: at(-40 * MIN) },
    { key: 'b', id: 2, at: at(-LATE_OK_MS - MIN), say: 'Far too late.', setAt: at(-3 * 60 * MIN) },
  ]);
  const t = fakeTimers(now);
  const due = [];
  const r = new Reminders({ memory, timezone: 'UTC', onDue: (g, rem, o) => due.push([rem.say, o.late]), ...t });
  r.start();
  t.run(0);
  assert.deepEqual(due, [['Ten minutes late.', true]]);
  assert.deepEqual(memory.reminders('g1'), []);
});

test('posted in text when it is not in a call with them: mentions them, in the channel it was set from', async () => {
  const sent = [];
  const channel = { isTextBased: () => true, send: async (m) => sent.push(m) };
  const client = { guilds: { cache: new Map([['g1', { systemChannel: null }]]) }, channels: { fetch: async (id) => (id === 'c1' ? channel : null) } };
  await postReminder(client, 'g1', { id: 1, say: 'Mike, time to queue.', userId: 'u1', channelId: 'c1', at: '2026-10-27T04:30:00Z' }, { late: true, timezone: 'America/Los_Angeles' });
  assert.equal(sent[0].content, '<@u1> Reminder: Mike, time to queue. (It was due at 9:30 PM, while I was offline.)');
  assert.deepEqual(sent[0].allowedMentions, { users: ['u1'] });
  const none = { guilds: { cache: new Map() }, channels: { fetch: async () => null } };
  assert.equal(await postReminder(none, 'g1', { id: 2, say: 'x' }), false);
});

test('the prompt explains the tags (not in text-chat replies) and lists the ones set', () => {
  const on = buildSystem({ botName: 'Gremlin', persona: 'p', reminders: true })[0].text;
  assert.match(on, /<reminder in="10 minutes" for="Mike">/);
  assert.match(on, /never on your own/);
  assert.doesNotMatch(buildSystem({ botName: 'Gremlin', persona: 'p' })[0].text, /<reminders>/);
  const msg = buildUserMessage({ callInfo: 'x', transcript: 'y', task: 'z', reminders: '- #1 for Mike at 9:30 PM (in 12 min): "Mike, time."' });
  assert.match(msg, /<reminders_set note="reminders you set that have not gone off yet">\n- #1 for Mike/);
  assert.doesNotMatch(buildUserMessage({ callInfo: 'x', transcript: 'y', task: 'z' }), /reminders_set/);
});

// ---------------------------------------------------------------------------
// In the call
// ---------------------------------------------------------------------------

const config = {
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  timezone: 'UTC',
  defaultChattiness: 'medium',
  persona: 'x',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
  anthropic: { webSearch: { enabled: false } },
};

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function brainWith(reply, { start = true, stopReason = 'end_turn' } = {}) {
  const said = [];
  const set = [];
  const calls = [];
  const speaker = {
    speaking: false,
    lines: [],
    wasAudibleBetween: () => false,
    say(text, opts = {}) {
      said.push({ text, kind: opts.kind });
      const line = { opts };
      this.lines.push(line);
      if (start) opts.onStart?.();
      return new Promise((resolve) => (line.resolve = resolve));
    },
    stop() {},
    stopKind() {},
    dropOptional() {},
  };
  const brain = new Brain({
    config,
    claude: {
      createMessage: async (args) => {
        calls.push(args);
        return { text: reply, refusal: false, stopReason };
      },
    },
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike'], activities: [] }),
    getReminders: () => '- #1 for Mike at 9:30 PM (in 12 min): "Mike, time."',
    onReminders: (tags, info) => set.push({ tags, name: info.name }),
  });
  return { brain, said, set, calls, speaker };
}

test('an answer that agrees to a reminder sets it once it is heard, and the tag is never said', async () => {
  const s = brainWith('<say>Got it, ten minutes.</say><reminder in="10 minutes" for="Mike">Mike, time to queue.</reminder>');
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin remind me in ten minutes to queue' });
  await settle();
  assert.deepEqual(s.said, [{ text: 'Got it, ten minutes.', kind: 'direct' }]);
  assert.equal(s.set.length, 1);
  assert.deepEqual(s.set[0].tags.set, [{ in: '10 minutes', at: null, for: 'Mike', say: 'Mike, time to queue.' }]);
  assert.equal(s.set[0].name, 'Mike');
  assert.match(String(s.calls[0].user), /<reminders_set/, 'it sees the ones already set');
  assert.match(s.calls[0].system[0].text, /<reminders>/);

  // An answer nobody heard (it never started playing) sets nothing.
  const quiet = brainWith('<say>Sure.</say><reminder in="5 minutes">Time.</reminder>', { start: false });
  quiet.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin set a timer for five minutes' });
  await settle();
  quiet.speaker.lines[0].resolve('dropped');
  await settle();
  assert.deepEqual(quiet.set, []);
});

test('an answer that ran out of room in the middle of the reminder tag: it says what it can, and that the reminder is not set', async () => {
  const s = brainWith('<say>Sure, ten minutes.</say><reminder in="10 minutes" for="Mike">Mike, ten minutes are up, time to qu', { stopReason: 'max_tokens' });
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin remind me in ten minutes' });
  await settle();
  assert.deepEqual(s.said, [{ text: 'Sure, ten minutes.', kind: 'direct' }]);
  assert.equal(s.set.length, 1);
  assert.deepEqual(s.set[0].tags, { set: [], cancel: [], cutOff: true });
  assert.ok(s.calls[0].maxTokens >= 260, 'room for the tag');
});

test('a reminder that goes off is said in the call, waiting a bit for a pause; one nobody heard says so', async () => {
  const s = brainWith('<say>x</say>');
  const outcome = s.brain.sayReminder('Mike, time to queue.');
  s.speaker.lines[0].resolve('played');
  assert.deepEqual(await outcome, { outcome: 'played', heard: true });
  assert.deepEqual(s.said, [{ text: 'Mike, time to queue.', kind: 'reminder' }]);
  assert.ok(s.brain.transcript.lines.some((l) => l.isBot && l.text === 'Mike, time to queue.'));
  // Stopped before it started (someone said its name over it): not heard, so it gets posted instead.
  const quiet = brainWith('<say>x</say>', { start: false });
  const stopped = quiet.brain.sayReminder('Jess, the oven.');
  quiet.speaker.lines[0].resolve('stopped');
  assert.deepEqual(await stopped, { outcome: 'stopped', heard: false });
});

test('a <say> written inside a reminder tag is never said, nor a cancel tag with words in it', () => {
  assert.equal(sayContent('<say>Sure, ten minutes.</say><reminder in="10 minutes"><say>Mike, ten minutes are up.</say></reminder>'), 'Sure, ten minutes.');
  assert.equal(sayContent('<say>Done. <cancel_reminder id="2">cancel it</cancel_reminder></say>').trim(), 'Done.');
  assert.equal(sayContent('<say>Done. <cancel_reminder id="2">canc').trim(), 'Done.', 'one still being written');
  assert.deepEqual(reminderTags('<cancel_reminder id="2">cancel it</cancel_reminder>').cancel, [{ id: 2, all: false }]);
});

test('more ways of saying how long', () => {
  assert.equal(parseDuration('a quarter of an hour'), 15 * MIN);
  assert.equal(parseDuration('1h30'), 90 * MIN);
  assert.equal(parseDuration('2 hours 15'), 135 * MIN);
  assert.equal(parseDuration('one and a half hours'), 90 * MIN);
  assert.equal(parseDuration('twenty-five minutes'), 25 * MIN);
  assert.equal(parseDuration('forty five minutes'), 45 * MIN);
  assert.equal(parseDuration('fifty minutes'), 50 * MIN);
  assert.deepEqual(parseClock('21:30:00'), { h: 21, m: 30 });
});

test('memory.json that could not be read at start-up: its reminders are armed once it can be', () => {
  const dir = tmp();
  const memory = new Memory(dir);
  const t = fakeTimers(Date.UTC(2026, 9, 26, 21, 0));
  const due = [];
  const r = new Reminders({ memory, timezone: 'UTC', onDue: (g, rem) => due.push(`${rem.id}: ${rem.say}`), ...t });
  // As if the file was held by OneDrive at start-up: nothing loaded, nothing armed.
  memory.unreadable = 'EBUSY';
  r.start();
  r.add('g1', { in: '30 minutes', say: 'Set during this run.' });
  fs.writeFileSync(
    path.join(dir, 'memory.json'),
    JSON.stringify({ guilds: { g1: { reminders: [{ key: 'saved', id: 1, at: new Date(t.clock() + 5 * MIN).toISOString(), say: 'Mike, time to queue.', setAt: new Date(t.clock() - MIN).toISOString() }] } } }),
  );
  assert.equal(memory.retryRead(), true);
  assert.deepEqual(r.list('g1').map((x) => x.id).sort(), [1, 2], 'the one set meanwhile gets the next number');
  t.run(60 * MIN);
  assert.deepEqual(due, ['1: Mike, time to queue.', '2: Set during this run.']);
});

test('the session sets them for whoever asked, someone else in the call, or everyone, and says when it cannot', () => {
  const posted = [];
  const added = [];
  const members = [
    { id: 'u1', displayName: 'Mike', user: { bot: false, username: 'mike99' } },
    { id: 'u2', displayName: 'Jess', user: { bot: false, username: 'jess' } },
  ];
  const guild = {
    id: 'g1',
    name: 'Pressure',
    channels: { cache: new Map([['B', { id: 'B', name: 'Gaming', members: new Map(members.map((m) => [m.id, m])) }]]) },
    members: { cache: new Map() },
    voiceStates: { cache: new Map() },
  };
  const reminders = {
    add: (g, o) => {
      if (o.in === 'never') return { error: "couldn't tell when (\"never\")" };
      added.push(o);
      return { reminder: { id: added.length, at: new Date(Date.now() + 600000).toISOString() } };
    },
    cancel: () => [],
    list: () => [],
  };
  const s = new VoiceSession({
    client: { user: { id: 'bot' } },
    guild,
    voiceChannel: { id: 'B' },
    textChannel: { id: 'T', send: async (m) => posted.push(m.content) },
    config: { botName: 'Gremlin', botAliases: ['gremlin'], stt: { extraTerms: [] }, tts: { audioTags: false }, timezone: 'UTC' },
    memory: {},
    reminders,
  });
  // An answer covering two people names the latest asker: with no name in the tag, it's for him.
  assert.deepEqual(s.reminderFor(null, { name: 'Mike', userIds: ['u2', 'u1'] }), { forName: 'Mike', userId: 'u1' });
  assert.deepEqual(s.reminderFor('me', { name: 'Jess', userIds: ['u2'] }), { forName: 'Jess', userId: 'u2' });
  guild.members.cache.set('u3', { id: 'u3', displayName: 'Ana', user: { bot: false, username: 'ana' } });
  assert.deepEqual(s.reminderFor('Ana', { name: 'Mike', userIds: ['u1'] }), { forName: 'Ana', userId: 'u3' }, 'someone in the server who is not in the call');
  assert.deepEqual(s.reminderFor('Bob', { name: 'Mike', userIds: ['u1'] }), { forName: 'Bob', userId: null });
  // It ran out of room in the middle of writing one down: says so.
  s.applyReminders({ set: [], cancel: [], cutOff: true }, { name: 'Mike', userIds: ['u1'] });
  assert.match(posted.pop(), /ran out of room writing that reminder down/);
  const info = { name: 'Mike', userIds: ['u1'] };
  s.applyReminders(
    {
      set: [
        { in: '10 minutes', for: 'Mike', say: 'Mike, time to queue.' },
        { in: '5 minutes', for: 'jess', say: 'Jess, check the oven.' },
        { in: '1 hour', for: 'everyone', say: 'Raid time!' },
        { in: '2 minutes', for: null, say: '' },
        { in: 'never', for: 'Mike', say: 'x' },
      ],
    },
    info,
  );
  assert.deepEqual(
    added.map((o) => [o.forName, o.userId, o.channelId, o.say]),
    [
      ['Mike', 'u1', 'T', 'Mike, time to queue.'],
      ['Jess', 'u2', 'T', 'Jess, check the oven.'],
      [null, null, 'T', 'Raid time!'],
      ['Mike', 'u1', 'T', "Mike, here's the reminder you asked for."],
    ],
  );
  assert.deepEqual(posted, ['-# (I couldn\'t set that reminder: couldn\'t tell when ("never").)']);
});
