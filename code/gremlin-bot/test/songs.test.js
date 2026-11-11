// Songs on request: the <song> tag after its line, making the song with ElevenLabs
// Music, playing it in the call (and stopping it), what it costs, and the second
// end-of-turn check that lets it answer a little sooner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import OpusScript from 'opusscript';
import { AudioPlayerStatus } from '@discordjs/voice';
import { Brain } from '../src/brain.js';
import { FIELDS } from '../desktop/lib/settings.mjs';
import { Listener, PAUSE_RECHECK_MS } from '../src/listener.js';
import { buildSystem, buildUserMessage, sayContent, withoutHiddenTags } from '../src/prompts.js';
import { VoiceSession } from '../src/session.js';
import {
  SONG_RATE,
  Songs,
  buildPlan,
  cutOffInSong,
  downmix,
  fitPlan,
  guessChannels,
  musicError,
  normalize,
  parseLyrics,
  planMs,
  songTags,
  splitStyles,
  withoutSongTags,
} from '../src/songs.js';
import { Speaker } from '../src/speaker.js';
import { costOf, describeBucket, emptyBucket, oneLine, totalDollars } from '../src/usage.js';

const LYRICS = '[Verse]\nMike walked into a door\nThe door won, what a bore\n[Chorus]\nDoor wins again\nDoor wins again\n[Outro]\nKnock knock';

// ---------------------------------------------------------------------------
// The tag
// ---------------------------------------------------------------------------

test('the song tag is read, and never said out loud (not even while it is still being written)', () => {
  const reply = `<say>Oh, give me a minute.</say><song style="pop punk, fast drums" seconds="25">${LYRICS}</song>`;
  assert.deepEqual(songTags(reply), [{ style: 'pop punk, fast drums', seconds: 25, lyrics: LYRICS }]);
  assert.equal(sayContent(reply), 'Oh, give me a minute.');
  // Written inside the words by mistake: still not said.
  assert.equal(sayContent(`<say>On it. <song style="pop">la la la</song> Hang on.</say>`).replace(/\s+/g, ' ').trim(), 'On it. Hang on.');
  // Still being written: nothing after the tag's start is said.
  assert.equal(sayContent('<say>On it. <song style="pop">la la'), 'On it. ');
  assert.equal(withoutSongTags('before <song style="x">words</song> after'), 'before   after');
  assert.equal(cutOffInSong('<say>Sure.</say><song style="pop" seconds="30">[Verse]\nhalf a li'), true);
  assert.equal(cutOffInSong(`<say>Sure.</say><song>${LYRICS}</song>`), false);
  assert.equal(withoutHiddenTags('<say>a</say><reminder in="5 minutes">x</reminder><song>y</song>'), '<say>a</say>  ');
  assert.deepEqual(songTags('<song seconds=40>words</song>'), [{ style: '', seconds: 40, lyrics: 'words' }]);
});

test('lyrics become sections; the plan shares the time out by lines, at least 3 s a section', () => {
  const sections = parseLyrics(`Intro line before any heading\n${LYRICS}\n(oh oh oh)\nChorus:\nOne more time`);
  assert.deepEqual(
    sections.map((s) => [s.name, s.lines.length]),
    [['Verse', 1], ['Verse', 2], ['Chorus', 2], ['Outro', 2], ['Chorus', 1]],
  );
  assert.equal(sections[3].lines[1], '(oh oh oh)', 'a line in brackets that is not a section name is sung');
  const plan = buildPlan({ style: 'pop punk, fast drums; raspy male vocals', seconds: 30, sections: parseLyrics(LYRICS) });
  assert.equal(plan.chunks.length, 3);
  assert.equal(
    plan.chunks.reduce((a, c) => a + c.duration_ms, 0),
    30000,
  );
  assert.ok(plan.chunks.every((c) => c.duration_ms >= 3000 && c.duration_ms <= 120000));
  assert.deepEqual(plan.chunks[0].positive_styles, ['pop punk', 'fast drums', 'raspy male vocals']);
  assert.equal(plan.chunks[1].text, '[Chorus]\nDoor wins again\nDoor wins again');
  assert.equal(plan.chunks[0].context_adherence, 'high');
  // Too short for every section: the last ones are merged in.
  const many = parseLyrics(Array.from({ length: 8 }, (_, i) => `[Part ${i}]\nline ${i}`).join('\n'));
  const short = buildPlan({ style: '', seconds: 15, sections: many });
  assert.equal(short.chunks.length, 5);
  assert.equal(
    short.chunks.reduce((a, c) => a + c.duration_ms, 0),
    15000,
  );
  assert.deepEqual(splitStyles(''), ['upbeat pop', 'catchy melody', 'clear lead vocals']);
  assert.equal(parseLyrics(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'))[0].lines.length, 24, 'capped');
});

// ---------------------------------------------------------------------------
// Making it
// ---------------------------------------------------------------------------

/** A tone as 16-bit PCM, mono or stereo, at 48 kHz. */
function tone(seconds, { channels = 1, amp = 2000 } = {}) {
  const frames = Math.round(seconds * SONG_RATE);
  const buf = Buffer.alloc(frames * 2 * channels);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / SONG_RATE));
    for (let c = 0; c < channels; c++) buf.writeInt16LE(v, (i * channels + c) * 2);
  }
  return buf;
}

function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    const r = queue.shift();
    if (r.audio) {
      return { ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? r.contentType || 'application/octet-stream' : null) }, arrayBuffer: async () => r.audio };
    }
    return { ok: false, status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body) };
  };
  return { fetchImpl, calls };
}

function fakeUsage(usedSeconds = 0) {
  const events = [];
  return { events, record: (e) => events.push(e), thisMonth: () => ({ musicSeconds: usedSeconds }) };
}

const songConfig = (songs = {}) => ({ tts: { elevenKey: 'k' }, songs: { enabled: true, minutesPerMonth: 10, maxSeconds: 60, model: 'music_v2_5', ...songs } });

test('a song is made from a plan as raw 48 kHz audio, brought to its voice level, and counted', async () => {
  const f = fakeFetch([{ audio: tone(20) }]);
  const usage = fakeUsage();
  const songs = new Songs(songConfig(), { fetchImpl: f.fetchImpl, usage });
  const made = await songs.make({ style: 'pop punk', seconds: 20, lyrics: LYRICS });
  assert.match(f.calls[0].url, /^https:\/\/api\.elevenlabs\.io\/v1\/music\?output_format=pcm_48000$/);
  assert.equal(f.calls[0].headers['xi-api-key'], 'k');
  assert.equal(f.calls[0].body.model_id, 'music_v2_5');
  assert.equal(f.calls[0].body.composition_plan.chunks.length, 3);
  assert.equal(made.sampleRate, 48000);
  assert.ok(Math.abs(made.seconds - 20) < 0.01);
  assert.equal(made.lyricsText, 'Mike walked into a door / The door won, what a bore / Door wins again / Door wins again / Knock knock');
  assert.equal(usage.events.length, 1);
  assert.equal(usage.events[0].type, 'music');
  // Louder than the quiet tone it got (brought up toward its voice level).
  const peak = Math.max(...Array.from({ length: 1000 }, (_, i) => Math.abs(made.pcm.readInt16LE(i * 2))));
  assert.ok(peak > 2000, `peak ${peak}`);
});

test('stereo audio is told apart by its length and mixed down; silence is an error', async () => {
  assert.equal(guessChannels(tone(10, { channels: 2 }).length, 10), 2);
  assert.equal(guessChannels(tone(10).length, 10), 1);
  assert.equal(guessChannels(tone(10).length, 10, 'audio/pcm; channels=2'), 2);
  const mono = downmix(tone(1, { channels: 2 }));
  assert.equal(mono.length, tone(1).length);
  assert.equal(normalize(Buffer.alloc(9600)), null);
  const f = fakeFetch([{ audio: tone(30, { channels: 2 }) }]);
  const made = await new Songs(songConfig(), { fetchImpl: f.fetchImpl, usage: fakeUsage() }).make({ style: 'pop', seconds: 30, lyrics: LYRICS });
  assert.ok(Math.abs(made.seconds - 30) < 0.01, `${made.seconds} s`);
  const silent = fakeFetch([{ audio: Buffer.alloc(48000 * 2 * 20) }]);
  await assert.rejects(new Songs(songConfig(), { fetchImpl: silent.fetchImpl, usage: fakeUsage() }).make({ style: 'pop', seconds: 20, lyrics: LYRICS }), /silent/);
});

test('a plan naming something it should not: ElevenLabs rewrites it, the rewrite is used, and the log says so', async () => {
  const suggestion = { chunks: [{ text: '[Verse]\nclean', duration_ms: 20000, positive_styles: ['pop'], negative_styles: [] }] };
  const f = fakeFetch([{ status: 400, body: { detail: { status: 'bad_composition_plan', message: 'copyrighted', data: { composition_plan_suggestion: suggestion } } } }, { audio: tone(20) }]);
  const made = await new Songs(songConfig(), { fetchImpl: f.fetchImpl, usage: fakeUsage() }).make({ style: 'like a famous band', seconds: 20, lyrics: LYRICS });
  assert.deepEqual(f.calls[1].body.composition_plan, suggestion);
  // (Never passed off as the song that was written: the provider's rewrite is labelled.)
  assert.equal(made.how, 'plan rewritten by ElevenLabs');
});

test('a plan this model will not take: the same song as a prompt (with its suggestion if it names something)', async () => {
  const f = fakeFetch([
    { status: 422, body: { detail: [{ loc: ['body', 'composition_plan'], msg: 'field required', type: 'missing' }] } },
    { status: 400, body: { detail: { status: 'bad_prompt', message: 'artist name', data: { prompt_suggestion: 'upbeat pop punk about a door' } } } },
    { audio: tone(25) },
  ]);
  const made = await new Songs(songConfig(), { fetchImpl: f.fetchImpl, usage: fakeUsage() }).make({ style: 'pop punk', seconds: 25, lyrics: LYRICS });
  assert.match(f.calls[1].body.prompt, /^pop punk\. A short, funny song with these lyrics:\n\[Verse\]\nMike walked into a door/);
  assert.equal(f.calls[1].body.music_length_ms, 25000);
  assert.equal(f.calls[2].body.prompt, 'upbeat pop punk about a door');
  assert.equal(made.how, 'prompt');
});

test('a key without Music access: a plain reason, and songs stop being offered', async () => {
  const f = fakeFetch([{ status: 403, body: { detail: { status: 'insufficient_permissions', message: 'missing permission music_generation' } } }]);
  const songs = new Songs(songConfig(), { fetchImpl: f.fetchImpl, usage: fakeUsage() });
  await assert.rejects(songs.make({ style: 'pop', seconds: 20, lyrics: LYRICS }), (err) => {
    assert.match(err.userText, /isn't allowed to make music\. In ElevenLabs open Developers > API Keys and turn on Music/);
    return true;
  });
  assert.equal(songs.status().ok, false);
  assert.match(songs.status().reason, /isn't allowed to make music/);
  assert.equal(f.calls.length, 1, 'no retries for that');
  assert.match(musicError(402, '{"detail":{"status":"insufficient_credits"}}').userText, /credits/);
  assert.match(musicError(429, '').userText, /busy/);
  assert.equal(musicError(403, '{"detail":{"status":"feature_not_available"}}').blocks, true);
});

test('the monthly minutes: a song is cut to what is left, and none once they are used up', async () => {
  const f = fakeFetch([{ audio: tone(20) }]);
  const songs = new Songs(songConfig({ minutesPerMonth: 10 }), { fetchImpl: f.fetchImpl, usage: fakeUsage(10 * 60 - 20) });
  await songs.make({ style: 'pop', seconds: 60, lyrics: LYRICS });
  assert.equal(f.calls[0].body.composition_plan.chunks.reduce((a, c) => a + c.duration_ms, 0), 20000);
  const out = new Songs(songConfig({ minutesPerMonth: 10 }), { fetchImpl: f.fetchImpl, usage: fakeUsage(10 * 60) });
  assert.equal(out.status().ok, false);
  assert.match(out.status().reason, /used up/);
  await assert.rejects(out.make({ style: 'pop', seconds: 30, lyrics: LYRICS }), /used up/);
  assert.equal(new Songs({ tts: { elevenKey: '' }, songs: { enabled: true } }).enabled, false, 'no key, no songs');
  assert.equal(new Songs({ tts: { elevenKey: 'k' }, songs: { enabled: false } }).status().ok, false);
});

test('ElevenLabs errors: what it says decides (a missing permission or an empty balance can come back as 401)', () => {
  const perm = musicError(401, JSON.stringify({ detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission music_generation to execute this operation.' } }));
  assert.match(perm.userText, /isn't allowed to make music/);
  assert.equal(perm.blocks, true);
  const quota = musicError(401, JSON.stringify({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000. You have 12 credits remaining, while 900 credits are required for this request.' } }));
  assert.match(quota.userText, /credits/);
  assert.equal(quota.blocks, false, 'credits come back: it can try again later');
  const bad = musicError(401, JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }));
  assert.match(bad.userText, /rejected the API key/);
  assert.equal(bad.blocks, true);
  assert.equal(musicError(403, '{"detail":{"status":"insufficient_permissions"}}').blocks, true);
  assert.equal(musicError(500, 'oops').blocks, false);
});

test('a suggested plan is fitted to the song it was allowed (never longer), and that length is what is counted', async () => {
  const long = { chunks: [{ text: '[Verse]\na', duration_ms: 30000 }, { text: '[Chorus]\nb', duration_ms: 30000 }] };
  const fitted = fitPlan(long, 20000);
  assert.deepEqual(
    fitted.chunks.map((c) => c.duration_ms),
    [10000, 10000],
  );
  assert.equal(planMs(fitted), 20000);
  // More chunks than fit at 3 s each: the last ones join the one before.
  const many = { chunks: Array.from({ length: 8 }, (_, i) => ({ text: `[Verse]\nline ${i}`, duration_ms: 5000 })) };
  const merged = fitPlan(many, 15000);
  assert.equal(merged.chunks.length, 5);
  assert.equal(planMs(merged), 15000);
  assert.ok(merged.chunks.every((c) => c.duration_ms >= 3000));
  assert.match(merged.chunks[4].text, /line 4\n\[Verse\]\nline 5\n\[Verse\]\nline 6\n\[Verse\]\nline 7$/);
  assert.equal(fitPlan('not a plan', 20000), null);
  assert.equal(fitPlan({ chunks: [] }, 20000), null);
  // Making one: the suggestion is sent fitted, and counted at that length.
  const f = fakeFetch([{ status: 400, body: { detail: { status: 'bad_composition_plan', message: 'x', data: { composition_plan_suggestion: long } } } }, { audio: tone(20) }]);
  const usage = fakeUsage();
  const made = await new Songs(songConfig(), { fetchImpl: f.fetchImpl, usage }).make({ style: 'pop', seconds: 20, lyrics: LYRICS });
  assert.equal(planMs(f.calls[1].body.composition_plan), 20000);
  assert.deepEqual(
    usage.events.map((e) => e.seconds),
    [20],
  );
  assert.ok(Math.abs(made.seconds - 20) < 0.01);
});

test('a song that comes back silent is still counted (it was paid for)', async () => {
  const silent = fakeFetch([{ audio: Buffer.alloc(48000 * 2 * 20) }]);
  const usage = fakeUsage();
  await assert.rejects(new Songs(songConfig(), { fetchImpl: silent.fetchImpl, usage }).make({ style: 'pop', seconds: 20, lyrics: LYRICS }), /silent/);
  assert.deepEqual(
    usage.events.map((e) => [e.type, e.seconds]),
    [['music', 20]],
  );
});

test('making a song: it counts against the month while it is made; a dropped connection is tried again; it gives up after a while', async () => {
  let release;
  const slowFetch = async () => {
    await new Promise((r) => (release = r));
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => tone(20) };
  };
  const songs = new Songs(songConfig({ minutesPerMonth: 1 }), { fetchImpl: slowFetch, usage: fakeUsage() });
  const making = songs.make({ style: 'pop', seconds: 50, lyrics: LYRICS });
  await settle();
  assert.equal(songs.reservedSeconds, 50);
  assert.equal(songs.status().ok, false, 'not enough left for another while this one is made');
  release();
  await making;
  assert.equal(songs.reservedSeconds, 0);
  assert.equal(songs.status().ok, true);
  // The connection dropped before any answer: sent once more.
  let tries = 0;
  const flaky = async () => {
    tries++;
    if (tries === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => tone(20) };
  };
  await new Songs(songConfig(), { fetchImpl: flaky, usage: fakeUsage() }).make({ style: 'pop', seconds: 20, lyrics: LYRICS });
  assert.equal(tries, 2);
  // ElevenLabs never answers: it gives up with a plain reason, and can try again next time.
  // (A timeout's timer doesn't keep Node running on its own: this stands in for the open call.)
  const hang = (_url, opts) =>
    new Promise((_, reject) => {
      const alive = setInterval(() => {}, 1000);
      opts.signal.addEventListener('abort', () => (clearInterval(alive), reject(opts.signal.reason)), { once: true });
    });
  const slow = new Songs(songConfig(), { fetchImpl: hang, usage: fakeUsage(), timeoutMs: 50 });
  await assert.rejects(slow.make({ style: 'pop', seconds: 20, lyrics: LYRICS }), (err) => {
    assert.match(err.userText, /took too long/);
    return true;
  });
  assert.equal(slow.reservedSeconds, 0);
  assert.equal(slow.status().ok, true);
  // Called off while it's made: the cancel comes through as it is.
  const ac = new AbortController();
  const cancelled = new Songs(songConfig(), { fetchImpl: hang, usage: fakeUsage() });
  const p = cancelled.make({ style: 'pop', seconds: 20, lyrics: LYRICS }, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (err) => err.name === 'AbortError');
  assert.equal(cancelled.reservedSeconds, 0);
});

test('audio in a buffer that does not start on an even byte is read right', () => {
  const stereo = tone(0.1, { channels: 2 });
  const odd = Buffer.alloc(stereo.length + 1);
  stereo.copy(odd, 1);
  assert.deepEqual(downmix(odd.subarray(1)), downmix(stereo));
  const mono = tone(0.1);
  const oddMono = Buffer.alloc(mono.length + 1);
  mono.copy(oddMono, 1);
  assert.deepEqual(normalize(oddMono.subarray(1)), normalize(mono));
});

test('songs count in usage: minutes of music and their cost, in the totals and /usage', () => {
  const d = costOf({ type: 'music', seconds: 30 });
  assert.equal(d.musicSeconds, 30);
  assert.equal(d.musicRequests, 1);
  assert.ok(Math.abs(d.musicDollars - 0.075) < 1e-9);
  const b = { ...emptyBucket(), ...d, claudeDollars: 0.5 };
  assert.ok(Math.abs(totalDollars(b) - 0.575) < 1e-9);
  assert.ok(describeBucket(b).some((l) => /^Songs: 1 made, 30 s of music \(\$0\.0[78]\)$/.test(l)));
  assert.match(oneLine(b), /1 song,/);
  assert.ok(!describeBucket(emptyBucket()).some((l) => l.startsWith('Songs')), 'no songs line before the first song');
  assert.equal(totalDollars({ ttsDollars: 1, sttDollars: 0, claudeDollars: 1 }), 2, 'an old bucket without songs still adds up');
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
  songs: { enabled: true, maxSeconds: 60 },
};

const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
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
      this.stopped = (this.stopped || 0) + 1;
      for (const l of lines) l.resolve?.('stopped');
    },
    stopKind() {},
    dropOptional() {},
  };
}

function setup({ reply, songs = true, making = false, onCancelSong } = {}) {
  const calls = [];
  const asked = [];
  const speaker = manualSpeaker();
  const brain = new Brain({
    config: baseConfig,
    claude: {
      async createMessage(args) {
        calls.push(args);
        args.onText?.(reply);
        return { text: reply, refusal: false };
      },
    },
    speaker,
    chattiness: 'medium',
    getCallInfo: () => ({ channelName: 'Lobby', people: ['Mike', 'Jess'], activities: [] }),
    onSong: songs ? (tag, info) => asked.push({ tag, info }) : undefined,
    getSongsNow: () => 'You can make a song if someone asks for one (about 9 minutes of songs left this month).',
    isMakingSong: () => making,
    onCancelSong,
  });
  return { brain, calls, asked, speaker };
}

test('asked for a song: it says it is on it, and the song is made once that line is heard', async () => {
  const reply = `<say>Oh, give me a minute.</say><song style="pop punk, fast drums" seconds="25">${LYRICS}</song>`;
  const s = setup({ reply });
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, make a song about me losing to a door' });
  await settle();
  assert.deepEqual(
    s.speaker.lines.map((l) => [l.kind, l.text]),
    [['direct', 'Oh, give me a minute.']],
  );
  assert.equal(s.asked.length, 0, 'not before anyone heard it agree');
  s.speaker.start(0);
  await settle();
  assert.equal(s.asked.length, 1);
  assert.deepEqual(s.asked[0].tag, { song: { style: 'pop punk, fast drums', seconds: 25, lyrics: LYRICS }, cutOff: false });
  assert.deepEqual(s.asked[0].info.userIds, ['u1']);
  // Its prompt explains songs, says whether it can make one now, and leaves room for the words.
  const system = s.calls[0].system[0].text;
  assert.match(system, /<songs>/);
  assert.match(system, /Never name a real artist, band or song/);
  assert.match(String(s.calls[0].user), /<songs_now>\nYou can make a song if someone asks for one/);
  assert.equal(s.calls[0].maxTokens, 200 + 320);
  // Without songs: none of that.
  const off = setup({ reply: '<say>Sure.</say>', songs: false });
  off.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, what do you think of the new map' });
  await settle();
  assert.doesNotMatch(off.calls[0].system[0].text, /<songs>/);
  assert.doesNotMatch(String(off.calls[0].user), /songs_now/);
  assert.equal(off.calls[0].maxTokens, 200);
});

test('a song tag cut off by the length limit: the call is told, nothing is made', async () => {
  const s = setup({ reply: '<say>On it.</say><song style="pop" seconds="30">[Verse]\nhalf a li' });
  // (The reply stopped at the length limit.)
  s.brain.claude.createMessage = async (args) => {
    args.onText?.('<say>On it.</say><song style="pop" seconds="30">[Verse]\nhalf a li');
    return { text: '<say>On it.</say><song style="pop" seconds="30">[Verse]\nhalf a li', refusal: false, stopReason: 'max_tokens' };
  };
  s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, sing something' });
  await settle();
  s.speaker.start(0);
  await settle();
  assert.deepEqual(s.asked[0].tag, { song: null, cutOff: true });
});

test('playing it: a quick intro, then the song right after; talk during it is let be; "skip it" stops it', async () => {
  const s = setup({ reply: '<say>Sure.</say>' });
  const pcm = tone(2);
  const played = s.brain.playSong({ pcm, sampleRate: 48000, seconds: 2, lyricsText: 'Door wins again / Door wins again' }, { userIds: ['u1'] });
  assert.deepEqual(
    s.speaker.lines.map((l) => l.kind),
    ['intro', 'song'],
  );
  const song = s.speaker.lines[1];
  assert.equal(song.opts.continues, true, 'right after the intro');
  assert.equal(song.opts.durationMs, 2000);
  const audio = await song.opts.source({});
  assert.equal(audio.sampleRate, 48000);
  const chunks = [];
  for await (const c of audio.stream) chunks.push(c);
  assert.equal(Buffer.concat(chunks).length, pcm.length);
  // Its words are in the transcript, so a mic playing them back is known as its own voice.
  s.speaker.start(0);
  s.speaker.finish(0);
  s.speaker.start(1);
  assert.equal(s.brain.hear({ userId: 'u2', id: 2, name: 'Jess', text: 'door wins again door wins again' }), 'echo');
  // Talking during it, even to it, doesn't stop it...
  assert.equal(s.brain.hear({ userId: 'u2', id: 3, name: 'Jess', text: 'Gremlin this is amazing' }), 'singing');
  assert.equal(s.brain.hear({ userId: 'u1', id: 4, name: 'Mike', text: 'hahaha' }), 'singing');
  assert.equal(s.speaker.stopped, undefined);
  // ...but asking it to stop does.
  assert.equal(s.brain.hear({ userId: 'u1', id: 5, name: 'Mike', text: 'Gremlin, skip it' }), 'stop');
  assert.equal(s.speaker.stopped, 1);
  assert.deepEqual(await played, { outcome: 'stopped', started: true });
});

test('a song made while someone is talking waits for a quiet moment; told to stop meanwhile, it is not played', async () => {
  const s = setup({ reply: '<say>Sure.</say>' });
  s.speaker.speaking = true;
  const played = s.brain.playSong({ pcm: tone(1), sampleRate: 48000, seconds: 1, lyricsText: 'la la' }, { userIds: ['u1'] });
  await settle();
  assert.equal(s.speaker.lines.length, 0, 'it waits');
  assert.equal(s.brain.songWaiting, true);
  s.brain.shush();
  assert.deepEqual(await played, { outcome: 'stopped', started: false });
  assert.equal(s.speaker.lines.length, 0);
  assert.equal(s.brain.songWaiting, false);
});

test('a song still being made: "never mind the song" calls it off (the answer says okay), and so does a stop', async () => {
  const cancelled = [];
  const s = setup({ reply: '<say>Fine, no song then.</say>', making: true, onCancelSong: (why) => cancelled.push(why) });
  assert.equal(s.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, never mind the song' }), 'direct');
  assert.deepEqual(cancelled, ['asked']);
  await settle();
  assert.deepEqual(
    s.speaker.lines.map((l) => l.text),
    ['Fine, no song then.'],
  );
  // "Gremlin, stop": shushed, and the song with it.
  assert.equal(s.brain.hear({ userId: 'u1', id: 2, name: 'Mike', text: 'Gremlin, stop' }), 'stop');
  assert.deepEqual(cancelled, ['asked', 'stop']);
  // Nothing being made: "never mind" is only an answer.
  const idle = [];
  const t = setup({ reply: '<say>Okay.</say>', onCancelSong: (why) => idle.push(why) });
  t.brain.hear({ userId: 'u1', id: 1, name: 'Mike', text: 'Gremlin, never mind' });
  assert.deepEqual(idle, []);
});

test('the speaker plays audio made elsewhere (a song) without the voice, and gives it as long as it needs', async () => {
  class FakePlayer extends EventEmitter {
    constructor() {
      super();
      this.state = { status: AudioPlayerStatus.Idle };
      this.played = [];
    }
    setStatus(status) {
      const old = this.state;
      this.state = { status };
      this.emit('stateChange', old, this.state);
    }
    play(r) {
      this.played.push(r);
      this.setStatus(AudioPlayerStatus.Playing);
    }
    stop() {
      if (this.state.status !== AudioPlayerStatus.Idle) this.setStatus(AudioPlayerStatus.Idle);
      return true;
    }
  }
  const player = new FakePlayer();
  const ttsCalls = [];
  const speaker = new Speaker({ tts: { stream: async (t) => (ttsCalls.push(t), { stream: Readable.from([Buffer.alloc(4800)]), sampleRate: 24000 }) }, player });
  const done = speaker.say('la la la', { kind: 'song', source: async () => ({ stream: Readable.from([tone(1)]), sampleRate: 48000 }), durationMs: 1000 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(player.played.length, 1);
  assert.deepEqual(ttsCalls, [], 'the voice is not used for it');
  assert.equal(speaker.nowPlaying().kind, 'song');
  player.setStatus(AudioPlayerStatus.Idle);
  assert.equal(await done, 'played');
});

test('the call: whether a song can be made now, and problems making one posted in the text chat', async () => {
  const posted = [];
  const s = new VoiceSession({
    client: { user: { id: 'bot' } },
    guild: { id: 'g', name: 'Test', channels: { cache: new Map() }, voiceStates: { cache: new Map() }, members: { cache: new Map() } },
    voiceChannel: { id: 'B' },
    textChannel: { send: async (m) => posted.push(m.content) },
    config: { botName: 'Gremlin', botAliases: ['gremlin'], stt: { extraTerms: [] }, autoLeaveSeconds: 60, listen: {} },
    memory: { isOptedOut: () => false },
    songs: { enabled: true, status: () => ({ ok: true, minutesLeft: 9.5 }), make: async () => { throw Object.assign(new Error('x'), { userText: "the ElevenLabs key isn't allowed to make music" }); } },
  });
  assert.match(s.songsNow(), /about 9 minutes of songs left this month/);
  await s.makeSong({ song: { style: 'pop', seconds: 20, lyrics: LYRICS } }, { name: 'Mike' });
  await settle();
  assert.deepEqual(posted, ["-# (I couldn't make that song: the ElevenLabs key isn't allowed to make music.)"]);
  await s.makeSong({ song: null, cutOff: true }, { name: 'Mike' });
  await settle();
  assert.equal(posted[1], '-# (I ran out of room writing that song. Ask me again.)');
  s.songJob = { ac: new AbortController() };
  assert.match(s.songsNow(), /still being made/);
  s.songJob = null;
  s.songs.status = () => ({ ok: false, reason: "this month's song minutes are used up" });
  assert.match(s.songsNow(), /can't make a song right now: this month's song minutes are used up/);
  s.songs = null;
  assert.equal(s.songsNow(), '');
});

function testSession(posted) {
  return new VoiceSession({
    client: { user: { id: 'bot' } },
    guild: { id: 'g', name: 'Test', channels: { cache: new Map() }, voiceStates: { cache: new Map() }, members: { cache: new Map() } },
    voiceChannel: { id: 'B' },
    textChannel: { id: 'T', send: async (m) => posted.push(m.content) },
    config: { botName: 'Gremlin', botAliases: ['gremlin'], stt: { extraTerms: [] }, autoLeaveSeconds: 60, listen: { minSpeechMs: 100 }, tts: { audioTags: false }, timezone: 'UTC' },
    memory: { isOptedOut: () => false },
    songs: { enabled: true, status: () => ({ ok: true, minutesLeft: 9.5 }), make: async () => ({ pcm: tone(1), sampleRate: 48000, seconds: 1, lyricsText: 'la' }) },
  });
}

test('the call: calling off a song being made, and a made song told to stop before it played', async () => {
  const posted = [];
  const s = testSession(posted);
  const ac = new AbortController();
  s.songJob = { ac };
  assert.equal(s.cancelSong('stop'), true);
  assert.equal(ac.signal.aborted, true);
  assert.equal(s.songJob, null);
  assert.deepEqual(posted, ['-# (I called off the song I was making, since I was told to stop.)']);
  assert.equal(s.cancelSong('stop'), false, 'nothing left to call off');
  // Asked to cancel it: its answer says okay, so nothing is posted, and its prompt knows.
  s.songJob = { ac: new AbortController() };
  s.cancelSong('asked');
  assert.equal(posted.length, 1);
  assert.match(s.songsNow(), /^The song you were making was just called off, as they asked\. You can make a song/);
  // Under a minute left: said so (not "about 0 minutes").
  s.songCalledOffAt = 0;
  s.songs.status = () => ({ ok: true, minutesLeft: 0.5 });
  assert.match(s.songsNow(), /\(under a minute of songs left this month\)/);
  s.songs.status = () => ({ ok: true, minutesLeft: 1.4 });
  assert.match(s.songsNow(), /\(about 1 minute of songs left this month\)/);
  // Made, but told to stop before it started: posted, so nobody waits for it.
  s.songs.status = () => ({ ok: true, minutesLeft: 9 });
  s.brain = { playSong: async () => ({ outcome: 'stopped', started: false }) };
  await s.makeSong({ song: { style: 'pop', seconds: 20, lyrics: LYRICS } }, { name: 'Mike' });
  assert.equal(posted.at(-1), "-# (That song was ready, but I was told to stop, so it didn't play. Ask again if you still want it.)");
  // Stopped partway through: they heard it stop.
  const before = posted.length;
  s.brain = { playSong: async () => ({ outcome: 'stopped', started: true }) };
  await s.makeSong({ song: { style: 'pop', seconds: 20, lyrics: LYRICS } }, { name: 'Mike' });
  assert.equal(posted.length, before);
  // A song tag written into a reminder's words isn't said with it.
  const added = [];
  s.reminders = { add: (_g, r) => (added.push(r), { reminder: { id: 1, at: new Date(Date.now() + 60000).toISOString() } }), cancel: () => [] };
  s.applyReminders({ set: [{ in: '5m', for: 'me', say: 'Mike, time to stretch. <song style="pop">la la</song>' }] }, { name: 'Mike', userIds: ['u1'] });
  assert.equal(added[0].say, 'Mike, time to stretch.');
});

test('the call: someone back after a moment keeps their join time (and gets no second hi); a move counts who is there', async () => {
  const s = testSession([]);
  const joined = [];
  s.ready = true;
  s.brain = { someoneJoined: (x) => joined.push(x) };
  s.isHuman = () => true;
  s.shouldListen = () => true;
  s.displayName = async (id) => (id === 'u1' ? 'Mike' : 'Jess');
  s.checkAlone = () => {};
  s.listener = { drop() {} };
  s.joinTimes.set('u1', 1000);
  s.onVoiceStateUpdate({ id: 'u1', channelId: 'B' }, { id: 'u1', channelId: null });
  assert.equal(s.joinTimes.has('u1'), false);
  s.onVoiceStateUpdate({ id: 'u1', channelId: null }, { id: 'u1', channelId: 'B' });
  assert.equal(s.joinTimes.get('u1'), 1000, 'still joined when they first did');
  await settle();
  assert.deepEqual(joined, [], 'no second hi');
  s.onVoiceStateUpdate({ id: 'u2', channelId: null }, { id: 'u2', channelId: 'B' });
  await settle();
  assert.deepEqual(joined, [{ userId: 'u2', name: 'Jess' }]);
  // In a new channel: whoever's there counts as joined now; anyone who came along keeps their time.
  s.humans = () => [{ id: 'u1' }, { id: 'u3' }];
  s.joinedHere();
  assert.equal(s.joinTimes.get('u1'), 1000);
  assert.ok(Math.abs(s.joinTimes.get('u3') - Date.now()) < 1000);
  assert.equal(s.joinTimes.has('u2'), false);
});

test('the second end-of-turn listen waits for the first one instead of being dropped', async () => {
  const s = testSession([]);
  const checks = [];
  s.stt = { checkPause: (wav) => new Promise((resolve) => checks.push({ wav, resolve })) };
  s.turnChecksOn = () => true;
  s.shouldListen = () => true;
  const ended = [];
  s.listener = { endSentence: (u, id, seq) => (ended.push([u, id, seq]), true) };
  const first = s.onPause({ userId: 'u1', id: 1, pauseSeq: 1, wav: 'a', voicedMs: 500 });
  const second = s.onPause({ userId: 'u1', id: 1, pauseSeq: 1, wav: 'b', voicedMs: 500, again: true });
  await settle();
  assert.equal(checks.length, 1, 'one at a time');
  // Another first listen while one runs is skipped, as before.
  await s.onPause({ userId: 'u1', id: 1, pauseSeq: 1, wav: 'c', voicedMs: 500 });
  assert.equal(checks.length, 1);
  checks[0].resolve({ complete: 0.3 });
  await first;
  await settle();
  assert.equal(checks.length, 2, 'then the second listen');
  assert.equal(checks[1].wav, 'b');
  checks[1].resolve({ complete: 0.9 });
  await second;
  assert.deepEqual(ended, [['u1', 1, 1]]);
  assert.equal(s.turnChecking.size, 0);
});

test('the settings for songs and the human touches', () => {
  assert.equal(FIELDS.get('SONGS').default, 'true');
  assert.equal(FIELDS.get('SONG_MINUTES_PER_MONTH').default, '10');
  assert.equal(FIELDS.get('SONG_MAX_SECONDS').max, 120);
  for (const k of ['THINKING_SOUNDS', 'LAUGH_ALONG', 'HELLO_GOODBYE']) assert.equal(FIELDS.get(k).default, 'true', k);
  const system = buildSystem({ botName: 'Gremlin', persona: 'p', songs: true, maxSongSeconds: 45 })[0].text;
  assert.match(system, /seconds: how long, 15 to 45/);
  assert.match(buildUserMessage({ callInfo: 'x', transcript: 'y', task: 'z', songsNow: 'Out of songs.' }), /<songs_now>\nOut of songs\.\n<\/songs_now>/);
});

// ---------------------------------------------------------------------------
// Answering sooner: a second end-of-turn check
// ---------------------------------------------------------------------------

function packets({ toneFrames = 0, silentFrames = 0 }) {
  const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const out = [];
  const frame = Buffer.alloc(960 * 4);
  let n = 0;
  for (let f = 0; f < toneFrames + silentFrames; f++) {
    const loud = f < toneFrames;
    for (let i = 0; i < 960; i++, n++) {
      const v = loud ? Math.round(6000 * Math.sin((2 * Math.PI * 220 * n) / 48000)) : 0;
      frame.writeInt16LE(v, i * 4);
      frame.writeInt16LE(v, i * 4 + 2);
    }
    out.push(Buffer.from(enc.encode(frame, 960)));
  }
  enc.delete();
  return out;
}

test('a pause that did not sound done is checked once more a little later, before the full pause', async () => {
  let now = 3_000_000;
  const streams = new Map();
  const receiver = {
    speaking: Object.assign(new EventEmitter(), { users: new Map() }),
    subscribe(userId) {
      const st = new Readable({ objectMode: true, read() {} });
      streams.set(userId, st);
      return st;
    },
  };
  const listener = new Listener({ receiver, listen: { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 8000, voiceRms: 200 }, shouldListen: () => true, clock: () => now });
  const pauses = [];
  const utterances = [];
  listener.on('pause', (p) => pauses.push(p));
  listener.on('utterance', (u) => utterances.push(u));
  listener.onSpeakingStart('u1');
  for (const p of packets({ toneFrames: 30 })) {
    streams.get('u1').push(p);
    await new Promise((r) => setImmediate(r));
    now += 20;
  }
  // Discord goes quiet: the first check after 200 ms, the second after 420 ms.
  now += 220;
  listener.sweep();
  now += 220;
  listener.sweep();
  now += 100;
  listener.sweep();
  assert.deepEqual(
    pauses.map((p) => [p.pauseSeq, p.again]),
    [[1, false], [1, true]],
  );
  const wavMs = (wav) => ((wav.length - 44) / 2 / 16000) * 1000;
  assert.ok(wavMs(pauses[1].wav) >= 30 * 20 + PAUSE_RECHECK_MS - 25, `second clip ${wavMs(pauses[1].wav)} ms`);
  assert.equal(utterances.length, 0);
  // The second check says they're done: the sentence ends there.
  assert.equal(listener.endSentence('u1', pauses[1].id, 1), true);
  assert.equal(utterances.length, 1);
  listener.stop();

  // Without the end-of-turn model, no clips are made at all (the sentence ends after the full pause).
  const quiet = new Listener({ receiver, listen: { silenceMs: 700, minSpeechMs: 300, maxUtteranceMs: 8000, voiceRms: 200 }, shouldListen: () => true, wantPauses: () => false, clock: () => now });
  const none = [];
  const done = [];
  quiet.on('pause', (p) => none.push(p));
  quiet.on('utterance', (u) => done.push(u));
  quiet.onSpeakingStart('u2');
  for (const p of packets({ toneFrames: 30 })) {
    streams.get('u2').push(p);
    await new Promise((r) => setImmediate(r));
    now += 20;
  }
  for (const step of [220, 220, 100, 200]) {
    now += step;
    quiet.sweep();
  }
  assert.deepEqual(none, []);
  assert.equal(done.length, 1);
  quiet.stop();
});
