import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystem, buildUserMessage, cleanSpoken, cleanText, formatTranscript, TASKS } from '../src/prompts.js';

const opts = { botName: 'Gremlin' };

test('PASS in any common shape means stay quiet', () => {
  for (const s of ['[PASS]', 'PASS', ' [pass] ', 'pass.', '[PASS] actually never mind', '']) {
    assert.equal(cleanSpoken(s, opts).pass, true, JSON.stringify(s));
  }
});

test('strips leaked labels, timestamps and wrapping quotes', () => {
  assert.equal(cleanSpoken('Gremlin: Mike, you absolute walnut.', opts).text, 'Mike, you absolute walnut.');
  assert.equal(cleanSpoken('Gremlin (you): wow.', opts).text, 'wow.');
  assert.equal(cleanSpoken('[22:41:02] Gremlin (you): wow.', opts).text, 'wow.');
  assert.equal(cleanSpoken('**Gremlin:** sure', opts).text, 'sure');
  assert.equal(cleanSpoken('"Bold strategy, Cotton."', opts).text, 'Bold strategy, Cotton.');
});

test('removes stage directions, markdown and emoji', () => {
  assert.equal(cleanSpoken("*laughs* Mike, you're trash", opts).text, "Mike, you're trash");
  assert.equal(cleanSpoken('(sighs dramatically) fine, I will help.', opts).text, 'fine, I will help.');
  assert.equal(cleanSpoken("You're **trash** 😂🔥", opts).text, "You're trash");
  assert.equal(cleanSpoken('I *really* mean it', opts).text, 'I really mean it');
  assert.equal(cleanSpoken('Check https://example.com now', opts).text, 'Check a link now');
});

test('square-bracket tags removed unless audio tags are on', () => {
  assert.equal(cleanSpoken('[laughs] okay buddy', opts).text, 'okay buddy');
  assert.equal(cleanSpoken('[laughs] okay buddy', { ...opts, audioTags: true }).text, '[laughs] okay buddy');
  assert.equal(cleanSpoken('[laughs]', { ...opts, audioTags: true }).pass, true);
});

test('long replies are cut at a sentence boundary', () => {
  const long = `${'This is a sentence that goes on. '.repeat(30)}`;
  const { text } = cleanSpoken(long, { ...opts, maxChars: 200 });
  assert.ok(text.length <= 200);
  assert.ok(text.endsWith('.'));
});

test('system prompt carries persona, lore, facts and cache control', () => {
  const sys = buildSystem({
    botName: 'Gremlin',
    persona: 'You are a goblin.',
    lore: '- Mike dies first.',
    facts: [{ text: 'Jess hates spiders' }],
  });
  assert.equal(sys.length, 1);
  assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
  assert.match(sys[0].text, /You are a goblin\./);
  assert.match(sys[0].text, /Mike dies first/);
  assert.match(sys[0].text, /Jess hates spiders/);
  assert.match(sys[0].text, /\[PASS\]/);
});

test('transcript labels the bot as (you)', () => {
  const t = formatTranscript(
    [
      { name: 'Mike', text: 'I got bit', at: Date.UTC(2026, 0, 1, 6, 0, 0), isBot: false },
      { name: 'Gremlin', text: 'Called it.', at: Date.UTC(2026, 0, 1, 6, 0, 5), isBot: true },
    ],
    { botName: 'Gremlin', timezone: 'UTC' },
  );
  assert.match(t, /Mike: I got bit/);
  assert.match(t, /Gremlin \(you\): Called it\./);
});

test('user message wraps call, transcript and task', () => {
  const msg = buildUserMessage({ callInfo: 'Voice channel: Lobby', transcript: 'Mike: hi', task: TASKS.quip() });
  assert.match(msg, /<call>\nVoice channel: Lobby\n<\/call>/);
  assert.match(msg, /<task>[\s\S]*\[PASS\][\s\S]*<\/task>/);
});

test('text replies neutralize mass pings', () => {
  assert.equal(cleanText('hey @everyone look', opts).text, 'hey @​everyone look');
  assert.equal(cleanText('[PASS]', opts).pass, true);
});

test('stage directions are not read out loud, emphasis keeps its word', () => {
  const clean = (t) => cleanSpoken(t, { botName: 'Gremlin' }).text;
  assert.equal(clean('*cracks knuckles* Alright Mike, listen up.'), 'Alright Mike, listen up.');
  assert.equal(clean('Mike, you walnut. *evil grin*'), 'Mike, you walnut.');
  assert.equal(clean('Nice try. *leans in* You lose.'), 'Nice try. You lose.');
  assert.equal(clean('Sure thing (evil grin)'), 'Sure thing');
  assert.equal(clean('That is *really* bad, Mike.'), 'That is really bad, Mike.');
  assert.equal(clean('You are *done*'), 'You are done');
  assert.equal(clean('I mean (and I mean this) you suck.'), 'I mean (and I mean this) you suck.');
  assert.equal(clean('*Mike* is the worst player here.'), 'Mike is the worst player here.');
  assert.equal(clean('*Really*?'), 'Really?');
});

test('an answer to several people names all of them', () => {
  assert.match(TASKS.direct({ names: ['Mike', 'Jess', 'Ana'], botName: 'Gremlin' }), /^Mike, Jess and Ana are talking to you/);
  assert.match(TASKS.direct({ name: 'Mike', botName: 'Gremlin' }), /^Mike is talking to you/);
});

test('text replies are told not to repeat the voice call in a public channel', () => {
  assert.match(TASKS.text({ author: 'Mike', content: 'what did jess say' }), /don't quote what was said in voice/);
});
