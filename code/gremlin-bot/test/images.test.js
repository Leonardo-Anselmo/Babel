// Pictures on request: the <image> tag after its line, drawing it with Google Gemini,
// posting it in the text chat (or as a reply to an @mention), what it costs, and the
// settings and start-up check that go with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { AudioPlayerStatus } from '@discordjs/voice';
import { Brain } from '../src/brain.js';
import { FIELDS, SECRET_KEYS, settingsView } from '../desktop/lib/settings.mjs';
import { textReply } from '../src/commands.js';
import {
  DOLLARS_PER_PICTURE,
  ImageError,
  Images,
  MAX_AT_ONCE,
  canPostPictures,
  cutOffInImage,
  drawAndPost,
  findImage,
  imageError,
  imageTags,
  imagesNowFor,
  normalizeAspect,
  pictureDollars,
  sniffImage,
  whyNoImage,
  withoutImageTags,
} from '../src/images.js';
import { buildSystem, buildUserMessage, cleanText, sayContent } from '../src/prompts.js';
import { VoiceSession } from '../src/session.js';
import { Speaker } from '../src/speaker.js';
import { costOf, describeBucket, emptyBucket, oneLine, totalDollars } from '../src/usage.js';

// A tiny real JPEG's first bytes are enough for the checks here.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// ---------------------------------------------------------------------------
// The tag
// ---------------------------------------------------------------------------

test('the picture tag is read, never said out loud, and never posted in a text reply', () => {
  const reply = '<say>On it, one goblin coming up.</say><image aspect="16:9">A cartoon goblin raging at a monitor, comic style.</image>';
  assert.deepEqual(imageTags(reply), [{ prompt: 'A cartoon goblin raging at a monitor, comic style.', aspect: '16:9', edit: false }]);
  assert.equal(sayContent(reply), 'On it, one goblin coming up.');
  // Written inside the words by mistake: still not said.
  assert.equal(sayContent('<say>Sure. <image>a cat</image> Hang on.</say>').replace(/\s+/g, ' ').trim(), 'Sure. Hang on.');
  // Still being written: nothing after the tag's start is said.
  assert.equal(sayContent('<say>On it. <image aspect="1:1">a ca'), 'On it. ');
  assert.equal(withoutImageTags('before <image>words</image> after'), 'before   after');
  assert.equal(cutOffInImage('<say>Sure.</say><image aspect="1:1">a goblin wearing'), true);
  assert.equal(cutOffInImage('<say>Sure.</say><image>a goblin</image>'), false);
  // A text-chat reply (no <say> tags) never shows the tag either.
  assert.equal(cleanText('Coming right up! <image aspect="1:1">a goblin</image>').text, 'Coming right up!');
  // edit="last" changes its last picture; odd attributes are tolerated.
  assert.deepEqual(imageTags("<image edit='last'>make it blue</image>"), [{ prompt: 'make it blue', aspect: null, edit: true }]);
  assert.deepEqual(imageTags('<image aspect=wide>  a  wide\n shot </image><image></image>'), [{ prompt: 'a wide shot', aspect: '16:9', edit: false }]);
});

test('picture shapes: ratios, words for them, and odd ones left to the default', () => {
  assert.equal(normalizeAspect('16:9'), '16:9');
  assert.equal(normalizeAspect('9x16'), '9:16');
  assert.equal(normalizeAspect('tall'), '9:16');
  assert.equal(normalizeAspect('square'), '1:1');
  assert.equal(normalizeAspect('7:3'), null);
  assert.equal(normalizeAspect(''), null);
});

// ---------------------------------------------------------------------------
// Errors, answers and costs
// ---------------------------------------------------------------------------

test('Gemini errors become plain reasons; setup problems stop new tries, refusals and hiccups do not', () => {
  const badKey = imageError(400, JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }));
  assert.match(badKey.userText, /rejected the Gemini key/);
  assert.equal(badKey.blocks, true);
  assert.equal(imageError(401, '{"error":{"code":"authentication","message":"bad key"}}').blocks, true);
  const noBilling = imageError(429, JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-nano-banana-2.1' } }));
  assert.match(noBilling.userText, /needs billing turned on/);
  assert.equal(noBilling.blocks, true);
  assert.match(imageError(400, '{"error":{"code":"failed_precondition","message":"Billing is disabled for this project."}}').userText, /billing/);
  const restricted = imageError(403, JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Requests to this API method are blocked.', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } }));
  assert.match(restricted.userText, /won't let this key make pictures/);
  assert.equal(restricted.refused, false, 'a blocked key is not a refused picture');
  const busy = imageError(429, '{"error":{"code":"rate_limit_exceeded","message":"Too many requests"}}');
  assert.match(busy.userText, /busy/);
  assert.equal(busy.blocks, false);
  // Google's usual quota message mentions billing even on paid keys: that's a passing limit, not "no billing".
  const quota = imageError(429, JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.' } }));
  assert.match(quota.userText, /busy/);
  assert.equal(quota.blocks, false);
  const refused = imageError(400, '{"error":{"code":"image_safety","message":"The image was blocked."}}');
  assert.equal(refused.refused, true);
  assert.equal(refused.blocks, false);
  assert.match(refused.userText, /wouldn't draw that one/);
  assert.equal(imageError(404, '{"error":{"code":"not_found","message":"Model not found"}}').blocks, true);
  assert.equal(imageError(402, '{"error":{"code":"payment_required","message":"Prepay credits depleted"}}').blocks, false);
  assert.equal(imageError(400, '{"error":{"code":"invalid_request","message":"Unknown field: store"}}').retryWithoutStore, true);
  assert.match(imageError(503, 'oops').userText, /had a problem/);
});

test('the picture is found in every answer shape Google uses; thought images are skipped', () => {
  const b64 = JPEG.toString('base64');
  const interaction = {
    status: 'completed',
    steps: [
      { type: 'user_input', content: [{ type: 'text', text: 'a goblin' }] },
      { type: 'thought', summary: [{ type: 'text', text: 'planning' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Here you go' }, { type: 'image', data: b64, mime_type: 'image/jpeg' }] },
    ],
  };
  assert.deepEqual(findImage(interaction), { data: b64, mimeType: 'image/jpeg' });
  assert.equal(findImage({ outputs: [{ type: 'image', data: b64, mime_type: 'image/png' }] }).mimeType, 'image/png');
  const gc = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' }, thought: true }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }] } }] };
  assert.equal(findImage(gc).data, b64);
  assert.equal(findImage({ candidates: [{ content: { parts: [{ inlineData: { data: 'AAAA' }, thought: true }] } }] }), null);
  assert.equal(findImage({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'no' }] }] }), null);
  // Why there's none: a refusal is told apart from an empty answer.
  assert.equal(whyNoImage({ status: 'failed', errors: [{ code: 'image_safety', message: 'blocked' }] }).refused, true);
  assert.equal(whyNoImage({ steps: [{ type: 'model_output', content: [{ type: 'text', text: "I can't create images of real people." }] }] }).refused, true);
  assert.equal(whyNoImage({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] }).refused, true);
  assert.equal(whyNoImage({ status: 'incomplete' }).refused, false);
  assert.deepEqual(sniffImage(JPEG), { ext: 'jpg', mimeType: 'image/jpeg' });
  assert.deepEqual(sniffImage(PNG), { ext: 'png', mimeType: 'image/png' });
  assert.equal(sniffImage(Buffer.from('not a picture')), null);
});

test('what a picture costs: from the token counts Google sends, or the list price', () => {
  // 1,120 image tokens at $30/M, 300 thinking tokens at $7.50/M, 20 input tokens at $1.50/M.
  const res = { usage: { total_input_tokens: 20, total_output_tokens: 1120, total_thought_tokens: 300, total_tokens: 1440, output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }] } };
  assert.ok(Math.abs(pictureDollars(res) - (20 * 1.5 + 1120 * 30 + 300 * 7.5) / 1e6) < 1e-12);
  // The total shows thinking is already inside the output count: not counted twice.
  const inside = { usage: { total_input_tokens: 20, total_output_tokens: 1420, total_thought_tokens: 300, total_tokens: 1440, output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }] } };
  assert.ok(Math.abs(pictureDollars(inside) - (20 * 1.5 + 1120 * 30 + 300 * 7.5) / 1e6) < 1e-12);
  const gc = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1120, thoughtsTokenCount: 100, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }] } };
  assert.ok(Math.abs(pictureDollars(gc) - (10 * 1.5 + 1120 * 30 + 100 * 7.5) / 1e6) < 1e-12);
  assert.equal(pictureDollars({}), DOLLARS_PER_PICTURE);
  // In the totals and /usage.
  const d = costOf({ type: 'image', count: 1, dollars: 0.0336 });
  assert.equal(d.imageCount, 1);
  const b = { ...emptyBucket(), ...d, claudeDollars: 0.5 };
  assert.ok(Math.abs(totalDollars(b) - 0.5336) < 1e-9);
  assert.ok(describeBucket(b).includes('Pictures: 1 drawn ($0.03)'));
  assert.match(oneLine(b), /1 picture,/);
  assert.ok(!describeBucket(emptyBucket()).some((l) => l.startsWith('Pictures')), 'no pictures line before the first picture');
  // A refused one may cost a little but isn't a picture.
  assert.equal(costOf({ type: 'image', count: 0, dollars: 0.002 }).imageCount, 0);
});

// ---------------------------------------------------------------------------
// Drawing it
// ---------------------------------------------------------------------------

function fakeGemini(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    const r = queue.shift();
    if (typeof r === 'function') return r(opts);
    if (r.throws) throw r.throws;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(r.body) };
  };
  return { fetchImpl, calls };
}

const picture = (data = JPEG, extra = {}) => ({
  body: {
    id: 'i1',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'image', data: data.toString('base64'), mime_type: 'image/jpeg' }] }],
    usage: { total_input_tokens: 30, total_output_tokens: 1120, total_thought_tokens: 200, total_tokens: 1350, output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }] },
    ...extra,
  },
});

function fakeUsage(usedPictures = 0) {
  const events = [];
  return { events, record: (e) => events.push(e), thisMonth: () => ({ imageCount: usedPictures }) };
}

const imageConfig = (images = {}) => ({ images: { enabled: true, key: 'g-key', perMonth: 100, model: 'gemini-nano-banana-2.1', ...images } });

test('a picture is drawn with one request to Gemini, counted, and kept so it can be changed', async () => {
  const g = fakeGemini([picture()]);
  const usage = fakeUsage();
  const images = new Images(imageConfig(), { fetchImpl: g.fetchImpl, usage });
  const made = await images.make({ prompt: 'a goblin raging at League', aspect: '16:9' }, { lastKey: 'g1', forName: 'Mike' });
  assert.equal(g.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(g.calls[0].headers['x-goog-api-key'], 'g-key');
  assert.deepEqual(g.calls[0].body, {
    model: 'gemini-nano-banana-2.1',
    input: [{ type: 'text', text: 'a goblin raging at League' }],
    response_format: { type: 'image', image_size: '1K', mime_type: 'image/jpeg', aspect_ratio: '16:9' },
    store: false,
  });
  assert.ok(made.data.equals(JPEG));
  assert.equal(made.ext, 'jpg');
  assert.equal(made.edited, false);
  assert.equal(usage.events.length, 1);
  assert.equal(usage.events[0].type, 'image');
  assert.equal(usage.events[0].count, 1);
  assert.ok(usage.events[0].dollars > 0.033 && usage.events[0].dollars < 0.04);
  // "Make it blue": its last picture goes along, and the shape stays the last one's.
  const g2 = fakeGemini([picture(PNG)]);
  images.fetchImpl = g2.fetchImpl;
  const changed = await images.make({ prompt: 'make it blue', edit: true }, { lastKey: 'g1' });
  const body = g2.calls[0].body;
  assert.equal(body.input[0].type, 'image');
  assert.equal(body.input[0].mime_type, 'image/jpeg');
  assert.equal(Buffer.from(body.input[0].data, 'base64').equals(JPEG), true);
  assert.deepEqual(body.input[1], { type: 'text', text: 'Change this picture: make it blue' });
  assert.equal(body.response_format.aspect_ratio, undefined);
  assert.equal(changed.edited, true);
  assert.equal(changed.ext, 'png');
  // Somewhere with no last picture: a change can't be drawn (it would be a random picture), and nothing is paid for.
  const g3 = fakeGemini([picture()]);
  images.fetchImpl = g3.fetchImpl;
  await assert.rejects(images.make({ prompt: 'make it blue', edit: true }, { lastKey: 'g2' }), (err) => /no recent picture of mine here to change/.test(err.userText));
  assert.equal(g3.calls.length, 0);
  assert.equal(images.inFlight, 0);
  // A picture that comes back unreadable was still paid for: counted.
  const g4 = fakeGemini([picture(Buffer.from('not a picture at all'))]);
  images.fetchImpl = g4.fetchImpl;
  const counted = usage.events.length;
  await assert.rejects(images.make({ prompt: 'a cat' }, { lastKey: 'g1' }), /couldn't read/);
  assert.equal(usage.events.length, counted + 1);
  assert.equal(usage.events.at(-1).count, 1);
});

test('a call and each text channel keep their own last picture; lastKey says which', async () => {
  const { lastKey } = await import('../src/images.js');
  assert.equal(lastKey('g1'), 'g1:voice');
  assert.equal(lastKey('g1', 'c9'), 'g1:text:c9');
  const images = new Images(imageConfig(), { fetchImpl: fakeGemini([picture()]).fetchImpl, usage: fakeUsage() });
  await images.make({ prompt: 'a goblin from the call' }, { lastKey: lastKey('g1'), forName: 'Mike' });
  assert.match(imagesNowFor({ images, lastKey: lastKey('g1') }), /a goblin from the call/);
  assert.doesNotMatch(imagesNowFor({ images, lastKey: lastKey('g1', 'c9') }), /a goblin from the call/, "a text channel doesn't see the call's picture");
});

test('the last picture can be changed for half an hour, then it is forgotten', async () => {
  let now = 1_000_000;
  const images = new Images(imageConfig(), { fetchImpl: fakeGemini([picture()]).fetchImpl, usage: fakeUsage(), clock: () => now });
  await images.make({ prompt: 'a cat' }, { lastKey: 'g1', forName: 'Jess' });
  assert.equal(images.lastFor('g1').forName, 'Jess');
  now += 29 * 60000;
  assert.ok(images.lastFor('g1'));
  now += 2 * 60000;
  assert.equal(images.lastFor('g1'), null);
});

test('when Google will not take the store setting, it is dropped and sent again; a hiccup is tried once more', async () => {
  const g = fakeGemini([{ status: 400, body: { error: { code: 'invalid_request', message: 'Unknown name "store": Cannot find field.' } } }, picture()]);
  const images = new Images(imageConfig(), { fetchImpl: g.fetchImpl, usage: fakeUsage() });
  await images.make({ prompt: 'a cat' });
  assert.equal(g.calls.length, 2);
  assert.equal(g.calls[1].body.store, undefined);
  assert.equal(images.sendStore, false, 'not sent again after that');
  const flaky = fakeGemini([{ status: 503, body: { error: { code: 503, message: 'overloaded' } } }, picture()]);
  await new Images(imageConfig(), { fetchImpl: flaky.fetchImpl, usage: fakeUsage() }).make({ prompt: 'a cat' });
  assert.equal(flaky.calls.length, 2);
  const dropped = fakeGemini([{ throws: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) }, picture()]);
  await new Images(imageConfig(), { fetchImpl: dropped.fetchImpl, usage: fakeUsage() }).make({ prompt: 'a cat' });
  assert.equal(dropped.calls.length, 2);
});

test('a refused picture says so plainly; a setup problem stops new tries for a while; the cap holds', async () => {
  const usage = fakeUsage();
  const refusing = fakeGemini([
    {
      body: {
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: "I can't create that image." }] }],
        usage: { total_input_tokens: 30, total_output_tokens: 12, total_thought_tokens: 100, total_tokens: 142, output_tokens_by_modality: [{ modality: 'text', tokens: 12 }] },
      },
    },
  ]);
  const images = new Images(imageConfig(), { fetchImpl: refusing.fetchImpl, usage });
  await assert.rejects(images.make({ prompt: 'something' }), (err) => {
    assert.ok(err instanceof ImageError);
    assert.equal(err.refused, true);
    assert.match(err.userText, /wouldn't draw that one/);
    return true;
  });
  assert.equal(usage.events[0].count, 0, 'tokens cost a little, but no picture is counted');
  assert.equal(images.status().ok, true, 'a refusal changes nothing');
  // A key Google rejects: no more tries for half an hour.
  let now = 5_000_000;
  const bad = new Images(imageConfig(), {
    fetchImpl: fakeGemini([{ status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } } }]).fetchImpl,
    usage: fakeUsage(),
    clock: () => now,
  });
  await assert.rejects(bad.make({ prompt: 'a cat' }), /API key not valid/);
  assert.equal(bad.status().ok, false);
  assert.match(bad.status().reason, /rejected the Gemini key/);
  now += 31 * 60000;
  assert.equal(bad.status().ok, true, 'tried again later (or after a restart)');
  // The month's cap.
  const full = new Images(imageConfig({ perMonth: 100 }), { fetchImpl: fakeGemini([]).fetchImpl, usage: fakeUsage(100) });
  assert.equal(full.status().ok, false);
  await assert.rejects(full.make({ prompt: 'a cat' }), /used up/);
  assert.equal(new Images(imageConfig({ key: '' })).enabled, false, 'no key, no pictures');
  assert.match(new Images(imageConfig({ key: '' })).status().reason, /no Gemini API key/);
  assert.equal(new Images(imageConfig({ enabled: false })).status().ok, false);
});

test('pictures being drawn count against the month, at most three at once; a slow one gives up', async () => {
  const releases = [];
  const slow = async () => {
    await new Promise((r) => releases.push(r));
    return { ok: true, status: 200, headers: { get: () => '' }, text: async () => JSON.stringify(picture().body) };
  };
  const images = new Images(imageConfig({ perMonth: 4 }), { fetchImpl: slow, usage: fakeUsage(0) });
  const drawing = [1, 2, 3].map(() => images.make({ prompt: 'a cat' }));
  await settle();
  assert.equal(images.inFlight, MAX_AT_ONCE);
  assert.equal(images.left(), 1);
  assert.equal(images.status().busy, true);
  await assert.rejects(images.make({ prompt: 'one more' }), /already drawing/);
  for (const r of releases) r();
  await Promise.all(drawing);
  assert.equal(images.inFlight, 0);
  // Google never answers: it gives up with a plain reason.
  const hang = (_url, opts) =>
    new Promise((_, reject) => {
      const alive = setInterval(() => {}, 1000);
      opts.signal.addEventListener('abort', () => (clearInterval(alive), reject(opts.signal.reason)), { once: true });
    });
  const stuck = new Images(imageConfig(), { fetchImpl: hang, usage: fakeUsage(), timeoutMs: 50 });
  await assert.rejects(stuck.make({ prompt: 'a cat' }), (err) => /took too long/.test(err.userText));
  assert.equal(stuck.inFlight, 0);
  assert.equal(stuck.status().ok, true);
});

// ---------------------------------------------------------------------------
// Posting it
// ---------------------------------------------------------------------------

function fakeChannel({ attach = true, failWith = null } = {}) {
  const sent = [];
  return {
    sent,
    permissionsFor: () => ({ has: (perms) => attach || !perms.includes?.(32768n) }),
    async send(msg) {
      if (failWith && msg.files) throw failWith;
      sent.push(msg);
      return msg;
    },
  };
}

test('what it tells the model about pictures right now', async () => {
  const images = new Images(imageConfig(), { fetchImpl: fakeGemini([picture()]).fetchImpl, usage: fakeUsage(10) });
  assert.match(imagesNowFor({ images, lastKey: 'g1' }), /^You can draw a picture if someone asks for one \(90 left this month\)\.$/);
  assert.match(imagesNowFor({ images, lastKey: 'g1', canPost: false }), /Attach Files permission/);
  await images.make({ prompt: 'a goblin in a crown' }, { lastKey: 'g1', forName: 'Mike' });
  assert.match(imagesNowFor({ images, lastKey: 'g1' }), /Your last picture \(just now, for Mike\) was: "a goblin in a crown"\. To change it, add edit="last"\./);
  images.blocked = { reason: 'Google rejected the Gemini key', until: Date.now() + 60000 };
  assert.match(imagesNowFor({ images, lastKey: 'g2' }), /^You can't draw a picture right now: Google rejected the Gemini key\./);
  assert.equal(imagesNowFor({ images: new Images(imageConfig({ key: '' })), lastKey: 'g1' }), '');
  // The permission check: Attach Files is needed (unknown counts as yes).
  assert.equal(canPostPictures(fakeChannel({ attach: false }), {}), false);
  assert.equal(canPostPictures(fakeChannel(), {}), true);
  assert.equal(canPostPictures({}, {}), true);
});

test('posting: the picture goes in the chat with who it is for; problems become a small note', async () => {
  const images = new Images(imageConfig(), { fetchImpl: fakeGemini([picture(), picture()]).fetchImpl, usage: fakeUsage() });
  const ch = fakeChannel();
  let posted = 0;
  const tag = { image: { prompt: 'a goblin', aspect: null, edit: false }, cutOff: false };
  assert.equal(await drawAndPost({ images, tag, channel: ch, lastKey: 'g1', forName: 'Mike', onPosted: () => posted++ }), 'posted');
  assert.equal(ch.sent[0].content, '-# For Mike');
  assert.equal(ch.sent[0].files[0].name, 'picture.jpg');
  assert.ok(ch.sent[0].files[0].attachment.equals(JPEG));
  assert.deepEqual(ch.sent[0].allowedMentions.parse, []);
  assert.equal(posted, 1);
  // Changing it says so.
  await drawAndPost({ images, tag: { image: { prompt: 'make it blue', edit: true } }, channel: ch, lastKey: 'g1', forName: 'Mike' });
  assert.equal(ch.sent[1].content, '-# For Mike (changed the last one)');
  // Ran out of room describing it.
  const ch2 = fakeChannel();
  assert.equal(await drawAndPost({ images, tag: { image: null, cutOff: true }, channel: ch2, lastKey: 'g1' }), 'skipped');
  assert.equal(ch2.sent[0].content, '-# (I ran out of room describing that picture. Ask me again.)');
  // No Attach Files: nothing is drawn (nothing paid for), and it says what to change.
  const noPerm = fakeChannel({ attach: false });
  const before = images.fetchImpl;
  images.fetchImpl = async () => assert.fail('should not draw');
  assert.equal(await drawAndPost({ images, tag, channel: noPerm, lastKey: 'g1' }), 'failed');
  assert.match(noPerm.sent[0].content, /needs the Attach Files permission/);
  images.fetchImpl = before;
  // Google says no.
  const refusing = new Images(imageConfig(), { fetchImpl: fakeGemini([{ status: 400, body: { error: { code: 'image_safety', message: 'blocked' } } }]).fetchImpl, usage: fakeUsage() });
  const ch3 = fakeChannel();
  assert.equal(await drawAndPost({ images: refusing, tag, channel: ch3, lastKey: 'g1' }), 'failed');
  assert.equal(ch3.sent[0].content, "-# (I couldn't draw that: Google wouldn't draw that one.)");
  // Drawn, but Discord won't take the file.
  const ch4 = fakeChannel({ failWith: Object.assign(new Error('Missing Permissions'), { code: 50013 }) });
  const fine = new Images(imageConfig(), { fetchImpl: fakeGemini([picture()]).fetchImpl, usage: fakeUsage() });
  assert.equal(await drawAndPost({ images: fine, tag, channel: ch4, lastKey: 'g1' }), 'failed');
  assert.match(ch4.sent[0].content, /drew it but can't post it here/);
  // As a reply to the message that asked (text chat).
  const replies = [];
  const message = { reply: async (m) => replies.push(m) };
  const fine2 = new Images(imageConfig(), { fetchImpl: fakeGemini([picture()]).fetchImpl, usage: fakeUsage() });
  await drawAndPost({ images: fine2, tag, channel: fakeChannel(), lastKey: 'g1', forName: 'Jess', replyTo: message });
  assert.equal(replies[0].content, '-# For Jess');
  assert.equal(replies[0].allowedMentions.repliedUser, false);
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
  images: { enabled: true },
};

function manualSpeaker() {
  const lines = [];
  return {
    lines,
    speaking: false,
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
      for (const l of lines) l.resolve?.('stopped');
    },
    stopKind() {},
    dropOptional() {},
  };
}

function setup({ reply, images = true, stopReason } = {}) {
  const calls = [];
  const asked = [];
  const speaker = manualSpeaker();
  const brain = new Brain({
    config: baseConfig,
    claude: {
      async createMessage(args) {
        calls.push(args);
        args.onText?.(reply);
        return { text: reply, refusal: false, stopReason };
      },
    },
    speaker,
    chattiness: 'medium',
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
    onImage: images ? (tag, info) => asked.push({ tag, info }) : undefined,
    getImagesNow: () => 'You can draw a picture if someone asks for one (90 left this month).',
  });
  return { brain, calls, asked, speaker };
}

test('asked for a picture: it says it is on it, and the picture is drawn once that line is heard', async () => {
  const reply = '<say>On it, one goblin coming up.</say><image aspect="16:9">A cartoon goblin raging at a monitor.</image>';
  const s = setup({ reply });
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, draw us a goblin raging at League' });
  await settle();
  assert.deepEqual(
    s.speaker.lines.map((l) => [l.kind, l.text]),
    [['direct', 'On it, one goblin coming up.']],
  );
  assert.equal(s.asked.length, 0, 'not before anyone heard it agree');
  s.speaker.start(0);
  await settle();
  assert.equal(s.asked.length, 1);
  assert.deepEqual(s.asked[0].tag, { image: { prompt: 'A cartoon goblin raging at a monitor.', aspect: '16:9', edit: false }, cutOff: false });
  assert.deepEqual(s.asked[0].info.userIds, ['u1']);
  assert.ok(!s.brain.transcript.lines.some((l) => /image|cartoon/i.test(l.text)), 'the tag is not in the transcript');
  // Its prompt explains pictures, says whether it can draw now, and leaves room for the description.
  const system = s.calls[0].system[0].text;
  assert.match(system, /<pictures>/);
  assert.match(system, /follow the image provider/);
  assert.match(String(s.calls[0].user), /<pictures_now>\nYou can draw a picture if someone asks for one/);
  assert.equal(s.calls[0].maxTokens, 200 + 150);
  // Without pictures: none of that.
  const off = setup({ reply: '<say>Sure.</say>', images: false });
  off.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, what do you think of the new map' });
  await settle();
  assert.doesNotMatch(off.calls[0].system[0].text, /<pictures>/);
  assert.doesNotMatch(String(off.calls[0].user), /pictures_now/);
  assert.equal(off.calls[0].maxTokens, 200);
});

test('a picture tag cut off by the length limit says so; one inside a reminder is not drawn', async () => {
  const cut = setup({ reply: '<say>On it.</say><image aspect="1:1">A goblin wearing a', stopReason: 'max_tokens' });
  cut.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, draw a goblin' });
  await settle();
  cut.speaker.start(0);
  await settle();
  assert.deepEqual(cut.asked[0].tag, { image: null, cutOff: true });
  const inside = setup({ reply: '<say>Sure.</say><reminder in="5 minutes" for="Mike">Time! <image>a clock</image></reminder>' });
  inside.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, remind me in five minutes' });
  await settle();
  inside.speaker.start(0);
  await settle();
  assert.equal(inside.asked.length, 0);
});

test('once it is posted, a quick "It\'s in the chat." if there is a pause for it', async () => {
  const s = setup({ reply: '<say>Sure.</say>' });
  s.brain.picturePosted();
  assert.equal(s.speaker.lines.length, 1);
  assert.equal(s.speaker.lines[0].kind, 'posted');
  assert.match(s.speaker.lines[0].text, /chat|Posted/);
  assert.ok(!s.brain.transcript.lines.length, 'not a line in the conversation');
  // The speaker treats it as a short sound: replayed from memory, dropped if nobody pauses.
  class FakePlayer extends EventEmitter {
    constructor() {
      super();
      this.state = { status: AudioPlayerStatus.Idle };
    }
    play() {
      const old = this.state;
      this.state = { status: AudioPlayerStatus.Playing };
      this.emit('stateChange', old, this.state);
    }
    stop() {
      const old = this.state;
      this.state = { status: AudioPlayerStatus.Idle };
      this.emit('stateChange', old, this.state);
      return true;
    }
  }
  const seen = [];
  const player = new FakePlayer();
  const speaker = new Speaker({ tts: { stream: async (text, o) => (seen.push(Boolean(o.cache)), { stream: Readable.from([Buffer.alloc(4800)]), sampleRate: 24000 }) }, player });
  const done = speaker.say("It's in the chat.", { kind: 'posted' });
  await new Promise((r) => setTimeout(r, 150));
  player.stop();
  assert.equal(await done, 'played');
  assert.deepEqual(seen, [true]);
  let talking = true;
  let now = 0;
  const busy = new Speaker({ tts: { stream: async () => assert.fail('not synthesized when nobody pauses') }, player: new FakePlayer(), isAnyoneSpeaking: () => talking, clock: () => now });
  const dropped = busy.say("It's in the chat.", { kind: 'posted' });
  await new Promise((r) => setTimeout(r, 50));
  now = 3000;
  assert.equal(await dropped, 'dropped');
  talking = false;
});

test('the call: pictures are offered only where it can post them, drawn, posted, and announced', async () => {
  const posted = [];
  const textChannel = { ...fakeChannel(), send: async (m) => (posted.push(m), m) };
  const images = new Images(imageConfig(), { fetchImpl: fakeGemini([picture()]).fetchImpl, usage: fakeUsage() });
  const s = new VoiceSession({
    client: { user: { id: 'bot' } },
    guild: { id: 'g', name: 'Test', channels: { cache: new Map() }, voiceStates: { cache: new Map() }, members: { cache: new Map(), me: { id: 'bot' } } },
    voiceChannel: { id: 'B' },
    textChannel,
    config: { botName: 'Gremlin', botAliases: ['gremlin'], stt: { extraTerms: [] }, autoLeaveSeconds: 60, listen: {} },
    memory: { isOptedOut: () => false },
    images,
  });
  assert.match(s.imagesNow(), /^You can draw a picture/);
  let announced = 0;
  s.brain = { picturePosted: () => announced++ };
  assert.equal(await s.drawImage({ image: { prompt: 'a goblin', aspect: null, edit: false }, cutOff: false }, { name: 'Mike' }), 'posted');
  assert.equal(posted[0].content, '-# For Mike');
  assert.equal(announced, 1);
  textChannel.permissionsFor = () => ({ has: () => false });
  assert.match(s.imagesNow(), /Attach Files/);
  s.images = null;
  assert.equal(s.imagesNow(), '');
});

test('an @mention can ask for a picture: the reply never shows the tag, and the picture is handed over', async () => {
  const calls = [];
  const reply = 'Coming right up! <image aspect="1:1">A goblin with a golden crown.</image>';
  const ctx = {
    config: { botName: 'Gremlin', persona: 'p', lore: '', timezone: 'UTC', anthropic: { webSearch: { enabled: false } } },
    claude: { createMessage: async (args) => (calls.push(args), { text: reply, refusal: false }) },
    memory: { facts: () => [] },
    sessions: new Map(),
    images: new Images(imageConfig(), { usage: fakeUsage() }),
  };
  const handed = [];
  const text = await textReply(ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'draw a goblin king', channel: fakeChannel(), onImage: (t) => handed.push(t) });
  assert.equal(text, 'Coming right up!');
  assert.deepEqual(handed, [{ image: { prompt: 'A goblin with a golden crown.', aspect: '1:1', edit: false }, cutOff: false }]);
  assert.match(calls[0].system[0].text, /<pictures>/);
  assert.match(String(calls[0].user), /<pictures_now>/);
  assert.equal(calls[0].maxTokens, 550);
  // Where it can't post one (/roast in text, or no handler): no pictures offered at all.
  const plain = await textReply(ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'hi' });
  assert.equal(plain, 'Coming right up!');
  assert.doesNotMatch(calls[1].system[0].text, /<pictures>/);
});

test('the settings for pictures, and the key never reaches the window', () => {
  assert.ok(SECRET_KEYS.includes('GEMINI_API_KEY'));
  assert.equal(FIELDS.get('GEMINI_API_KEY').type, 'secret');
  assert.equal(FIELDS.get('IMAGES').default, 'true');
  assert.equal(FIELDS.get('IMAGES_PER_MONTH').default, '100');
  const json = JSON.stringify(settingsView({ GEMINI_API_KEY: 'AIza-secret-123' }));
  assert.ok(!json.includes('AIza-secret-123'));
  const system = buildSystem({ botName: 'Gremlin', persona: 'p', images: true })[0].text;
  assert.match(system, /add edit="last"/);
  assert.match(buildUserMessage({ callInfo: 'x', transcript: 'y', task: 'z', imagesNow: 'Out of pictures.' }), /<pictures_now>\nOut of pictures\.\n<\/pictures_now>/);
});

test('a passed text reply draws nothing; a picture tag never ends up in a reminder or a song', async () => {
  const ctx = {
    config: { botName: 'Gremlin', persona: 'p', lore: '', timezone: 'UTC', anthropic: { webSearch: { enabled: false } } },
    claude: { createMessage: async () => ({ text: '[PASS] <image>a goblin</image>', refusal: false }) },
    memory: { facts: () => [] },
    sessions: new Map(),
    images: new Images(imageConfig(), { usage: fakeUsage() }),
  };
  const handed = [];
  const text = await textReply(ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'lol', channel: fakeChannel(), onImage: (t) => handed.push(t) });
  assert.equal(text, '');
  assert.deepEqual(handed, []);
  // Only the tag, no words: still drawn.
  ctx.claude.createMessage = async () => ({ text: '<image>a goblin</image>', refusal: false });
  await textReply(ctx, { guildId: 'g', authorId: 'u1', author: 'Jess', content: 'draw a goblin', channel: fakeChannel(), onImage: (t) => handed.push(t) });
  assert.equal(handed.length, 1);
  // A reminder's words: the tag is left out, not said later.
  const s = new VoiceSession({
    client: { user: { id: 'bot' } },
    guild: { id: 'g', name: 'Test', channels: { cache: new Map() }, voiceStates: { cache: new Map() }, members: { cache: new Map() } },
    voiceChannel: { id: 'B' },
    textChannel: fakeChannel(),
    config: { botName: 'Gremlin', botAliases: ['gremlin'], stt: { extraTerms: [] }, autoLeaveSeconds: 60, listen: {}, tts: { audioTags: false }, timezone: 'UTC' },
    memory: { isOptedOut: () => false },
  });
  const added = [];
  s.reminders = { add: (_g, r) => (added.push(r), { reminder: { id: 1, at: new Date(Date.now() + 60000).toISOString() } }), cancel: () => [] };
  s.applyReminders({ set: [{ in: '5m', for: 'me', say: 'Time to check the oven! <image aspect="1:1">a cartoon alarm clock</image>' }] }, { name: 'Mike', userIds: ['u1'] });
  assert.equal(added[0].say, 'Time to check the oven!');
  // A song's words: never sung.
  const { songTags } = await import('../src/songs.js');
  assert.equal(songTags('<song style="pop">[Verse]\nThe goblin sails the sea\n<image>a goblin pirate</image></song>')[0].lyrics, '[Verse]\nThe goblin sails the sea');
});
