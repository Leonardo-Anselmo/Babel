// Joke tuning: laughs after its jokes make it joke a bit more often, being shushed
// or talked over makes it wait longer and be pickier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { JokeTuning, jokeOutcome, reactionTo } from '../src/jokes.js';
import { Memory } from '../src/memory.js';
import { TASKS } from '../src/prompts.js';

test('what counts as a laugh, and as telling it off: a whole line of it, or said to it by name', () => {
  for (const t of ['Hahaha', 'ha ha ha', 'Ha, ha.', 'lol', 'LMAO', 'heh', 'Hehe.', 'hehehe']) assert.equal(reactionTo(t), 'laugh', t);
  for (const t of ['good one gremlin', "gremlin that's so funny", 'gremlin lol']) assert.equal(reactionTo(t, { toMe: true }), 'laugh', t);
  for (const t of ['shut up', 'bro shut up', 'nobody asked', 'Not funny.', 'boo', 'Booo!']) assert.equal(reactionTo(t), 'boo', t);
  for (const t of ['gremlin shut up', 'gremlin nobody asked']) assert.equal(reactionTo(t, { toMe: true }), 'boo', t);
  // About the game, not the joke.
  for (const t of [
    "I'm dead",
    'What?',
    'yeah',
    'haunted',
    'nice one Mike, he is one shot',
    'ha ha, very funny',
    'LMAO Mike just fell off the map',
    'boo, they took the round',
    'shut up, no way he hit that',
    'shut it down',
    'stop',
    'good one',
  ]) {
    assert.equal(reactionTo(t), null, t);
  }
});

test('a joke goes one way: told off beats a laugh, a laugh beats being talked over', () => {
  assert.equal(jokeOutcome({ laughs: 2, boos: 1 }), 'shushed');
  assert.equal(jokeOutcome({ laughs: 1, talkedOver: 2 }), 'laughed');
  assert.equal(jokeOutcome({ talkedOver: 1 }), 'talked over');
  assert.equal(jokeOutcome({}), 'no reaction');
});

test('the score moves a quarter of the way each joke, and sets the waits once a few jokes are in', () => {
  const t = new JokeTuning();
  assert.equal(t.factor(), 1);
  t.record('laughed');
  assert.equal(t.score, 0.25);
  assert.equal(t.factor(), 1, 'one joke is too few to go by');
  for (let i = 0; i < 4; i++) t.record('no reaction');
  assert.ok(Math.abs(t.factor() - (1 - 0.4 * t.score)) < 1e-9);
  assert.ok(t.factor() < 1);
  for (let i = 0; i < 30; i++) t.record('laughed');
  assert.ok(t.factor() >= 0.6 && t.factor() < 0.62, 'never less than 0.6 of the usual wait');
  for (let i = 0; i < 30; i++) t.record('shushed');
  assert.ok(t.factor() <= 2 && t.factor() > 1.95, 'never more than twice the usual wait');
  assert.equal(t.choosy(), true);
  assert.equal(t.told, 65);
  assert.equal(t.laughed, 31);
  assert.equal(t.shushed, 30);
  const saved = new JokeTuning(JSON.parse(JSON.stringify(t)));
  assert.equal(Math.round(saved.score * 100), Math.round(t.score * 100), 'saved and loaded');
  assert.equal(new JokeTuning({ score: 7 }).score, 1, 'a damaged score is clamped');
  // A saved score fades by half a week later.
  const weekAgo = new Date(Date.UTC(2026, 9, 19)).toISOString();
  assert.ok(Math.abs(new JokeTuning({ score: 0.8, at: weekAgo }, { now: Date.UTC(2026, 9, 26) }).score - 0.4) < 1e-9);
});

test('when its jokes keep falling flat, the joke task asks for only a really good one', () => {
  assert.doesNotMatch(TASKS.quip(), /falling flat/);
  assert.match(TASKS.quip({ choosy: true }), /falling flat with this group lately, so only jump in with one you're sure lands/);
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

/** Lines start and finish when the test says so. */
function manualSpeaker() {
  const lines = [];
  let audible = false;
  return {
    lines,
    speaking: false,
    setAudible(v) {
      audible = v;
    },
    wasAudibleBetween: () => audible,
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
        opts.signal?.addEventListener('abort', () => {
          if (!line.started) line.resolve('dropped');
        });
      });
    },
    start(i) {
      lines[i].started = true;
      lines[i].opts.onStart?.();
    },
    finish(i) {
      lines[i].resolve('played');
    },
    stop() {
      for (const l of lines) if (!l.outcome) l.resolve('stopped');
    },
    stopKind() {},
    dropOptional() {},
  };
}

function setup({ jokes = { told: 10 }, config = {} } = {}) {
  let now = 50_000_000;
  const calls = [];
  const claude = {
    async createMessage(args) {
      calls.push(args);
      return { text: '<say>Mike, that flank was a cry for help.</say>', refusal: false };
    },
  };
  const speaker = manualSpeaker();
  const saved = [];
  const brain = new Brain({
    config: { ...baseConfig, ...config },
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
    clock: () => now,
    jokes,
    onJokes: (state) => saved.push(state),
  });
  return { brain, calls, speaker, saved, advance: (ms) => (now += ms), now: () => now };
}

/** It tells a joke, which starts playing. */
async function tellJoke(s) {
  s.brain.request('quip', {});
  await settle();
  const i = s.speaker.lines.findIndex((l) => l.kind === 'quip' && !l.started);
  assert.ok(i >= 0, 'a joke is on its way');
  s.advance(100);
  s.speaker.start(i);
  return i;
}

test('a laugh after its joke: it jokes a bit more often', async () => {
  const s = setup();
  const usual = s.brain.quipPacing().cooldownMs;
  const i = await tellJoke(s);
  s.advance(1500);
  s.speaker.finish(i);
  await settle();
  s.advance(1000);
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'hahaha', startedAt: s.now() - 600, spokeUntil: s.now() - 100 });
  s.brain.finishJoke();
  assert.equal(s.saved.length, 1);
  assert.equal(s.saved[0].laughed, 1);
  assert.ok(s.saved[0].score > 0);
  assert.ok(s.brain.quipPacing().cooldownMs < usual);
});

test('"Gremlin, shut up" during its joke: it waits longer before the next one', async () => {
  const s = setup();
  const usual = s.brain.quipPacing().cooldownMs;
  await tellJoke(s);
  s.advance(800);
  s.brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'gremlin shut up', startedAt: s.now() - 500, spokeUntil: s.now() - 100 });
  await settle();
  s.brain.finishJoke();
  assert.equal(s.saved[0].shushed, 1);
  assert.ok(s.brain.quipPacing().cooldownMs > usual);
});

test('/shush right after its joke counts against the joke', async () => {
  const s = setup();
  const i = await tellJoke(s);
  s.advance(1500);
  s.speaker.finish(i);
  await settle();
  s.advance(2000);
  s.brain.shush();
  s.brain.finishJoke();
  assert.equal(s.saved[0].shushed, 1);
});

test('talked over for a while: a small step toward fewer jokes; a short overlap or calling it is not', async () => {
  const s = setup();
  await tellJoke(s);
  s.advance(2500);
  s.speaker.setAudible(true);
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'push B push B', startedAt: s.now() - 2200, spokeUntil: s.now() - 100 });
  s.brain.finishJoke();
  assert.equal(s.saved[0].talkedOver, 1);
  assert.equal(s.saved[0].score, -0.062); // (-0.0625, rounded)

  const t = setup();
  await tellJoke(t);
  t.advance(2500);
  t.speaker.setAudible(true);
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'push B', startedAt: t.now() - 600, spokeUntil: t.now() - 100 });
  t.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'gremlin what time is it', startedAt: t.now() - 2200, spokeUntil: t.now() - 100 });
  await settle();
  t.brain.finishJoke();
  assert.equal(t.saved[0]?.talkedOver ?? 0, 0);
});

test('a laugh at what it says after the joke, a channel move, its own voice, or leaving early do not count', async () => {
  // Laughing at its next line.
  const a = setup();
  const i = await tellJoke(a);
  a.advance(1500);
  a.speaker.finish(i);
  await settle();
  a.advance(500);
  a.brain.sayExactly('Anyway, back to the game.');
  a.advance(1500);
  a.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'hahaha', startedAt: a.now() - 600, spokeUntil: a.now() - 100 });
  a.brain.finishJoke();
  assert.equal(a.saved.length ? a.saved[0].laughed : 0, 0);

  // A channel move.
  const b = setup();
  await tellJoke(b);
  b.advance(500);
  b.brain.shush({ fromThem: false });
  b.brain.finishJoke();
  assert.equal(b.saved.length ? b.saved[0].shushed : 0, 0);

  // Its own words coming back through a mic.
  const c = setup();
  await tellJoke(c);
  c.advance(1500);
  c.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'a cry for help', startedAt: c.now() - 900, spokeUntil: c.now() - 100 });
  c.brain.finishJoke();
  assert.equal(c.saved.length ? c.saved[0].talkedOver : 0, 0);

  // It left before anyone reacted.
  const d = setup();
  await tellJoke(d);
  d.brain.close();
  assert.equal(d.saved.length, 0);
});

test('a joke that laughs itself: a laugh while it plays may be its own voice, after it ends it counts', async () => {
  const s = setup();
  s.brain.claude.createMessage = async () => ({ text: '<say>Haha, Mike, that flank was a cry for help.</say>', refusal: false });
  const i = await tellJoke(s);
  s.advance(800);
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'haha', startedAt: s.now() - 500, spokeUntil: s.now() - 100 });
  s.advance(1500);
  s.speaker.finish(i);
  await settle();
  s.brain.finishJoke();
  assert.equal(s.saved[0].laughed, 0);
});

test('no reaction: nothing changes, and lines from before the joke, or long after it, do not count', async () => {
  const s = setup();
  const i = await tellJoke(s);
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'hahaha', startedAt: s.now() - 5000, spokeUntil: s.now() - 4000 });
  s.advance(1500);
  s.speaker.finish(i);
  await settle();
  s.advance(9000);
  s.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'lmao', startedAt: s.now() - 500, spokeUntil: s.now() - 100 });
  s.brain.finishJoke();
  assert.equal(s.saved[0].laughed, 0);
  assert.equal(s.saved[0].score, 0);
});

test('a joke nobody heard does not count', async () => {
  const s = setup();
  s.brain.request('quip', {});
  await settle();
  const i = s.speaker.lines.findIndex((l) => l.kind === 'quip');
  s.speaker.lines[i].resolve('dropped');
  await settle();
  s.brain.finishJoke();
  assert.equal(s.saved.length, 0);
});

test('what it learned is loaded back: a group that laughs gets jokes sooner from the start', () => {
  const s = setup({ jokes: { score: 0.8, told: 12, laughed: 9 } });
  assert.equal(s.brain.quipPacing().cooldownMs, Math.round(150000 * (1 - 0.4 * 0.8)));
  const flat = setup({ jokes: { score: -0.8, told: 12 } });
  assert.equal(flat.brain.quipPacing().cooldownMs, Math.round(150000 * 1.8));
  const fresh = setup({ jokes: { score: -0.8, told: 2 } });
  assert.equal(fresh.brain.quipPacing().cooldownMs, 150000, 'too few jokes to go by yet');
});

test('when its jokes have been falling flat, it is asked for only a really good one', async () => {
  const s = setup({ jokes: { score: -0.6, told: 8 } });
  s.brain.request('quip', {});
  await settle();
  assert.match(s.calls[0].user, /falling flat with this group lately/);
});

test('JOKE_TUNING=false: the usual waits, and nothing is counted', async () => {
  const s = setup({ jokes: { score: 0.9, told: 9 }, config: { jokeTuning: false } });
  assert.equal(s.brain.quipPacing().cooldownMs, 150000);
  const i = await tellJoke(s);
  s.speaker.finish(i);
  await settle();
  s.brain.finishJoke();
  assert.equal(s.saved.length, 0);
});

test('the joke score and learned words are saved per server in memory.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-jokes-'));
  const m = new Memory(dir);
  m.setJokes('g1', { score: 0.5, told: 3 });
  m.setWords('g1', [{ term: 'Malenia', count: 2, at: '2026-10-26T00:00:00.000Z' }]);
  m.flush();
  const again = new Memory(dir);
  assert.deepEqual(again.jokes('g1'), { score: 0.5, told: 3 });
  assert.equal(again.words('g1')[0].term, 'Malenia');
  assert.equal(again.jokes('other'), null);
  assert.deepEqual(again.words('other'), []);
});
