// How long people wait for an answer to start: from the moment they stop talking to
// its first sound, with where the time went. Logged per answer; the end-of-call line
// has the median, for the weekly review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain, replyTimeSummary } from '../src/brain.js';

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function setup() {
  let now = 1_000_000;
  const replies = ['<say>Half past nine.</say>', '<say>Tuesday, all day long.</say>'];
  const brain = new Brain({
    config: {
      botName: 'Gremlin',
      botAliases: ['gremlin'],
      timezone: 'UTC',
      defaultChattiness: 'medium',
      persona: 'x',
      lore: '',
      tts: { audioTags: false },
      transcript: { maxLines: 40, maxMinutes: 15 },
      anthropic: { webSearch: { enabled: false } },
    },
    claude: {
      createMessage: async () => {
        now += 900; // Claude writing
        return { text: replies.shift() ?? '<say>Half past nine.</say>', refusal: false };
      },
    },
    speaker: {
      speaking: false,
      wasAudibleBetween: () => false,
      say(text, opts = {}) {
        now += 400; // the voice's first audio
        opts.onStart?.();
        return Promise.resolve('played');
      },
      stop() {},
      stopKind() {},
      dropOptional() {},
    },
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike'], activities: [] }),
    clock: () => now,
  });
  return { brain, now: () => now, advance: (ms) => (now += ms) };
}

test('an answer is timed from when they stopped talking to its first sound', async () => {
  const s = setup();
  const t0 = s.now();
  // Stopped talking 500 ms ago; the sentence was closed 200 ms ago; its words came back now.
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what time is it', startedAt: t0 - 2500, spokeUntil: t0 - 500, at: t0 - 200 });
  await settle();
  assert.deepEqual(s.brain.replyTimes, [500 + 900 + 400]);
  // A follow-up reply is timed too.
  s.advance(3000);
  const t1 = s.now();
  s.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'and what day is it', startedAt: t1 - 1500, spokeUntil: t1 - 300, at: t1 - 100 });
  await settle();
  assert.equal(s.brain.replyTimes.length, 2);
  assert.equal(s.brain.replyTimes[1], 300 + 900 + 400);
});

test('a follow-up that needed a web lookup is timed from when they stopped talking, too', async () => {
  let now = 2_000_000;
  const replies = ['<say>Easy one.</say>', '[LOOKUP]', '<say>Patch five point two came out Tuesday.</say>'];
  const brain = new Brain({
    config: {
      botName: 'Gremlin',
      botAliases: ['gremlin'],
      timezone: 'UTC',
      defaultChattiness: 'medium',
      persona: 'x',
      lore: '',
      tts: { audioTags: false },
      transcript: { maxLines: 40, maxMinutes: 15 },
      anthropic: { webSearch: { enabled: true } },
    },
    claude: {
      canSearchNow: true,
      createMessage: async () => {
        now += 500;
        return { text: replies.shift(), refusal: false };
      },
    },
    speaker: {
      speaking: false,
      wasAudibleBetween: () => false,
      say(text, opts = {}) {
        now += 300;
        opts.onStart?.();
        return Promise.resolve('played');
      },
      stop() {},
      stopKind() {},
      dropOptional() {},
    },
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike'], activities: [] }),
    clock: () => now,
    fillerAfterMs: 1e9,
  });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin is the patch out', startedAt: now - 2000, spokeUntil: now - 400, at: now - 100 });
  await settle();
  now += 2000;
  const t1 = now;
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'when did it come out', startedAt: t1 - 1500, spokeUntil: t1 - 300, at: t1 - 100 });
  await settle(16);
  assert.equal(brain.replyTimes.length, 2);
  assert.equal(brain.replyTimes[1], 300 + 500 + 500 + 300, 'from the end of the follow-up: the check, the looked-up answer, the voice');
});

test('the end-of-call line has the median and the slowest', () => {
  assert.equal(replyTimeSummary([]), '');
  assert.equal(replyTimeSummary([1800, 1200, 4200]), 'answers started 1.8 s after people stopped talking (median of 3; slowest 4.2 s)');
  assert.equal(replyTimeSummary([1000, 2000]), 'answers started 1.5 s after people stopped talking (median of 2; slowest 2.0 s)');
});
