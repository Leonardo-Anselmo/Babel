"""Tests for the local Whisper server (no GPU or model needed: the model is faked).

Run: python -m unittest whisper/test_server.py
"""

import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import server  # noqa: E402


def wav_bytes(samples, rate=16000, channels=1):
    import numpy as np

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((np.asarray(samples) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def seg(text, no_speech=0.05, logprob=-0.2, ratio=1.2):
    return SimpleNamespace(text=text, no_speech_prob=no_speech, avg_logprob=logprob, compression_ratio=ratio)


class FakeModel:
    """Stands in for faster_whisper.WhisperModel and records how it was called."""

    def __init__(self, path, **kwargs):
        self.path = path
        self.init_kwargs = kwargs
        self.calls = []
        self.segments = [seg(" Winslow, what's the meta?")]
        self.segments_without_hints = None  # what it hears when no names are hinted (None: the same)

    def transcribe(self, audio, **kwargs):
        self.calls.append((audio, kwargs))
        segments = self.segments
        if kwargs.get("hotwords") is None and self.segments_without_hints is not None:
            segments = self.segments_without_hints
        return iter(segments), SimpleNamespace(duration_after_vad=1.5)


class AudioTests(unittest.TestCase):
    def test_reads_16k_mono(self):
        audio = server.read_wav(wav_bytes([0.0, 0.5, -0.5] * 1000))
        self.assertEqual(len(audio), 3000)
        self.assertAlmostEqual(float(audio[1]), 0.5, places=3)

    def test_resamples_and_mixes_to_16k_mono(self):
        import numpy as np

        stereo = np.zeros(24000 * 2)  # one second of 24 kHz stereo
        audio = server.read_wav(wav_bytes(stereo, rate=24000, channels=2))
        self.assertEqual(len(audio), 16000)

    def test_rejects_non_wav(self):
        with self.assertRaises(ValueError):
            server.read_wav(b"definitely not audio")


class FilterTests(unittest.TestCase):
    def test_normal_speech_is_kept(self):
        self.assertTrue(server.keep_segment(seg("who's the worst player"), "Winslow, Mike"))

    def test_silence_by_whispers_own_measure_is_dropped(self):
        self.assertFalse(server.keep_segment(seg("you", no_speech=0.9, logprob=-1.2), ""))

    def test_repetition_is_dropped(self):
        self.assertFalse(server.keep_segment(seg("ha ha ha ha ha ha ha", ratio=3.1), ""))

    def test_a_clear_call_of_its_name_is_kept(self):
        hints = "Winslow, Mike, Jess"
        self.assertTrue(server.keep_segment(seg("Winslow!"), hints))
        self.assertTrue(server.keep_segment(seg("Winslow, Winslow, Winslow!"), hints))
        self.assertTrue(server.keep_segment(seg("Hey Winslow."), hints))
        # A short call is less certain by one measure only: still kept.
        self.assertTrue(server.keep_segment(seg("Winslow?", no_speech=0.45, logprob=-0.9), hints))

    def test_an_unclear_clip_that_only_echoes_the_names_is_dropped(self):
        hints = "Winslow, Mike, Jess"
        self.assertFalse(server.keep_segment(seg("Winslow.", no_speech=0.55, logprob=-0.9), hints))
        self.assertFalse(server.keep_segment(seg("Thank you, Winslow.", no_speech=0.55, logprob=-0.9), hints))
        # Three names alone isn't thrown away: it's listened to again without the hints
        # (a callout of words it learned, like "Jett, Sova, Reyna", is real).
        self.assertTrue(server.keep_segment(seg("Winslow, Mike, Jess."), hints))

    def test_names_inside_a_real_sentence_are_always_kept(self):
        hints = "Winslow, Mike, Jess"
        self.assertTrue(server.keep_segment(seg("Winslow tell Mike and Jess they suck", no_speech=0.55, logprob=-0.9), hints))

    def test_subtitle_credits_are_hallucinations(self):
        self.assertTrue(server.is_hallucination("Subtitles by the Amara.org community"))
        self.assertTrue(server.is_hallucination("Thanks for watching!"))
        self.assertFalse(server.is_hallucination("thanks for carrying me"))
        self.assertFalse(server.is_hallucination("I told him thanks for watching my stream last night even though he left after five minutes"))


class TranscriberTests(unittest.TestCase):
    def make(self, **kw):
        return server.Transcriber("/models/x", model_factory=FakeModel, **kw)

    def test_loads_on_the_gpu_from_local_files_only(self):
        t = self.make()
        self.assertEqual(t.model.init_kwargs["device"], "cuda")
        self.assertEqual(t.model.init_kwargs["compute_type"], "float16")
        self.assertTrue(t.model.init_kwargs["local_files_only"])

    def test_passes_names_as_hotwords_with_vad_and_english(self):
        t = self.make()
        out = t.transcribe([0.0] * 16000, hotwords="Winslow, Mike")
        kwargs = t.model.calls[-1][1]
        self.assertEqual(kwargs["hotwords"], "Winslow, Mike")
        self.assertTrue(kwargs["vad_filter"])
        self.assertEqual(kwargs["language"], "en")
        self.assertFalse(kwargs["condition_on_previous_text"])
        # One decode, no sampled retries at higher temperatures (random sound-alikes, slower).
        self.assertEqual(kwargs["temperature"], 0.0)
        self.assertEqual(out["text"], "Winslow, what's the meta?")

    def test_hallucinated_credits_come_back_empty(self):
        t = self.make()
        t.model.segments = [seg(" Subtitles by the Amara.org community")]
        self.assertEqual(t.transcribe([0.0] * 16000)["text"], "")

    def test_names_it_only_heard_because_of_the_hints_are_dropped(self):
        t = self.make()
        t.model.segments = [seg(" Weevil, Zomboid")]
        t.model.segments_without_hints = [seg(" Thank you.")]
        self.assertEqual(t.transcribe([0.0] * 16000, hotwords="Winslow, Weevil, Zomboid")["text"], "")
        second = t.model.calls[-1][1]
        self.assertIsNone(second.get("hotwords"), "listened again without the hints")
        self.assertIsNone(second["no_speech_threshold"])
        self.assertTrue(second["vad_filter"])

    def test_a_real_sentence_the_hints_turned_into_names_is_recovered(self):
        t = self.make()
        hints = "Winslow, Weevil, Zomboid"
        t.model.segments = [seg(" Zomboid")]
        t.model.segments_without_hints = [seg(" That's not what it's worth.")]
        self.assertEqual(t.transcribe([0.0] * 16000, hotwords=hints)["text"], "That's not what it's worth.")
        # ...but not when what it hears instead is silence by Whisper's own measure.
        t.model.segments_without_hints = [seg(" Hmm, what was that?", no_speech=0.9, logprob=-1.5)]
        self.assertEqual(t.transcribe([0.0] * 16000, hotwords=hints)["text"], "")

    def test_names_it_hears_on_its_own_are_kept(self):
        t = self.make()
        hints = "Winslow, Weevil, Zomboid"
        # Its own name heard as a look-alike without the hint still counts; a word it
        # learned must be heard as itself ("Zombie?" stays "Zombie?").
        for first, again, want in (("Winslow!", "Winslow!", "Winslow!"), ("Hey Winslow.", "Hey, Wins low.", "Hey Winslow."), ("Zomboid?", "Zomboid?", "Zomboid?"), ("Zomboid?", "Zombie?", "Zombie?")):
            t.model.segments = [seg(f" {first}")]
            t.model.segments_without_hints = [seg(f" {again}")]
            self.assertEqual(t.transcribe([0.0] * 16000, hotwords=hints, wake="Winslow")["text"], want, f"{first} / {again}")

    def test_a_callout_of_learned_words_is_kept_and_an_echo_of_them_is_not(self):
        t = self.make()
        hints = "Winslow, Jett, Sova, Reyna"
        t.model.segments = [seg(" Jett, Sova, Reyna.")]
        t.model.segments_without_hints = [seg(" Jett, Sova, Reyna.")]
        self.assertEqual(t.transcribe([0.0] * 16000, hotwords=hints, wake="Winslow")["text"], "Jett, Sova, Reyna.")
        t.model.segments_without_hints = [seg(" Thank you.", no_speech=0.9, logprob=-1.5)]
        self.assertEqual(t.transcribe([0.0] * 16000, hotwords=hints, wake="Winslow")["text"], "", "only the hints, from noise")

    def test_the_log_shows_words_only_when_asked(self):
        server.SHOW_WORDS.on = False
        self.assertEqual(server.said("Jett, Sova"), "<2 words>")
        server.SHOW_WORDS.on = True
        self.assertEqual(server.said("Jett, Sova"), "'Jett, Sova'")
        server.SHOW_WORDS.on = False

    def test_a_clear_call_of_its_own_name_is_not_second_guessed(self):
        t = self.make()
        # A real call from a live session: Whisper was fairly sure, but heard it as "Wednesday" without the hint.
        t.model.segments = [seg(" Oh, Winslow, you...", no_speech=0.0, logprob=-0.46)]
        t.model.segments_without_hints = [seg(" Oh, Wednesday.")]
        out = t.transcribe([0.0] * 16000, hotwords="Winslow", wake="Winslow")
        self.assertEqual(out["text"], "Oh, Winslow, you...")
        self.assertEqual(len(t.model.calls), 1, "a clear call of its name is trusted as heard")

    def test_an_unsure_call_of_its_name_is_checked_without_the_hint(self):
        t = self.make()
        call = lambda: t.transcribe([0.0] * 16000, hotwords="Winslow", wake="Winslow")["text"]  # noqa: E731
        # Only the hint, and Whisper not sure of it: listened to again without the hint.
        t.model.segments = [seg(" Winslow", no_speech=0.0, logprob=-0.81)]
        t.model.segments_without_hints = [seg(" What are you doing?")]
        self.assertEqual(call(), "What are you doing?", "a clearly different phrase wins: not a call")
        self.assertIsNone(t.model.calls[-1][1].get("hotwords"), "listened again without the hint")
        t.model.segments_without_hints = [seg(" It's the best.")]
        self.assertEqual(call(), "It's the best.")
        # A real but mumbled call is still heard as its name without the hint, so it stays a call.
        t.model.segments = [seg(" Winslow", no_speech=0.0, logprob=-0.99)]
        t.model.segments_without_hints = [seg(" Winslow,")]
        self.assertEqual(call(), "Winslow")

    def test_an_unclear_call_of_its_name_gets_the_benefit_of_the_doubt(self):
        t = self.make()
        # From live calls: real calls Whisper couldn't make out without the hint.
        for again in (" Thank you.", " You.", " Oh, Wednesday.", " Thanks, Vincent.", " Wait.", " Pfff!", ""):
            t.model.segments = [seg(" Winslow", no_speech=0.0, logprob=-1.08)]
            t.model.segments_without_hints = [seg(again)] if again else []
            self.assertEqual(t.transcribe([0.0] * 16000, hotwords="Winslow", wake="Winslow")["text"], "Winslow", repr(again))
        # Other hinted words don't get it: only the bot's own name does.
        t.model.segments = [seg(" Zomboid", no_speech=0.0, logprob=-0.9)]
        t.model.segments_without_hints = [seg(" Thank you.")]
        self.assertEqual(t.transcribe([0.0] * 16000, hotwords="Winslow, Zomboid", wake="Winslow")["text"], "")

    def test_a_very_unsure_call_kept_on_the_benefit_of_the_doubt_is_marked(self):
        t = self.make()
        call = lambda: t.transcribe([0.0] * 16000, hotwords="Babel", wake="Babel")  # noqa: E731
        # From a live call: "Babel" at -1.45 that was "you" without the hint, most often noise.
        t.model.segments = [seg(" Babel", no_speech=0.0, logprob=-1.45)]
        t.model.segments_without_hints = [seg(" you")]
        out = call()
        self.assertEqual(out["text"], "Babel", "still a call: the bot listens, without a reply")
        self.assertTrue(out["unsure_name"])
        # Less unsure: an ordinary call.
        t.model.segments = [seg(" Babel", no_speech=0.0, logprob=-0.9)]
        self.assertNotIn("unsure_name", call())
        # Heard as its name without the hint too: an ordinary call however low the score.
        t.model.segments = [seg(" Babel", no_speech=0.0, logprob=-1.45)]
        t.model.segments_without_hints = [seg(" Babel?")]
        self.assertNotIn("unsure_name", call())
        # Clearly something else: those words, not a call.
        t.model.segments_without_hints = [seg(" Cheers, sir, good game.")]
        out = call()
        self.assertEqual(out["text"], "Cheers, sir, good game.")
        self.assertNotIn("unsure_name", out)
        # A sentence with its name in it is never marked.
        t.model.segments = [seg(" Babel, what time is it?", no_speech=0.0, logprob=-1.45)]
        self.assertNotIn("unsure_name", call())
        # One clear "Babel" in the clip is enough, even next to a mumbled one.
        t.model.segments = [seg(" Babel", no_speech=0.0, logprob=-0.2), seg(" Babel", no_speech=0.0, logprob=-1.4)]
        t.model.segments_without_hints = [seg(" you")]
        out = call()
        self.assertEqual(out["text"], "Babel Babel")
        self.assertNotIn("unsure_name", out)

    def test_real_sentences_are_listened_to_once(self):
        t = self.make()
        t.transcribe([0.0] * 16000, hotwords="Winslow, Mike")
        t.model.segments = [seg(" Zomboid tonight?")]
        t.transcribe([0.0] * 16000, hotwords="Winslow, Zomboid")
        t.model.segments = [seg(" Winslow!")]
        t.transcribe([0.0] * 16000, hotwords="")
        self.assertEqual(len(t.model.calls), 3)


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.t = server.Transcriber("/models/x", model_factory=FakeModel)
        self.state = server.State(self.t, "large-v3", idle_exit=0)
        self.httpd = server.LocalServer(("127.0.0.1", 0), server.make_handler(self.state))
        self.port = self.httpd.server_address[1]
        self.stopped = threading.Event()

        def run():
            server.serve(self.state, self.httpd)
            self.stopped.set()

        threading.Thread(target=run, daemon=True).start()
        time.sleep(0.05)

    def tearDown(self):
        if not self.stopped.is_set():
            self.httpd.shutdown()
        self.stopped.wait(5)

    def request(self, path, data=None, headers=None):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=data, headers={"Content-Type": "audio/wav", **(headers or {})}
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status, json.load(res)
        except urllib.error.HTTPError as err:
            return err.code, json.load(err)

    def test_health_reports_the_settings_it_runs_with(self):
        code, body = self.request("/health")
        self.assertEqual(code, 200)
        self.assertEqual(body["model"], "large-v3")
        self.assertEqual(body["device"], "cuda")
        self.assertEqual(body["compute_type"], "float16")
        self.assertEqual(body["beam_size"], 5)
        self.assertEqual(body["language"], "en")
        # Which version of server.py is running, so the bot can replace an outdated copy.
        self.assertEqual(body["code"], server.code_fingerprint(server.__file__))
        self.assertRegex(body["code"], r"^[0-9a-f]{12}$")

    def test_web_pages_and_other_hosts_are_turned_away(self):
        code, _ = self.request("/transcribe", wav_bytes([0.1] * 1600), {"Origin": "https://evil.example"})
        self.assertEqual(code, 403)
        code, _ = self.request("/health", None, {"Host": "attacker.example:80"})
        self.assertEqual(code, 403)
        self.assertEqual(self.t.model.calls, [])

    def test_only_wav_uploads_are_accepted(self):
        code, _ = self.request("/transcribe", b"hello", {"Content-Type": "text/plain"})
        self.assertEqual(code, 415)

    def test_shutdown_endpoint_stops_it(self):
        code, _ = self.request("/shutdown", b"")
        self.assertEqual(code, 200)
        self.assertTrue(self.stopped.wait(5))

    def test_transcribe(self):
        code, body = self.request("/transcribe?language=en&hotwords=Winslow%2C%20Mike", wav_bytes([0.1] * 16000))
        self.assertEqual(code, 200)
        self.assertEqual(body["text"], "Winslow, what's the meta?")
        self.assertEqual(self.t.model.calls[-1][1]["hotwords"], "Winslow, Mike")
        self.assertEqual(self.state.requests, 1)

    def test_its_name_alone_comes_back_without_a_second_listen(self):
        self.t.model.segments = [seg(" Winslow!", logprob=-0.11)]
        self.t.model.segments_without_hints = [seg(" Wait.")]
        code, body = self.request("/transcribe?hotwords=Winslow&wake=Winslow", wav_bytes([0.1] * 16000))
        self.assertEqual(code, 200)
        self.assertEqual(body["text"], "Winslow!")
        self.assertEqual(len(self.t.model.calls), 1)
        self.assertNotIn("unsure_name", body)

    def test_a_very_unsure_call_of_its_name_says_so(self):
        self.t.model.segments = [seg(" Winslow", logprob=-1.4)]
        self.t.model.segments_without_hints = [seg(" Okay.")]
        code, body = self.request("/transcribe?hotwords=Winslow&wake=Winslow", wav_bytes([0.1] * 16000))
        self.assertEqual(code, 200)
        self.assertEqual(body["text"], "Winslow")
        self.assertIs(body["unsure_name"], True)

    def test_bad_audio_is_a_400_not_a_crash(self):
        code, body = self.request("/transcribe", b"garbage")
        self.assertEqual(code, 400)
        self.assertIn("WAV", body["error"])

    def test_model_failure_is_reported(self):
        def boom(audio, **kw):
            raise RuntimeError("CUDA failed with error out of memory")

        self.t.model.transcribe = boom
        code, body = self.request("/transcribe", wav_bytes([0.1] * 1600))
        self.assertEqual(code, 500)
        self.assertIn("out of memory", body["error"])
        self.assertEqual(self.state.errors, 1)
        self.assertFalse(self.stopped.is_set(), "one failure is not enough to restart")

    def test_repeated_failures_make_it_exit_so_the_bot_restarts_a_fresh_copy(self):
        def boom(audio, **kw):
            raise RuntimeError("CUDA failed with error unspecified launch failure")

        self.t.model.transcribe = boom
        for _ in range(3):
            self.request("/transcribe", wav_bytes([0.1] * 1600))
        self.assertTrue(self.stopped.wait(5))

    def test_a_success_resets_the_failure_count(self):
        real = self.t.model.transcribe
        fail = {"on": True}

        def flaky(audio, **kw):
            if fail["on"]:
                raise RuntimeError("hiccup")
            return real(audio, **kw)

        self.t.model.transcribe = flaky
        self.request("/transcribe", wav_bytes([0.1] * 1600))
        self.request("/transcribe", wav_bytes([0.1] * 1600))
        fail["on"] = False
        self.assertEqual(self.request("/transcribe", wav_bytes([0.1] * 1600))[0], 200)
        fail["on"] = True
        self.request("/transcribe", wav_bytes([0.1] * 1600))
        self.request("/transcribe", wav_bytes([0.1] * 1600))
        self.assertFalse(self.stopped.is_set())


    def test_the_apps_status_check_does_not_keep_it_awake(self):
        self.state.last_seen = 100.0
        code, body = self.request("/health?peek=1")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(self.state.last_seen, 100.0, "a peek doesn't count as using it")
        self.request("/health")
        self.assertGreater(self.state.last_seen, 100.0, "the bot's own check does")

    def test_a_stuck_transcription_shows_in_health(self):
        self.state.running[99] = time.time() - 12
        code, body = self.request("/health?peek=1")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"], "still alive: a second copy couldn't take the port anyway")
        self.assertGreater(body["busy_s"], 11)
        self.state.running.clear()
        self.assertEqual(self.request("/health?peek=1")[1]["busy_s"], 0)


class StuckExitTests(unittest.TestCase):
    def test_exits_when_a_transcription_never_finishes(self):
        t = server.Transcriber("/models/x", model_factory=FakeModel)
        state = server.State(t, "large-v3", idle_exit=0)
        state.stuck_exit_s = 1
        httpd = server.LocalServer(("127.0.0.1", 0), server.make_handler(state))
        exited = threading.Event()
        codes = []

        def fake_exit(code):
            codes.append(code)
            exited.set()

        threading.Thread(target=lambda: server.serve(state, httpd, hard_exit=fake_exit), daemon=True).start()
        try:
            state.begin()  # a transcription that never ends
            self.assertTrue(exited.wait(8), "it should give up on a hung transcription")
            self.assertEqual(codes, [3])
        finally:
            httpd.shutdown()


class IdleExitTests(unittest.TestCase):
    def test_shuts_down_when_nobody_uses_it(self):
        t = server.Transcriber("/models/x", model_factory=FakeModel)
        state = server.State(t, "large-v3", idle_exit=1)
        state.last_seen = time.time() - 10
        done = threading.Event()

        httpd = server.LocalServer(("127.0.0.1", 0), server.make_handler(state))

        def run():
            server.serve(state, httpd)
            done.set()

        threading.Thread(target=run, daemon=True).start()
        self.assertTrue(done.wait(12), "server kept running while idle")


class DownloadTests(unittest.TestCase):
    """A fake Hugging Face: a tree listing plus files that support resumed (Range) downloads."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.blob = os.urandom(300_000)
        self.blob_sha = hashlib.sha256(self.blob).hexdigest()
        self.config = b'{"alignment_heads": []}'
        self.range_requests = []
        test = self

        class HF(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.path.startswith("/api/models/acme/whisper/tree/main"):
                    tree = [
                        {"type": "file", "path": "model.bin", "size": len(test.blob), "lfs": {"oid": test.blob_sha, "size": len(test.blob)}},
                        {"type": "file", "path": "config.json", "size": len(test.config)},
                        {"type": "file", "path": "README.md", "size": 10},
                        {"type": "directory", "path": "extras"},
                    ]
                    body = json.dumps(tree).encode()
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if self.path == "/acme/whisper/resolve/main/model.bin":
                    start = 0
                    rng = self.headers.get("Range")
                    if rng:
                        test.range_requests.append(rng)
                        start = int(rng.split("=")[1].split("-")[0])
                        if start >= len(test.blob):
                            self.send_response(416)
                            self.end_headers()
                            return
                        self.send_response(206)
                    else:
                        self.send_response(200)
                    self.send_header("Content-Length", str(len(test.blob) - start))
                    self.end_headers()
                    self.wfile.write(test.blob[start:])
                    return
                if self.path == "/acme/whisper/resolve/main/config.json":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(test.config)
                    return
                self.send_response(404)
                self.end_headers()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), HF)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_downloads_only_model_files_and_checks_them(self):
        lines = []
        dest = server.download_model("acme/whisper", self.tmp, base=self.base, report=lines.append)
        self.assertEqual(sorted(os.listdir(dest)), ["config.json", "model.bin"])
        with open(os.path.join(dest, "model.bin"), "rb") as f:
            self.assertEqual(f.read(), self.blob)
        self.assertTrue(server.model_ready(dest))

    def test_resumes_a_partial_download(self):
        dest = server.model_dir(self.tmp, "acme/whisper")
        os.makedirs(dest)
        with open(os.path.join(dest, "model.bin.part"), "wb") as f:
            f.write(self.blob[:100_000])
        server.download_model("acme/whisper", self.tmp, base=self.base, report=lambda m: None)
        self.assertEqual(self.range_requests, ["bytes=100000-"])
        with open(os.path.join(dest, "model.bin"), "rb") as f:
            self.assertEqual(f.read(), self.blob)

    def test_a_corrupt_download_is_rejected(self):
        self.blob_sha = "0" * 64  # published hash no longer matches what is served
        with self.assertRaises(RuntimeError):
            server.download_model("acme/whisper", self.tmp, base=self.base, report=lambda m: None)
        self.assertFalse(os.path.exists(os.path.join(server.model_dir(self.tmp, "acme/whisper"), "model.bin")))

    def test_a_complete_part_file_is_just_checked_not_fetched(self):
        dest = server.model_dir(self.tmp, "acme/whisper")
        os.makedirs(dest)
        with open(os.path.join(dest, "model.bin.part"), "wb") as f:
            f.write(self.blob)  # setup was closed while it was checking this
        server.download_model("acme/whisper", self.tmp, base=self.base, report=lambda m: None)
        self.assertEqual(self.range_requests, [])
        with open(os.path.join(dest, "model.bin"), "rb") as f:
            self.assertEqual(f.read(), self.blob)

    def test_a_damaged_finished_file_is_replaced(self):
        dest = server.model_dir(self.tmp, "acme/whisper")
        os.makedirs(dest)
        with open(os.path.join(dest, "model.bin"), "wb") as f:
            f.write(b"x" * len(self.blob))
        server.download_model("acme/whisper", self.tmp, base=self.base, report=lambda m: None)
        with open(os.path.join(dest, "model.bin"), "rb") as f:
            self.assertEqual(f.read(), self.blob)
        self.assertEqual([n for n in os.listdir(dest) if n.startswith("model.bin")], ["model.bin"])

    def test_already_downloaded_files_are_not_fetched_again(self):
        server.download_model("acme/whisper", self.tmp, base=self.base, report=lambda m: None)
        lines = []
        server.download_model("acme/whisper", self.tmp, base=self.base, report=lines.append)
        self.assertTrue(any("already downloaded" in line for line in lines))


class FakeTurn:
    def __init__(self, score):
        self.score = score
        self.calls = 0

    def complete(self, audio):
        self.calls += 1
        if isinstance(self.score, Exception):
            raise self.score
        return self.score


class FakeWake:
    name = "winslow"

    def __init__(self, score):
        self.value = score
        self.calls = []

    def score(self, audio, last_seconds=None):
        self.calls.append(last_seconds)
        return self.value


class ExtrasTests(unittest.TestCase):
    """The small models next to Whisper: end-of-turn and the name detector."""

    def test_log_mel_features_have_smart_turns_shape(self):
        import numpy as np

        t = np.arange(16000 * 3) / 16000
        mel = server.whisper_log_mel(0.3 * np.sin(2 * np.pi * 440 * t))
        self.assertEqual(mel.shape, (80, 800))
        self.assertEqual(mel.dtype, np.float32)
        self.assertLessEqual(float(mel.max()), 2.0)
        self.assertGreaterEqual(float(mel.min()), float(mel.max()) - 2.0 - 1e-6, "clamped to 8 below the peak, then scaled")

    def test_nothing_loads_without_the_files_and_the_server_says_so(self):
        tmp = tempfile.mkdtemp()
        try:
            extras = server.Extras.load(None, extras_dir=tmp)
            self.assertEqual(extras.describe(), {"turn": False, "wake": None, "wake_model": None})
            extras = server.Extras.load(os.path.join(tmp, "winslow.onnx"), extras_dir=tmp)
            self.assertIsNone(extras.wake, "a missing name detector is not an error")
            # It still says which one it was asked for, so the bot doesn't restart it over a bad file.
            self.assertEqual(extras.describe(), {"turn": False, "wake": None, "wake_model": "winslow"})
            with open(os.path.join(tmp, "broken.onnx"), "wb") as f:
                f.write(b"not a model")
            extras = server.Extras.load(os.path.join(tmp, "broken.onnx"), extras_dir=tmp)
            self.assertEqual(extras.describe()["wake_model"], "broken")
            self.assertIsNone(extras.wake)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_the_real_end_of_turn_model_runs_on_the_processor(self):
        path = os.path.join(server.EXTRAS_DIR, server.SMART_TURN_FILE)
        try:
            import numpy as np
            import onnxruntime  # noqa: F401
        except ImportError:
            self.skipTest("numpy and onnxruntime are not installed here")
        if not os.path.isfile(path):
            self.skipTest("no end-of-turn model in whisper/extras")
        turn = server.TurnDetector(path)
        t = np.arange(16000 * 2) / 16000
        for audio in (np.zeros(16000, np.float32), (0.2 * np.sin(2 * np.pi * 200 * t)).astype(np.float32), np.zeros(16000 * 12, np.float32)):
            p = turn.complete(audio)
            self.assertGreaterEqual(p, 0.0)
            self.assertLessEqual(p, 1.0)

    def test_a_name_detector_model_scores_a_clip(self):
        # Any livekit-wakeword/openWakeWord classifier will do (WAKE_TEST_MODEL), or the bot's own.
        model = os.environ.get("WAKE_TEST_MODEL") or next(
            (os.path.join(server.EXTRAS_DIR, f) for f in sorted(os.listdir(server.EXTRAS_DIR)) if f.endswith(".onnx") and f not in (server.SMART_TURN_FILE, *server.WAKE_FRONTEND_FILES)),
            None,
        )
        try:
            import numpy as np
            import onnxruntime  # noqa: F401
        except ImportError:
            self.skipTest("numpy and onnxruntime are not installed here")
        if not model or not os.path.isfile(model):
            self.skipTest("no name detector model to try")
        wake = server.WakeWord(model)
        t = np.arange(16000 * 3) / 16000
        for audio in (np.zeros(800, np.float32), (0.1 * np.sin(2 * np.pi * 300 * t)).astype(np.float32)):
            s = wake.score(audio)
            self.assertGreaterEqual(s, 0.0)
            self.assertLessEqual(s, 1.0)
        self.assertGreaterEqual(wake.score(np.zeros(16000 * 10, np.float32), last_seconds=2.5), 0.0)

    def test_the_name_detector_hears_16_bit_samples_over_a_quiet_floor_never_digital_silence(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("numpy is not installed here")
        seen = []

        class Mel:
            def run(self, _, feeds):
                seen.append(feeds["x"].copy())
                return [np.zeros((1, 1, (feeds["x"].shape[1] - 400) // 160 + 1, 32), np.float32)]

        class Embedding:
            def run(self, _, feeds):
                return [np.zeros((len(feeds["x"]), 1, 1, 96), np.float32)]

        class Classifier:
            def run(self, _, feeds):
                return [np.full((feeds["x"].shape[0], 1), 0.25, np.float32)]

        wake = server.WakeWord.__new__(server.WakeWord)
        wake.mel, wake.embedding, wake.classifier = Mel(), Embedding(), Classifier()
        wake.mel_input = wake.embedding_input = wake.classifier_input = "x"
        wake.batched = None
        clip = np.zeros(16000, np.float32)
        clip[8000:8100] = 0.5
        self.assertAlmostEqual(wake.score(clip), 0.25)
        x = seen[0][0]
        self.assertEqual(len(x), 2 * 16000 + 16000 + 16000 // 3, "2 s before the clip and a third of a second after")
        self.assertFalse(np.any(x == 0), "no exact digital silence reaches the model")
        floor_db = 20 * np.log10(np.sqrt(np.mean(x[:32000] ** 2)) / 32768)
        self.assertAlmostEqual(floor_db, server.WakeWord.FLOOR_DBFS, delta=1)
        self.assertAlmostEqual(x[32000 + 8050] / 32768, 0.5, delta=0.01, msg="the clip itself, as 16-bit sample values")
        wake.score(clip)
        self.assertTrue(np.array_equal(seen[0], seen[1]), "the same clip always gets the same score")

    def test_an_unsure_call_of_its_name_the_detector_heard_is_kept_without_a_second_listen(self):
        t = server.Transcriber("/models/x", model_factory=FakeModel)
        t.model.segments = [seg(" Winslow", no_speech=0.0, logprob=-0.81)]
        t.model.segments_without_hints = [seg(" What are you doing?")]
        out = t.transcribe([0.0] * 16000, hotwords="Winslow", wake="Winslow", wake_score=lambda: 0.62)
        self.assertEqual(out["text"], "Winslow")
        self.assertEqual(len(t.model.calls), 1)
        # (However unsure Whisper was: the detector heard it.)
        t.model.segments = [seg(" Winslow", no_speech=0.0, logprob=-1.4)]
        t.model.segments_without_hints = [seg(" You.")]
        self.assertNotIn("unsure_name", t.transcribe([0.0] * 16000, hotwords="Winslow", wake="Winslow", wake_score=lambda: 0.62))
        t.model.segments = [seg(" Winslow", no_speech=0.0, logprob=-0.81)]
        t.model.segments_without_hints = [seg(" What are you doing?")]
        out = t.transcribe([0.0] * 16000, hotwords="Winslow", wake="Winslow", wake_score=lambda: 0.1)
        self.assertEqual(out["text"], "What are you doing?", "the detector did not hear it: listened to again")
        # A clear call never waits for the detector.
        t.model.segments = [seg(" Winslow!", no_speech=0.0, logprob=-0.2)]
        asked = []
        t.transcribe([0.0] * 16000, hotwords="Winslow", wake="Winslow", wake_score=lambda: asked.append(1) or 0.9)
        self.assertEqual(asked, [])


class TurnEndpointTests(unittest.TestCase):
    def setUp(self):
        self.t = server.Transcriber("/models/x", model_factory=FakeModel)
        self.state = server.State(self.t, "large-v3", idle_exit=0)
        self.httpd = server.LocalServer(("127.0.0.1", 0), server.make_handler(self.state))
        self.port = self.httpd.server_address[1]
        threading.Thread(target=lambda: server.serve(self.state, self.httpd), daemon=True).start()
        time.sleep(0.05)

    def tearDown(self):
        self.httpd.shutdown()

    request = ServerTests.request

    def test_health_says_which_extras_it_has(self):
        self.state.extras = server.Extras(turn=FakeTurn(0.5), wake=FakeWake(0.1))
        _, body = self.request("/health")
        self.assertEqual((body["turn"], body["wake"]), (True, "winslow"))

    def test_turn_answers_whether_they_are_done_and_whether_the_name_was_said(self):
        turn, wake = FakeTurn(0.8312), FakeWake(0.9171)
        self.state.extras = server.Extras(turn=turn, wake=wake)
        code, body = self.request("/turn?turn=1&wake=1&seconds=2.5", wav_bytes([0.1] * 16000))
        self.assertEqual(code, 200)
        self.assertEqual((body["complete"], body["wake"]), (0.831, 0.917))
        self.assertEqual(wake.calls, [2.5], "only the last few seconds")
        self.assertIn("ms", body)
        code, body = self.request("/turn?turn=0&wake=1", wav_bytes([0.1] * 1600))
        self.assertEqual((body["complete"], body["wake"]), (None, 0.917))
        self.assertEqual(turn.calls, 1, "turn=0 skips the end-of-turn model")
        self.assertEqual(self.t.model.calls, [], "Whisper itself is not used")

    def test_turn_without_extras_answers_nothing_rather_than_failing(self):
        code, body = self.request("/turn?turn=1&wake=1", wav_bytes([0.1] * 1600))
        self.assertEqual(code, 200)
        self.assertEqual((body["complete"], body["wake"]), (None, None))

    def test_turn_failures_and_bad_audio_are_reported(self):
        self.state.extras = server.Extras(turn=FakeTurn(RuntimeError("bad model")))
        code, body = self.request("/turn", wav_bytes([0.1] * 1600))
        self.assertEqual(code, 500)
        self.assertIn("bad model", body["error"])
        code, _ = self.request("/turn", b"garbage")
        self.assertEqual(code, 400)

    def test_transcribe_adds_the_name_detector_score(self):
        self.state.extras = server.Extras(wake=FakeWake(0.7712))
        code, body = self.request("/transcribe?hotwords=Winslow&wake=Winslow", wav_bytes([0.1] * 16000))
        self.assertEqual(code, 200)
        self.assertEqual(body["wake"], 0.771)
        self.state.extras = server.Extras()
        _, body = self.request("/transcribe", wav_bytes([0.1] * 16000))
        self.assertNotIn("wake", body)


class CliTests(unittest.TestCase):
    def test_missing_model_says_to_run_setup(self):
        tmp = tempfile.mkdtemp()
        try:
            self.assertEqual(server.main(["--home", tmp, "--model", "large-v3"]), 2)
            self.assertEqual(server.main(["--home", tmp, "--model", "large-v3", "--wake-model", os.path.join(tmp, "winslow.onnx")]), 2)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
