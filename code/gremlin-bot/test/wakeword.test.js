import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAddressed, isHoldOn, isJustCallingIt, isStopCommand, levenshtein, similarity } from '../src/wakeword.js';

const aliases = ['gremlin', 'grem', 'gremmy'];

test('detects the name anywhere, with punctuation, plurals and possessives', () => {
  assert.ok(isAddressed('Hey Gremlin, what do you think?', aliases));
  assert.ok(isAddressed("gremlin's being weird again", aliases));
  assert.ok(isAddressed('you gremlins are all the same', aliases));
  assert.ok(isAddressed('What do you think, Grem?', aliases));
  assert.ok(isAddressed('GREMLIN.', aliases));
});

test('tolerates one misheard letter on longer names', () => {
  assert.ok(isAddressed('grimlin say something', aliases));
  assert.ok(isAddressed('gremblin you there', aliases));
});

test('does not fire on unrelated words', () => {
  assert.ok(!isAddressed('remind me to grab the green line', aliases));
  assert.ok(!isAddressed('gremlinification is not a word', aliases));
  assert.ok(!isAddressed('', aliases));
});

test('multi-word aliases match as a phrase', () => {
  assert.ok(isAddressed('yo little guy, help', ['little guy']));
  assert.ok(!isAddressed('the guy is little', ['little guy']));
});

test('real words one letter off the name do not count as the name', () => {
  assert.ok(!isAddressed('the kremlin said no', aliases));
  assert.ok(!isAddressed('did you watch the grammy awards', aliases));
  assert.ok(isAddressed('gremmy you there', aliases));
});

test('stop phrases in the middle of a question are not commands', () => {
  assert.ok(!isStopCommand('Gremlin, how do I stop bleeding', aliases));
  assert.ok(!isStopCommand('Gremlin, quiet down the music is it', aliases));
  assert.ok(isStopCommand('gremlin you stop', aliases));
  for (const polite of ['Gremlin, can you shut up?', 'will you be quiet gremlin', 'gremlin could you stop', 'gremlin I said shut up', 'gremlin you need to stop']) {
    assert.ok(isStopCommand(polite, aliases), polite);
  }
  assert.ok(!isStopCommand('gremlin can you tell me a joke', aliases));
  assert.ok(!isStopCommand("why can't you stop gremlin", aliases));
  for (const q of [
    'Gremlin, why so quiet?', 'gremlin why so quiet', "gremlin you've been quiet", "gremlin don't stop",
    'gremlin keep going dont stop', "gremlin why'd you stop", 'gremlin how do I stop', "gremlin where's the bus stop",
    'gremlin do I have enough', 'gremlin had enough',
  ]) {
    assert.ok(!isStopCommand(q, aliases), q);
  }
  assert.ok(isStopCommand('gremlin stop talking about my mom', aliases));
  assert.ok(isStopCommand('oh my god gremlin shut up', aliases));
  assert.ok(isStopCommand('gremlin please stop', aliases));
  assert.ok(isStopCommand('gremlin shut up already', aliases));
});

test('stop commands must be short and contain a stop phrase', () => {
  assert.ok(isStopCommand('Gremlin, shut up!', aliases));
  assert.ok(isStopCommand('shut up gremlin', aliases));
  assert.ok(isStopCommand('gremlin stop', aliases));
  assert.ok(isStopCommand('okay gremlin, be quiet', aliases));
  assert.ok(!isStopCommand('gremlin what is the best stop in the whole game', aliases));
  assert.ok(!isStopCommand('gremlin tell me a joke', aliases));
});

test('levenshtein and similarity basics', () => {
  assert.equal(levenshtein('gremlin', 'grimlin'), 1);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(similarity('you are all terrible at this game', 'You are ALL terrible at this game!'), 1);
  assert.ok(similarity('pass me the ammo', 'you are all terrible') < 0.3);
});

test('Babel: its name and close mishearings wake it, common words one letter off do not', () => {
  const babel = ['Babel'];
  for (const t of ['Babel, what time is it', 'hey babel', "babel's back", 'Babell, you there?', 'babbel help']) {
    assert.ok(isAddressed(t, babel), t);
  }
  for (const t of ['check the label on it', 'hey babe', 'I ate a bagel', 'Mabel is here', 'Abel and Cain', 'the babes', 'Basel is in Switzerland']) {
    assert.ok(!isAddressed(t, babel), t);
  }
  assert.ok(isJustCallingIt('Babel!', babel));
  assert.ok(isJustCallingIt('hey Babel, hold on', babel));
});

test('just calling its name vs actually saying something', () => {
  const withPhrase = [...aliases, 'little guy'];
  for (const t of [
    'Gremlin!', 'hey gremlin', 'Gremlin, wait', 'yo grem, hold on', 'gremlin gremlin', 'okay little guy listen', 'grimlin?',
    'Gremlin, hold on a second', 'wait a sec gremlin', 'gremlin wait a minute', 'gremlin just wait', 'no, wait, gremlin',
  ]) {
    assert.ok(isJustCallingIt(t, withPhrase), t);
  }
  for (const t of ['Gremlin, what is up', 'gremlin tell me a joke', 'hey gremlin roast mike', 'gremlin wait what did you say', '']) {
    assert.ok(!isJustCallingIt(t, withPhrase), t);
  }
});

test('hold-on phrases', () => {
  assert.ok(isHoldOn('Gremlin, wait'));
  assert.ok(isHoldOn('hold on gremlin'));
  assert.ok(isHoldOn('grem hang on'));
  assert.ok(isHoldOn('gremlin listen'));
  assert.ok(isHoldOn('Gremlin, one moment'));
  assert.ok(!isHoldOn('hey gremlin'));
  assert.ok(!isHoldOn('gremlin hold the door'));
});
