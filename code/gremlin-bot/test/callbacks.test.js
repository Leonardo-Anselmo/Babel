// Callbacks: its jokes that got a laugh are kept (per server), and a few from earlier
// calls are offered when it thinks about chiming in, to call back to when something
// sets one up. One it used rests a week; /forgetcalls (or Forget all) clears them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { CALLBACK_REST_MS, MAX_LANDED, callbacksToOffer, callsBackTo, mentionsAny } from '../src/jokes.js';
import { Memory } from '../src/memory.js';
import { TASKS } from '../src/prompts.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-callbacks-'));
const DAY = 86400000;

test('a new joke calls back to an old one when they share a phrase or two of their longer words', () => {
  const old = "Mike's still losing fights to doors.";
  assert.equal(callsBackTo('Careful Mike, that door looks like it wants a rematch... losing fights to doors again?', old), true, 'a phrase');
  assert.equal(callsBackTo('Somewhere a door is still celebrating its win over Mike, losing count of fights.', old), true, 'two longer words: losing, fights');
  assert.equal(callsBackTo('Nice shot, Jess.', old), false);
  assert.equal(callsBackTo('That was really something, everyone.', 'Really something else, everyone.'), false, 'common long words only');
});

test('which kept jokes are offered: from earlier calls, not used this week, none naming someone who opted out', () => {
  const now = Date.UTC(2026, 9, 26, 20);
  const joinedAt = now - 3600000;
  const at = (ms) => new Date(ms).toISOString();
  const landed = [
    { text: 'Oldest one.', at: at(now - 30 * DAY) },
    { text: 'Used two days ago.', at: at(now - 10 * DAY), usedAt: at(now - 2 * DAY) },
    { text: 'Used last month.', at: at(now - 20 * DAY), usedAt: at(now - 9 * DAY) },
    { text: 'Jess fell off the map again.', at: at(now - 5 * DAY) },
    { text: 'Newest from before.', at: at(now - DAY) },
    { text: 'From this call.', at: at(now - 60000) },
  ];
  assert.deepEqual(callbacksToOffer(landed, { since: joinedAt, now }), ['Newest from before.', 'Jess fell off the map again.', 'Used last month.']);
  assert.deepEqual(callbacksToOffer(landed, { since: joinedAt, now, avoidNames: ['Jess'], max: 2 }), ['Newest from before.', 'Used last month.']);
  assert.ok(CALLBACK_REST_MS >= 7 * DAY);
  assert.equal(mentionsAny('That was really Al', ['Al']), true);
  assert.equal(mentionsAny('That was really funny', ['Al']), false, 'a name inside another word is not the name');
  assert.equal(mentionsAny('Big Mike strikes again', ['big mike']), true);
});

test('memory keeps the newest dozen, marks one used, and /forgetcalls clears them', () => {
  const dir = tmp();
  const m = new Memory(dir);
  for (let i = 0; i < MAX_LANDED + 3; i++) m.addLandedJoke('g1', `Joke number ${i}.`);
  m.addLandedJoke('g1', 'Joke number 3.'); // kept again: moves to the newest, not twice
  assert.equal(m.landedJokes('g1').length, MAX_LANDED);
  assert.equal(m.landedJokes('g1').at(-1).text, 'Joke number 3.');
  assert.equal(m.landedJokes('g1').filter((j) => j.text === 'Joke number 3.').length, 1);
  assert.equal(m.addLandedJoke('g1', '   '), false);
  assert.equal(m.markJokeUsed('g1', 'Joke number 14.'), true);
  assert.ok(m.landedJokes('g1').find((j) => j.text === 'Joke number 14.').usedAt);
  m.flush();
  assert.equal(new Memory(dir).landedJokes('g1').length, MAX_LANDED, 'saved');
  m.forgetCalls('g1');
  assert.deepEqual(m.landedJokes('g1'), []);
});

test('someone who opts out: kept jokes naming them go, by any of their names (decorated ones too), and their names are kept with the opt-out', () => {
  const m = new Memory(tmp());
  m.addLandedJoke('g1', 'Jess fell off the map again.');
  m.addLandedJoke('g1', "That's Jess's third death to lava.");
  m.addLandedJoke('g1', 'Mike carries like a grocery bag.');
  m.setOptOut('g1', 'u2', true, { names: ['Jess (she/her)', 'jessplays'] });
  assert.deepEqual(m.landedJokes('g1').map((j) => j.text), ['Mike carries like a grocery bag.']);
  assert.deepEqual(m.optOutNames('g1'), ['Jess (she/her)', 'jessplays']);
  // Later, when Discord doesn't say who she is: her name still keeps a new joke about her out.
  assert.equal(mentionsAny('Jess built a base in lava.', m.optOutNames('g1')), true);
  assert.equal(mentionsAny('Mike carries again.', ['[TTV] Mike']), true, 'a tag in front of the name');
  assert.equal(mentionsAny('She said her piece.', ['Jess (she/her)']), false, 'pronouns are not the name');
  m.setOptOut('g1', 'u2', false);
  assert.deepEqual(m.optOutNames('g1'), []);
});

test('a joke told again word for word that gets a laugh still rests from its last use', () => {
  const m = new Memory(tmp());
  m.addLandedJoke('g1', 'Mike lost to a door.');
  m.markJokeUsed('g1', 'Mike lost to a door.');
  const used = m.landedJokes('g1')[0].usedAt;
  m.addLandedJoke('g1', 'Mike lost to a door.');
  assert.equal(m.landedJokes('g1')[0].usedAt, used);
});

test('the joke task shows a few kept jokes, as callbacks only when the call sets one up', () => {
  const task = TASKS.quip({ callbacks: ['Mike lost to a door.', 'Jess built a base in lava.'] });
  assert.match(task, /got a laugh from this group in earlier calls: "Mike lost to a door\."; "Jess built a base in lava\."/);
  assert.match(task, /only when something in the last few lines sets it up\. Never repeat one word for word/);
  assert.doesNotMatch(TASKS.quip(), /earlier calls/);
});

// ---------------------------------------------------------------------------
// In the call
// ---------------------------------------------------------------------------

const baseConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  timezone: 'UTC',
  defaultChattiness: 'medium',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
  anthropic: { webSearch: { enabled: false } },
};

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function manualSpeaker() {
  const lines = [];
  return {
    lines,
    speaking: false,
    wasAudibleBetween: () => false,
    say(text, opts = {}) {
      const line = { text, kind: opts.kind, opts, outcome: null };
      lines.push(line);
      return new Promise((resolve) => {
        line.resolve = (o) => {
          if (!line.outcome) {
            line.outcome = o;
            resolve(o);
          }
        };
      });
    },
    start(i) {
      lines[i].started = true;
      lines[i].opts.onStart?.();
    },
    finish(i, outcome = 'played') {
      lines[i].resolve(outcome);
    },
    stop() {},
    stopKind() {},
    dropOptional() {},
  };
}

function setup({ joke = 'Mike, that door is still undefeated.', config = {}, callbacks = [] } = {}) {
  let now = 50_000_000;
  const calls = [];
  const kept = [];
  const used = [];
  const speaker = manualSpeaker();
  const brain = new Brain({
    config: { ...baseConfig, ...config },
    claude: {
      async createMessage(args) {
        calls.push(args);
        return { text: `<say>${joke}</say>`, refusal: false };
      },
    },
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
    clock: () => now,
    jokes: { told: 10 },
    getCallbacks: () => callbacks,
    onJokeLanded: (text) => kept.push(text),
    onCallbackUsed: (text) => used.push(text),
  });
  return { brain, calls, speaker, kept, used, advance: (ms) => (now += ms), now: () => now };
}

/** It tells a joke; it plays (or is cut off), and Mike laughs. */
async function jokeThenLaugh(s, { outcome = 'played' } = {}) {
  s.brain.request('quip', {});
  await settle();
  const i = s.speaker.lines.findIndex((l) => l.kind === 'quip');
  s.advance(100);
  s.speaker.start(i);
  s.advance(1500);
  s.speaker.finish(i, outcome);
  await settle();
  s.advance(800);
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'hahaha', startedAt: s.now() - 600, spokeUntil: s.now() - 100 });
  s.brain.finishJoke();
}

test('a joke that got a laugh is kept; one cut off is not; the setting turns it off', async () => {
  const s = setup();
  await jokeThenLaugh(s);
  assert.deepEqual(s.kept, ['Mike, that door is still undefeated.']);

  const cut = setup();
  await jokeThenLaugh(cut, { outcome: 'stopped' });
  assert.deepEqual(cut.kept, [], 'cut off partway: not the whole joke');

  const noTuning = setup({ config: { jokeTuning: false } });
  await jokeThenLaugh(noTuning);
  assert.deepEqual(noTuning.kept, ['Mike, that door is still undefeated.'], 'kept even with joke tuning off');

  const off = setup({ config: { jokeCallbacks: false } });
  await jokeThenLaugh(off);
  assert.deepEqual(off.kept, []);
});

test('kept jokes are offered to the joke task, and one it calls back to is marked used', async () => {
  const s = setup({ callbacks: ['Mike lost a fight to a door.', 'Jess built a base in lava.'], joke: 'Mike, careful, you lost a fight to a door once.' });
  s.brain.request('quip', {});
  await settle();
  assert.match(String(s.calls[0].user), /Mike lost a fight to a door\./);
  const i = s.speaker.lines.findIndex((l) => l.kind === 'quip');
  s.speaker.start(i);
  s.speaker.finish(i);
  await settle();
  assert.deepEqual(s.used, ['Mike lost a fight to a door.']);

  const off = setup({ callbacks: ['Mike lost a fight to a door.'], config: { jokeCallbacks: false } });
  off.brain.request('quip', {});
  await settle();
  assert.doesNotMatch(String(off.calls[0].user), /lost a fight/);
});
