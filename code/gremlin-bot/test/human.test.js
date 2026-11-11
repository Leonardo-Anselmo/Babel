// Sounding like a person in the call instead of a bot: not opening every line the
// same way, a quick "Hmm." before a slow answer, laughing along with the group,
// and saying hi and bye.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { LAUGHS, THINKING_SOUNDS, isCancelSong, isGoodbye, isQuestion, openerKey, pickFresh, varyOpening } from '../src/human.js';
import { TASKS } from '../src/prompts.js';

// ---------------------------------------------------------------------------
// The helpers
// ---------------------------------------------------------------------------

test('a laugh to open a line is dropped right after it laughed; one laugh a line at most; nothing else changes', () => {
  assert.equal(varyOpening("[laughs] Ha, that's wild.", { laughedLately: true }), "That's wild.");
  assert.equal(varyOpening('Haha, no way he did that.', { laughedLately: true }), 'No way he did that.');
  assert.equal(varyOpening("Oh man, that's rough. [laughs]", { laughedLately: true }), "Oh man, that's rough.");
  assert.equal(varyOpening('[laughs] Okay [laughs] fine [laughs].', {}), '[laughs] Okay fine.', 'only the first laugh stays');
  assert.equal(varyOpening("[laughs] Ha, that's wild.", {}), "[laughs] Ha, that's wild.", 'not laughed lately: as written');
  assert.equal(varyOpening('first answer', {}), 'first answer', 'untouched lines stay exactly as written');
  assert.equal(varyOpening('Haha.', { laughedLately: true }), 'Haha.', 'never leaves a line with nothing to say');
  assert.equal(varyOpening('[laughs]', { laughedLately: true }), '[laughs]');
  assert.equal(varyOpening('ha, sure thing buddy', { laughedLately: true, opening: false }), 'ha, sure thing buddy', 'later sentences keep their words');
});

test('after its own "Hmm." the answer does not open with another one', () => {
  assert.equal(varyOpening('Hmm, the shotgun, no question.', { afterSound: true }), 'The shotgun, no question.');
  assert.equal(varyOpening('Okay so, Jinx is the pick.', { afterSound: true }), 'Jinx is the pick.');
  assert.equal(varyOpening('[excited] Oh, the shotgun for sure.', { afterSound: true }), '[excited] The shotgun for sure.');
  assert.equal(varyOpening('Oh.', { afterSound: true }), 'Oh.');
  assert.equal(varyOpening('Hmm, the shotgun.', {}), 'Hmm, the shotgun.', 'no "Hmm." was said: as written');
});

test('how a line opens, and picking a sound it did not just use', () => {
  assert.equal(openerKey('[laughs] Okay'), 'laugh');
  assert.equal(openerKey('Hahaha, sure'), 'laugh');
  assert.equal(openerKey('[sighs] Fine'), '[sighs]');
  assert.equal(openerKey("Nah, that's wrong"), 'nah');
  const recent = THINKING_SOUNDS.slice(0, 3);
  for (let i = 0; i < 20; i++) assert.ok(!recent.includes(pickFresh(THINKING_SOUNDS, recent, Math.random)));
  assert.equal(pickFresh(['a'], ['a'], () => 0), 'a', 'only one choice: that one');
});

test('goodbyes are told apart from lines that only sound like one', () => {
  for (const t of ["Alright guys, I'm heading out.", 'gn', 'Good night guys', 'bye yall', "Okay I'm out", 'I gotta go', 'gotta head out', "I'm gonna hop off", 'Peace out', 'See you guys tomorrow', 'I have to go to bed', 'logging off for tonight', 'ok bye for real', 'night guys fr']) {
    assert.equal(isGoodbye(t), true, t);
  }
  for (const t of ["I'm out of ammo", 'later', "I'll do it later", 'gotta go pee', 'say goodbye to your base', 'he said bye to the team and then died', 'I need to go left', 'peace was never an option for this team', 'for real though that was crazy', "yeah I'm off tomorrow"]) {
    assert.equal(isGoodbye(t), false, t);
  }
});

test('questions: a question mark, or a question word past its name and fillers', () => {
  assert.equal(isQuestion('Gremlin, what is the best gun?', ['gremlin']), true);
  assert.equal(isQuestion('gremlin what is the best gun', ['gremlin']), true);
  assert.equal(isQuestion('hey gremlin so how do I buy it', ['gremlin']), true);
  assert.equal(isQuestion('gremlin tell me a joke', ['gremlin']), false);
  assert.equal(isQuestion('Gremlin, roast Mike.', ['gremlin']), false);
  // Without a "?", "do", "is" and "should" too often start something else.
  assert.equal(isQuestion('Gremlin, do it', ['gremlin']), false);
  assert.equal(isQuestion('gremlin is the best', ['gremlin']), false);
  assert.equal(isQuestion('Gremlin, should we push?', ['gremlin']), true);
});

test('calling off a song it is still making: short, a command, nothing else asked', () => {
  const a = ['gremlin'];
  for (const t of ['Gremlin, cancel the song', 'gremlin never mind', 'Gremlin, nah, forget it', "gremlin actually don't make it", 'Gremlin, stop the song please', 'cancel it'])
    assert.equal(isCancelSong(t, a), true, t);
  for (const t of ['Gremlin, cancel my reminder', 'Gremlin, forget it, what is the weather?', 'Gremlin never mind that, what about Darius', 'I never mind a good song', 'Gremlin, cancel?'])
    assert.equal(isCancelSong(t, a), false, t);
});

test('the hi and bye tasks use the names the group uses and may pass', () => {
  const hi = TASKS.welcome({ names: ['Circadian'] });
  assert.match(hi, /Circadian just joined the voice call/);
  assert.match(hi, /the name the group uses for them/);
  assert.match(hi, /\[PASS\]/);
  assert.match(TASKS.welcome({ names: ['Circadian', 'weevil'] }), /Circadian and weevil just joined/);
  const bye = TASKS.farewell({ name: 'Marthxander' });
  assert.match(bye, /Marthxander just said they're heading out/);
  assert.match(bye, /\[PASS\]/);
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
  tts: { audioTags: true },
  transcript: { maxLines: 40, maxMinutes: 15 },
  anthropic: { webSearch: { enabled: false } },
};

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function manualSpeaker() {
  const lines = [];
  return {
    lines,
    speaking: false,
    committed: false,
    wasAudibleBetween: () => false,
    nowPlaying() {
      const l = lines.find((x) => x.started && !x.outcome);
      return l ? { kind: l.kind } : null;
    },
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
    stop() {
      this.stopped = (this.stopped || 0) + 1;
      for (const l of lines) l.resolve?.('stopped');
    },
    stopKind() {},
    dropOptional() {},
  };
}

/** A Claude whose replies come back only when released (or right away, given text). */
function fakeClaude(replies = []) {
  const calls = [];
  const queue = [...replies];
  return {
    calls,
    async createMessage(args) {
      calls.push(args);
      const next = queue.length ? queue.shift() : '[PASS]';
      const text = typeof next === 'function' ? await next() : await next;
      if (text && text !== '[PASS]') args.onText?.(text);
      return { text, refusal: false };
    },
  };
}

function setup({ config = {}, replies = [], chattiness = 'medium', random = () => 0, joinedAt = null } = {}) {
  let now = 50_000_000;
  const speaker = manualSpeaker();
  const claude = fakeClaude(replies);
  const brain = new Brain({
    config: { ...baseConfig, ...config },
    claude,
    speaker,
    chattiness,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess', 'Ana'], activities: [] }),
    getJoinedAt: joinedAt ? () => joinedAt() : undefined,
    clock: () => now,
    random,
  });
  return { brain, speaker, claude, now: () => now, advance: (ms) => (now += ms) };
}

test('a slow answer to a question gets a quick "Hmm." first, and the answer does not open with another one', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let release;
    const answer = '<say>Hmm, the shotgun, no question.</say>';
    const s = setup({ config: { thinkingSounds: true }, replies: [() => new Promise((r) => (release = () => r(answer)))] });
    const t = s.now();
    s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, what is the best gun?', at: t, startedAt: t - 1800, spokeUntil: t - 900 });
    await settle();
    assert.deepEqual(s.speaker.lines, [], 'not right away');
    s.advance(600);
    mock.timers.tick(600); // 1.5 s after Mike stopped talking
    assert.deepEqual(
      s.speaker.lines.map((l) => [l.kind, l.text]),
      [['think', 'Hmm.']],
    );
    s.speaker.start(0);
    s.speaker.finish(0);
    release();
    await settle();
    const said = s.speaker.lines.find((l) => l.kind === 'direct');
    assert.equal(said.text, 'The shotgun, no question.');
    // Another question a minute later: no second "Hmm." (at most every couple of minutes).
    s.advance(60000);
    s.speaker.start(1);
    s.speaker.finish(1);
    await settle();
    const t2 = s.now();
    s.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'Gremlin, and the best armor?', at: t2, startedAt: t2 - 1500, spokeUntil: t2 - 900 });
    await settle();
    mock.timers.tick(3000);
    await settle();
    assert.equal(s.speaker.lines.filter((l) => l.kind === 'think').length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('no "Hmm." for a request that is not a question, when the answer is quick, after a bare name call, or with the setting off', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const [config, text, extra] of [
      [{ thinkingSounds: true }, 'Gremlin, tell me a joke.', {}],
      [{ thinkingSounds: false }, 'Gremlin, what is the best gun?', {}],
      [{}, 'Gremlin, what is the best gun?', {}],
    ]) {
      let release;
      const s = setup({ config, replies: [() => new Promise((r) => (release = () => r('<say>Sure.</say>')))] });
      const t = s.now();
      s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text, at: t, startedAt: t - 1500, spokeUntil: t - 900, ...extra });
      await settle();
      s.advance(3000);
      mock.timers.tick(3000);
      assert.equal(s.speaker.lines.filter((l) => l.kind === 'think').length, 0, `${text} ${JSON.stringify(config)}`);
      release();
      await settle();
    }
    // Quick: the answer is on its way before the moment passes.
    const s = setup({ config: { thinkingSounds: true }, replies: ['<say>The shotgun.</say>'] });
    const t = s.now();
    s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, best gun?', at: t, startedAt: t - 1500, spokeUntil: t - 900 });
    await settle();
    s.advance(3000);
    mock.timers.tick(3000);
    assert.deepEqual(
      s.speaker.lines.map((l) => l.kind),
      ['direct'],
    );
    // After a bare "Gremlin!" (answered with "Yeah?"), the next line may turn out not to be for it.
    const called = setup({ config: { thinkingSounds: true }, replies: [() => new Promise(() => {})] });
    const t2 = called.now();
    called.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin!', at: t2, startedAt: t2 - 600, spokeUntil: t2 - 300 });
    called.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'what is the best gun?', at: t2 + 2000, startedAt: t2 + 500, spokeUntil: t2 + 1100 });
    await settle();
    called.advance(3000);
    mock.timers.tick(3000);
    assert.deepEqual(
      called.speaker.lines.map((l) => l.kind),
      ['ack'],
    );
    // The chance roll: half the time there's no sound at all.
    const noRoll = setup({ config: { thinkingSounds: true }, random: () => 0.9, replies: [() => new Promise(() => {})] });
    const t3 = noRoll.now();
    noRoll.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, best gun?', at: t3, startedAt: t3 - 1500, spokeUntil: t3 - 900 });
    await settle();
    mock.timers.tick(3000);
    assert.equal(noRoll.speaker.lines.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test('its answers do not keep opening with a laugh, and the prompt says how its last lines started', async () => {
  const replies = ['<say>[laughs] Ha, that is so true.</say>', '<say>[laughs] Okay, that one got me.</say>', '<say>Haha, fair enough Mike.</say>'];
  const s = setup({ replies, chattiness: 'off' });
  for (let i = 0; i < 3; i++) {
    s.brain.hear({ userId: 'u1', id: i + 1, name: 'Mike', text: `Gremlin, line ${i}` });
    await settle();
    const line = s.speaker.lines.at(-1);
    s.speaker.start(s.speaker.lines.length - 1);
    s.speaker.finish(s.speaker.lines.length - 1);
    await settle();
    s.advance(20000);
    assert.ok(line);
  }
  assert.deepEqual(
    s.speaker.lines.map((l) => l.text),
    ['[laughs] Ha, that is so true.', 'Okay, that one got me.', 'Fair enough Mike.'],
  );
  // Right after a line that opened with a laugh, the task says so; once it's moved on, nothing.
  assert.match(String(s.claude.calls[1].user), /Your last few lines started with a laugh too often: start this one some other way\./);
  assert.doesNotMatch(String(s.claude.calls[2].user), /Your last few lines started with/);
  // The same start twice in its last few lines: named.
  s.brain.recentOpeners = ['okay', 'so', 'okay'];
  assert.equal(s.brain.openerHint(), ' (Your last few lines started with "Okay" too often: start this one some other way.)');
  s.brain.recentOpeners = ['so', 'well', 'right'];
  assert.equal(s.brain.openerHint(), '');
  // In a fresh call it may open with a laugh.
  const later = setup({ replies: ['<say>[laughs] Okay, you win.</say>'], chattiness: 'off' });
  later.brain.hear({ userId: 'u1', id: 9, name: 'Mike', text: 'Gremlin, one more' });
  await settle();
  assert.equal(later.speaker.lines[0].text, '[laughs] Okay, you win.');
});

test('it laughs along now and then when the group cracks up, never at its own line', async () => {
  // One person laughing: a 35% chance (the roll here is 0.5, so no).
  const s = setup({ config: { laughAlong: true }, random: () => 0.5, chattiness: 'low' });
  s.advance(60000);
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'hahaha' });
  await settle();
  assert.equal(s.speaker.lines.length, 0, 'one person: not this time');
  // Jess cracks up too: 75% (0.5 is under it).
  s.advance(1500);
  s.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'lmao' });
  await settle();
  assert.deepEqual(
    s.speaker.lines.map((l) => l.kind),
    ['laugh'],
  );
  assert.ok(LAUGHS.includes(s.speaker.lines[0].text));
  assert.equal(s.brain.transcript.lines.filter((l) => l.isBot).length, 0, 'not a line in the conversation');
  s.speaker.start(0);
  s.speaker.finish(0);
  await settle();
  // Its own laugh coming back through a mic is its own voice, not someone laughing.
  assert.equal(s.brain.hear({ userId: 'u3', id: 3, name: 'Ana', text: s.speaker.lines[0].text.replace(/\[[^\]]*\]\s*/g, '') }), 'echo');
  // Another laugh a minute later: not again so soon.
  s.advance(60000);
  s.brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'hahaha' });
  s.brain.hear({ userId: 'u2', id: 5, name: 'Jess', text: 'lol' });
  await settle();
  assert.equal(s.speaker.lines.length, 1);

  // People laughing at its own line: that's for them.
  const own = setup({ config: { laughAlong: true }, random: () => 0, chattiness: 'low', replies: ['<say>Nice try, Mike.</say>'] });
  own.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, say something' });
  await settle();
  own.speaker.start(0);
  own.speaker.finish(0);
  await settle();
  own.advance(3000);
  own.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'hahaha' });
  own.brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'lmao' });
  await settle();
  assert.equal(own.speaker.lines.filter((l) => l.kind === 'laugh').length, 0);

  // Off: with the setting off, or chattiness off.
  for (const [config, chattiness] of [[{ laughAlong: false }, 'low'], [{ laughAlong: true }, 'off']]) {
    const off = setup({ config, random: () => 0, chattiness });
    off.advance(60000);
    off.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'hahaha' });
    off.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'hahaha' });
    await settle();
    assert.equal(off.speaker.lines.length, 0);
  }
});

test('its own laugh in someone\'s mic is an echo only while it plays or just after, so laughs at its next joke count', async () => {
  const s = setup({ config: { laughAlong: true }, chattiness: 'medium', random: () => 0, replies: ['<say>Mike plays like his monitor is off.</say>'] });
  s.advance(60000);
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'hahaha' });
  await settle();
  assert.deepEqual(
    s.speaker.lines.map((l) => l.kind),
    ['laugh'],
  );
  const laughAt = s.now();
  s.speaker.start(0);
  // Its "Haha." through Jess's mic while it plays: its own voice.
  s.advance(300);
  assert.equal(s.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'Haha.', at: s.now(), startedAt: laughAt + 100, spokeUntil: s.now() }), 'echo');
  s.advance(400);
  s.speaker.finish(0);
  await settle();
  // A joke right after, and people crack up at it: those are laughs, not its echo.
  s.brain.request('quip', {});
  await settle();
  const q = s.speaker.lines.findIndex((l) => l.kind === 'quip');
  s.advance(1000);
  s.speaker.start(q);
  s.advance(2500);
  s.speaker.finish(q);
  await settle();
  s.advance(500);
  const t = s.now();
  assert.notEqual(s.brain.hear({ userId: 'u3', id: 3, name: 'Ana', text: 'haha', at: t, startedAt: t - 600, spokeUntil: t - 100 }), 'echo');
  assert.equal(s.brain.joke?.laughs, 1);
});

test('someone joining gets a quick hi (once it has been in the call a minute), once per half hour', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const s = setup({ config: { helloGoodbye: true }, chattiness: 'low', replies: ['<say>Hey Carlo, just in time.</say>'] });
    s.brain.someoneJoined({ userId: 'u3', name: 'Circadian' });
    mock.timers.tick(5000);
    await settle();
    assert.equal(s.claude.calls.length, 0, 'it just got here: its own hello covered everyone');
    s.advance(90000);
    s.brain.someoneJoined({ userId: 'u4', name: 'weevil' });
    s.brain.someoneJoined({ userId: 'u3', name: 'Circadian' }); // (the first time was too early to count)
    mock.timers.tick(4000);
    await settle();
    assert.equal(s.claude.calls.length, 1, 'joins close together get one hi');
    assert.match(String(s.claude.calls[0].user), /weevil and Circadian just joined the voice call/);
    assert.deepEqual(
      s.speaker.lines.map((l) => [l.kind, l.text]),
      [['welcome', 'Hey Carlo, just in time.']],
    );
    s.speaker.start(0);
    s.speaker.finish(0);
    await settle();
    s.advance(60000);
    s.brain.someoneJoined({ userId: 'u4', name: 'weevil' });
    mock.timers.tick(5000);
    await settle();
    assert.equal(s.claude.calls.length, 1, 'not twice in half an hour');

    const off = setup({ config: { helloGoodbye: true }, chattiness: 'off' });
    off.advance(90000);
    off.brain.someoneJoined({ userId: 'u3', name: 'Circadian' });
    mock.timers.tick(5000);
    await settle();
    assert.equal(off.claude.calls.length, 0, 'chattiness off: no hi');
  } finally {
    mock.timers.reset();
  }
});

test('a hi nobody heard (no pause for it) does not make what the newcomer says next look like a reply to it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const s = setup({ config: { helloGoodbye: true }, chattiness: 'low', replies: ['<say>Hey Carlo, just in time.</say>'] });
    s.advance(90000);
    s.brain.someoneJoined({ userId: 'u9', name: 'Carlo' });
    mock.timers.tick(4000);
    await settle();
    assert.deepEqual(
      s.speaker.lines.map((l) => l.kind),
      ['welcome'],
    );
    assert.equal(s.brain.talkingWith.has('u9'), false, 'not before it is heard');
    s.speaker.finish(0, 'dropped');
    await settle();
    assert.equal(s.brain.hear({ userId: 'u9', id: 1, name: 'Carlo', text: 'hey guys what are we playing' }), 'heard');
    // Heard: Carlo is in the conversation.
    const t = setup({ config: { helloGoodbye: true }, chattiness: 'low', replies: ['<say>Hey Carlo.</say>'] });
    t.advance(90000);
    t.brain.someoneJoined({ userId: 'u9', name: 'Carlo' });
    mock.timers.tick(4000);
    await settle();
    t.speaker.start(0);
    assert.equal(t.brain.talkingWith.has('u9'), true);
    t.speaker.finish(0);
    await settle();
    assert.equal(t.brain.hear({ userId: 'u9', id: 1, name: 'Carlo', text: 'hey what are we playing' }), 'followup');
  } finally {
    mock.timers.reset();
  }
});

test('a "Hmm." that got dropped (no pause for it) does not stand in for "one sec" on a slow answer', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const s = setup({ config: { thinkingSounds: true, anthropic: { webSearch: { enabled: true } } }, replies: [() => new Promise(() => {})] });
    const t = s.now();
    s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, what is the best gun?', at: t, startedAt: t - 1800, spokeUntil: t - 900 });
    await settle();
    s.advance(600);
    mock.timers.tick(600);
    assert.deepEqual(
      s.speaker.lines.map((l) => l.kind),
      ['think'],
    );
    s.speaker.finish(0, 'dropped');
    await settle();
    s.advance(2900);
    mock.timers.tick(2900); // past 3.5 s, nobody talking
    await settle();
    assert.deepEqual(
      s.speaker.lines.map((l) => l.kind),
      ['think', 'filler'],
    );
  } finally {
    mock.timers.reset();
  }
});

test('someone heading out after a while gets a bye; not right after joining, and one bye at a time', async () => {
  let joined = 0;
  const s = setup({ config: { helloGoodbye: true }, chattiness: 'low', replies: ['<say>Night, Alex!</say>'], joinedAt: () => joined });
  joined = s.now() - 2 * 60000; // two minutes in
  assert.equal(s.brain.hear({ userId: 'u1', id: 1, name: 'Marthxander', text: "Alright guys, I'm heading out." }), 'heard', 'only just got here');
  joined = s.now() - 20 * 60000;
  assert.equal(s.brain.hear({ userId: 'u2', id: 2, name: 'Marthxander', text: 'gn guys' }), 'farewell');
  await settle();
  assert.match(String(s.claude.calls[0].user), /Marthxander just said they're heading out/);
  assert.deepEqual(
    s.speaker.lines.map((l) => [l.kind, l.text]),
    [['farewell', 'Night, Alex!']],
  );
  assert.equal(s.brain.hear({ userId: 'u3', id: 3, name: 'Circadian', text: 'bye yall' }), 'heard', 'one bye at a time');
  assert.equal(s.brain.hear({ userId: 'u4', id: 4, name: 'weevil', text: "I'm out of ammo" }), 'heard');
});

test('a bye does not end the conversation it was having with someone else', async () => {
  const s = setup({ config: { helloGoodbye: true }, chattiness: 'medium', replies: ['<say>The shotgun.</say>', '<say>Later, Alex!</say>'], joinedAt: () => 0 });
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, best gun?' });
  await settle();
  s.speaker.start(0);
  s.speaker.finish(0);
  await settle();
  const window = s.brain.engagedUntil;
  assert.ok(window > s.now());
  s.advance(2000);
  s.brain.hear({ userId: 'u2', id: 2, name: 'Marthxander', text: 'aight I gotta go' });
  await settle();
  assert.equal(s.speaker.lines.at(-1).kind, 'farewell');
  assert.equal(s.brain.engagedUntil, window, 'still talking with Mike');
  assert.ok(s.brain.talkingWith.has('u1'));
});
