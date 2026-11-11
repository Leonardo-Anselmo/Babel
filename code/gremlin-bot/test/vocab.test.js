// Learned words: when it answers with a word spelled differently from what the
// speech-to-text heard ("Malenia" for "melania"), the word becomes a hint for the
// speech-to-text, on sentences long enough that a hint can't be "heard" in noise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../src/brain.js';
import { createStt } from '../src/stt.js';
import { HINT_WORDS, MAX_WORDS, Vocabulary, corrections, everyday, similarity } from '../src/vocab.js';

const skip = ['Mike', 'Kneeheel', 'Gremlin'];

test('a word it answered with, heard differently, is learned', () => {
  const learned = (said, heard) => corrections(said, [heard], { skip });
  assert.deepEqual(learned("Malenia's a pain: dodge the Waterfowl Dance.", 'gremlin how do i beat melania'), [{ term: 'Malenia', heard: 'melania' }]);
  assert.deepEqual(learned('Jett dashes way better than that.', 'who should i play jet or sage'), [{ term: 'Jett', heard: 'jet' }]);
  assert.deepEqual(learned('Zomboid is brutal, stock up on canned food.', 'should i play project zombie'), [{ term: 'Zomboid', heard: 'zombie' }]);
  assert.deepEqual(learned('Sova is the recon guy.', 'who is soba'), [{ term: 'Sova', heard: 'soba' }]);
  assert.deepEqual(learned('Zomboid it is.', 'project zom boid'), [{ term: 'Zomboid', heard: 'zom boid' }], 'a word heard split in two');
});

test('nothing is learned from words heard right, names, everyday words or other forms of a word', () => {
  const learned = (said, heard) => corrections(said, [heard], { skip });
  // Everyday words capitalized because they start a sentence, next to a look-alike in the question.
  assert.deepEqual(learned('They camp the tower on B every round.', 'where do the snipers sit'), []);
  assert.deepEqual(learned('Skill issue.', 'how do i kill this boss'), []);
  assert.deepEqual(learned('Trust me, the shotgun is better.', 'should we play rust tonight'), []);
  assert.deepEqual(learned("You're overthinking it.", 'your team is better than you think'), []);
  assert.deepEqual(learned('Aight, I will stop.', 'alright gremlin chill'), []);
  assert.deepEqual(learned('Yeahhh, no.', 'yeah should i buy it'), []);
  // The same letters written another way.
  assert.deepEqual(learned('Spider-Man 2 is great.', 'is the new spiderman game good'), []);
  assert.deepEqual(learned('Headshot city.', 'did you see that head shot'), []);
  assert.deepEqual(learned('AK-47, no question.', 'ak 47 or m4'), []);
  assert.deepEqual(learned('Tell Mikey I said hi.', 'mike says hi'), [], 'a name and a word are not one word');
  assert.equal(everyday('They'), true);
  assert.equal(everyday('Malenia'), false);
  assert.deepEqual(learned('Elden Ring is the one.', 'what about elden ring'), []);
  assert.deepEqual(learned('Kneeheel already died twice.', 'how many times did neil die'), [], 'people in the call');
  assert.deepEqual(learned('Yeah, Mike, the shotgun is better.', 'the shotgun is better right'), []);
  assert.deepEqual(learned('Honestly, the patch fixed it.', 'did the patch fix it honest'), []);
  assert.deepEqual(learned('Sure thing.', 'shore thing'), []);
  assert.deepEqual(learned('Tacos are always the answer.', 'tacos or pizza'), []);
  assert.deepEqual(learned('Radahn hits like a truck.', 'how do i beat the boss'), [], 'nothing close was heard');
  assert.ok(similarity('Malenia', 'melania') > 0.7);
  assert.ok(similarity('Radahn', 'pizza') < 0.3);
});

test('learned words are counted, and a word heard wrong twice becomes a hint, most used first', () => {
  const saved = [];
  const v = new Vocabulary([], { onChange: (e) => saved.push(e) });
  const day = 86400000;
  const t0 = Date.UTC(2026, 9, 1);
  // Made-up game words, so none of them is an everyday word.
  const word = (i) => `Zorb${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`;
  const heardAs = (i) => word(i).toLowerCase().slice(0, -1) + 'z';
  v.learn("Malenia's tough.", ['how do i beat melania'], { now: t0 });
  assert.deepEqual(v.hints({ now: t0 }), [], 'heard wrong once could be chance');
  v.learn('Malenia again.', ['melenia is so hard'], { now: t0 + day });
  v.learn('Jett is fast.', ['should i play jet'], { now: t0 + day });
  assert.equal(saved.length, 3);
  assert.deepEqual(v.toJSON().find((e) => e.term === 'Malenia'), { term: 'Malenia', count: 2, at: new Date(t0 + day).toISOString() }, 'never what was said');
  assert.deepEqual(v.hints({ now: t0 + day }), ['Malenia']);
  // A word not heard in weeks fades behind one heard lately.
  v.learn('Sova first.', ['play soba'], { now: t0 + 60 * day });
  v.learn('Sova again.', ['soba again'], { now: t0 + 60 * day });
  assert.equal(v.hints({ now: t0 + 60 * day })[0], 'Sova');
  for (let i = 0; i < 20; i++) for (let k = 0; k < 2; k++) v.learn(`${word(i)} is up.`, [heardAs(i)], { now: t0 + 61 * day + i });
  assert.equal(v.hints({ now: t0 + 62 * day }).length, HINT_WORDS);
  for (let i = 20; i < 20 + MAX_WORDS; i++) v.learn(`${word(i)} here.`, [heardAs(i)], { now: t0 + 70 * day + i });
  assert.equal(v.toJSON().length, MAX_WORDS, 'the oldest words make room');
  assert.equal(new Vocabulary(v.toJSON()).toJSON().length, MAX_WORDS, 'saved and loaded');
  // Damaged or everyday saved words are left out; a bad date sinks to the bottom.
  const loaded = new Vocabulary([{ term: '' }, null, { term: 'They', count: 3 }, { term: 'Radahn', count: -2, at: 'nope' }]).toJSON();
  assert.deepEqual(loaded, [{ term: 'Radahn', count: 1, at: new Date(0).toISOString() }]);
});

// ---------------------------------------------------------------------------
// The speech-to-text gets them
// ---------------------------------------------------------------------------

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wavOf = (seconds) => {
  const b = Buffer.alloc(44 + Math.round(32000 * seconds));
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32000, 28);
  return b;
};
const sttConfig = (over = {}) => ({
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  stt: { provider: 'whisper', deepgramKey: 'dg', deepgramModel: 'nova-3', language: 'en', useKeyterms: true, whisper: { port: 8178 }, ...over },
});

test('Whisper gets the learned words only on a sentence long enough, and its own name always', async () => {
  const urls = [];
  const stt = createStt(sttConfig(), { fetchImpl: async (url) => (urls.push(new URL(String(url))), json(200, { text: 'ok then' })) });
  await stt.transcribeDetailed(wavOf(2), { durationMs: 2000, hints: ['Malenia', 'Jett', 'Gremlin'] });
  await stt.transcribeDetailed(wavOf(0.8), { durationMs: 800, hints: ['Malenia', 'Jett'] });
  assert.equal(urls[0].searchParams.get('hotwords'), 'Gremlin, Malenia, Jett');
  assert.equal(urls[0].searchParams.get('wake'), 'Gremlin', 'only its name counts as calling it');
  assert.equal(urls[1].searchParams.get('hotwords'), 'Gremlin', 'a short sentence: only its name');
});

test('Deepgram gets the learned words as keyterms', async () => {
  const urls = [];
  const stt = createStt(sttConfig({ provider: 'deepgram' }), {
    fetchImpl: async (url) => (urls.push(new URL(String(url))), json(200, { results: { channels: [{ alternatives: [{ transcript: 'hi' }] }] } })),
  });
  await stt.transcribeDetailed(wavOf(1), { durationMs: 1000, keyterms: ['Gremlin', 'Mike'], hints: ['Malenia'] });
  assert.deepEqual(urls[0].searchParams.getAll('keyterm'), ['Gremlin', 'Mike', 'Malenia']);
});

// ---------------------------------------------------------------------------
// Where it learns from: answers that were heard
// ---------------------------------------------------------------------------

test('an answer that was heard is learned from, with the lines from them it was answering', async () => {
  const learned = [];
  let now = 1_000_000;
  const said = [];
  const brain = new Brain({
    config: {
      botName: 'Gremlin',
      botAliases: ['gremlin'],
      timezone: 'UTC',
      defaultChattiness: 'off',
      persona: 'x',
      lore: '',
      tts: { audioTags: false },
      transcript: { maxLines: 40, maxMinutes: 15 },
      anthropic: { webSearch: { enabled: false } },
    },
    claude: { createMessage: async () => ({ text: "<say>Malenia's tough, dodge the waterfowl.</say>", refusal: false }) },
    speaker: {
      speaking: false,
      wasAudibleBetween: () => false,
      say(text, opts = {}) {
        said.push(text);
        opts.onStart?.();
        return Promise.resolve('played');
      },
      stop() {},
      stopKind() {},
      dropOptional() {},
    },
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
    clock: () => now,
    learnWords: (s, heard) => learned.push({ s, heard }),
  });
  brain.hear({ userId: 'u2', id: 1, name: 'Jess', text: 'i love that boss' });
  brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'gremlin how do i beat melania' });
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  now += 3000;
  assert.deepEqual(said, ["Malenia's tough, dodge the waterfowl."]);
  assert.deepEqual(learned, [{ s: "Malenia's tough, dodge the waterfowl.", heard: ['gremlin how do i beat melania'] }], 'only what Mike said');
});
