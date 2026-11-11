// Shared lists people keep with it between calls: the tags in its answers, the store in
// memory.json, how they're shown to it and posted in the text chat, and the wiring in
// voice (applied once heard) and text (@mentions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Lists,
  MAX_ITEMS,
  MAX_ITEM_CHARS,
  MAX_LISTS,
  MAX_NAME_CHARS,
  changeNote,
  cleanItem,
  describeResult,
  displayName,
  escapeMarkdown,
  formatListPosts,
  formatListsForPrompt,
  listKey,
  listTags,
  mergeLists,
  problemNote,
  withoutListTags,
} from '../src/lists.js';
import { Brain } from '../src/brain.js';
import { textReply } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { Memory } from '../src/memory.js';
import { buildSystem, buildUserMessage, cleanSpoken, cleanText, sayContent, withoutHiddenTags } from '../src/prompts.js';
import { VoiceSession } from '../src/session.js';
import { songTags } from '../src/songs.js';
import { FIELDS } from '../desktop/lib/settings.mjs';

const settle = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** A memory that only keeps lists (what the store needs). */
function fakeMemory(initial = {}) {
  const data = { ...initial };
  return {
    data,
    saves: 0,
    lists(g) {
      return Array.isArray(data[g]) ? data[g] : [];
    },
    listsTrash(g) {
      return Array.isArray(data[`trash:${g}`]) ? data[`trash:${g}`] : [];
    },
    setLists(g, l, trash) {
      data[g] = l;
      if (Array.isArray(trash)) data[`trash:${g}`] = trash;
      this.saves++;
    },
  };
}

const op = (o, list, item) => (item === undefined ? { op: o, list } : { op: o, list, item });
const texts = (l) => l.items.map((i) => (i.done ? `~${i.text}` : i.text));

// ---------------------------------------------------------------------------
// The tags
// ---------------------------------------------------------------------------

test('list tags: every kind and form, in the order written', () => {
  const reply = [
    '<say>Added both, and it is in the chat.</say>',
    '<list_add list="games to try">Hades 2</list_add>',
    "<list_add list='Games to try' item=\"Deadlock\"/>",
    '<list_remove list="games to try" item="2"/>',
    '<list_done list="games to try">Hades 2</list_done>',
    '<list_clear list="shopping"/>',
    '<list_delete list="ban list"></list_delete>',
    '<list_post list="games to try">',
    '<list_post list=“all”/>',
  ].join(' ');
  assert.deepEqual(listTags(reply), {
    ops: [
      op('add', 'games to try', 'Hades 2'),
      op('add', 'Games to try', 'Deadlock'),
      op('remove', 'games to try', '2'),
      op('done', 'games to try', 'Hades 2'),
      op('clear', 'shopping'),
      op('delete', 'ban list'),
      op('post', 'games to try'),
      op('post', 'all'),
    ],
    cutOff: false,
  });
  // name= works for list=, and the item's words lose any tags inside them.
  assert.deepEqual(listTags('<list_add name="x">a <b>bold</b> one</list_add>').ops, [op('add', 'x', 'a bold one')]);
  // An add left open (no closing tag) still counts when the reply wasn't cut off...
  assert.deepEqual(listTags('<list_add list="x">Hades 2').ops, [op('add', 'x', 'Hades 2')]);
  // ...but not when it ran out of room: its words may be cut short.
  assert.deepEqual(listTags('<list_add list="x">Hades', { cutOff: true }), { ops: [], cutOff: true });
  assert.deepEqual(listTags('Ok. <list_add list="ga', { cutOff: true }), { ops: [], cutOff: true });
  assert.deepEqual(listTags('<list_post list="x"> and <list_add list="x">Ha', { cutOff: true }), { ops: [op('post', 'x')], cutOff: true }, 'a whole post still counts');
  assert.deepEqual(listTags('no tags here'), { ops: [], cutOff: false });
});

test('list tags are never said or shown, not even half written', () => {
  const reply = '<say>Added it.</say> <list_add list="games">Hades 2</list_add> <list_post list="games"/>';
  assert.equal(sayContent(reply), 'Added it.');
  assert.equal(withoutListTags('Ok <list_add list="games">Hades 2</list_add> then <list_post list="games"> done').replace(/\s+/g, ' ').trim(), 'Ok then done');
  // While it's still being written: nothing from the open tag on.
  assert.equal(withoutListTags('Sure thing <list_add list="games">Had').trim(), 'Sure thing');
  assert.equal(withoutListTags('Sure <list_rem').trim(), 'Sure');
  // A stray closing tag goes too.
  assert.equal(withoutListTags('Fine </list_add> then').replace(/\s+/g, ' ').trim(), 'Fine then');
  // In a text reply (no <say> tags).
  assert.equal(cleanText('Added it! <list_add list="games">Hades 2</list_add>', { botName: 'Gremlin' }).text, 'Added it!');
  // In the words of a reminder or a song.
  assert.equal(cleanSpoken(withoutHiddenTags('Mike, time to queue. <list_add list="x">y</list_add>'), { botName: 'G' }).text, 'Mike, time to queue.');
  assert.deepEqual(
    songTags('<song style="punk" seconds="30">[Verse] la la <list_add list="x">Hades</list_add> done <list_post list="x"/></song>').map((s) => s.lyrics.replace(/\s+/g, ' ')),
    ['[Verse] la la done'],
  );
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

test('names and items: matched without "the", "list", case or end punctuation', () => {
  assert.equal(listKey('The Games To Try List'), 'games to try');
  assert.equal(listKey('games-to-try'), 'games to try');
  assert.equal(listKey('List'), 'list');
  assert.equal(displayName('the games to try list'), 'Games to try');
  assert.equal(displayName('"shopping list"'), 'Shopping');
  assert.equal(displayName('x'.repeat(60)).length, MAX_NAME_CHARS);
  assert.equal(cleanItem('  "Hades   2"  '), 'Hades 2');
  assert.ok(cleanItem('word '.repeat(80)).length <= MAX_ITEM_CHARS);
});

test('adding: a new name starts a list, the same item twice is kept once, and a ticked-off one comes back', () => {
  const memory = fakeMemory();
  const lists = new Lists({ memory, clock: () => Date.parse('2026-10-29T03:00:00Z') });
  const { results } = lists.apply('g', [op('add', 'Games to try', 'Hades 2'), op('add', 'the games to try list', 'Deadlock'), op('add', 'GAMES TO TRY', 'hades 2.')], { by: 'Mike' });
  assert.deepEqual(
    results.map((r) => [r.op, r.ok, r.list, r.item, Boolean(r.created), Boolean(r.duplicate), r.count]),
    [
      ['add', true, 'Games to try', 'Hades 2', true, false, 1],
      ['add', true, 'Games to try', 'Deadlock', false, false, 2],
      ['add', true, 'Games to try', 'hades 2.', false, true, 2],
    ],
  );
  assert.equal(memory.saves, 1, 'saved once for the whole answer');
  const [games] = lists.all('g');
  assert.equal(games.name, 'Games to try');
  assert.deepEqual(games.items[0], { text: 'Hades 2', done: false, by: 'Mike', at: '2026-10-29T03:00:00.000Z' });
  lists.apply('g', [op('done', 'games to try', '1')]);
  assert.deepEqual(texts(lists.find('g', 'games to try')), ['~Hades 2', 'Deadlock']);
  lists.apply('g', [op('add', 'games to try', 'Hades 2')]);
  assert.deepEqual(texts(lists.find('g', 'games to try')), ['Hades 2', 'Deadlock'], 'added again: back on');
  // Adding to a name that isn't there starts a new list, even if another one has that word.
  lists.apply('g', [op('add', 'games', 'Silksong')]);
  assert.deepEqual(lists.all('g').map((l) => l.name), ['Games to try', 'Games']);
});

test('taking off and ticking off: by the number it was shown, or by the words', () => {
  const memory = fakeMemory();
  const lists = new Lists({ memory });
  lists.apply('g', ['Hades 2', 'Deadlock', 'Silksong', 'Elden Ring Nightreign'].map((i) => op('add', 'games', i)));
  // Two numbers in one answer are both the ones it saw (taking 2 off doesn't move 4 up).
  const { results } = lists.apply('g', [op('remove', 'games', '2'), op('remove', 'games', '#4')]);
  assert.deepEqual(results.map((r) => [r.ok, r.item]), [
    [true, 'Deadlock'],
    [true, 'Elden Ring Nightreign'],
  ]);
  assert.deepEqual(texts(lists.find('g', 'games')), ['Hades 2', 'Silksong']);
  // By words: the same words, or the only item that contains them.
  assert.equal(lists.apply('g', [op('done', 'games', 'silksong')]).results[0].item, 'Silksong');
  assert.equal(lists.apply('g', [op('remove', 'games', 'hades')]).results[0].item, 'Hades 2');
  assert.deepEqual(texts(lists.find('g', 'games')), ['~Silksong']);
  const nope = lists.apply('g', [op('remove', 'games', 'Portal'), op('done', 'games', '9'), op('remove', 'nothing', '1')]).results;
  assert.deepEqual(nope.map((r) => r.error), ['no such item', 'no such item', 'no such list']);
  assert.match(problemNote(nope), /^-# \(I couldn't take off "Portal" \(Games\): no such item; tick off "9" \(Games\): no such item; take off "1" \(Nothing\): no such list\.\)$/);
  // Ticking off one that's already ticked off is fine.
  assert.equal(lists.apply('g', [op('done', 'games', '1')]).results[0].already, true);
});

test('for anything but adding, "the games list" finds the only list with those words', () => {
  const lists = new Lists({ memory: fakeMemory() });
  lists.apply('g', [op('add', 'games to try', 'Hades 2'), op('add', 'shopping for LAN night', 'chips')]);
  assert.equal(lists.apply('g', [op('done', 'the games list', '1')]).results[0].ok, true);
  assert.equal(lists.apply('g', [op('post', 'shopping')]).posts[0].name, 'Shopping for LAN night');
  lists.apply('g', [op('add', 'games for later', 'Portal')]);
  assert.equal(lists.apply('g', [op('remove', 'games', '1')]).results[0].error, 'no such list', 'two lists with that word: not a guess');
});

test('clearing, deleting and posting', () => {
  const lists = new Lists({ memory: fakeMemory() });
  lists.apply('g', [op('add', 'shopping', 'chips'), op('add', 'shopping', 'salsa'), op('add', 'ban list', 'Yuumi')]);
  const { results, posts } = lists.apply('g', [op('post', 'shopping'), op('clear', 'shopping'), op('post', 'shopping'), op('delete', 'ban'), op('post', 'ban'), op('post', 'all')]);
  assert.deepEqual(results.map((r) => [r.op, r.ok, r.count ?? null]), [
    ['post', true, null],
    ['clear', true, 2],
    ['post', true, null],
    ['delete', true, 1],
    ['post', false, null],
    ['post', true, null],
  ]);
  // Each post shows the list as it was at that point.
  assert.deepEqual(
    posts.map((p) => (p.missing !== undefined ? `missing ${p.missing}` : p.all ? `all: ${p.all.map((l) => l.name).join(', ')}` : `${p.name}: ${p.items.length}`)),
    ['Shopping: 2', 'Shopping: 0', 'missing Ban', 'all: Shopping'],
  );
  assert.deepEqual(lists.all('g').map((l) => l.name), ['Shopping']);
  lists.apply('g', [op('delete', 'shopping')]);
  assert.deepEqual(lists.apply('g', [op('post', 'all')]).posts, [{ all: [] }]);
  // A tag with no list name.
  assert.equal(lists.apply('g', [op('add', '', 'x')]).results[0].error, 'no list name');
});

test('limits: lists per server, items per list (a ticked-off one makes room)', () => {
  const lists = new Lists({ memory: fakeMemory() });
  lists.apply('g', Array.from({ length: MAX_LISTS }, (_, i) => op('add', `list ${i}`, 'x')));
  assert.equal(lists.apply('g', [op('add', 'one too many', 'x')]).results[0].error, `there are already ${MAX_LISTS} lists`);
  const full = new Lists({ memory: fakeMemory() });
  full.apply('g', Array.from({ length: MAX_ITEMS }, (_, i) => op('add', 'big', `item ${i}`)));
  const r = full.apply('g', [op('add', 'big', 'one more')]).results[0];
  assert.equal(r.error, `the list is full (${MAX_ITEMS} items)`);
  assert.match(problemNote([r]), /I couldn't add "one more" \(Big\): the list is full/);
  full.apply('g', [op('done', 'big', '3')]);
  assert.equal(full.apply('g', [op('add', 'big', 'one more')]).results[0].ok, true);
  const items = full.find('g', 'big').items;
  assert.equal(items.length, MAX_ITEMS);
  assert.ok(!items.some((i) => i.text === 'item 2'), 'the ticked-off one made room');
  assert.equal(items.at(-1).text, 'one more');
});

// ---------------------------------------------------------------------------
// How it's shown: to it, and in the text chat
// ---------------------------------------------------------------------------

test('in its prompt: numbered, ticked-off marked, the newest-changed first, cut at about 1,500 characters', () => {
  assert.equal(formatListsForPrompt([]), '(no lists yet)');
  const lists = [
    { name: 'Shopping', items: [], updatedAt: '2026-10-01T00:00:00Z' },
    { name: 'Games', items: [{ text: 'Hades 2' }, { text: 'Deadlock', done: true }], updatedAt: '2026-10-28T00:00:00Z' },
  ];
  assert.equal(formatListsForPrompt(lists), '- Games (2):\n  1. "Hades 2"\n  2. "Deadlock" (done)\n- Shopping (0): empty');
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `List ${i}`, items: Array.from({ length: 10 }, (_, j) => ({ text: `a fairly long item number ${j}` })), updatedAt: `2026-10-${10 + i}T00:00:00Z` }));
  const shown = formatListsForPrompt(many);
  assert.ok(shown.length <= 1500, shown.length);
  assert.match(shown, /^- List 11 \(10\):\n  1\. "a fairly long item number 0"/, 'the newest first');
  assert.match(shown, /more lists? not shown: /);
});

test('in the text chat: bold title and count, numbered, ticked-off struck through, markdown escaped, no message over 2,000', () => {
  const games = { name: 'Games *to* try', items: [{ text: 'Hades_2' }, { text: 'Dead~lock', done: true }, { text: '<@123> @everyone' }] };
  assert.deepEqual(formatListPosts([games]), ['**Games \\*to\\* try** (3)\n1. Hades\\_2\n2. ~~Dead\\~lock~~\n3. \\<@123\\> @everyone']);
  assert.equal(escapeMarkdown('a*b_c`d|e>f[g]h\\i'), 'a\\*b\\_c\\`d\\|e\\>f\\[g\\]h\\\\i');
  // Short lists share a message; a missing one and no lists at all say so.
  assert.deepEqual(formatListPosts([{ name: 'Shopping', items: [] }, { missing: 'ban list' }]), ['**Shopping** (empty)\n\nThere\'s no list called "Ban".']);
  assert.deepEqual(formatListPosts([{ all: [] }]), ["There aren't any lists yet."]);
  // A long list goes on in the next message.
  const big = { name: 'Big', items: Array.from({ length: 50 }, (_, i) => ({ text: `${'x'.repeat(190)} ${i}` })) };
  const parts = formatListPosts([big]);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((m) => m.length <= 2000));
  assert.match(parts[1], /^\*\*Big\*\* \(continued\)\n/);
  assert.equal(parts.join('\n').match(/^\d+\. /gm).length, 50, 'every item, once');
});

test('the log has the words only when transcripts are logged; the notes in the chat', () => {
  const r = { op: 'add', ok: true, list: 'Games', item: 'Hades 2', count: 3 };
  assert.equal(describeResult(r), 'added an item to a list (3 items)');
  assert.equal(describeResult(r, { words: true }), 'added "Hades 2" to "Games" (3 items)');
  assert.equal(describeResult({ op: 'clear', ok: true, list: 'Games', count: 1 }), 'cleared a list (1 item taken off)');
  assert.equal(describeResult({ op: 'post', ok: false, list: 'Ban', error: 'no such list' }, { words: true }), 'couldn\'t post on "Ban": no such list');
  assert.equal(changeNote([r, { op: 'post', ok: true, list: 'Games' }]), '-# (Added "Hades 2" to Games.)');
  assert.equal(changeNote([{ op: 'post', ok: true }]), '');
  assert.equal(problemNote([{ op: 'post', ok: false, error: 'no such list' }]), '', 'a missing list says so in its own post');
});

// ---------------------------------------------------------------------------
// memory.json
// ---------------------------------------------------------------------------

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gremlin-lists-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('lists are saved in memory.json and are there after a restart; /forgetcalls leaves them', () => {
  const dir = tmp();
  try {
    const memory = new Memory(dir);
    new Lists({ memory }).apply('g1', [op('add', 'games', 'Hades 2'), op('add', 'games', 'Deadlock')], { by: 'Mike' });
    memory.forgetCalls('g1');
    memory.flush();
    const again = new Lists({ memory: new Memory(dir) });
    assert.deepEqual(texts(again.find('g1', 'games')), ['Hades 2', 'Deadlock']);
    assert.equal(again.find('g1', 'games').items[0].by, 'Mike');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('when memory.json could not be read at start, the lists in it are kept and this run\'s are added on top', async () => {
  const dir = tmp();
  const { error, warn, log: info } = console;
  console.error = console.warn = console.log = () => {};
  try {
    const file = path.join(dir, 'memory.json');
    fs.mkdirSync(file); // in the way and unreadable, like a file a sync app is holding
    const memory = new Memory(dir, { retryReadMs: 100 });
    assert.ok(memory.unreadable);
    const lists = new Lists({ memory });
    lists.apply('g1', [op('add', 'games', 'Hades 2'), op('add', 'games', 'Elden Ring'), op('done', 'games', 'Elden Ring'), op('add', 'new one', 'x')]);
    memory.flush();
    assert.equal(fs.statSync(file).isDirectory(), true, 'not saved over');
    fs.rmSync(file, { recursive: true });
    const saved = {
      guilds: {
        g1: {
          facts: [],
          optouts: [],
          lists: [
            { key: 'a', name: 'Games', items: [{ text: 'Elden Ring', done: false }, { text: 'Portal', done: false }], updatedAt: '2026-10-01T00:00:00Z' },
            { key: 'b', name: 'Shopping', items: [{ text: 'chips', done: false }] },
          ],
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(saved));
    await wait(600); // the retry reads it, then the change is saved
    assert.equal(memory.unreadable, null);
    const now = JSON.parse(fs.readFileSync(file, 'utf8')).guilds.g1.lists;
    assert.deepEqual(
      now.map((l) => [l.name, l.items.map((i) => `${i.done ? '~' : ''}${i.text}`)]),
      [
        ['Games', ['~Elden Ring', 'Portal', 'Hades 2']],
        ['Shopping', ['chips']],
        ['New one', ['x']],
      ],
    );
  } finally {
    console.error = error;
    console.warn = warn;
    console.log = info;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeLists keeps everything already saved', () => {
  assert.deepEqual(mergeLists(undefined, [{ name: 'A', items: [{ text: 'x' }] }]).map((l) => l.name), ['A']);
  const merged = mergeLists([{ name: 'A', items: [{ text: 'x' }, { text: 'y' }] }], [{ name: 'the a list', items: [{ text: 'X', done: true }] }]);
  assert.deepEqual(texts(merged[0]), ['~x', 'y']);
  assert.deepEqual(mergeLists([{ name: 'A', items: [] }], []).length, 1);
});

// ---------------------------------------------------------------------------
// In voice: applied once its answer is heard
// ---------------------------------------------------------------------------

const brainConfig = {
  botName: 'Gremlin',
  botAliases: ['gremlin'],
  timezone: 'UTC',
  defaultChattiness: 'off',
  persona: 'You are Gremlin.',
  lore: '',
  tts: { audioTags: false },
  transcript: { maxLines: 40, maxMinutes: 15 },
};

function voiceBrain({ reply, outcome = 'played', lists = '(no lists yet)', config = {} }) {
  const calls = [];
  const applied = [];
  const said = [];
  const brain = new Brain({
    config: { ...brainConfig, ...config },
    claude: {
      async createMessage(args) {
        calls.push(args);
        return { text: reply, refusal: false };
      },
    },
    speaker: {
      speaking: false,
      wasAudibleBetween: () => false,
      say(text, opts = {}) {
        said.push(text);
        if (outcome === 'played') opts.onStart?.();
        return Promise.resolve(outcome);
      },
      stop() {},
      stopKind() {},
      dropOptional() {},
    },
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike'], activities: [] }),
    getLists: () => lists,
    onLists: (tags, info) => applied.push({ tags, info }),
  });
  return { brain, calls, applied, said };
}

test('in voice: the lists are in its prompt, and the tags are applied once its answer is heard, never said', async () => {
  const t = voiceBrain({ reply: '<say>Added it, and it is in the chat.</say> <list_add list="games">Hades 2</list_add> <list_post list="games"/>', lists: '- Games (1): 1. Deadlock' });
  assert.equal(t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin add hades 2 to the games list and post it' }), 'direct');
  await settle();
  assert.deepEqual(t.said, ['Added it, and it is in the chat.']);
  assert.equal(t.applied.length, 1);
  // (A plain-text getLists has no copy for item numbers: shown is null, and the current lists count.)
  assert.deepEqual(t.applied[0].tags, { ops: [op('add', 'games', 'Hades 2'), op('post', 'games')], cutOff: false, shown: null });
  assert.equal(t.applied[0].info.name, 'Mike');
  assert.match(t.calls[0].system[0].text, /<lists>/);
  assert.match(String(t.calls[0].user), /<lists_now note="[^"]*">\n- Games \(1\): 1\. Deadlock\n<\/lists_now>/);
  assert.equal(t.calls[0].maxTokens, 200 + 80);
});

test('in voice: nothing changes when its answer is not heard, or when it passes', async () => {
  const dropped = voiceBrain({ reply: '<say>Added it.</say> <list_add list="games">Hades 2</list_add>', outcome: 'dropped' });
  dropped.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin add hades 2 to the games list' });
  await settle();
  assert.equal(dropped.applied.length, 0);
  const passed = voiceBrain({ reply: '[PASS] <list_add list="games">Hades 2</list_add>' });
  passed.brain.speaker.talkedOver = false;
  passed.brain.listenFor('u1', 0); // after a bare "Gremlin!" the next line may pass
  passed.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'add hades 2 to the games list' });
  await settle();
  assert.equal(passed.said.length, 0);
  assert.equal(passed.applied.length, 0);
});

test('in voice: an answer cut off in the middle of a list tag says so instead of changing the list', async () => {
  const t = voiceBrain({ reply: '<say>Adding it.</say> <list_add list="games">Hades' });
  t.brain.claude.createMessage = async (args) => (t.calls.push(args), { text: '<say>Adding it.</say> <list_add list="games">Hades', refusal: false, stopReason: 'max_tokens' });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin add hades 2 to the games list' });
  await settle();
  assert.deepEqual(t.said, ['Adding it.']);
  assert.deepEqual(t.applied[0].tags, { ops: [], cutOff: true, shown: null });
});

test('with LISTS off there is no lists section and nothing is applied', async () => {
  const t = voiceBrain({ reply: '<say>Sure.</say> <list_add list="games">Hades 2</list_add>', config: { lists: false } });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin add hades 2 to the games list' });
  await settle();
  assert.doesNotMatch(t.calls[0].system[0].text, /<lists>/);
  assert.doesNotMatch(String(t.calls[0].user), /<lists_now/);
  assert.equal(t.applied.length, 0);
  assert.deepEqual(t.said, ['Sure.']);
});

function sessionWith({ lists, textChannel, logTranscripts = false }) {
  return new VoiceSession({
    client: { user: { id: 'bot' } },
    guild: { id: 'g1', name: 'Pressure', channels: { cache: new Map() }, voiceStates: { cache: new Map() }, members: { cache: new Map() } },
    voiceChannel: { id: 'B' },
    textChannel,
    config: { botName: 'Gremlin', botAliases: ['gremlin'], stt: { extraTerms: [] }, tts: { audioTags: false }, timezone: 'UTC', logTranscripts },
    memory: {},
    lists,
  });
}

test('in voice: the session makes the changes and posts what was asked for in the call\'s text chat, in order', async () => {
  const posted = [];
  const textChannel = { id: 'T', send: async (m) => posted.push(m) };
  const lists = new Lists({ memory: fakeMemory() });
  const s = sessionWith({ lists, textChannel });
  s.applyLists({ ops: [op('add', 'games', 'Hades 2'), op('add', 'games', 'Deadlock'), op('post', 'games'), op('remove', 'shopping', '1')], cutOff: false }, { name: 'Mike' });
  await settle();
  assert.deepEqual(
    posted.map((m) => m.content),
    ['**Games** (2)\n1. Hades 2\n2. Deadlock', '-# (I couldn\'t take off "1" (Shopping): no such list.)'],
  );
  assert.ok(posted.every((m) => Array.isArray(m.allowedMentions?.parse) && m.allowedMentions.parse.length === 0), 'nobody is pinged');
  assert.equal(lists.find('g1', 'games').items[0].by, 'Mike');
  posted.length = 0;
  s.applyLists({ ops: [], cutOff: true }, { name: 'Mike' });
  await settle();
  assert.match(posted[0].content, /ran out of room writing that down/);
  // No text chat for the call: the changes are still made.
  const quiet = sessionWith({ lists, textChannel: null });
  quiet.applyLists({ ops: [op('add', 'games', 'Silksong'), op('post', 'games')] }, { name: 'Jess' });
  assert.equal(lists.find('g1', 'games').items.length, 3);
});

// ---------------------------------------------------------------------------
// In text: @mentions
// ---------------------------------------------------------------------------

function textCtx(reply, { lists = new Lists({ memory: fakeMemory() }), config = {} } = {}) {
  const calls = [];
  return {
    calls,
    lists,
    ctx: {
      config: { botName: 'Gremlin', persona: 'p', lore: '', timezone: 'UTC', anthropic: { webSearch: { enabled: false } }, ...config },
      claude: { createMessage: async (args) => (calls.push(args), typeof reply === 'function' ? reply(args) : { text: reply, refusal: false }) },
      memory: { facts: () => [] },
      sessions: new Map(),
      lists,
    },
  };
}

test('an @mention can change and post lists: the reply never shows the tags, and the posts go up after it', async () => {
  const t = textCtx('Added it! Here it is. <list_add list="games">Hades 2</list_add> <list_post list="games"/>');
  const handed = [];
  const text = await textReply(t.ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'add hades 2 to the games list and show it', onLists: (m) => handed.push(m) });
  assert.equal(text, 'Added it! Here it is.');
  assert.deepEqual(handed, [['**Games** (1)\n1. Hades 2']]);
  assert.equal(t.lists.find('g', 'games').items[0].by, 'Jess');
  assert.match(t.calls[0].system[0].text, /<lists>/);
  assert.match(String(t.calls[0].user), /<lists_now note="[^"]*">\n\(no lists yet\)\n<\/lists_now>/);
  assert.equal(t.calls[0].maxTokens, 480);
  // The next @mention sees what's on it.
  await textReply(t.ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: "what's on the games list", onLists: () => {} });
  assert.match(String(t.calls[1].user), /- Games \(1\):\n  1\. "Hades 2"/);
});

test('an @mention that passed changes nothing; one that is only tags says what changed', async () => {
  const passed = textCtx('[PASS] <list_add list="games">Hades 2</list_add>');
  const handed = [];
  assert.equal(await textReply(passed.ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'lol', onLists: (m) => handed.push(m) }), '');
  assert.deepEqual(handed, []);
  assert.deepEqual(passed.lists.all('g'), []);
  const bare = textCtx('<list_add list="games">Hades 2</list_add>');
  assert.equal(await textReply(bare.ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'add hades 2 to games', onLists: (m) => handed.push(m) }), '');
  assert.deepEqual(handed, [['-# (Added "Hades 2" to Games.)']]);
});

test('without a place to post (like /roast in text), or with LISTS off, lists are left out of a text reply', async () => {
  const t = textCtx('Sure. <list_add list="games">Hades 2</list_add>');
  assert.equal(await textReply(t.ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'hi' }), 'Sure.');
  assert.doesNotMatch(t.calls[0].system[0].text, /<lists>/);
  assert.deepEqual(t.lists.all('g'), []);
  const off = textCtx('Sure. <list_add list="games">Hades 2</list_add>', { config: { lists: false } });
  await textReply(off.ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'hi', onLists: () => assert.fail('nothing to post') });
  assert.doesNotMatch(off.calls[0].system[0].text, /<lists>/);
  assert.deepEqual(off.lists.all('g'), []);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('LISTS is on unless turned off, and the app has a switch for it', (t) => {
  const saved = process.env.LISTS;
  try {
    delete process.env.LISTS;
    const c = loadConfig();
    if (c.envFile) t.diagnostic('a real .env is present; its LISTS (if any) wins');
    else assert.equal(c.lists, true);
    process.env.LISTS = 'false';
    assert.equal(loadConfig().lists, false);
  } finally {
    if (saved === undefined) delete process.env.LISTS;
    else process.env.LISTS = saved;
  }
  assert.equal(FIELDS.get('LISTS').type, 'toggle');
  assert.equal(FIELDS.get('LISTS').default, 'true');
  const system = buildSystem({ botName: 'Gremlin', persona: 'p', lists: true })[0].text;
  assert.match(system, /<list_add list="games to try">Hades 2<\/list_add>/);
  assert.match(system, /Never read a long list out loud/);
  assert.doesNotMatch(buildSystem({ botName: 'Gremlin', persona: 'p' })[0].text, /<lists>/);
  assert.doesNotMatch(buildUserMessage({ callInfo: 'x', transcript: 'y', task: 'z' }), /lists_now/);
});

// ---------------------------------------------------------------------------
// From the independent review
// ---------------------------------------------------------------------------

test('an item is found by its exact words, or by all of its words when only one item has them, never a near miss', () => {
  const lists = new Lists({ memory: fakeMemory() });
  lists.apply('g', [op('add', 'games', 'Hades'), op('add', 'games', 'Deadlock'), op('add', 'snacks', 'tea'), op('add', 'snacks', 'pop'), op('add', 'snacks', 'chips and salsa')]);
  assert.equal(lists.apply('g', [op('remove', 'games', 'Hades 2')]).results[0].error, 'no such item', '"Hades 2" is not "Hades"');
  assert.equal(lists.apply('g', [op('remove', 'snacks', 'steak')]).results[0].error, 'no such item', '"steak" is not "tea"');
  assert.equal(lists.apply('g', [op('done', 'snacks', 'popcorn')]).results[0].error, 'no such item');
  assert.equal(lists.apply('g', [op('done', 'snacks', 'all')]).results[0].error, 'no such item', '"all" picks out nothing');
  assert.deepEqual(lists.apply('g', [op('done', 'snacks', 'the chips')]).results[0].item, 'chips and salsa', 'all of its words, as whole words');
  // "remove 1, then tick off 1": the second still means the first item as it was shown, now gone.
  const r = lists.apply('g', [op('remove', 'games', '1'), op('done', 'games', '1')]).results;
  assert.deepEqual(r.map((x) => [x.op, x.ok, x.item]), [
    ['remove', true, 'Hades'],
    ['done', false, 'Hades'],
  ]);
  assert.deepEqual(texts(lists.find('g', 'games')), ['Deadlock']);
});

test('item numbers mean the items it was shown, even when the list changed before its answer was heard', () => {
  const lists = new Lists({ memory: fakeMemory() });
  lists.apply('g', [op('add', 'shopping', 'chips'), op('add', 'shopping', 'salsa'), op('add', 'shopping', 'soda'), op('add', 'shopping', 'ice')]);
  const shown = lists.all('g'); // what Jess's answer was written from
  lists.apply('g', [op('remove', 'shopping', '1')]); // Mike's answer, heard first: chips off
  lists.apply('g', [op('done', 'shopping', '3')], { shown }); // Jess: "tick off the soda" (3 when she asked)
  assert.deepEqual(texts(lists.find('g', 'shopping')), ['salsa', '~soda', 'ice']);
  // One taken off meanwhile isn't touched by its old number.
  const again = lists.all('g');
  lists.apply('g', [op('remove', 'shopping', 'ice')]);
  assert.equal(lists.apply('g', [op('remove', 'shopping', '3')], { shown: again }).results[0].error, 'no such item');
});

test('in voice, the copy of the lists its prompt showed goes with its changes', async () => {
  const shown = [{ key: 'k1', name: 'Games', items: [{ text: 'Deadlock' }] }];
  const t = voiceBrain({ reply: '<say>Took it off.</say> <list_remove list="games" item="1"/>', lists: { text: '- Games (1):\n  1. "Deadlock"', shown } });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'gremlin take the first one off the games list' });
  await settle();
  assert.deepEqual(t.applied[0].tags.shown, shown);
  assert.match(String(t.calls[0].user), /<lists_now note="[^"]*">\n- Games \(1\):\n {2}1\. "Deadlock"\n<\/lists_now>/);
});

test('a long list name finds the same list again, and a name with no letters or digits is refused', () => {
  const lists = new Lists({ memory: fakeMemory() });
  const long = "stuff to buy for Saturday's LAN party at Mike's place";
  lists.apply('g', [op('add', long, 'chips'), op('add', long, 'salsa'), op('add', long, 'soda')]);
  assert.equal(lists.all('g').length, 1, 'one list, not three');
  assert.ok(lists.all('g')[0].name.length <= MAX_NAME_CHARS);
  assert.doesNotMatch(lists.all('g')[0].name, /\bat$/, 'cut at a word');
  assert.equal(lists.apply('g', [op('remove', long, 'salsa')]).results[0].ok, true);
  assert.equal(lists.apply('g', [op('add', '🎮', 'Hades')]).results[0].error, 'a list name needs letters or numbers');
  assert.equal(lists.all('g').length, 1);
});

test('clearing and deleting need the exact name, and a deleted or cleared list can be brought back', () => {
  const lists = new Lists({ memory: fakeMemory() });
  lists.apply('g', [op('add', 'movie night snacks', 'popcorn'), op('add', 'movies', 'Alien'), op('add', 'all games', 'Hades')]);
  assert.equal(lists.apply('g', [op('delete', 'movie list')]).results[0].error, 'no such list', 'not "Movie night snacks" by a guess');
  assert.equal(lists.apply('g', [op('delete', 'all')]).results[0].error, 'no such list', 'not "All games"');
  assert.equal(lists.all('g').length, 3);
  lists.apply('g', [op('delete', 'movies'), op('clear', 'movie night snacks')]);
  assert.deepEqual(lists.all('g').map((l) => `${l.name} ${l.items.length}`), ['Movie night snacks 0', 'All games 1']);
  assert.match(formatListsForPrompt(lists.all('g'), { trash: lists.trash('g') }), /Deleted or cleared lately, can be brought back with <list_restore>: Movie night snacks \(cleared, 1 item\), Movies \(deleted, 1 item\)/);
  const r = lists.apply('g', [op('restore', 'movies'), op('restore', 'movie night snacks')]).results;
  assert.deepEqual(r.map((x) => [x.ok, x.restored]), [
    [true, 'deleted'],
    [true, 'cleared'],
  ]);
  assert.deepEqual(lists.all('g').map((l) => `${l.name}: ${texts(l).join(', ')}`).sort(), ['All games: Hades', 'Movie night snacks: popcorn', 'Movies: Alien']);
  assert.equal(lists.apply('g', [op('restore', 'movies')]).results[0].error, 'nothing like that was deleted or cleared lately');
});

test('"post all the lists" gives a short overview when the whole thing would flood the chat', () => {
  const lists = new Lists({ memory: fakeMemory() });
  for (let i = 0; i < 20; i++) lists.apply('g', Array.from({ length: 50 }, (_, j) => op('add', `list ${i}`, `item ${j} of list ${i}`)));
  const messages = formatListPosts(lists.apply('g', [op('post', 'all')]).posts);
  assert.ok(messages.length <= 2, messages.length);
  assert.match(messages[0], /^\*\*Lists\*\* \(20\)\n- \*\*List 0\*\* \(50\): item 0 of list 0, item 1 of list 0, item 2 of list 0, and 47 more/);
  assert.match(messages.at(-1), /Ask for one list to see all of it\.$/);
  // A few short lists are posted whole.
  const few = new Lists({ memory: fakeMemory() });
  few.apply('g', [op('add', 'games', 'Hades'), op('add', 'shopping', 'chips')]);
  assert.deepEqual(formatListPosts(few.apply('g', [op('post', 'all')]).posts), ['**Games** (1)\n1. Hades\n\n**Shopping** (1)\n1. chips']);
});

test("in voice, when it can't post in the text chat, its prompt says so", () => {
  const lists = new Lists({ memory: fakeMemory() });
  const none = sessionWith({ lists, textChannel: null });
  assert.match(none.listsForPrompt().text, /You can't post in the text chat right now/);
  const blocked = sessionWith({ lists, textChannel: { id: 'T', send: async () => {}, permissionsFor: () => ({ has: () => false }) } });
  assert.match(blocked.listsForPrompt().text, /You can't post in the text chat right now/);
  const open = sessionWith({ lists, textChannel: { id: 'T', send: async () => {}, permissionsFor: () => ({ has: () => true }) } });
  assert.doesNotMatch(open.listsForPrompt().text, /can't post/);
  assert.deepEqual(open.listsForPrompt().shown, []);
});

test('in voice, an answer cut off mid-tag changes nothing at all, so asking again does nothing twice', async () => {
  const posted = [];
  const lists = new Lists({ memory: fakeMemory() });
  lists.apply('g1', [op('add', 'games', 'Hades'), op('add', 'games', 'Deadlock')]);
  const s = sessionWith({ lists, textChannel: { id: 'T', send: async (m) => posted.push(m) } });
  const tags = listTags('<say>Done.</say> <list_remove list="games" item="2"/> <list_add list="games">Port', { cutOff: true });
  assert.equal(tags.cutOff, true);
  s.applyLists(tags, { name: 'Mike' });
  await settle();
  assert.deepEqual(texts(lists.find('g1', 'games')), ['Hades', 'Deadlock'], 'Deadlock is still there');
  assert.match(posted[0].content, /the lists didn't change/);
});

test('streamed in pieces, words inside a post tag never make the spoken words shrink', () => {
  const reply = '<say>Here you go, posting it now. <list_post list="games">the games list</list_post> Check the chat for it now.</say>';
  let last = '';
  for (let i = 1; i <= reply.length; i++) {
    const words = sayContent(reply.slice(0, i)) ?? '';
    assert.ok(words.startsWith(last.trimEnd()) || last.trimEnd().startsWith(words.trimEnd()) === false ? words.startsWith(last.trimEnd()) : true, `shrank at ${i}: "${last}" -> "${words}"`);
    last = words;
  }
  assert.doesNotMatch(last, /<|list_/);
});

test('tag parsing: unquoted names, apostrophes in single quotes, unclosed adds in a row, a space after "<"', () => {
  assert.deepEqual(listTags('<list_post list=games/>').ops, [op('post', 'games')]);
  assert.deepEqual(listTags("<list_remove list='games' item='Baldur's Gate 3'/>").ops, [op('remove', 'games', "Baldur's Gate 3")]);
  assert.deepEqual(listTags('<list_add list="games">Hades 2 <list_add list="games">Deadlock').ops, [op('add', 'games', 'Hades 2'), op('add', 'games', 'Deadlock')]);
  assert.deepEqual(listTags('<list_add list="games">Hades 2\nand then more talk').ops, [], 'an unclosed add followed by more lines is not trusted');
  assert.deepEqual(listTags('< list_add list="x">Y</list_add>').ops, [op('add', 'x', 'Y')]);
  assert.equal(cleanText('Added it! < list_add list="x">Y</list_add>', { botName: 'G' }).text, 'Added it!');
  // An unclosed add written before its line doesn't silence the line.
  assert.equal(sayContent('<list_add list="games">Hades 2\n<say>Added it.</say>'), 'Added it.');
  // Half a tag at the end of a cut-off text reply doesn't show.
  assert.equal(cleanText('Added it! <lis', { botName: 'G' }).text, 'Added it!');
  assert.equal(cleanText('Added it! <remi', { botName: 'G' }).text, 'Added it!');
});

test('an @mention reply of just "PASS" changes nothing, like "[PASS]"', async () => {
  const t = textCtx('PASS <list_add list="games">Hades 2</list_add>');
  const handed = [];
  assert.equal(await textReply(t.ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'lol', onLists: (m) => handed.push(m) }), '');
  assert.deepEqual(handed, []);
  assert.deepEqual(t.lists.all('g'), []);
});

test('an @mention cut off mid-tag changes nothing and says so', async () => {
  const lists = new Lists({ memory: fakeMemory() });
  lists.apply('g', [op('add', 'games', 'Hades')]);
  const t = textCtx(() => ({ text: 'Done! <list_remove list="games" item="1"/> <list_add list="games">Dead', refusal: false, stopReason: 'max_tokens' }), { lists });
  const handed = [];
  await textReply(t.ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'swap hades for deadlock', onLists: (m) => handed.push(m) });
  assert.deepEqual(texts(lists.find('g', 'games')), ['Hades']);
  assert.match(handed[0][0], /the lists didn't change/);
});

test("its prompt's lists stay within their limit, items quoted one a line", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `List number ${i} with a long name`, items: Array.from({ length: 50 }, (_, j) => ({ text: `${'x'.repeat(150)} ${j} | 2. fake (done)` })), updatedAt: `2026-10-${10 + (i % 18)}T00:00:00Z` }));
  const trash = Array.from({ length: 5 }, (_, i) => ({ list: { name: `Old list ${i} with quite a long name`, items: [{ text: 'a' }] }, how: 'deleted', at: '2026-10-28T00:00:00Z' }));
  const shown = formatListsForPrompt(many, { trash });
  assert.ok(shown.length <= 1500, shown.length);
  assert.match(shown, /\n {2}1\. "x+ 0 \| 2\. fake \(done\)"/, 'an item that looks like more items stays one quoted line');
});

test('small slips in how a tag is written still work, and nothing shown is taken back as it streams in', () => {
  const ops = (text) => listTags(text).ops.map((o) => `${o.op}:${o.list}:${o.item ?? ''}`);
  // A tag left open before another one: two items, not one run together.
  assert.deepEqual(ops('Sure. <list_add list="games">Hades 2 <list_add list="games">Deadlock</list_add> Bye.'), ['add:games:Hades 2', 'add:games:Deadlock']);
  // </list> closes one, and what follows it is still said.
  assert.deepEqual(ops('Sure. <list_add list="games">Hades 2</list> Want more?'), ['add:games:Hades 2']);
  assert.equal(withoutListTags('Sure. <list_add list="games">Hades 2</list> Want more?').replace(/\s+/g, ' '), 'Sure. Want more?');
  // A remove or done that names its item needs no closing.
  const said = '<say>Took it off. <list_remove list="games" item="2"> Anything else?</say>';
  assert.deepEqual(ops(said), ['remove:games:2']);
  assert.equal(sayContent(withoutHiddenTags(said)).replace(/\s+/g, ' '), 'Took it off. Anything else?');
  // Quotes written as if in a string, and an item tag left open right before its <say>.
  assert.deepEqual(ops('<list_add list=\\"games\\">Hades 2</list_add>'), ['add:games:Hades 2']);
  assert.deepEqual(ops('<list_add list="games">Hades 2<say>Done.</say>'), ['add:games:Hades 2']);
  // A lone "<" at the end of a cut-off reply is half a tag.
  assert.equal(listTags('Done! <list_add list="games">Hades</list_add> <', { cutOff: true }).cutOff, true);
  assert.equal(withoutListTags('Added it! <').trim(), 'Added it!');
  // What's shown while it streams in only ever grows.
  const replies = [
    '<say>Took it off the list for you. <list_remove list="games" item="2"> Anything else you need from me?</say>',
    '<list_add list="games">Hades 2<say>Done, it is on the games list now.</say>',
    'Sure. <list_add list="games">Hades 2 <list_add list="games">Deadlock</list_add> Bye.',
    'Okay, a < b and c > d. <list_add list="math">a < b</list_add> Done.',
    '<say>Sure thing. <list_add list="games">Hades 2</list_add> It is on there.</say> <list_post list="games"/>',
  ];
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const r of replies) {
    const final = norm(withoutListTags(r));
    for (let i = 1; i <= r.length; i++) assert.ok(final.startsWith(norm(withoutListTags(r.slice(0, i)))), `${JSON.stringify(r.slice(0, i))} shows what ${JSON.stringify(final)} doesn't`);
  }
});

test('what it says while a reply streams in is never taken back, character for character', () => {
  // Spoken text is handed on by how many characters were said, so even spaces must stay put.
  const replies = [
    '<say>Took it off the list for you. <list_remove list="games" item="1">Deadlock</list_remove> Anything else you need from me?</say>',
    '<say>Added it for you right now. <list_add list="games">Hades 2</list_post> It is on the games list now, Mike.</list_add></say>',
    '<list_add list="shopping">chips\nsalsa\n<say>Added chips and salsa for you. <list_add list="shopping">soda</list_add> Anything else for the party?</say>',
    '<say>Here you go, it is posted. <list_post list="ideas -> later"/> Have a look in the chat.</say>',
    '<say>Added it to the games list for you. <list_add list="games">Hades 2</say>',
  ];
  for (const r of replies) {
    const final = sayContent(withoutHiddenTags(r)) ?? '';
    for (let i = 1; i <= r.length; i++) {
      const now = sayContent(withoutHiddenTags(r.slice(0, i))) ?? '';
      assert.ok(final.startsWith(now), `${JSON.stringify(r.slice(0, i))} says ${JSON.stringify(now)}, but the whole reply says ${JSON.stringify(final)}`);
    }
  }
  const ops = (text) => listTags(text).ops.map((o) => `${o.op}:${o.list}:${o.item ?? ''}`);
  assert.deepEqual(ops(replies[0]), ['remove:games:1']);
  assert.deepEqual(ops(replies[1]), ['add:games:Hades 2'], 'a wrong closing tag ends the item');
  assert.deepEqual(ops(replies[4]), ['add:games:Hades 2'], 'an item left open at </say>');
});
