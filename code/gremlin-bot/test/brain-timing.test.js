// When it speaks up, and what it does with requests that overlap.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';

const baseConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  timezone: 'UTC',
  defaultChattiness: 'high',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
};

/** Claude fake: each reply is text or a function returning a promise; every call is recorded. */
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

/** A reply you release by hand: hold(...) returns [replyFn, release]. */
function hold() {
  let release;
  const fn = () => new Promise((r) => (release = (text) => r({ text, refusal: false })));
  return [fn, (text) => release(text)];
}

function setup({ replies = [], chattiness = 'high' } = {}) {
  let now = 10_000_000;
  const said = [];
  const speaker = {
    said,
    stops: 0,
    dropped: 0,
    speaking: false,
    talkedOver: false,
    wasAudibleBetween() {
      return this.talkedOver;
    },
    say(text, opts) {
      said.push({ text, kind: opts?.kind });
      opts?.onStart?.();
      return this.play ? this.play(text, opts) : Promise.resolve('played');
    },
    stop() {
      this.stops++;
    },
    dropOptional() {
      this.dropped++;
    },
  };
  const claude = fakeClaude(replies);
  const brain = new Brain({
    config: baseConfig,
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess', 'Ana'], activities: [] }),
    chattiness,
    clock: () => now,
  });
  return { brain, claude, speaker, said, advance: (ms) => (now += ms), now: () => now };
}

const settle = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

test('a joke queued while it writes an answer is dropped once the answer goes out', async () => {
  const [answer, releaseAnswer] = hold();
  const { brain, claude, said } = setup({ replies: [answer, 'A joke nobody needed.'] });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin who is right' });
  await settle();
  brain.request('quip', {}); // the quip check fired while the answer was being written
  releaseAnswer('Jess is right, obviously.');
  await settle(6);
  assert.equal(claude.calls.length, 1, 'the joke was never even written');
  assert.deepEqual(said.map((s) => s.kind), ['direct']);
});

test('a quip check that was about to fire is cancelled when someone says its name', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { brain, claude, advance } = setup({ replies: ['Sure, Mike.'] });
    advance(120000);
    for (const text of ['so the raid', 'yeah', 'whatever man']) brain.hear({ userId: 'u2', name: 'Jess', text });
    brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin what do you think' }); // before the lull timer fires
    mock.timers.tick(5000);
    await settle();
    assert.equal(claude.calls.length, 1);
    assert.match(claude.calls[0].user, /Mike is talking to you/);
  } finally {
    mock.timers.reset();
  }
});

test('a joke written just before it answered someone is not spoken right after', async () => {
  const [quip, releaseQuip] = hold();
  const { brain, said } = setup({ replies: [quip, 'Answer for Mike.'] });
  brain.request('quip', {});
  await settle();
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin quick question' }); // aborts the joke
  await settle();
  releaseQuip('Late joke.');
  await settle(6);
  assert.deepEqual(said.map((s) => s.text), ['Answer for Mike.']);
});

test('two comebacks in its follow-up window get at most one follow-up', async () => {
  const [first, releaseFirst] = hold();
  const { brain, claude, said, advance } = setup({ replies: ['Cry about it.', first, 'Second follow-up.'] });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin roast jess' });
  await settle();
  advance(2000);
  brain.hear({ userId: 'u2', name: 'Jess', text: 'wow rude' });
  brain.hear({ userId: 'u3', name: 'Ana', text: 'lmao' });
  await settle();
  releaseFirst('Rude is my brand.');
  await settle(6);
  assert.deepEqual(said.map((s) => s.kind), ['direct', 'followup']);
  assert.equal(claude.calls.length, 2, 'the second follow-up was dropped before it was written');
});

test('calling its name again after "Gremlin!" gets a quick "Yeah?" instead of more silence', async () => {
  const { brain, claude, speaker, said } = setup();
  speaker.talkedOver = true;
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin!', startedAt: 1, spokeUntil: 2 }), 'listening');
  speaker.talkedOver = false;
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'Gremlin?', startedAt: 3, spokeUntil: 4 }), 'acknowledged');
  await settle();
  assert.deepEqual(said.map((s) => s.kind), ['ack']);
  assert.equal(claude.calls.length, 0, 'nothing for Claude to write');
});

test('the comeback window starts when the answer finishes playing', async () => {
  let finish;
  const { brain, claude, speaker, advance, now } = setup({ replies: ['A long answer that takes a while to say.', 'Comeback reply.'] });
  speaker.play = () => new Promise((r) => (finish = r));
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin tell me something' });
  await settle();
  advance(9000); // it takes 9 s to say it
  finish('played');
  await settle();
  advance(5000); // Mike answers 5 s after it stopped (14 s after it was written)
  const startedAt = now();
  advance(2500);
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'no way thats true', startedAt, spokeUntil: now() }), 'followup');
  await settle();
  assert.equal(claude.calls.length, 2);
});

test('a /roast is not lost when someone says its name right after', async () => {
  const [roast, releaseRoast] = hold();
  const { brain, claude, said } = setup({ replies: [roast, 'Answer for Ana.'] });
  brain.roast({ target: 'Mike', requester: 'Jess' });
  await settle();
  brain.hear({ userId: 'u3', name: 'Ana', text: 'gremlin what time is it' });
  await settle();
  releaseRoast('Mike plays like his monitor is off.');
  await settle(6);
  assert.equal(claude.calls.length, 2);
  assert.deepEqual(said.map((s) => s.kind), ['roast', 'direct']);
});

test('a /roast that arrives while an answer is pending still happens afterwards', async () => {
  const [first, releaseFirst] = hold();
  const { brain, claude, said } = setup({ replies: [first, 'Second answer.', 'The roast.'] });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin first question' });
  await settle();
  brain.hear({ userId: 'u2', name: 'Jess', text: 'gremlin second question' }); // waits its turn
  brain.roast({ target: 'Ana', requester: 'Mike' }); // queued behind that
  releaseFirst('First answer.');
  await settle(10);
  assert.deepEqual(said.map((s) => s.kind), ['direct', 'direct', 'roast']);
  assert.match(claude.calls[2].user, /roast Ana/);
});

test('three people asking at once are all named in the next answer', async () => {
  const [first, releaseFirst] = hold();
  const { brain, claude } = setup({ replies: [first, 'Both of you, calm down.'] });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin first question' });
  await settle();
  brain.hear({ userId: 'u2', name: 'Jess', text: 'gremlin second question' });
  brain.hear({ userId: 'u3', name: 'Ana', text: 'gremlin third question' });
  releaseFirst('Answer one.');
  await settle(6);
  assert.match(claude.calls[1].user, /Jess and Ana are talking to you/);
});

test('its own long line echoing through a mic is still recognized near the end of the line', async () => {
  let finish;
  const line = 'Here is a long rant about how all of you play like your controllers are unplugged and your monitors are off.';
  const { brain, speaker, advance } = setup({ replies: [line] });
  speaker.play = () => new Promise((r) => (finish = r));
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin rant' });
  await settle();
  advance(20000); // still talking 20 s after writing it
  assert.equal(brain.hear({ userId: 'u2', name: 'Jess', text: 'controllers are unplugged and your monitors are off' }), 'echo');
  finish('played');
  await settle();
  advance(16000);
  assert.notEqual(brain.hear({ userId: 'u2', name: 'Jess', text: 'controllers are unplugged and your monitors are off' }), 'echo');
});

test('no joke while a sentence someone just finished is still being transcribed (it may be for the bot)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let hearing = false;
    let now = 10_000_000;
    const claude = fakeClaude(['Answer to Mike.']);
    const said = [];
    const brain = new Brain({
      config: baseConfig,
      claude,
      speaker: { wasAudibleBetween: () => false, say: (t, o) => (said.push(o.kind), Promise.resolve('played')), stop() {} },
      getCallInfo: () => ({}),
      chattiness: 'low',
      isHearingSomething: () => hearing,
      clock: () => now,
    });
    now += 6 * 60_000;
    for (const t of ['so', 'the game', 'is broken', 'again', 'lol']) brain.hear({ userId: 'u2', name: 'Jess', text: t });
    hearing = true; // Mike just said "Gremlin, who's right?" and it's being transcribed
    mock.timers.tick(2400);
    await settle();
    assert.equal(claude.calls.length, 0, 'held the joke');
    hearing = false;
    brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin who is right' });
    mock.timers.tick(5000);
    await settle(6);
    assert.deepEqual(said, ['direct']);
    assert.equal(claude.calls.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('a queued /roast is dropped when someone takes the floor, instead of starting over them', async () => {
  const [first, releaseFirst] = hold();
  const { brain, claude, said, speaker } = setup({ replies: [first, 'Second answer.', 'The roast.'] });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin first question' });
  await settle();
  brain.roast({ target: 'Ana', requester: 'Jess' }); // waits behind the answer
  speaker.talkedOver = true;
  brain.hear({ userId: 'u2', id: 7, name: 'Jess', text: 'Gremlin!', startedAt: 1, spokeUntil: 2 }); // takes the floor
  releaseFirst('Too late.');
  await settle(8);
  assert.equal(claude.calls.length, 1, 'nothing new was written while Jess has the floor');
  assert.deepEqual(said, []);
});

test('a comeback that started inside the window still counts when its transcript arrives late', async () => {
  const { brain, claude, advance, now } = setup({ replies: ['Answer.', 'Comeback reply.'] });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin say something' });
  await settle();
  advance(19000);
  const startedAt = now(); // starts talking 1 s before the window closes
  advance(4000); // long sentence: transcript arrives 3 s after it closed
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'no but seriously listen to this', startedAt, spokeUntil: now() - 1000 }), 'followup');
  await settle();
  assert.equal(claude.calls.length, 2);
});
