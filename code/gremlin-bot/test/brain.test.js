import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ACKS, Brain } from '../src/brain.js';

const baseConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin', 'grem'],
  timezone: 'UTC',
  defaultChattiness: 'medium',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
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

function fakeSpeaker() {
  const said = [];
  const stoppedKinds = [];
  let stops = 0;
  return {
    said,
    stoppedKinds,
    get stops() {
      return stops;
    },
    stopKind(kind) {
      stoppedKinds.push(kind);
    },
    speaking: false,
    talkedOver: false, // set true to make it look like someone talked over it
    wasAudibleBetween() {
      return this.talkedOver;
    },
    say(text, opts) {
      said.push({ text, kind: opts?.kind });
      return Promise.resolve('played');
    },
    stop() {
      stops++;
    },
  };
}

function makeBrain({ replies = [], chattiness = 'medium', speaking = () => false } = {}) {
  let now = 1_000_000;
  const claude = fakeClaude(replies);
  const speaker = fakeSpeaker();
  const brain = new Brain({
    config: baseConfig,
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
    getFacts: () => [],
    isAnyoneSpeaking: speaking,
    chattiness,
    clock: () => now,
  });
  return { brain, claude, speaker, advance: (ms) => (now += ms) };
}

const settle = () => new Promise((r) => setImmediate(r));

test('saying its name gets a spoken reply', async () => {
  const { brain, claude, speaker } = makeBrain({ replies: ['Gremlin: Mike, you walnut.'] });
  assert.equal(brain.hear({ name: 'Mike', text: 'gremlin what do you think of my build' }), 'direct');
  await settle();
  assert.equal(claude.calls.length, 1);
  assert.match(claude.calls[0].user, /Mike is talking to you/);
  assert.match(claude.calls[0].user, /Mike: gremlin what do you think of my build/);
  assert.deepEqual(speaker.said, [{ text: 'Mike, you walnut.', kind: 'direct' }]);
  assert.ok(brain.transcript.recent().some((l) => l.isBot && l.text === 'Mike, you walnut.'));
});

test('ordinary chatter with chattiness off never calls Claude', async () => {
  const { brain, claude } = makeBrain({ chattiness: 'off' });
  brain.hear({ name: 'Mike', text: 'pass me the shotgun' });
  brain.hear({ name: 'Jess', text: 'no' });
  brain.hear({ name: 'Mike', text: 'please' });
  await settle();
  assert.equal(claude.calls.length, 0);
});

test('"gremlin shut up" stops speech without asking Claude', async () => {
  const { brain, claude, speaker } = makeBrain();
  assert.equal(brain.hear({ name: 'Jess', text: 'Gremlin, shut up' }), 'stop');
  await settle();
  assert.equal(speaker.stops, 1);
  assert.equal(claude.calls.length, 0);
});

test('unprompted quips wait for enough chatter and a lull, and PASS stays silent', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { brain, claude, speaker, advance } = makeBrain({ chattiness: 'high', replies: ['[PASS]'] });
    advance(21000);
    brain.hear({ name: 'Mike', text: 'I just got bit' });
    brain.hear({ name: 'Jess', text: 'again?' });
    mock.timers.tick(1000);
    await settle();
    assert.equal(claude.calls.length, 0, 'needs at least 3 new lines on high');
    brain.hear({ name: 'Mike', text: 'it was a door this time' });
    mock.timers.tick(799);
    await settle();
    assert.equal(claude.calls.length, 0, 'waits for a lull');
    mock.timers.tick(1);
    await settle();
    assert.equal(claude.calls.length, 1);
    assert.match(claude.calls[0].user, /Nobody is talking to you/);
    await settle();
    assert.equal(speaker.said.length, 0, 'PASS means silence');
  } finally {
    mock.timers.reset();
  }
});

test('quips do not open a follow-up window', async () => {
  const { brain, advance } = makeBrain({ replies: ['Quip line.'] });
  brain.request('quip', {});
  await settle();
  advance(2000);
  assert.notEqual(brain.hear({ name: 'Mike', text: 'lol ok' }), 'followup');
});

test('a quip that comes back too late is skipped', async () => {
  let release;
  const slow = () => new Promise((r) => (release = r));
  const { brain, speaker } = makeBrain({ replies: [slow] });
  brain.request('quip', {});
  await settle(); // the request is on its way
  brain.hear({ name: 'Mike', text: 'ok so anyway' });
  brain.hear({ name: 'Jess', text: 'moving on' });
  release({ text: 'Late joke.', refusal: false });
  await settle();
  await settle();
  assert.equal(speaker.said.length, 0);
});

test('someone saying its name cancels a pending quip and gets answered', async () => {
  let quipSignal;
  const hangingQuip = (args) =>
    new Promise((_r, reject) => {
      quipSignal = args.signal;
      args.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const { brain, claude, speaker } = makeBrain({ replies: [hangingQuip, 'What do you want, Mike.'] });
  brain.request('quip', {});
  await settle();
  brain.hear({ name: 'Mike', text: 'grem what do you think' });
  await settle();
  await settle();
  assert.equal(quipSignal.aborted, true);
  assert.equal(claude.calls.length, 2);
  assert.deepEqual(speaker.said, [{ text: 'What do you want, Mike.', kind: 'direct' }]);
});

test('after it talks, replies without its name are considered (follow-up window)', async () => {
  const { brain, claude, speaker, advance } = makeBrain({ replies: ['Cry about it.', 'Still crying?'] });
  brain.hear({ name: 'Mike', text: 'gremlin roast jess' });
  await settle();
  advance(3000);
  assert.equal(brain.hear({ name: 'Jess', text: 'wow okay rude' }), 'followup');
  await settle();
  assert.equal(claude.calls.length, 2);
  assert.match(claude.calls[1].user, /talked right after you/);
  assert.equal(speaker.said.length, 2);
  advance(25000);
  assert.notEqual(brain.hear({ name: 'Jess', text: 'anyway' }), 'followup');
});

test('follow-ups keep the conversation going without its name, for a few turns', async () => {
  const replies = ['Answer.', 'Reply 1.', 'Reply 2.', 'Reply 3.', 'Reply 4.', 'Reply 5.', 'Too many.'];
  const { brain, claude, speaker, advance } = makeBrain({ replies });
  brain.hear({ name: 'Mike', text: 'gremlin what should we play' });
  await settle();
  for (let i = 1; i <= 5; i++) {
    advance(3000);
    assert.equal(brain.hear({ name: 'Mike', text: `comment number ${i}` }), 'followup', `comment ${i} is still part of the conversation`);
    await settle();
  }
  assert.equal(speaker.said.length, 6);
  assert.equal(claude.calls.length, 6);
  advance(3000);
  assert.notEqual(brain.hear({ name: 'Mike', text: 'and another thing' }), 'followup', 'after five in a row it needs its name again');
  await settle();
  assert.equal(claude.calls.length, 6);
});

test('on low chattiness, replies without its name get a shorter window and fewer turns', async () => {
  const replies = ['Answer.', 'Reply 1.', 'Reply 2.', 'Too many.'];
  const { brain, claude, advance } = makeBrain({ replies, chattiness: 'low' });
  brain.hear({ name: 'Mike', text: 'gremlin what should we play' });
  await settle();
  advance(14000);
  assert.notEqual(brain.hear({ name: 'Mike', text: 'that was a while ago' }), 'followup', 'the window is 12 s on low');
  brain.hear({ name: 'Mike', text: 'gremlin ok what should we play then' });
  await settle();
  for (let i = 1; i <= 2; i++) {
    advance(3000);
    assert.equal(brain.hear({ name: 'Mike', text: `comment number ${i}` }), 'followup', `comment ${i} still counts`);
    await settle();
  }
  advance(3000);
  assert.notEqual(brain.hear({ name: 'Mike', text: 'and another thing' }), 'followup', 'after two in a row it needs its name again');
  await settle();
  assert.equal(claude.calls.length, 4);
});

test('its own voice leaking through a mic is ignored', async () => {
  const { brain, claude, advance } = makeBrain({ replies: ['You are all terrible at this game.'] });
  brain.hear({ name: 'Mike', text: 'gremlin how are we doing' });
  await settle();
  advance(2000);
  assert.equal(brain.hear({ name: 'Jess', text: 'you are all terrible at this game' }), 'echo');
  await settle();
  assert.equal(claude.calls.length, 1);
});

test('quips and follow-ups use the fast model, direct asks use the main one', async () => {
  const main = fakeClaude(['Main model line.']);
  const fast = fakeClaude(['Fast quip.']);
  const speaker = fakeSpeaker();
  const brain = new Brain({
    config: baseConfig,
    claude: main,
    claudeFast: fast,
    speaker,
    getCallInfo: () => ({}),
    clock: () => 1_000_000,
  });
  brain.request('quip', {});
  await settle();
  brain.hear({ name: 'Mike', text: 'gremlin you good' });
  await settle();
  assert.equal(fast.calls.length, 1);
  assert.equal(main.calls.length, 1);
  assert.match(main.calls[0].user, /Mike is talking to you/);
});

test('a refusal on a direct question becomes an in-character dodge', async () => {
  const { brain, speaker } = makeBrain({ replies: [() => ({ text: '', refusal: true })] });
  brain.hear({ name: 'Mike', text: 'gremlin say something terrible' });
  await settle();
  assert.equal(speaker.said.length, 1);
  assert.ok(speaker.said[0].text.length > 5);
});

// When they were talking, for hear(): the fake speaker decides whether that overlapped it.
const spoke = { startedAt: 1_000_000, spokeUntil: 1_001_000 };

test('saying its name while it is talking stops it and answers instead', async () => {
  const { brain, claude, speaker } = makeBrain({ replies: ['What, Mike.'] });
  speaker.speaking = true;
  speaker.talkedOver = true;
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin what did you just call me', ...spoke }), 'direct');
  assert.equal(speaker.stops, 1);
  speaker.speaking = false;
  await settle();
  assert.equal(claude.calls.length, 1);
  assert.deepEqual(speaker.said, [{ text: 'What, Mike.', kind: 'direct' }]);
});

test('ordinary talking over it does not stop it', async () => {
  const { brain, speaker } = makeBrain({ chattiness: 'off' });
  speaker.speaking = true;
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'hahaha that is so true' }), 'heard');
  assert.equal(speaker.stops, 0);
});

test('after a cut-in, their finished sentence is treated as talking to it, once', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off', replies: ['Your mom is lovely, actually.'] });
  speaker.speaking = true;
  brain.cutIn('u1');
  assert.equal(speaker.stops, 1);
  speaker.speaking = false;
  // The full transcript lost the name ("gremlin" came out as "grandma"): still answered.
  assert.equal(brain.hear({ userId: 'u2', name: 'Jess', text: 'oh no here we go' }), 'heard', 'only the person who cut in');
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'grandma what did you just say about my mom' }), 'direct');
  await settle();
  assert.equal(claude.calls.length, 1);
  assert.match(claude.calls[0].user, /Mike is talking to you/);
  assert.equal(speaker.said.length, 1);
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'anyway' }), 'heard', 'the cut-in is used up');
});

test('a cut-in expires if their sentence never arrives', () => {
  const { brain, advance } = makeBrain({ chattiness: 'off' });
  brain.cutIn('u1', 5);
  advance(65000);
  assert.equal(brain.hear({ userId: 'u1', id: 5, name: 'Mike', text: 'so anyway' }), 'heard');
});

test('a cut-in belongs to the sentence it was caught in, not an earlier one still being transcribed', async () => {
  const { brain, claude } = makeBrain({ chattiness: 'off', replies: ['What, Mike.'] });
  brain.cutIn('u1', 5);
  assert.equal(brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'jess cover me on the left' }), 'heard');
  assert.equal(brain.hear({ userId: 'u1', id: 5, name: 'Mike', text: 'grandma what are you even saying' }), 'direct');
  await settle();
  assert.equal(claude.calls.length, 1);
});

test('a cut-in is forgotten when its sentence comes back empty', () => {
  const { brain } = makeBrain({ chattiness: 'off' });
  brain.cutIn('u1', 5);
  brain.dropCutIn('u1', 5);
  assert.equal(brain.hear({ userId: 'u1', id: 6, name: 'Mike', text: 'jess grab the medkit' }), 'heard');
});

test('/shush forgets cut-ins that were waiting', () => {
  const { brain } = makeBrain({ chattiness: 'off' });
  brain.cutIn('u1', 5);
  brain.shush();
  assert.equal(brain.hear({ userId: 'u1', id: 5, name: 'Mike', text: 'so anyway' }), 'heard');
});

test('a cut-in that turns out to be its own voice echoing is not answered, and is forgotten', async () => {
  const { brain, claude } = makeBrain({ chattiness: 'off', replies: ['You are all terrible at this game.'] });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin how are we doing' });
  await settle();
  brain.cutIn('u2', 5);
  assert.equal(brain.hear({ userId: 'u2', id: 5, name: 'Jess', text: 'you are all terrible at this game' }), 'echo');
  assert.equal(brain.hear({ userId: 'u2', id: 6, name: 'Jess', text: 'lol nice' }), 'heard');
  await settle();
  assert.equal(claude.calls.length, 1);
});

test('an echo running from one of its lines into the next is still caught', async () => {
  const { brain } = makeBrain({ chattiness: 'off', replies: ['Gremlin is starving right now.', 'Mike your aim is a war crime.'] });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin you hungry' });
  await settle();
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin rate my aim' });
  await settle();
  assert.equal(brain.hear({ userId: 'u2', name: 'Jess', text: 'starving right now mike your aim is' }), 'echo');
});

test('"gremlin shut up" after a cut-in stays quiet', async () => {
  const { brain, claude } = makeBrain();
  brain.cutIn('u1');
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'Gremlin, shut up' }), 'stop');
  await settle();
  assert.equal(claude.calls.length, 0);
});

test('a cut-in throws away the reply still being written, and the next reply starts right away', async () => {
  let release;
  let firstSignal;
  const slow = (args) =>
    new Promise((r) => {
      firstSignal = args.signal;
      release = r; // never rejects on abort, like a request that is slow to notice
    });
  const { brain, claude, speaker } = makeBrain({ replies: [slow, 'Yes, Jess?'] });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin tell a story' });
  await settle();
  brain.cutIn('u2');
  assert.equal(firstSignal.aborted, true);
  brain.hear({ userId: 'u2', name: 'Jess', text: 'actually wait' });
  await settle();
  assert.equal(claude.calls.length, 2, 'did not wait for the old request to finish failing');
  release({ text: 'Once upon a time...', refusal: false });
  await settle();
  await settle();
  assert.deepEqual(speaker.said, [{ text: 'Yes, Jess?', kind: 'direct' }]);
});

test('a cut-in pauses follow-ups to everyone else until it answers', async () => {
  const { brain, advance } = makeBrain({ replies: ['Sure, Mike.'] });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin what time is it' });
  await settle();
  advance(2000);
  brain.cutIn('u2');
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'lol' }), 'heard');
});

test('lines cut off mid-way stay in the transcript marked as cut off; unsaid lines are removed', async () => {
  const { brain } = makeBrain({ replies: ['First line that got interrupted.', 'Second line nobody heard.'] });
  let n = 0;
  brain.speaker.say = (_text, { onStart }) => {
    n++;
    if (n === 1) onStart(); // started playing, then got stopped
    return Promise.resolve('stopped');
  };
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin first question' });
  await settle();
  await settle();
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin second question' });
  await settle();
  await settle();
  const botLines = brain.transcript.recent().filter((l) => l.isBot).map((l) => l.text);
  assert.deepEqual(botLines, ['First line that got interrupted. (got cut off here)']);
});

test('"Gremlin!" over it: stops, says nothing yet, and answers what they say next', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off', replies: ['I was getting to the good part.'] });
  speaker.speaking = true;
  speaker.talkedOver = true;
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin!', ...spoke }), 'listening');
  assert.equal(speaker.stops, 1);
  speaker.speaking = false;
  speaker.talkedOver = false;
  await settle();
  assert.equal(claude.calls.length, 0, 'waits for the rest');
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'why are you like this' }), 'direct');
  await settle();
  assert.equal(claude.calls.length, 1);
  assert.deepEqual(speaker.said, [{ text: 'I was getting to the good part.', kind: 'direct' }]);
});

test('calling it while it was quiet does not cut off a line that started after they finished', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off', replies: ['Patience, Mike.'] });
  speaker.speaking = true; // its answer to Mike's earlier question started right after he stopped
  speaker.talkedOver = false;
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'hey gremlin?', ...spoke }), 'acknowledged');
  assert.equal(speaker.stops, 0, 'the answer keeps playing');
  await settle();
  assert.deepEqual(speaker.said, [], 'the answer playing is reply enough: no "Yeah?" on top');
  assert.equal(claude.calls.length, 0);
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'what map are we on' }), 'direct', 'his next sentence is for it');
});

test('after "Gremlin, wait", a sentence started much later does not count', () => {
  const { brain, advance } = makeBrain({ chattiness: 'off' });
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, wait' }), 'listening');
  advance(15000);
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'so anyway', startedAt: 1_015_000 }), 'heard');
});

test('"hey Gremlin" while it is quiet gets a quick "Yeah?" or the like, not a whole reply', async () => {
  const { brain, claude, speaker } = makeBrain({ replies: ['What.'] });
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'hey gremlin' }), 'acknowledged');
  await settle();
  assert.equal(claude.calls.length, 0, 'nothing for Claude to write');
  assert.equal(speaker.said.length, 1);
  assert.equal(speaker.said[0].kind, 'ack');
  assert.ok(ACKS.includes(speaker.said[0].text));
  assert.ok(speaker.said[0].text.split(' ').length <= 3, 'brief');
  assert.ok(brain.transcript.recent().some((l) => l.isBot && l.text === speaker.said[0].text), 'it remembers saying it');
});

test('the quick replies to its name vary, and two calls at once get one', async () => {
  let r = 0;
  const { brain, speaker, advance } = makeBrain({ chattiness: 'off' });
  brain.random = () => [0, 0, 0.99][r++ % 3];
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin' });
  brain.hear({ userId: 'u2', name: 'Jess', text: 'hey gremlin' }); // at the same moment (or Mike's voice in Jess's mic)
  await settle();
  assert.equal(speaker.said.length, 1, 'one "Yeah?" for both');
  advance(5000);
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin!' });
  await settle();
  assert.equal(speaker.said.length, 2);
  assert.notEqual(speaker.said[1].text, speaker.said[0].text, 'not the same one twice in a row');
});

test('its own "Yeah?" coming back through a mic is not taken as someone talking to it', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off' });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin' });
  await settle();
  const ack = speaker.said[0].text;
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: ack.toLowerCase().replace(/[?.]/g, '') }), 'echo');
  assert.equal(claude.calls.length, 0);
  // Mike's real next sentence still counts as for it.
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'what map are we on' }), 'direct');
});

test('"Gremlin, hold on" waits for them even when it was quiet', async () => {
  const { brain, claude } = makeBrain({ chattiness: 'off', replies: ['Sure.'] });
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'Gremlin, hold on' }), 'listening');
  await settle();
  assert.equal(claude.calls.length, 0);
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'what was that thing you said earlier' }), 'direct');
});

test('an early cut-in whose full sentence was only its name keeps listening', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off', replies: ['Go on then.'] });
  speaker.speaking = true;
  brain.cutIn('u1');
  speaker.speaking = false;
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin gremlin' }), 'listening');
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'ok so here is my question' }), 'direct');
  await settle();
  assert.equal(claude.calls.length, 1);
});

test('"hey Gremlin" while it is still writing its hello: the hello is the reply, no "Yeah?" first', async () => {
  let release;
  const hello = () => new Promise((r) => (release = r));
  const { brain, claude, speaker } = makeBrain({ replies: [hello] });
  brain.greet();
  await settle();
  assert.equal(brain.hear({ userId: 'u1', name: 'Mike', text: 'hey gremlin' }), 'acknowledged');
  release({ text: 'Evening, degenerates.', refusal: false });
  await settle();
  await settle();
  assert.equal(claude.calls.length, 1);
  assert.deepEqual(speaker.said, [{ text: 'Evening, degenerates.', kind: 'greet' }]);
});

test('"hey Gremlin" while quiet gets a quick "Yeah?", and what they say next gets the real answer', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off', replies: ['The shotgun, obviously.'] });
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'hey gremlin' }), 'acknowledged');
  await settle();
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'what is the best gun for close range' }), 'direct');
  assert.deepEqual(speaker.stoppedKinds, ['ack'], 'the "Yeah?" gives way if it is still playing');
  assert.equal(speaker.stops, 0, 'nothing else is cut off');
  await settle();
  await settle();
  assert.equal(claude.calls.length, 1);
  assert.deepEqual(speaker.said.map((s) => s.kind), ['ack', 'direct']);
  assert.equal(speaker.said[1].text, 'The shotgun, obviously.');
});

test('with chattiness off, the question after a bare "Gremlin!" is still answered', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off', replies: ['Close range? Shotgun.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin!' });
  await settle();
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'best gun for close range' }), 'direct');
  await settle();
  assert.equal(claude.calls.length, 1);
  assert.deepEqual(speaker.said.map((s) => s.kind), ['ack', 'direct']);
});

test('if a reply someone asked for fails (say Claude credit ran out), the failure is reported once per ask', async () => {
  const failures = [];
  const broken = () => Promise.reject(Object.assign(new Error('Claude API 400 invalid_request_error: credit balance is too low'), { status: 400 }));
  const claude = fakeClaude([broken, broken]);
  const brain = new Brain({
    config: baseConfig,
    claude,
    speaker: fakeSpeaker(),
    getCallInfo: () => ({}),
    chattiness: 'off',
    onReplyFailure: (kind, err) => failures.push([kind, err.message]),
    clock: () => 1_000_000,
  });
  brain.hear({ userId: 'u1', name: 'Mike', text: 'gremlin what time is it' });
  await settle();
  await settle();
  assert.deepEqual(failures, [['direct', 'Claude API 400 invalid_request_error: credit balance is too low']]);
  brain.request('quip', {});
  await settle();
  await settle();
  assert.equal(failures.length, 1, 'unprompted lines fail quietly');
});

test('after a bare "Gremlin!", the next line is answered, but may be passed on if it was clearly for someone else', async () => {
  const { brain, claude, speaker } = makeBrain({ chattiness: 'off', replies: ['[PASS]', 'Shotgun.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin' }); // misheard: Mike wasn't calling it
  await settle();
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'jess grab the ammo on your left' }), 'direct');
  await settle();
  assert.match(claude.calls[0].user, /A moment ago they said your name/);
  assert.match(claude.calls[0].user, /\[PASS\]/);
  assert.deepEqual(speaker.said.map((s) => s.kind), ['ack'], 'nothing said to a line meant for Jess');
  // Saying its name in the sentence itself is never second-guessed.
  brain.hear({ userId: 'u2', id: 3, name: 'Jess', text: 'gremlin best gun for close range' });
  await settle();
  assert.doesNotMatch(claude.calls[1].user, /A moment ago/);
  assert.deepEqual(speaker.said.map((s) => s.kind), ['ack', 'direct']);
});
