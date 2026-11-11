// Replies to it without its name: after its hello, said in pieces, in a one-on-one,
// and what the quick check is told about who's talking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { TASKS } from '../src/prompts.js';

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

function fakeClaude(replies) {
  const calls = [];
  const queue = [...replies];
  return {
    calls,
    async createMessage(args) {
      calls.push(args);
      const next = queue.shift();
      if (typeof next === 'function') return next(args);
      return { text: next ?? '[PASS]', refusal: false };
    },
  };
}

/** Lines start and finish only when the test says so (start(i), finish(i)). */
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
    play(i) {
      this.start(i);
      this.finish(i);
    },
    stop() {
      for (const l of lines) if (!l.outcome) l.resolve('stopped');
    },
    stopKind() {},
    dropOptional() {},
  };
}

/** Every line plays right away. */
function autoSpeaker() {
  const said = [];
  return {
    said,
    speaking: false,
    wasAudibleBetween: () => false,
    say(text, opts = {}) {
      said.push({ text, kind: opts.kind, opts });
      opts.onStart?.();
      return Promise.resolve('played');
    },
    stop() {},
    stopKind() {},
    dropOptional() {},
  };
}

function setup({ replies = [], people = ['Mike', 'Jess', 'Ana'], speaker = manualSpeaker(), speaking = () => false, hearingFrom = () => false, chattiness } = {}) {
  let now = 5_000_000;
  const claude = fakeClaude(replies);
  const brain = new Brain({
    config: baseConfig,
    claude,
    speaker,
    chattiness,
    getCallInfo: () => ({ channelName: 'Lobby', people, activities: [] }),
    isSpeaking: speaking,
    isHearingFrom: hearingFrom,
    clock: () => now,
  });
  return { brain, claude, speaker, advance: (ms) => (now += ms), now: () => now };
}

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

test('its hello opens the conversation: a reply to it without its name gets considered', async () => {
  const { brain, claude, speaker, advance, now } = setup({ replies: ['Hey Mike, hey Jess.', 'All good here, Mike.'] });
  brain.greet();
  await settle();
  speaker.play(0);
  await settle();
  advance(3000);
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: "hey what's up, how are you", startedAt: now() - 1500, spokeUntil: now() - 200 }), 'followup');
  await settle();
  assert.equal(claude.calls.length, 2);
  assert.match(claude.calls[1].user, /Mike talked right after you/);
  advance(40000);
  assert.equal(brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'anyway, where were we', startedAt: now() - 1000 }), 'heard', 'the window closes like after any line');
});

test('a reply said in pieces gets one reply that covers all of it', async () => {
  const { brain, claude, speaker, advance, now } = setup({ replies: ['Doing great, you?', 'Nice.', 'Same old, same old.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin how are you', startedAt: now() - 1500, spokeUntil: now() - 200 });
  await settle();
  speaker.play(0);
  await settle();
  advance(2000);
  // "I'm good." ... "What about you?" with a short pause the end-of-turn model took for the end.
  const t = now();
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: "I'm good", startedAt: t - 900, spokeUntil: t - 300 }), 'followup');
  await settle();
  assert.equal(speaker.lines.length, 2, 'a reply to the first piece is written and waiting');
  assert.equal(typeof speaker.lines[1].opts.hold, 'function', 'it waits while Mike is still talking');
  advance(1500);
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'what about you', startedAt: t + 200, spokeUntil: t + 1000 }), 'continued');
  await settle();
  assert.equal(speaker.lines[1].outcome, 'dropped', 'the reply to half of it is taken back');
  assert.equal(claude.calls.length, 3);
  assert.match(claude.calls[2].user, /Mike: I'm good\n.*Mike: what about you/);
  assert.equal(speaker.lines[2].text, 'Same old, same old.');
  assert.ok(!brain.transcript.recent().some((l) => l.text === 'Nice.'), 'the unsaid reply is gone from the transcript');
});

test('more of a reply a few seconds later, before its reply was heard, is covered too', async () => {
  const { brain, claude, speaker, advance, now } = setup({ replies: ['Doing great, you?', 'Nice.', 'Ha, fair enough.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin how are you', startedAt: now() - 1500, spokeUntil: now() - 200 });
  await settle();
  speaker.play(0);
  await settle();
  advance(2000);
  const t = now();
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'honestly pretty tired', startedAt: t - 1200, spokeUntil: t - 300 });
  await settle();
  advance(5000);
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'long day at work', startedAt: t + 4000, spokeUntil: t + 4800 }), 'continued', '4.3 s after the first piece');
  await settle();
  assert.equal(speaker.lines[1].outcome, 'dropped');
  assert.equal(claude.calls.length, 3);
  assert.match(claude.calls[2].user, /honestly pretty tired\n.*long day at work/);
});

test('once its reply is playing, more from them is a new follow-up, not a redo', async () => {
  const { brain, claude, speaker, advance, now } = setup({ replies: ['Doing great, you?', 'Nice.', 'Glad to hear it.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin how are you', startedAt: now() - 1500, spokeUntil: now() - 200 });
  await settle();
  speaker.play(0);
  await settle();
  advance(2000);
  const t = now();
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: "I'm good", startedAt: t - 900, spokeUntil: t - 300 });
  await settle();
  speaker.start(1); // "Nice." is playing
  advance(1500);
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'just got home actually', startedAt: t + 1200, spokeUntil: t + 1400 }), 'followup');
  assert.equal(speaker.lines[1].outcome, null, 'what is playing keeps playing');
  speaker.finish(1);
  await settle();
  assert.equal(claude.calls.length, 3);
});

test('laughing right after its reply is not more of the reply', async () => {
  const { brain, claude, speaker, advance, now } = setup({ replies: ['Doing great, you?', 'Nice.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin how are you', startedAt: now() - 1500, spokeUntil: now() - 200 });
  await settle();
  speaker.play(0);
  await settle();
  advance(2000);
  const t = now();
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: "I'm good", startedAt: t - 900, spokeUntil: t - 300 });
  await settle();
  assert.notEqual(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'haha', startedAt: t + 100, spokeUntil: t + 400 }), 'continued');
  assert.equal(speaker.lines[1].outcome, null, 'the reply stays');
  assert.equal(claude.calls.length, 2);
});

test('in a one-on-one, the back-and-forth has no turn limit and the check knows it', async () => {
  const replies = ['Answer.', ...Array.from({ length: 8 }, (_, i) => `Reply ${i + 1}.`)];
  const { brain, claude, advance, now } = setup({ replies, people: ['Mike'], speaker: autoSpeaker() });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what should we play', startedAt: now() - 1000, spokeUntil: now() - 100 });
  await settle();
  for (let i = 1; i <= 8; i++) {
    advance(3000);
    assert.equal(brain.hear({ userId: 'u1', id: i + 1, name: 'Mike', text: `comment number ${i}`, startedAt: now() - 1000, spokeUntil: now() - 100 }), 'followup', `comment ${i}`);
    await settle();
  }
  assert.equal(claude.calls.length, 9);
  assert.match(claude.calls[1].user, /Mike is the only one talking in the call right now/);
  assert.doesNotMatch(claude.calls[1].user, /nothing to do with you/);
});

test('someone who is the only one talking counts as a one-on-one even with quiet people in the call', async () => {
  const { brain, claude, advance, now } = setup({ replies: ['Answer.', 'Reply.'], people: ['Mike', 'Leo', 'Ana'], speaker: autoSpeaker() });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin how was your day', startedAt: now() - 1000, spokeUntil: now() - 100 });
  await settle();
  advance(3000);
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'mine was rough', startedAt: now() - 1000, spokeUntil: now() - 100 });
  await settle();
  assert.match(claude.calls[1].user, /Mike is the only one talking in the call right now/);
});

test('the check is told who it was talking with, and stays careful with everyone else', async () => {
  const { brain, claude, advance, now } = setup({ replies: ['Answer.', 'Reply to Mike.', 'Reply to Jess.'], speaker: autoSpeaker() });
  brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'lol mike stop', startedAt: now() - 3000, spokeUntil: now() - 2500 });
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin which gun is best', startedAt: now() - 1000, spokeUntil: now() - 100 });
  await settle();
  advance(3000);
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'really, not the rifle', startedAt: now() - 1000, spokeUntil: now() - 100 }), 'followup');
  await settle();
  assert.match(claude.calls[1].user, /You were just talking with Mike, so it's most likely meant for you/);
  assert.doesNotMatch(claude.calls[1].user, /only one talking/);
  advance(3000);
  assert.equal(brain.hear({ userId: 'u2', id: 4, name: 'Jess', text: 'nah the rifle is trash', startedAt: now() - 1000, spokeUntil: now() - 100 }), 'followup');
  await settle();
  assert.doesNotMatch(claude.calls[2].user, /You were just talking with Jess/);
  assert.match(claude.calls[2].user, /talking to someone else or about something that has nothing to do with you/);
});

test('in a group, the turn limit still applies to people taking turns', async () => {
  const replies = ['Answer.', 'Reply 1.', 'Reply 2.', 'Reply 3.', 'Reply 4.', 'Reply 5.', 'Too many.'];
  const { brain, claude, advance, now } = setup({ replies, speaker: autoSpeaker() });
  brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'ok who is ready', startedAt: now() - 3000, spokeUntil: now() - 2500 });
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin what should we play', startedAt: now() - 1000, spokeUntil: now() - 100 });
  await settle();
  for (let i = 1; i <= 5; i++) {
    advance(3000);
    assert.equal(brain.hear({ userId: 'u1', id: i + 2, name: 'Mike', text: `comment number ${i}`, startedAt: now() - 1000, spokeUntil: now() - 100 }), 'followup');
    await settle();
  }
  advance(3000);
  assert.notEqual(brain.hear({ userId: 'u1', id: 9, name: 'Mike', text: 'and another thing', startedAt: now() - 1000, spokeUntil: now() - 100 }), 'followup');
  assert.equal(claude.calls.length, 6);
});

test('a reply to someone waits while they are still talking', async () => {
  let talking = true;
  const { brain, speaker, advance, now } = setup({ replies: ['Doing great, you?', 'Nice.'], speaking: (u) => u === 'u1' && talking });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin how are you', startedAt: now() - 1500, spokeUntil: now() - 200 });
  await settle();
  speaker.play(0);
  await settle();
  advance(2000);
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: "I'm good", startedAt: now() - 900, spokeUntil: now() - 300 });
  await settle();
  const hold = speaker.lines[1].opts.hold;
  assert.equal(hold(), true);
  talking = false;
  assert.equal(hold(), false);
});

test('the follow-up and hello prompts', () => {
  const group = TASKS.followup({ name: 'Jess' });
  assert.match(group, /Jess talked right after you/);
  assert.match(group, /nothing to do with you/);
  assert.match(group, /their answer is for you, even a one-word one/);
  assert.match(group, /not only the newest line/);
  const one = TASKS.followup({ name: 'Mike', onlyOne: true });
  assert.match(one, /only one talking/);
  assert.match(one, /clearly meant for someone else/);
  assert.doesNotMatch(one, /nothing to do with you/);
  assert.match(TASKS.followup({ name: 'Mike', partner: true }), /You were just talking with Mike/);
  assert.match(TASKS.greet(), /no nickname for the group/);
});

// Cases from the independent review of this change.

async function talkingWithMike(replies, opts = {}) {
  const h = setup({ replies, ...opts });
  h.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin how are you', startedAt: h.now() - 1500, spokeUntil: h.now() - 200 });
  await settle();
  h.speaker.play(0);
  await settle();
  return h;
}

test('the second piece began before the reply to the first was written (as in the real call): one reply for both', async () => {
  const { brain, claude, speaker, advance, now } = await talkingWithMike(['Doing great, you?', 'Nice.', 'Same old.']);
  advance(2000);
  const t = now();
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: "I'm good", startedAt: t - 900, spokeUntil: t - 300 });
  await settle();
  advance(1500);
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'what about you', startedAt: t - 100, spokeUntil: t + 700 }), 'continued');
  await settle();
  assert.equal(claude.calls.length, 3, 'asked again for both pieces');
  assert.deepEqual(speaker.lines.filter((l) => l.outcome !== 'dropped').map((l) => l.text), ['Doing great, you?', 'Same old.']);
});

test('redoing the last follow-up the chattiness level allows still gets said', async () => {
  const { brain, claude, speaker, advance, now } = setup({ replies: ['Answer.', 'Reply 1.', 'Half.', 'Whole.'], chattiness: 'low' });
  brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'ok who is ready', startedAt: now() - 3000, spokeUntil: now() - 2500 });
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin what should we play', startedAt: now() - 1000, spokeUntil: now() - 100 });
  await settle();
  speaker.play(0);
  await settle();
  advance(3000);
  brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'comment number one', startedAt: now() - 1000, spokeUntil: now() - 100 });
  await settle();
  speaker.play(1);
  await settle();
  advance(3000);
  const t = now();
  brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'I think we should', startedAt: t - 900, spokeUntil: t - 300 });
  await settle();
  advance(1500);
  assert.equal(brain.hear({ userId: 'u1', id: 5, name: 'Mike', text: 'play the new map', startedAt: t + 200, spokeUntil: t + 1000 }), 'continued');
  await settle();
  assert.equal(claude.calls.length, 4, 'the taken-back reply is written again');
  assert.equal(speaker.lines.at(-1).text, 'Whole.');
});

test('a long second piece that outlasts the reply (dropped, nobody paused) is still considered', async () => {
  const { brain, speaker, advance, now } = await talkingWithMike(['Doing great, you?', 'Nice.', 'Whole reply.']);
  advance(2000);
  const t = now();
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: "I'm good", startedAt: t - 900, spokeUntil: t - 300 });
  await settle();
  advance(5500);
  speaker.lines[1].resolve('dropped');
  await settle();
  advance(1000);
  assert.notEqual(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'had a long day at work and then the car broke down', startedAt: t - 100, spokeUntil: t + 6200 }), 'heard');
});

test("someone else's follow-up in the pause doesn't stop a question by name being continued", async () => {
  const { brain, speaker, advance, now } = setup({ replies: ['First answer.', 'Half.', '[PASS]', 'Whole.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what time is it in tokyo', startedAt: now() - 1500, spokeUntil: now() - 200 });
  await settle();
  speaker.play(0);
  await settle();
  advance(4000);
  const t = now();
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin what is the best build for', startedAt: t - 1500, spokeUntil: t - 300 });
  await settle();
  advance(600);
  brain.hear({ userId: 'u2', id: 3, name: 'Jess', text: 'oh good question', startedAt: t + 100, spokeUntil: t + 500 });
  await settle();
  advance(800);
  assert.equal(brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'a support main in ranked', startedAt: t + 1200, spokeUntil: t + 1300 }), 'continued');
});

test("their own laugh in the pause doesn't stop a question by name being continued", async () => {
  const { brain, speaker, advance, now } = setup({ replies: ['First answer.', 'Half.', '[PASS]', 'Whole.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what time is it in tokyo', startedAt: now() - 1500, spokeUntil: now() - 200 });
  await settle();
  speaker.play(0);
  await settle();
  advance(4000);
  const t = now();
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin what is the best build for', startedAt: t - 1500, spokeUntil: t - 300 });
  await settle();
  advance(500);
  brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'haha', startedAt: t + 100, spokeUntil: t + 400 });
  await settle();
  advance(1200);
  assert.equal(brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'a support main in ranked', startedAt: t + 1000, spokeUntil: t + 1600 }), 'continued');
});

test("a piece merged into a waiting follow-up isn't lost when another answer plays in between", async () => {
  let finishJess;
  const replies = [
    'First answer to Mike.',
    (args) => {
      args.onText('<say>Tokyo is fourteen hours ahead of you right now. ');
      return new Promise((r) => (finishJess = () => r({ text: '<say>Tokyo is fourteen hours ahead of you right now. Easy.</say>', refusal: false })));
    },
    'Reply to Mike.',
  ];
  const { brain, claude, speaker, advance, now } = await talkingWithMike(replies);
  advance(3000);
  brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'gremlin what time is it in tokyo', startedAt: now() - 1500, spokeUntil: now() - 200 });
  const t = now();
  brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'ok cool the desert one', startedAt: t - 1000, spokeUntil: t - 300 });
  await settle();
  advance(2000);
  brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'I always win on that one', startedAt: t + 500, spokeUntil: t + 1600 });
  speaker.play(1);
  finishJess();
  await settle(8);
  assert.equal(claude.calls.length, 3, "Mike's reply is still considered");
});

test('the first person to talk after its hello in a full channel is not "the only one talking"', async () => {
  const { brain, claude, speaker, advance, now } = setup({ replies: ['Hey all.', 'Reply.'], people: ['Mike', 'Jess', 'Ana'] });
  brain.greet();
  await settle();
  speaker.play(0);
  await settle();
  advance(2000);
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'did you guys see that clip I sent', startedAt: now() - 1500, spokeUntil: now() - 200 }), 'followup');
  await settle();
  assert.doesNotMatch(claude.calls[1].user, /only one talking/);
  assert.match(claude.calls[1].user, /nothing to do with you/);
});

test('a one-on-one still has a cap, in case a mic is picking up a video', async () => {
  const replies = ['Answer.', ...Array.from({ length: 14 }, (_, i) => `Reply ${i + 1}.`)];
  const { brain, claude, advance, now } = setup({ replies, people: ['Mike'], speaker: autoSpeaker() });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what should we play', startedAt: now() - 1000, spokeUntil: now() - 100 });
  await settle();
  let followups = 0;
  for (let i = 1; i <= 14; i++) {
    advance(3000);
    if (brain.hear({ userId: 'u1', id: i + 1, name: 'Mike', text: `comment number ${i}`, startedAt: now() - 1000, spokeUntil: now() - 100 }) === 'followup') followups++;
    await settle();
  }
  assert.equal(followups, 12);
  assert.equal(claude.calls.length, 13);
});
