// Group conversation: several people asking at once, pauses mid-question, and
// the small checks that keep it from talking over or past people.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { cleanSpoken } from '../src/prompts.js';

const baseConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  timezone: 'UTC',
  defaultChattiness: 'off',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
  anthropic: { webSearch: { enabled: false } },
};

function fakeClaude(replies, extra = {}) {
  const calls = [];
  const queue = [...replies];
  return {
    calls,
    ...extra,
    async createMessage(args) {
      calls.push(args);
      const next = queue.shift();
      if (typeof next === 'function') return next(args);
      return { text: next ?? '[PASS]', refusal: false };
    },
  };
}

/** A reply you release by hand. */
function held() {
  let release;
  let signal;
  const fn = (args) =>
    new Promise((resolve, reject) => {
      signal = args.signal;
      release = (text) => resolve({ text, refusal: false });
      args.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return { fn, release: (text) => release(text), signal: () => signal };
}

/**
 * A speaker whose lines start only when told (start(i)) and finish when told (finish(i)),
 * so a test can catch a line that's written but not playing yet.
 */
function fakeSpeaker() {
  const lines = [];
  return {
    lines,
    stops: 0,
    stoppedKinds: [],
    speaking: false,
    talkedOver: false,
    wasAudibleBetween() {
      return this.talkedOver;
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
      this.stops++;
      for (const l of lines) if (!l.outcome) l.resolve('stopped');
    },
    stopKind(kind) {
      this.stoppedKinds.push(kind);
    },
    dropOptional() {},
  };
}

function setup({ replies = [], claudeExtra = {}, config = {}, speaking = () => false, hearingFrom = () => false } = {}) {
  let now = 5_000_000;
  const claude = fakeClaude(replies, claudeExtra);
  const speaker = fakeSpeaker();
  const brain = new Brain({
    config: { ...baseConfig, ...config },
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess', 'Ana'], activities: [] }),
    isSpeaking: speaking,
    isHearingFrom: hearingFrom,
    clock: () => now,
  });
  return { brain, claude, speaker, advance: (ms) => (now += ms), now: () => now };
}

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

test('the sentence after a bare "Gremlin!" does not cut off an answer someone else is getting', async () => {
  const jess = held();
  const { brain, claude, speaker } = setup({ replies: [jess.fn, 'Nine thirty.'] });
  assert.equal(brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'gremlin which map is best' }), 'direct');
  await settle();
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin' }), 'acknowledged');
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'what time is it' }), 'direct');
  assert.equal(jess.signal().aborted, false, "Jess's answer is still being written");
  jess.release('Rosewood, easy.');
  await settle();
  speaker.start(0);
  await settle();
  assert.equal(claude.calls.length, 2, "Mike's question is answered next");
  assert.deepEqual(speaker.lines.map((l) => l.text), ['Rosewood, easy.', 'Nine thirty.']);
  assert.equal(speaker.stops, 0, 'nobody got cut off');
  assert.deepEqual(speaker.stoppedKinds, ['ack']);
});

test('someone taking the floor still gets the others an answer: the reply covers everyone who was waiting', async () => {
  const mike = held();
  const { brain, claude, speaker } = setup({ replies: [mike.fn, 'Short version: all of you are wrong.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin is the shotgun good' });
  await settle();
  brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'gremlin what about the rifle' }); // waits its turn
  speaker.talkedOver = true; // Ana says its name over it
  assert.equal(brain.hear({ userId: 'u3', id: 3, name: 'Ana', text: 'gremlin settle this', startedAt: 4_999_000, spokeUntil: 5_000_000 }), 'direct');
  await settle();
  assert.equal(mike.signal().aborted, true, 'the old answer is dropped');
  assert.equal(claude.calls.length, 2);
  assert.match(claude.calls[1].user, /Mike, Jess and Ana are talking to you/);
  assert.equal(speaker.lines.at(-1).text, 'Short version: all of you are wrong.');
});

test('"Gremlin, shut up" forgets who was waiting', async () => {
  const mike = held();
  const { brain, claude } = setup({ replies: [mike.fn, 'Fine.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin is the shotgun good' });
  await settle();
  assert.equal(brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'gremlin shut up' }), 'stop');
  brain.hear({ userId: 'u2', id: 3, name: 'Jess', text: 'gremlin what time is it' });
  await settle();
  assert.match(claude.calls[1].user, /Jess is talking to you/);
});

test('a pause mid-question: the answer to the first half is dropped and the whole question answered', async () => {
  const first = held();
  const { brain, claude, speaker } = setup({ replies: [first.fn, 'Medic with the grenade launcher.'] });
  const t0 = 5_000_000;
  assert.equal(brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what is the best build for', startedAt: t0 - 2000, spokeUntil: t0 - 700 }), 'direct');
  await settle();
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'a support main', startedAt: t0 + 500, spokeUntil: t0 + 1200 }), 'continued');
  await settle();
  assert.equal(first.signal().aborted, true);
  assert.equal(claude.calls.length, 2);
  assert.match(claude.calls[1].user, /Mike: gremlin what is the best build for\n.*Mike: a support main/);
  assert.deepEqual(speaker.lines.map((l) => l.text), ['Medic with the grenade launcher.']);
});

test('a pause mid-question after the answer was written but before it played: the written answer is taken back', async () => {
  const { brain, claude, speaker } = setup({ replies: ['Probably medic.', 'Medic, with the launcher.'] });
  const t0 = 5_000_000;
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin best build for', startedAt: t0 - 2000, spokeUntil: t0 - 700 });
  await settle();
  assert.equal(speaker.lines.length, 1, 'written and waiting for a gap');
  assert.equal(typeof speaker.lines[0].opts.hold, 'function', 'it waits a bit longer while Mike keeps talking');
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'a support main', startedAt: t0 + 800, spokeUntil: t0 + 1500 }), 'continued');
  await settle();
  assert.equal(speaker.lines[0].outcome, 'dropped');
  assert.equal(claude.calls.length, 2);
  assert.deepEqual(speaker.lines.map((l) => l.text), ['Probably medic.', 'Medic, with the launcher.']);
  assert.ok(!brain.transcript.recent().some((l) => l.text === 'Probably medic.'), 'the unsaid answer is gone from the transcript');
});

test('not a continuation: laughter, a later sentence, someone else, or an answer already playing', async () => {
  const t0 = 5_000_000;
  {
    const first = held();
    const { brain } = setup({ replies: [first.fn] });
    brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin best build for', startedAt: t0 - 2000, spokeUntil: t0 - 700 });
    await settle();
    assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'haha', startedAt: t0, spokeUntil: t0 + 300 }), 'heard');
    assert.equal(brain.hear({ userId: 'u2', id: 3, name: 'Jess', text: 'a support main', startedAt: t0, spokeUntil: t0 + 700 }), 'heard');
    assert.equal(brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'anyway', startedAt: t0 + 1800, spokeUntil: t0 + 2300 }), 'heard', 'started 2.5 s after the question');
    assert.equal(first.signal().aborted, false);
  }
  {
    const { brain, claude, speaker } = setup({ replies: ['Medic.'] });
    brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin best build for', startedAt: t0 - 2000, spokeUntil: t0 - 700 });
    await settle();
    speaker.start(0); // already answering out loud
    assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'a support main', startedAt: t0, spokeUntil: t0 + 700 }), 'heard');
    assert.equal(claude.calls.length, 1);
  }
});

test('an answer holds while the person who asked is still talking or being transcribed', async () => {
  let mikeTalking = false;
  let mikeTranscribing = false;
  const { brain, speaker } = setup({
    replies: ['Medic.'],
    speaking: (u) => u === 'u1' && mikeTalking,
    hearingFrom: (u) => u === 'u1' && mikeTranscribing,
  });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin best build' });
  await settle();
  const hold = speaker.lines[0].opts.hold;
  assert.equal(hold(), false);
  mikeTalking = true;
  assert.equal(hold(), true);
  mikeTalking = false;
  mikeTranscribing = true;
  assert.equal(hold(), true);
});

test('after a bare "Gremlin!", a reply that starts with PASS is never spoken', async () => {
  const { brain, speaker } = setup({ replies: ['PASS - that was for Jess.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin' });
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'jess grab the ammo' });
  await settle();
  assert.deepEqual(speaker.lines.map((l) => l.kind), ['ack']);
});

test('a line with its name that quotes it back is someone talking to it, not an echo', async () => {
  const { brain, speaker } = setup({ replies: ['The shotgun is the best gun in the game.', 'Fight me.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin best gun' });
  await settle();
  speaker.start(0);
  speaker.finish(0);
  await settle();
  assert.equal(brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'the shotgun is the best gun in the game' }), 'echo');
  assert.equal(brain.hear({ userId: 'u2', id: 3, name: 'Jess', text: 'gremlin the shotgun is the best gun in the game' }), 'direct');
});

test('when web search is unavailable, the prompts and fillers do not pretend it can look things up', async () => {
  const config = { anthropic: { webSearch: { enabled: true } } };
  const on = setup({ replies: ['Patch notes say no.'], config, claudeExtra: { canSearchNow: true } });
  on.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin did they nerf the rifle' });
  await settle();
  assert.equal(on.claude.calls[0].search, true);
  assert.match(on.claude.calls[0].system[0].text, /<web_search>/);

  const off = setup({ replies: ['No idea, honestly.'], config, claudeExtra: { canSearchNow: false } });
  off.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin did they nerf the rifle' });
  await settle();
  assert.equal(off.claude.calls[0].search, false);
  assert.doesNotMatch(off.claude.calls[0].system[0].text, /<web_search>/);
});

test('jokes and follow-ups are said whole or not at all; answers are trimmed to fit', () => {
  const whole = { maxChars: 160, optional: true, wholeSentences: true };
  const runOn = 'And here is a second sentence that runs on and on '.repeat(4);
  const long = `${'word '.repeat(40).trim()} and then some more words to go past the limit`;
  // (Marked too long: a follow-up like that gets a proper answer instead.)
  assert.deepEqual(cleanSpoken(long, whole), { pass: true, text: '', tooLong: true }, 'would stop mid-sentence');
  assert.deepEqual(cleanSpoken(`Nah. ${runOn}`, whole), { pass: true, text: '', tooLong: true }, 'a stub is not worth saying');
  const first = 'That was a great play, honestly the best one all night.';
  assert.equal(cleanSpoken(`${first} ${runOn}`, whole).text, first);
  assert.deepEqual(cleanSpoken(`I asked my buddy who knows the game really well, Dr. ${runOn}`, whole), { pass: true, text: '', tooLong: true }, '"Dr." does not end a sentence');
  assert.ok(cleanSpoken(long, { maxChars: 160 }).text.length <= 160, 'an answer is cut to fit instead');
});

test('an answer that may pass: a marked pass is quiet, an answer that starts with the word is not', () => {
  const marked = { passMarked: true };
  assert.equal(cleanSpoken('PASS - that was for Jess.', marked).pass, true);
  assert.equal(cleanSpoken('Pass. Not for me.', marked).pass, true);
  assert.equal(cleanSpoken('PASS that was for Jess', marked).pass, true);
  assert.equal(cleanSpoken('Pass it to Jess, she has the better shot.', marked).text, 'Pass it to Jess, she has the better shot.');
  assert.equal(cleanSpoken('Pass on the shotgun, the rifle is better.', marked).pass, false);
});

test('the rest of a bare "Gremlin!" said while someone else\'s answer plays does not cut that answer off', async () => {
  const jess = held();
  const { brain, claude, speaker } = setup({ replies: [jess.fn, 'Nine thirty.'] });
  brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'gremlin which map is best' });
  await settle();
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin' }), 'acknowledged');
  jess.release('Rosewood, easy.');
  await settle();
  speaker.start(0); // Jess's answer starts while Mike is still asking
  speaker.talkedOver = true;
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'what time is it', startedAt: 4_999_000, spokeUntil: 5_000_000 }), 'direct');
  await settle();
  assert.equal(speaker.stops, 0, "Jess's answer keeps playing");
  assert.equal(claude.calls.length, 2);
  assert.match(claude.calls[1].user, /Mike is talking to you/);
});

test('asking again before the answer plays gets one answer for both, not two', async () => {
  const first = held();
  const { brain, claude, speaker } = setup({ replies: [first.fn, 'The rifle, at range.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin which gun is best' });
  await settle();
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin' });
  brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'which gun should I use' });
  await settle();
  assert.equal(first.signal().aborted, true);
  assert.equal(claude.calls.length, 2);
  assert.doesNotMatch(claude.calls[1].user, /A moment ago/, 'he asked by name, so this answer cannot be passed on');
  first.release('Too late.');
  await settle();
  assert.deepEqual(speaker.lines.map((l) => l.text), ['The rifle, at range.']);
});

test('a quick "yeah" or "okay" after a question does not start the answer over, and restarts are limited', async () => {
  const t0 = 5_000_000;
  const first = held();
  const { brain, claude } = setup({ replies: [first.fn, () => new Promise(() => {}), () => new Promise(() => {}), () => new Promise(() => {})] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin best build for', startedAt: t0 - 2000, spokeUntil: t0 - 700 });
  await settle();
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'yeah okay', startedAt: t0, spokeUntil: t0 + 300 }), 'heard');
  assert.equal(first.signal().aborted, false);
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'for a medic', startedAt: t0 + 900, spokeUntil: t0 + 1500 }), 'continued');
  assert.equal(brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'in the new patch', startedAt: t0 + 2200, spokeUntil: t0 + 2900 }), 'continued');
  assert.equal(brain.hear({ userId: 'u1', id: 5, name: 'Mike', text: 'with the launcher', startedAt: t0 + 3500, spokeUntil: t0 + 4000 }), 'heard', 'two restarts at most');
  await settle();
  // The first restart was replaced by the second before it was sent, so only two went out.
  assert.equal(claude.calls.length, 2);
  assert.equal(first.signal().aborted, true);
});

test('asking again while a slow answer is on its way (say, a web search) does not start it over', async () => {
  const slow = held();
  const { brain, claude, advance } = setup({ replies: [slow.fn, 'And the other thing.'] });
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what changed in the last patch' });
  await settle();
  advance(3000);
  assert.equal(brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin come on' }), 'acknowledged', 'a nudge is just calling it');
  assert.equal(brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'gremlin also is the rifle still good' }), 'direct');
  await settle();
  assert.equal(slow.signal().aborted, false, 'the slow answer keeps going');
  assert.equal(claude.calls.length, 1, 'the new question waits its turn');
});
