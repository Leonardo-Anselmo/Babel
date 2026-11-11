// Thinking out loud: describing what someone said ("Leonardo's asking me to..."),
// talking about the setup ("the user", "the transcript"), or reasoning before a
// [PASS]. None of it is ever said, and real lines are never mistaken for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain, SEARCH_CAME_UP_EMPTY } from '../src/brain.js';
import { buildSystem, cleanSpoken, cleanText, isThinkingOutLoud, sayContent, TASKS } from '../src/prompts.js';

// ---------------------------------------------------------------------------
// Which sentences count
// ---------------------------------------------------------------------------

test('describing what the person it is answering just asked, opening the reply, is thinking out loud', () => {
  for (const [s, askers] of [
    ["Leonardo's asking me to talk like his mommy.", ['Leonardo']],
    ['Sounds like Kneeheel wants a roast.', ['Kneeheel']],
    ['So Mike is asking about the new patch.', ['Mike']],
    ['Okay, so Mike wants to know the best build.', ['Mike']],
    ['Okay, Jess is wondering if the boss has a second phase.', ['Jess']],
    ['Kneeheel told me to roast Leonardo.', ['Kneeheel']],
    ["Mike's asking Leonardo about fries.", ['Mike']],
    ['Mike and Jess want to know who wins.', ['Mike', 'Jess']],
    ["Mike's question is about the patch.", ['Mike']],
    ["Mike's asking me to roast Kneeheel.", ['Big Mike 🎮']],
    ['Mike is asking for a roast.', ['Mike']],
    ['Jess wants a story about the war.', ['Jess']],
    ['Mike just asked me a question.', ['Mike']],
    ["Mike asked me, so I'll answer.", ['Mike']],
    ['Leonardo wants me to roast Mike, so let me think of one.', ['Leonardo']],
    ['Mike wants to know the best build and I should keep it short.', ['Mike']],
  ]) {
    assert.equal(isThinkingOutLoud(s, { first: true, askers }), true, s);
    assert.equal(isThinkingOutLoud(s, { first: false, askers }), false, `later in a reply it may be a real line: ${s}`);
  }
});

test('describing someone else is a recap, not thinking out loud', () => {
  // Ana asked what she missed.
  for (const s of ['Mike asked about doing the raid tonight.', 'Jess wants to know who is buying pizza.', 'Mike and Jess want to know who wins.', "He's asking me to talk like his mommy."]) {
    assert.equal(isThinkingOutLoud(s, { first: true, mayPass: true, askers: ['Ana'] }), false, s);
  }
  assert.equal(isThinkingOutLoud('Mike and I want to know who ate the last slice.', { first: true, askers: ['Mike'] }), false);
  assert.equal(isThinkingOutLoud('Mike wants to know the best build.', { first: true }), false, 'nobody it is answering: not a description of them');
});

test('talking about the setup, or about whether to reply, is thinking out loud anywhere', () => {
  for (const s of [
    'The user wants the best build.',
    "The user's question is about the patch.",
    'Looking at the transcript, Leonardo was talking to Mike.',
    'My response should be short.',
    "My instructions say to stay quiet unless it's for me.",
    "I'll respond to Leonardo first.",
    "I should answer Mike's question.",
    'No need to respond.',
    "As an AI, I can't play games.",
  ]) {
    assert.equal(isThinkingOutLoud(s, { askers: ['Mike'] }), true, s);
  }
});

test('working out whether a line was meant for it counts only when it may stay quiet', () => {
  for (const s of [
    "That wasn't aimed at me.",
    "Mike's comment seems directed at me.",
    'Mike is responding to my question about the build.',
    'Mike just answered my question.',
    "That's an answer to my question.",
    'No response needed.',
    'Nothing here for me to respond to.',
    "Mike's talking to Leonardo, not me.",
    "Mike isn't talking to me.",
    "That one's for Jess, not me.",
    'Jess was the one being asked there, not me at all.',
    'Mike is joking around with Jess.',
    'Sounds like Mike is talking to Jess.',
    'Mike is talking to Leonardo, so no reply needed.',
    "Since it's not for me, I'll pass.",
    'The question was for Jess.',
  ]) {
    assert.equal(isThinkingOutLoud(s, { mayPass: true, askers: ['Mike'] }), true, s);
    assert.equal(isThinkingOutLoud(s, { askers: ['Mike'] }), false, `an answer may say it: ${s}`);
  }
  assert.equal(isThinkingOutLoud('Leonardo said yeah.', { first: true, mayPass: true, askers: ['Leonardo'] }), true);
  assert.equal(isThinkingOutLoud('Leonardo said yeah.', { first: true, askers: ['Leonardo'] }), false);
  assert.equal(isThinkingOutLoud('Jess said yeah.', { first: true, mayPass: true, askers: ['Leonardo'] }), false, 'a recap of someone else');
});

test('real lines are never mistaken for thinking out loud', () => {
  const askers = ['Mike', 'Jess', 'Leonardo', 'Kneeheel'];
  for (const s of [
    // questions back, exclamations, idioms, lines to them, second clauses
    'Mike wants to fight me?',
    'Kneeheel wants to know who stole his kill!',
    'You want me to roast him?',
    "Kneeheel's asking for trouble with that build.",
    'Mike was asking for that.',
    "Kneeheel's asking for a whooping with that build.",
    "Sounds like Mike's asking for trouble.",
    'Sounds like Mike wants a rematch.',
    "Looks like Mike's trying to get himself killed again.",
    'Mike wants to rush B again, God help us all.',
    "Mike wants me to carry him and that's not happening.",
    'Jess asked me to roast Mike and honestly his aim did it already.',
    "Jess asked me to roast you, Mike, but your K/D already did it for me.",
    "Okay, Jess wants to know if you're coming.",
    "Jess told me you'd say that.",
    'Mike asked for a roast, so here goes: your aim is trash.',
    // gaming words that look like setup words
    "It's not the controller, Mike, it's the user.",
    'Blame the user, not the gun.',
    'The user is the problem, not the controller.',
    'The user score on that game is like a six.',
    "Mike's aim is like his college transcript, all Ds.",
    'Follow my instructions, crouch, peek, shoot.',
    'My instructions are simple, crouch and shoot.',
    'My reply to that is a hard no.',
    'My response time is better than yours.',
    'The newest line of skins is overpriced garbage.',
    'Just finish the task in electrical, you coward.',
    'Wait for the prompt to pop up.',
    // things it would say about replying
    "I'll pass on that one, friend.",
    "I'm staying out of this one.",
    "Okay, I'll keep quiet.",
    "I'd better not answer that one.",
    "I'll answer you when you stop camping.",
    "I'm going to answer that with a firm no.",
    'I have to acknowledge, that was a clean shot.',
    "I'll answer that one: the shotgun.",
    "I'll respond when someone buys me a drink.",
    "I should acknowledge Mike's clutch play.",
    'Let me weigh in on this pizza debate.',
    // follow-up replies
    'Mike said yeah, so the shotgun it is.',
    'Mike said no to pineapple pizza.',
    'Mike agreed with me for once.',
    'Jess said yes!',
    'Mike said it, not me.',
    "That wasn't meant for me, but I'll take it.",
    'That was meant for Jess.',
    "That's between Mike and Jess.",
    "They're just talking to each other.",
    "That doesn't need a response.",
    'Stop replying to me with memes, Mike.',
    'Your answer to my question was rude, Mike.',
    "My wife's not talking to me since I bought this game.",
    "That's a conversation between you and your therapist, Mike.",
    'Still waiting on an answer to my question, Mike.',
    'Nothing says teamwork like four people on one point.',
    "Legend says he's still camping that corner.",
    'He said what he said.',
  ]) {
    assert.equal(isThinkingOutLoud(s, { first: true, mayPass: true, askers }), false, s);
  }
});

// ---------------------------------------------------------------------------
// The cleanup
// ---------------------------------------------------------------------------

const opts = { botName: 'Gremlin', askers: ['Mike', 'Leonardo', 'Kneeheel'] };

test('a reply that opens by thinking out loud loses only that part', () => {
  const c = cleanSpoken("Leonardo's asking me to talk like his mommy. Absolutely not, sweetie.", opts);
  assert.deepEqual(c, { pass: false, text: 'Absolutely not, sweetie.', thinking: true, dropped: ["Leonardo's asking me to talk like his mommy."] });
  assert.equal(cleanSpoken('The user said yeah. Told you it was the shotgun.', opts).text, 'Told you it was the shotgun.');
  assert.equal(cleanSpoken('Okay. Mike wants to know the best build. Easy, heavy armor.', opts).text, 'Okay. Easy, heavy armor.', 'a lone "Okay." does not start the reply');
  assert.equal(cleanSpoken('Go heavy armor. Mike wants to know the best build.', { ...opts, first: false }).text, 'Go heavy armor. Mike wants to know the best build.', 'not the opening: kept');
});

test('a reply that is all thinking out loud says nothing', () => {
  const c = cleanSpoken('Sounds like Kneeheel wants a roast. I should respond to that.', opts);
  assert.equal(c.pass, true);
  assert.equal(c.thinking, true);
  assert.equal(c.dropped.length, 2);
});

test('reasoning before a pass is not said when the reply may pass, in any shape', () => {
  for (const t of ['Jess was talking to Mike there. [PASS]', 'Not for me, so PASS', "That one's for Jess (pass)", 'Leonardo is answering Mike. [pass].', 'They moved on. PASS']) {
    assert.equal(cleanSpoken(t, { ...opts, optional: true }).pass, true, t);
    assert.equal(cleanSpoken(t, { ...opts, passMarked: true }).pass, true, t);
  }
  for (const t of ['Hard PASS.', 'YOU SHALL NOT PASS!', 'Nice pass, Mike.']) {
    assert.equal(cleanSpoken(t, { ...opts, optional: true }).pass, false, t);
  }
  assert.equal(cleanSpoken('Pass it to Jess, PASS IT.', { ...opts, passMarked: true }).pass, false);
});

test('a label in front of the line is not read out', () => {
  assert.equal(cleanSpoken('Response: "Nice shot, Mike."', opts).text, 'Nice shot, Mike.');
  assert.equal(cleanSpoken('My reply: nah, the rifle.', opts).text, 'nah, the rifle.');
  assert.equal(cleanSpoken('Responding to Mike: the shotgun.', opts).text, 'the shotgun.');
  assert.equal(cleanSpoken('Staying in character, the shotgun.', opts).text, 'the shotgun.');
});

// ---------------------------------------------------------------------------
// What it's told
// ---------------------------------------------------------------------------

test('it writes its words inside <say></say>, and every task ends on it', () => {
  const sys = buildSystem({ botName: 'Gremlin', persona: 'You are Gremlin.' })[0].text;
  assert.match(sys, /Put the exact words you say inside <say><\/say> tags\. Only what is inside the tags is spoken/);
  assert.match(sys, /in ten words or fewer; never inside the tags/);
  assert.match(sys, /don't open by describing what someone said or asked/);
  assert.doesNotMatch(sys, /Leonardo|Kneeheel/, 'no real names in the shared rules');
  assert.doesNotMatch(sys, /everything you write is spoken/);
  assert.match(TASKS.direct({ name: 'Mike', botName: 'Gremlin' }), /Say your line straight to them, inside <say><\/say>\.$/);
  assert.match(TASKS.direct({ name: 'Mike', botName: 'Gremlin', afterCall: true }), /inside <say><\/say>, or reply with exactly \[PASS\]\.$/);
  assert.match(TASKS.followup({ name: 'Mike' }), /One short sentence straight to them, inside <say><\/say>\. Or exactly \[PASS\] or \[LONG\] for something long\.$/);
  assert.match(TASKS.followup({ name: 'Mike', lookup: true }), /Or exactly \[PASS\], \[LOOKUP\] for a question about facts, or \[LONG\] for something long\.$/);
  assert.match(TASKS.quip(), /One short sentence max, inside <say><\/say>\.$/);
  assert.match(TASKS.roast({ target: 'Mike', requester: 'Jess' }), /Write it inside <say><\/say>\.$/);
  assert.match(TASKS.greet(), /one short, friendly, in-character line inside <say><\/say>/);
  assert.match(TASKS.text({ author: 'Mike', content: 'hi' }), /no <say> tags/);
  assert.doesNotMatch(TASKS.direct({ name: 'Mike', botName: 'Gremlin' }), /first try/);
  assert.match(TASKS.direct({ name: 'Mike', botName: 'Gremlin', again: true }), /Your first try only described the conversation.*just your line to them, inside <say><\/say>\.$/);
  assert.match(TASKS.direct({ name: 'Mike', botName: 'Gremlin', again: true, afterCall: true }), /inside <say><\/say>, or reply with exactly \[PASS\] if their line wasn't meant for you\.$/);
  assert.match(TASKS.roast({ target: 'Mike', requester: 'Jess', again: true }), /Your first try only described the conversation/);
});

test('the words are what is inside the tags; notes around them never are', () => {
  assert.equal(sayContent("Leonardo's asking me to talk like his mommy. <say>Absolutely not, sweetie.</say>"), 'Absolutely not, sweetie.');
  assert.equal(sayContent('<say>One.</say> a note <say>Two.</say>'), 'One. Two.');
  assert.equal(sayContent('<say>Hey Mike.</sa'), 'Hey Mike.', 'a closing tag still coming in is not words');
  assert.equal(sayContent('notes so far <sa'), null, 'not open yet');
  assert.equal(sayContent('Hey Mike.'), null, 'no tags at all');
  assert.equal(sayContent('<say></say>'), '');
  assert.equal(cleanSpoken('<say>Hey</say> Mike', opts).text, 'Hey Mike', 'stray tags are never read out');
  assert.equal(cleanText('Notes first. <say>Patch is Tuesday.</say>', opts).text, 'Patch is Tuesday.');
  assert.equal(cleanText('Patch is Tuesday.', opts).text, 'Patch is Tuesday.');
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

const settle = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Records lines; the test says when each one plays. */
function fakeSpeaker() {
  const lines = [];
  return {
    lines,
    speaking: false,
    wasAudibleBetween: () => false,
    say(text, opts = {}) {
      const line = { text, kind: opts.kind, opts };
      lines.push(line);
      return new Promise((resolve) => {
        line.end = (outcome) => {
          if (!line.outcome) {
            line.outcome = outcome;
            resolve(outcome);
          }
        };
        opts.signal?.addEventListener('abort', () => {
          if (!line.started) line.end('dropped');
        });
      });
    },
    play(i) {
      this.lines[i].started = true;
      this.lines[i].opts.onStart?.();
      this.lines[i].end('played');
    },
    stop() {
      for (const l of lines) l.end?.('stopped');
    },
    stopKind() {},
    dropOptional() {},
  };
}

/** A Claude whose replies stream in pieces the test hands out (send), then finish (done). */
function streamingClaude() {
  const calls = [];
  return {
    calls,
    canSearchNow: true,
    async createMessage(args) {
      const call = { args, user: typeof args.user === 'string' ? args.user : '', searches: 0 };
      calls.push(call);
      return new Promise((resolve, reject) => {
        let text = '';
        call.send = (piece) => {
          text += piece;
          args.onText?.(piece);
        };
        // Overloaded mid-reply: the client asks whether it may start over.
        call.retry = () => {
          if (args.onRetry && !args.onRetry()) throw new Error('not restartable');
          text = '';
        };
        call.search = () => {
          call.searches++;
          args.onToolStart?.();
          text = '';
        };
        call.done = (extra = {}) => resolve({ text, refusal: false, searches: call.searches, citations: [], stopReason: 'end_turn', ...extra });
        args.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
    get last() {
      return calls.at(-1);
    },
  };
}

function setup({ config = {}, fillerAfterMs } = {}) {
  let now = 9_000_000;
  const claude = streamingClaude();
  const speaker = fakeSpeaker();
  const brain = new Brain({
    config: { ...baseConfig, ...config },
    claude,
    speaker,
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess', 'Leonardo'], activities: [] }),
    clock: () => now,
    ...(fillerAfterMs !== undefined ? { fillerAfterMs } : {}),
  });
  return { brain, claude, speaker, advance: (ms) => (now += ms), now: () => now };
}

const ACKS = /^(Yeah\?|What's up\?|I'm here\.|Go ahead\.|Talk to me\.)$/;
const said = (speaker) => speaker.lines.filter((l) => l.kind !== 'filler').map((l) => l.text).filter((t) => !ACKS.test(t));

test('notes it writes before its words are never said, and the words start right away', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u3', id: 1, name: 'Leonardo', text: 'gremlin talk like my mommy' });
  await settle();
  claude.last.send("Leonardo's asking me to talk like his mommy. That's a weird one. ");
  assert.equal(speaker.lines.length, 0, 'notes are not said');
  claude.last.send('<say>Absolutely not, sweetie. ');
  assert.deepEqual(said(speaker), ['Absolutely not, sweetie.'], 'its words stream as soon as a sentence is in');
  claude.last.send('Eat your vegetables.</say>');
  claude.last.done();
  await settle();
  assert.deepEqual(said(speaker), ['Absolutely not, sweetie.', 'Eat your vegetables.']);
});

test('its first line when it joins: notes about the call are not said, only the hello', async () => {
  const { brain, claude, speaker } = setup();
  brain.greet();
  await settle();
  claude.last.send('I just joined the call. Mike, Jess and Leonardo are here, so I will greet them by name. ');
  claude.last.send('<say>Hey Mike, hey Jess, Leonardo.</say>');
  claude.last.done();
  await settle();
  assert.deepEqual(said(speaker), ['Hey Mike, hey Jess, Leonardo.']);
});

test('a reply written without the tags is said whole once it is in', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what build should I run' });
  await settle();
  claude.last.send('Heavy armor, every time. ');
  claude.last.send('Trust me.');
  assert.equal(speaker.lines.length, 0, 'no tags: nothing streams');
  claude.last.done();
  await settle();
  assert.deepEqual(said(speaker), ['Heavy armor, every time. Trust me.']);
});

test('inside the tags, an opening that describes the ask is still left out', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u3', id: 1, name: 'Leonardo', text: 'gremlin talk like my mommy' });
  await settle();
  claude.last.send("<say>Leonardo's asking me to talk like his mommy. ");
  assert.equal(speaker.lines.length, 0, 'the description is not said');
  claude.last.send('Absolutely not, sweetie. ');
  assert.deepEqual(said(speaker), ['Absolutely not, sweetie.']);
  claude.last.send('Eat your vegetables.</say>');
  claude.last.done();
  await settle();
  assert.deepEqual(said(speaker), ['Absolutely not, sweetie.', 'Eat your vegetables.']);
  speaker.play(0);
  speaker.play(1);
  await settle();
  const lines = brain.transcript.lines.filter((l) => l.isBot).map((l) => l.text);
  assert.deepEqual(lines, ['Absolutely not, sweetie. Eat your vegetables.'], 'the transcript has only what was said');
});

test('asked what someone said, telling them is the answer, not thinking out loud', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'can we do the raid tonight' });
  brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'gremlin what did mike just ask' });
  await settle();
  claude.last.send('Mike asked about doing the raid tonight.');
  claude.last.done();
  await settle();
  assert.deepEqual(said(speaker), ['Mike asked about doing the raid tonight.']);
  assert.equal(claude.calls.length, 1);
});

/** Mike asks it something, it answers, and Mike talks right after: a follow-up. */
async function toFollowup({ brain, claude, speaker, advance, now }) {
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin how are you', startedAt: now() - 1500, spokeUntil: now() - 200 });
  await settle();
  claude.last.send('<say>Doing great, you?</say>');
  claude.last.done();
  await settle();
  speaker.play(0);
  await settle();
  advance(2000);
  const kind = brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'leonardo did you eat my fries', startedAt: now() - 900, spokeUntil: now() - 300 });
  await settle();
  assert.equal(kind, 'followup');
  assert.equal(claude.calls.length, 2);
}

test('a follow-up that reasons and then passes says nothing, even sentence by sentence', async () => {
  const s = setup();
  await toFollowup(s);
  s.claude.last.send("Mike's talking to Leonardo, not me. ");
  s.claude.last.send('That one is between them. ');
  assert.equal(s.speaker.lines.length, 1, 'nothing more said while it is still being written');
  s.claude.last.send('[PASS]');
  s.claude.last.done();
  await settle();
  assert.equal(s.speaker.lines.length, 1);
});

test('a follow-up reply is judged whole, then said', async () => {
  const s = setup();
  await toFollowup(s);
  s.claude.last.send("Mike's asking Leonardo about fries. ");
  s.claude.last.send('<say>Leonardo, hand them over. ');
  assert.equal(s.speaker.lines.length, 1);
  s.claude.last.send('Nobody likes a fry thief.</say>');
  s.claude.last.done();
  await settle();
  assert.deepEqual(said(s.speaker).slice(1), ['Leonardo, hand them over. Nobody likes a fry thief.']);
});

test('a follow-up that answers with "Mike said yeah, so..." is said as it is', async () => {
  const s = setup();
  await toFollowup(s);
  s.claude.last.send('<say>Mike said yeah, so the shotgun it is.</say>');
  s.claude.last.done();
  await settle();
  assert.deepEqual(said(s.speaker).slice(1), ['Mike said yeah, so the shotgun it is.']);
});

test('started over after an overload, a follow-up is still judged whole', async () => {
  const s = setup();
  await toFollowup(s);
  s.claude.last.send("That wasn't aimed at me. ");
  s.claude.last.retry();
  s.claude.last.send("They're talking to each other. ");
  assert.equal(s.speaker.lines.length, 1);
  s.claude.last.send('[PASS]');
  s.claude.last.done();
  await settle();
  assert.equal(s.speaker.lines.length, 1);
});

test('after a bare "Gremlin!", reasoning that the next line was for someone else is not said', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin' });
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'jess are you coming tonight' });
  await settle();
  claude.last.send('Jess was the one being asked there, not me at all. ');
  assert.deepEqual(said(speaker), []);
  claude.last.send('[PASS]');
  claude.last.done();
  await settle();
  assert.deepEqual(said(speaker), []);
});

test('after a bare "Gremlin!", "one sec" comes only once a search starts, never before a pass', async () => {
  const s = setup({ config: { anthropic: { webSearch: { enabled: true } } }, fillerAfterMs: 0 });
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin' });
  s.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'jess are you coming tonight' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.speaker.lines.filter((l) => l.kind === 'filler').length, 0, 'no timed "one sec"');
  s.claude.last.send('[PASS]');
  s.claude.last.done();
  await settle();
  assert.deepEqual(said(s.speaker), []);

  // A real question that needs a search: "one sec" when the search starts.
  s.brain.hear({ userId: 'u1', id: 3, name: 'Mike', text: 'gremlin' });
  s.brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'when does the new season start' });
  await settle();
  s.claude.last.search();
  assert.equal(s.speaker.lines.filter((l) => l.kind === 'filler').length, 1);
  s.claude.last.send('Next Tuesday.');
  s.claude.last.done();
  await settle();
  assert.deepEqual(said(s.speaker), ['Next Tuesday.']);
});

test('an answer that was only thinking out loud is asked for once more', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what build should I run' });
  await settle();
  claude.last.send('Mike wants to know the best build. ');
  claude.last.send('I should answer him.');
  claude.last.done();
  await settle();
  assert.equal(claude.calls.length, 2, 'asked again');
  assert.match(claude.last.user, /Your first try only described the conversation/);
  assert.deepEqual(said(speaker), []);
  claude.last.send('Heavy armor, every time.');
  claude.last.done();
  await settle();
  assert.deepEqual(said(speaker), ['Heavy armor, every time.']);
});

test('asked once more and still only thinking out loud: it gives up quietly', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what build should I run' });
  await settle();
  claude.last.send('Mike wants to know the best build.');
  claude.last.done();
  await settle();
  claude.last.send('The user wants a build.');
  claude.last.done();
  await settle();
  assert.equal(claude.calls.length, 2, 'only one more try');
  assert.deepEqual(said(speaker), []);
});

test('after a "one sec", an answer that never comes ends with "came up empty", not silence', async () => {
  const s = setup({ config: { anthropic: { webSearch: { enabled: true } } }, fillerAfterMs: 0 });
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what build should I run' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.speaker.lines.filter((l) => l.kind === 'filler').length, 1);
  s.speaker.play(s.speaker.lines.findIndex((l) => l.kind === 'filler')); // it was heard
  s.claude.last.send('Mike wants to know the best build.');
  s.claude.last.done();
  await settle();
  s.claude.last.send('Mike is asking about builds.');
  s.claude.last.done();
  await settle();
  assert.deepEqual(said(s.speaker), [SEARCH_CAME_UP_EMPTY]);
});

test('a roast that was only thinking out loud is asked for once more', async () => {
  const { brain, claude, speaker } = setup();
  brain.roast({ target: 'Mike', requester: 'Jess' });
  await settle();
  assert.equal(claude.calls.length, 1);
  claude.last.send('Jess wants me to roast Mike.');
  claude.last.done();
  await settle();
  assert.equal(claude.calls.length, 2);
  assert.match(claude.last.user, /Your first try only described the conversation/);
  claude.last.send('Mike, your aim is a cry for help.');
  claude.last.done();
  await settle();
  assert.deepEqual(said(speaker), ['Mike, your aim is a cry for help.']);
});

test('a joke that is only thinking out loud is not asked for again', async () => {
  const s = setup();
  await toFollowup(s);
  s.claude.last.send("Mike isn't talking to me.");
  s.claude.last.done();
  await settle();
  assert.equal(s.claude.calls.length, 2);
  assert.equal(s.speaker.lines.length, 1);
});

test('cut off before it got to its words: none of its notes are said', async () => {
  const s = setup();
  await toFollowup(s);
  s.claude.last.send('Mike is talking to Leonardo about fries, and I asked how he was, so this could be for me or for Leonardo, it is hard to tell because');
  s.claude.last.done({ stopReason: 'max_tokens' });
  await settle();
  assert.equal(s.speaker.lines.length, 1, 'nothing said');
});

test('an answer cut off before its words is asked for once more', async () => {
  const { brain, claude, speaker } = setup();
  brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin what build should I run' });
  await settle();
  claude.last.send('Mike wants a build. He plays a lot of melee, so heavy armor might fit, but he also said he likes speed, so maybe');
  claude.last.done({ stopReason: 'max_tokens' });
  await settle();
  assert.equal(claude.calls.length, 2);
  claude.last.send('<say>Heavy armor, every time.</say>');
  claude.last.done();
  await settle();
  assert.deepEqual(said(speaker), ['Heavy armor, every time.']);
});
