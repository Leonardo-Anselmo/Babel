// Shared lists people keep with it ("Babel, add Hades 2 to the games list", "post the
// shopping list", "@Babel take Deadlock off games to try"): named lists for the whole
// server, kept in data/memory.json between calls. Its answer carries tags that are never
// said or shown: <list_add>, <list_remove>, <list_done>, <list_clear>, <list_delete>,
// <list_restore> (a deleted or cleared list comes back) and <list_post>. They're applied
// once the answer is heard (or, in text, once it's decided), and a list someone wants to
// see is posted in the text chat. LISTS=false turns this off.

import { PermissionFlagsBits } from 'discord.js';

export const MAX_LISTS = 20; // per server
export const MAX_ITEMS = 50; // per list
export const MAX_ITEM_CHARS = 200;
export const MAX_NAME_CHARS = 40;
// How much of the lists goes into its prompt (the newest-changed lists first).
export const PROMPT_CHARS = 1500;
// Discord's limit is 2,000 characters a message; a little room to spare.
export const POST_CHARS = 1900;

// Tags with an item: <list_add list="games">Hades 2</list_add>, or closed in place:
// <list_remove list="games" item="2"/>. (Double-quoted values may hold ">"; a single
// quote is taken as an apostrophe here: attributes() sorts out single-quoted values.)
// The words can't run into another list tag, and </list> closes one too.
const ATTRS = String.raw`((?:[^<>"“]|"[^"]*"|“[^”]*”)*?)`;
const ITEM_TAG = new RegExp(String.raw`<\s*list_(add|remove|done)\b${ATTRS}(?:\/\s*>|>((?:(?!<\s*(?:\/\s*)?list)[\s\S])*?)<\s*\/\s*list(?:_\1)?\s*>)`, 'gi');
// The ones with nothing inside (post, clear, delete, restore): each opening tag is the
// whole thing, so words written inside one are simply left as they are.
const BARE_TAG = new RegExp(String.raw`<\s*list_(post|clear|delete|restore)\b${ATTRS}\/?\s*>`, 'gi');
// An item tag still open: being written, or never closed.
const OPEN_ITEM_TAG = new RegExp(String.raw`<\s*list_(add|remove|done)\b${ATTRS}>`, 'gi');
const CLOSE_TAG = /<\s*\/\s*list(?:_[a-z]+)?\s*>/gi;
// Half a tag at the very end ("<", "<lis", "<list_add list="ga"): still being written, or cut off.
const PARTIAL_TAG = /<\s*(?:\/\s*)?(?:(?:l|li|lis|list|list_[a-z]*)(?:\s[^<>]*)?)?$/i;
// What ends the words of an item tag left open: another list tag, or the start or end of its line (<say>, </say>).
const ENDS_OPEN_ITEM = /^<\s*(?:\/\s*)?(?:list(?![a-z])|say\b)/i;

/** The name="value" pairs in a tag (double, curly or single quotes, or no quotes). */
function attributes(text) {
  const out = {};
  // A single-quoted value can hold an apostrophe ('Baldur's Gate 3'): it ends at a quote
  // followed by the next name=, the end of the tag, or nothing.
  const re = /(?<![a-z_])([a-z_]+)\s*=\s*(?:"([^"]*)"|“([^”]*)”|'((?:[^']|'(?!\s*(?:[a-z_]+\s*=|\/?\s*>|$)))*)'|([^\s"'“”/>]+))/gi;
  const t = String(text ?? '').replace(/\\(["'“”])/g, '$1'); // list=\"games\" written as if in a string
  for (const m of t.matchAll(re)) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim();
  return out;
}

/** One tag as an operation: { op, list, item } (item: the words, or a number as text). */
function toOp(kind, attrText, inner) {
  const a = attributes(attrText);
  const op = kind.toLowerCase();
  const words = String(inner ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const out = { op, list: a.list ?? a.name ?? '' };
  if (op === 'add' || op === 'remove' || op === 'done') out.item = a.item ?? words;
  return out;
}

/** The text with these matches blanked out (so places still line up). */
const blank = (text, re) => text.replace(re, (m) => ' '.repeat(m.length));

/**
 * Where the list tags are in a reply (for listTags and withoutListTags).
 * whole: the finished tags, { at, end, op } (op null for a closing tag on its own). A
 * remove or done tag that names its item (<list_remove list="games" item="2">) is finished
 * at its ">", even when a closing tag comes later (words between them stay, as they may
 * already have been said).
 * open: item tags left open, { at, end, kind, attrs, words, ends, toEnd }: words, what
 * follows it up to the next "<"; ends, they're one line that stops at another list tag or
 * at <say> or </say>, so the tag ends there; toEnd, they're one line that runs to the end.
 * rest: the reply with the finished tags blanked out.
 */
function scanTags(t) {
  const whole = [];
  let rest = t;
  for (const m of t.matchAll(ITEM_TAG)) {
    let end = m.index + m[0].length;
    if (m[3] !== undefined && m[1].toLowerCase() !== 'add' && attributes(m[2]).item) end = m.index + m[0].lastIndexOf('<') - m[3].length;
    whole.push({ at: m.index, end, op: toOp(m[1], m[2], m[3]) });
    rest = rest.slice(0, m.index) + ' '.repeat(end - m.index) + rest.slice(end);
  }
  for (const m of rest.matchAll(BARE_TAG)) whole.push({ at: m.index, end: m.index + m[0].length, op: toOp(m[1], m[2], '') });
  rest = blank(rest, BARE_TAG);
  for (const m of rest.matchAll(CLOSE_TAG)) whole.push({ at: m.index, end: m.index + m[0].length, op: null });
  rest = blank(rest, CLOSE_TAG);
  const open = [];
  for (const m of rest.matchAll(OPEN_ITEM_TAG)) {
    const end = m.index + m[0].length;
    if (m[1].toLowerCase() !== 'add' && attributes(m[2]).item) {
      whole.push({ at: m.index, end, op: toOp(m[1], m[2], '') });
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(end);
      continue;
    }
    const after = t.slice(end);
    const stop = after.search(/</);
    const words = stop === -1 ? after : after.slice(0, stop);
    const oneLine = !words.trim().includes('\n');
    open.push({ at: m.index, end, kind: m[1], attrs: m[2], words, ends: oneLine && stop !== -1 && ENDS_OPEN_ITEM.test(after.slice(stop)), toEnd: oneLine && stop === -1 });
  }
  return { whole, open, rest };
}

/**
 * The list tags in a reply, in the order they were written: { ops: [{ op, list, item }], cutOff }.
 * cutOff (pass true when the reply ran out of room): cutOff comes back true when a tag
 * was left half written, and then the caller makes none of the changes (some may be missing).
 */
export function listTags(text, { cutOff = false } = {}) {
  const { whole, open, rest } = scanTags(String(text ?? ''));
  const found = whole.filter((x) => x.op);
  let wasCut = false;
  // An item tag left open counts only when its words are one line that runs to the end of
  // the reply, to another list tag, or to <say> or </say> ("<list_add list="games">Hades 2"):
  // otherwise what comes after it can't be told apart from the item.
  for (const o of open) {
    if (cutOff) wasCut = true;
    else if (o.ends || o.toEnd) found.push({ at: o.at, op: toOp(o.kind, o.attrs, o.words) });
  }
  if (cutOff && PARTIAL_TAG.test(rest)) wasCut = true;
  found.sort((a, b) => a.at - b.at);
  return { ops: found.map((f) => f.op), cutOff: wasCut };
}

/**
 * A reply without its list tags (they're never said or shown). A list tag still being
 * written (or never finished) hides everything after it, up to the next <say> if there is
 * one; half a tag at the end goes too. Words written inside a post, clear or delete tag
 * stay, so what's been said never changes as the reply comes in.
 */
export function withoutListTags(text) {
  const t = String(text ?? '');
  const { whole, open } = scanTags(t);
  const spans = [...whole.map((x) => [x.at, x.end]), ...open.filter((o) => o.ends).map((o) => [o.at, o.end + o.words.length])];
  // Blanked with a mark that can't be in a reply, so places still line up; each run of it is one space at the end.
  let b = t;
  for (const [a, e] of spans) b = b.slice(0, a) + '\u0000'.repeat(e - a) + b.slice(e);
  for (let from = 0; ; ) {
    const rel = b.slice(from).search(/<\s*list_(?:add|remove|done|post|clear|delete|restore)\b/i);
    if (rel === -1) break;
    const at = from + rel;
    const say = b.slice(at).search(/<say\s*>/i);
    if (say === -1) {
      b = b.slice(0, at);
      break;
    }
    b = `${b.slice(0, at)}\u0000${b.slice(at + say)}`;
    from = at + 1;
  }
  return b.replace(/\u0000+/g, ' ').replace(PARTIAL_TAG, '');
}

/** "The Games to Try list" -> "games to try": how list names are matched. */
export function listKey(name) {
  let k = String(name ?? '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  k = k.replace(/^the /, '');
  if (k !== 'list') k = k.replace(/ list$/, '');
  return k;
}

/** How a list's name is shown: "the games to try list" -> "Games to try". */
export function displayName(name) {
  let n = String(name ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  n = n.replace(/^the\s+/i, '');
  if (!/^list$/i.test(n)) n = n.replace(/\s+list$/i, '');
  // Too long: cut at a word (the same long name later finds the same list, see sameName).
  if (n.length > MAX_NAME_CHARS) n = n.slice(0, MAX_NAME_CHARS).replace(/\s+\S*$/, '').trim() || n.slice(0, MAX_NAME_CHARS).trim();
  return n ? n[0].toUpperCase() + n.slice(1) : '';
}

/** The key a name is found by, as it would be saved (cut the same way). '' for a name without letters or digits. */
export function nameKey(name) {
  return listKey(displayName(name));
}

/** An item's words as kept: one line, no tags or wrapping quotes, at most MAX_ITEM_CHARS. */
export function cleanItem(text) {
  let t = String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (t.length > MAX_ITEM_CHARS) t = t.slice(0, MAX_ITEM_CHARS).replace(/\s+\S*$/, '').trim() || t.slice(0, MAX_ITEM_CHARS);
  return t;
}

/** How items are matched: "Hades 2." and "hades 2" are the same item. */
export function itemKey(text) {
  return cleanItem(text)
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[.!?,;:]+$/, '')
    .trim();
}

/** A number as written in a tag ("2", "#2", "item 2"), or null. */
function itemNumber(ref) {
  const m = /^(?:item\s*|number\s*|no\.?\s*|#)?\s*(\d{1,3})\.?$/i.exec(String(ref ?? '').trim());
  return m ? Number(m[1]) : null;
}

const ALL = /^(?:all|every|everything|all lists|all of them|\*)$/i;
// Words that don't pick out one item.
const NOT_AN_ITEM = /^(?:all|every|everything|each|both|any|them|it|that|this|the list|all of them|all items|everything on it)$/i;

const clone = (v) => JSON.parse(JSON.stringify(v));
const isList = (l) => Boolean(l) && typeof l === 'object' && typeof l.name === 'string' && Array.isArray(l.items);
const wordsOf = (text) => itemKey(text).split(/[^\p{L}\p{N}']+/u).filter(Boolean);

/** A saved list in the shape the rest of this file expects (anything odd in the file is dropped). */
function tidy(l) {
  return {
    key: typeof l.key === 'string' ? l.key : `l${listKey(l.name).replace(/\s+/g, '-')}`,
    name: l.name,
    items: l.items.filter((i) => i && typeof i.text === 'string' && i.text.trim()).map((i) => ({ text: i.text, done: Boolean(i.done), by: i.by ?? null, at: i.at ?? null })),
    createdAt: l.createdAt ?? null,
    updatedAt: l.updatedAt ?? null,
  };
}

/** The item with these exact words (case and end punctuation aside), or -1. */
function findItemExact(list, words) {
  const k = itemKey(words);
  return k ? list.items.findIndex((i) => itemKey(i.text) === k) : -1;
}

/**
 * Finds an item by its words: the same words, or else the only item that has all of them
 * as whole words ("the chips" finds "chips and salsa", "Hades 2" doesn't find "Hades",
 * "steak" doesn't find "tea"). "all" or "it" picks out nothing.
 */
function findItem(list, words) {
  if (NOT_AN_ITEM.test(String(words ?? '').trim())) return -1;
  const exact = findItemExact(list, words);
  if (exact !== -1) return exact;
  const want = wordsOf(words).filter((w) => !/^(?:the|a|an)$/.test(w));
  if (!want.length) return -1;
  const near = list.items.map((i, n) => [new Set(wordsOf(i.text)), n]).filter(([has]) => want.every((w) => has.has(w)));
  return near.length === 1 ? near[0][1] : -1;
}

// Deleted or cleared lists are kept this long (the last few) so they can be brought back.
export const TRASH_KEEP = 5;
export const TRASH_DAYS = 7;

/**
 * The shared lists of every server, kept in memory.json (memory.lists / memory.setLists,
 * and memory.listsTrash for deleted or cleared ones that can still be brought back).
 */
export class Lists {
  constructor({ memory, clock = Date.now }) {
    this.memory = memory;
    this.clock = clock;
  }

  /** This server's lists, as saved (the order they were made in). */
  all(guildId) {
    const saved = this.memory.lists?.(guildId) ?? [];
    return saved.filter(isList).map(tidy);
  }

  /** Deleted or cleared lists that can still be brought back, newest first: [{ list, how, at }]. */
  trash(guildId) {
    const saved = this.memory.listsTrash?.(guildId) ?? [];
    const since = this.clock() - TRASH_DAYS * 86400000;
    return saved
      .filter((t) => t && isList(t.list) && (Date.parse(t.at) || 0) >= since)
      .map((t) => ({ list: tidy(t.list), how: t.how === 'cleared' ? 'cleared' : 'deleted', at: t.at }))
      .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  }

  /** One list by name ("the games list" finds "Games"), or null. */
  find(guildId, name) {
    const k = nameKey(name);
    return (k && this.all(guildId).find((l) => listKey(l.name) === k)) || null;
  }

  /**
   * Does what one answer's tags ask, in order, and saves once.
   * shown: the lists as they were when that answer was written (its item numbers mean
   * those items; one gone since is not touched). Returns { results, posts }: one result
   * per tag ({ op, ok, list, item, count, error, created, duplicate, already, restored }),
   * and what to post: lists (as they are at that point), { missing: name } for a list
   * that isn't there, or { all: lists } for every list.
   */
  apply(guildId, ops = [], { by = null, shown = null } = {}) {
    const lists = this.all(guildId);
    const before = (Array.isArray(shown) ? shown : lists).filter(isList).map(tidy);
    let trash = this.trash(guildId);
    const results = [];
    const posts = [];
    let changed = false;
    let trashChanged = false;
    const now = new Date(this.clock()).toISOString();
    // A list by its name. For taking off, ticking off and posting, also the only list whose
    // name has all the words given ("the games list" for "Games to try"); never for adding,
    // clearing or deleting (adding to a new name starts that list).
    const findList = (name, { loose = false } = {}) => {
      const k = nameKey(name);
      if (!k) return null;
      const exact = lists.find((l) => listKey(l.name) === k);
      if (exact || !loose) return exact || null;
      const words = k.split(' ');
      const near = lists.filter((l) => {
        const has = new Set(listKey(l.name).split(' '));
        return words.every((w) => has.has(w));
      });
      return near.length === 1 ? near[0] : null;
    };
    // An item by its number as it was shown (that exact item), or by its words.
    // meant: the words of the item a number pointed at, to say which one isn't there.
    const findIn = (list, ref) => {
      const n = itemNumber(ref);
      if (n === null) return { i: findItem(list, ref) };
      const was = before.find((l) => l.key === list.key);
      if (was) {
        const meant = was.items[n - 1]?.text ?? null;
        return { i: meant === null ? -1 : findItemExact(list, meant), meant };
      }
      return { i: n >= 1 && n <= list.items.length ? n - 1 : -1 }; // made by this answer: its own numbers
    };
    const toTrash = (list, how) => {
      trash = [{ list: clone(list), how, at: now }, ...trash].slice(0, TRASH_KEEP);
      trashChanged = true;
    };
    for (const o of ops) {
      const op = String(o?.op ?? '').toLowerCase();
      const raw = String(o?.list ?? '').trim();
      const name = displayName(raw);
      const r = { op, ok: false, list: name || raw };
      results.push(r);
      if (op === 'post') {
        if (!raw || ALL.test(raw)) {
          posts.push({ all: clone(lists) });
          r.ok = true;
          r.list = 'all';
          continue;
        }
        const list = findList(raw, { loose: true });
        if (list) {
          posts.push(clone(list));
          r.ok = true;
          r.list = list.name;
        } else {
          posts.push({ missing: name || raw });
          r.error = 'no such list';
        }
        continue;
      }
      if (!nameKey(raw)) {
        r.error = raw ? 'a list name needs letters or numbers' : 'no list name';
        continue;
      }
      if (op === 'restore') {
        const k = nameKey(raw);
        const t = trash.find((x) => listKey(x.list.name) === k);
        if (!t) {
          r.error = 'nothing like that was deleted or cleared lately';
          continue;
        }
        const list = findList(raw);
        if (list) {
          // Cleared (or made again since): its items come back on.
          for (const item of t.list.items) if (findItemExact(list, item.text) === -1 && list.items.length < MAX_ITEMS) list.items.push(clone(item));
          list.updatedAt = now;
          r.list = list.name;
          r.count = list.items.length;
        } else {
          if (lists.length >= MAX_LISTS) {
            r.error = `there are already ${MAX_LISTS} lists`;
            continue;
          }
          lists.push({ ...clone(t.list), updatedAt: now });
          r.list = t.list.name;
          r.count = t.list.items.length;
        }
        trash = trash.filter((x) => x !== t);
        trashChanged = true;
        changed = true;
        r.ok = true;
        r.restored = t.how;
        continue;
      }
      let list = findList(raw, { loose: op === 'remove' || op === 'done' });
      if (op === 'add') {
        const text = cleanItem(o.item);
        if (!text) {
          r.error = 'nothing to add';
          continue;
        }
        r.item = text;
        if (!list) {
          if (lists.length >= MAX_LISTS) {
            r.error = `there are already ${MAX_LISTS} lists`;
            continue;
          }
          list = { key: `l${this.clock().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, name, items: [], createdAt: now, updatedAt: now };
          lists.push(list);
          r.created = true;
        }
        r.list = list.name;
        const same = findItemExact(list, text);
        if (same !== -1) {
          // Already on it (a ticked-off one is back on).
          if (list.items[same].done) {
            list.items[same].done = false;
            list.updatedAt = now;
            changed = true;
          }
          r.ok = true;
          r.duplicate = true;
          r.count = list.items.length;
          continue;
        }
        if (list.items.length >= MAX_ITEMS) {
          // Full: the oldest ticked-off item makes room, if there is one.
          const doneAt = list.items.findIndex((i) => i.done);
          if (doneAt === -1) {
            r.error = `the list is full (${MAX_ITEMS} items)`;
            continue;
          }
          list.items.splice(doneAt, 1);
        }
        list.items.push({ text, done: false, by: by ?? null, at: now });
        list.updatedAt = now;
        changed = true;
        r.ok = true;
        r.count = list.items.length;
        continue;
      }
      if (!list) {
        r.error = 'no such list';
        if (op === 'remove' || op === 'done') r.item = cleanItem(o.item);
        continue;
      }
      r.list = list.name;
      if (op === 'remove' || op === 'done') {
        const { i, meant } = findIn(list, o.item);
        if (i === -1) {
          r.error = 'no such item';
          r.item = meant ?? cleanItem(o.item);
          continue;
        }
        r.item = list.items[i].text;
        if (op === 'remove') list.items.splice(i, 1);
        else if (list.items[i].done) r.already = true;
        else list.items[i].done = true;
        if (!r.already) {
          list.updatedAt = now;
          changed = true;
        }
        r.ok = true;
        r.count = list.items.length;
      } else if (op === 'clear') {
        r.count = list.items.length;
        if (list.items.length) toTrash(list, 'cleared');
        list.items = [];
        list.updatedAt = now;
        changed = true;
        r.ok = true;
      } else if (op === 'delete') {
        r.count = list.items.length;
        toTrash(list, 'deleted');
        lists.splice(lists.indexOf(list), 1);
        changed = true;
        r.ok = true;
      } else {
        r.error = 'unknown list tag';
      }
    }
    if (changed || trashChanged) this.memory.setLists(guildId, lists, trashChanged ? trash : undefined);
    return { results, posts };
  }
}

/**
 * The lists for its prompt, the most recently changed first, one item a line in quotes,
 * numbered as it should refer to them:
 *   - Games to try (3):
 *     1. "Hades 2"
 *     2. "Deadlock" (done)
 * At most maxChars, everything included; lists that don't fit are named at the end.
 * trash: deleted or cleared lists that can be brought back (named on one line).
 */
export function formatListsForPrompt(lists = [], { maxChars = PROMPT_CHARS, trash = [] } = {}) {
  const valid = lists.filter(isList).map(tidy);
  const back = trash.length ? `(Deleted or cleared lately, can be brought back with <list_restore>: ${trash.map((t) => `${t.list.name} (${t.how}, ${t.list.items.length} ${t.list.items.length === 1 ? 'item' : 'items'})`).join(', ')})` : '';
  if (!valid.length) return back ? `(no lists yet)\n${back}` : '(no lists yet)';
  const newest = [...valid].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  const lines = [];
  const left = [];
  // Room kept for the closing lines (lists not shown, and lists that can be brought back).
  const reserve = 140 + Math.min(back.length, 300);
  let used = 0;
  const fits = (text) => used + text.length + 1 <= maxChars - reserve;
  for (const l of newest) {
    const head = `- ${l.name} (${l.items.length})${l.items.length ? ':' : ': empty'}`;
    const items = l.items.map((i, n) => `  ${n + 1}. "${i.text.replace(/"/g, "'")}"${i.done ? ' (done)' : ''}`);
    const whole = [head, ...items].join('\n');
    if (fits(whole)) {
      lines.push(whole);
      used += whole.length + 1;
      continue;
    }
    // Too long to show whole: as many of its items as fit.
    let part = head;
    let n = 0;
    for (const it of items) {
      const more = `${part}\n${it}`;
      if (!fits(`${more}\n  ...and 99 more not shown here`)) break;
      part = more;
      n++;
    }
    if (n) {
      part += `\n  ...and ${l.items.length - n} more not shown here`;
      lines.push(part);
      used += part.length + 1;
      continue;
    }
    left.push(l.name);
  }
  if (left.length) {
    const names = left.slice(0, 8).join(', ');
    lines.push(`(${left.length} more ${left.length === 1 ? 'list' : 'lists'} not shown: ${names}${left.length > 8 ? ', ...' : ''})`.slice(0, 140));
  }
  if (back) lines.push(back.length > 300 ? `${back.slice(0, 296)}...)` : back);
  return lines.join('\n');
}

/** The bot can post messages in that channel (true when it can't tell). */
export function canPostText(channel, me) {
  if (!channel) return false;
  try {
    const perms = channel.permissionsFor?.(me);
    if (!perms) return true;
    return perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  } catch {
    return true;
  }
}

/** Text that shows as typed in Discord (no bold, strike-through, links or mentions). */
export function escapeMarkdown(text) {
  return String(text ?? '').replace(/[\\*_~`|>[\]<]/g, '\\$&');
}

/** One list as lines of a Discord message: a bold title with the count, then numbered items (done ones struck through). */
function listLines(list) {
  const title = `**${escapeMarkdown(list.name)}**`;
  if (!list.items.length) return [`${title} (empty)`];
  return [`${title} (${list.items.length})`, ...list.items.map((i, n) => `${n + 1}. ${i.done ? `~~${escapeMarkdown(i.text)}~~` : escapeMarkdown(i.text)}`)];
}

/** Every list in short: its name, count and first few items, for "post all the lists" when the whole thing would be long. */
function overviewLines(lists) {
  const out = [`**Lists** (${lists.length})`];
  for (const l of lists) {
    const first = l.items.slice(0, 3).map((i) => escapeMarkdown(i.text));
    const more = l.items.length > 3 ? `, and ${l.items.length - 3} more` : '';
    out.push(`- **${escapeMarkdown(l.name)}** (${l.items.length})${first.length ? `: ${first.join(', ')}${more}` : ''}`);
  }
  out.push('-# Ask for one list to see all of it.');
  return out;
}

/**
 * Lists as Discord messages, each under maxChars: short lists share a message, a long
 * one goes on in the next message ("(continued)"). posts: lists, { missing: name } for
 * one that isn't there, or { all: lists } for every list (in short when the whole of
 * them would take more than maxAllMessages messages).
 */
export function formatListPosts(posts = [], { maxChars = POST_CHARS, maxAllMessages = 2 } = {}) {
  const blocks = [];
  for (const p of posts) {
    if (p?.all) {
      const all = p.all.filter(isList).map(tidy);
      if (!all.length) {
        blocks.push({ lines: ["There aren't any lists yet."] });
        continue;
      }
      const whole = formatListPosts(all, { maxChars });
      if (whole.length <= maxAllMessages) for (const l of all) blocks.push({ lines: listLines(l), name: l.name });
      else blocks.push({ lines: overviewLines(all) });
      continue;
    }
    if (p?.missing !== undefined) {
      blocks.push({ lines: [`There's no list called "${escapeMarkdown(displayName(p.missing) || p.missing)}".`] });
      continue;
    }
    if (isList(p)) {
      const l = tidy(p);
      blocks.push({ lines: listLines(l), name: l.name });
    }
  }
  const messages = [];
  let current = '';
  const flush = () => {
    if (current) messages.push(current);
    current = '';
  };
  for (const block of blocks) {
    const whole = block.lines.join('\n');
    // A whole list fits with what's there already (a blank line between lists).
    if ((current ? current.length + 2 : 0) + whole.length <= maxChars) {
      current = current ? `${current}\n\n${whole}` : whole;
      continue;
    }
    flush();
    if (whole.length <= maxChars) {
      current = whole;
      continue;
    }
    // A long list: line by line, going on in the next message.
    const name = block.name ? escapeMarkdown(block.name) : '';
    for (const line of block.lines) {
      const piece = line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line;
      if (current && current.length + 1 + piece.length > maxChars) {
        flush();
        current = name ? `**${name}** (continued)` : '';
      }
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  flush();
  return messages;
}

/**
 * The lists this run kept while memory.json couldn't be read, added to the ones in the
 * file once it can be: a list it didn't have gets added, and items new to a list go on
 * the end (a ticked-off item stays ticked off). Nothing in the file is lost.
 */
export function mergeLists(saved = [], mine = []) {
  const out = (Array.isArray(saved) ? saved : []).filter(isList).map(tidy);
  for (const l of (Array.isArray(mine) ? mine : []).filter(isList).map(tidy)) {
    const there = out.find((x) => listKey(x.name) === listKey(l.name));
    if (!there) {
      out.push(clone(l));
      continue;
    }
    for (const item of l.items) {
      const same = there.items.find((x) => itemKey(x.text) === itemKey(item.text));
      if (same) {
        if (item.done) same.done = true;
      } else there.items.push(clone(item));
    }
    if ((Date.parse(l.updatedAt) || 0) > (Date.parse(there.updatedAt) || 0)) there.updatedAt = l.updatedAt;
  }
  return out;
}

/**
 * One result for the log: what changed, with the words only when transcripts are logged
 * ("added "Hades 2" to "Games to try" (3 items)" or "added an item to a list (3 items)").
 */
export function describeResult(r, { words = false } = {}) {
  const list = words ? `"${r.list}"` : 'a list';
  const item = words && r.item ? `"${r.item}"` : 'an item';
  const count = Number.isFinite(r.count) ? ` (${r.count} ${r.count === 1 ? 'item' : 'items'})` : '';
  if (!r.ok) return `couldn't ${r.op} on ${list}${words && r.item ? ` (${r.item})` : ''}: ${r.error}`;
  switch (r.op) {
    case 'add':
      return r.duplicate ? `${item} was already on ${list}` : `added ${item} to ${list}${r.created ? ' (a new list)' : ''}${count}`;
    case 'remove':
      return `took ${item} off ${list}${count}`;
    case 'done':
      return r.already ? `${item} on ${list} was already ticked off` : `ticked off ${item} on ${list}`;
    case 'clear':
      return `cleared ${list} (${r.count} ${r.count === 1 ? 'item' : 'items'} taken off)`;
    case 'delete':
      return `deleted ${list}${count}`;
    case 'restore':
      return `brought back ${list}${count}`;
    case 'post':
      return r.list === 'all' ? 'posted all the lists in the text chat' : `posted ${list} in the text chat`;
    default:
      return `${r.op} on ${list}`;
  }
}

/**
 * What to tell people in the text chat about the tags that didn't work ("(I couldn't
 * add that: the Games list is full (50 items).)"), one note for all of them.
 * Not the posts of a list that isn't there: those say so themselves.
 */
export function problemNote(results = []) {
  const failed = results.filter((r) => !r.ok && r.op !== 'post');
  if (!failed.length) return '';
  const what = failed.map((r) => {
    const item = r.item ? ` "${escapeMarkdown(r.item)}"` : '';
    const list = r.list ? ` (${escapeMarkdown(r.list)})` : '';
    const verb = { add: 'add', remove: 'take off', done: 'tick off', clear: 'clear', delete: 'delete', restore: 'bring back' }[r.op] || r.op;
    return `${verb}${item}${list}: ${r.error}`;
  });
  return `-# (I couldn't ${what.join('; ')}.)`;
}

/**
 * What changed, for the text chat when its reply had no words of its own ("-# (Added
 * "Hades 2" to Games to try.)"), so a change is never made without anyone seeing it.
 */
export function changeNote(results = []) {
  const done = results.filter((r) => r.ok && r.op !== 'post');
  if (!done.length) return '';
  const item = (r) => (r.item ? `"${escapeMarkdown(r.item)}"` : 'it');
  const list = (r) => escapeMarkdown(r.list);
  const what = done.map((r) => {
    switch (r.op) {
      case 'add':
        return r.duplicate ? `${item(r)} was already on ${list(r)}` : `added ${item(r)} to ${list(r)}`;
      case 'remove':
        return `took ${item(r)} off ${list(r)}`;
      case 'done':
        return `ticked off ${item(r)} on ${list(r)}`;
      case 'clear':
        return `cleared ${list(r)}`;
      case 'delete':
        return `deleted ${list(r)}`;
      case 'restore':
        return `brought back ${list(r)}`;
      default:
        return `${r.op} ${list(r)}`;
    }
  });
  const text = what.join('; ');
  return `-# (${text[0].toUpperCase()}${text.slice(1)}.)`;
}
