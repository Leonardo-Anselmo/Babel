#!/usr/bin/env python3
"""Free speech-to-text for the bot: Whisper running on your own NVIDIA graphics card.

The bot sends each finished sentence (a short WAV clip) to this small server on
127.0.0.1 and gets the words back. Nothing leaves your PC. Uses faster-whisper
(the same Whisper model, made faster with CTranslate2).

    python server.py                    run the server (the bot starts it for you)
    python server.py --download         download the model (setup-whisper.bat does this)
    python server.py --self-test x.wav  load the model on the GPU and transcribe a file

The model, Python and the NVIDIA libraries live outside the bot folder (by default
in %LOCALAPPDATA%\\WinslowWhisper), so OneDrive never syncs gigabytes of them.
"""

import argparse
import ctypes
import difflib
import glob
import hashlib
import io
import json
import os
import re
import site
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8178
SAMPLE_RATE = 16000
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # about 5 minutes of 16 kHz audio; the bot sends seconds
# Speech detection, the same for the first listen and the double check of names-only clips.
VAD_PARAMETERS = {"threshold": 0.45, "min_silence_duration_ms": 500}

# Converted Whisper models on Hugging Face (CTranslate2 format).
MODEL_REPOS = {
    "large-v3": "Systran/faster-whisper-large-v3",
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "distil-large-v3.5": "distil-whisper/distil-large-v3.5-ct2",
    "medium.en": "Systran/faster-whisper-medium.en",
    "small.en": "Systran/faster-whisper-small.en",
    "base.en": "Systran/faster-whisper-base.en",
    "tiny.en": "Systran/faster-whisper-tiny.en",
}
MODEL_FILE_PATTERNS = ("config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.")
HF_BASE = "https://huggingface.co"

# Things Whisper is known to invent from silence, music or noise (it learned them
# from video subtitles). A clip that comes back as one of these is treated as empty.
HALLUCINATION_MARKERS = (
    "amara.org",
    "subtitles by",
    "subtitled by",
    "captions by",
    "transcribed by",
    "transcript by",
    "translated by",
    "thanks for watching",
    "thank you for watching",
    "thanks for listening",
    "please subscribe",
    "like and subscribe",
    "don't forget to subscribe",
    "see you in the next video",
    "www.",
)


LOG_FILE = None  # set by --log: the bot starts this with no console, so it logs to a file


def code_fingerprint(path=__file__):
    """Identifies this version of the server, so the bot can tell an outdated copy is still running."""
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()[:12]
    except OSError:
        return ""


CODE = code_fingerprint()


# Whether this request's words may go in the log (the bot sends log_text=1 only when
# LOG_TRANSCRIPTS is on). Otherwise a clip is logged as how many words it had.
SHOW_WORDS = threading.local()


def said(text):
    return repr(text) if getattr(SHOW_WORDS, "on", False) else f"<{len(words(text or ''))} words>"


def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    if LOG_FILE:
        try:
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass
    if sys.stdout is not None:
        print(line, flush=True)


def default_home():
    for name in ("WHISPER_HOME", "WINSLOW_WHISPER_HOME"):
        if os.environ.get(name):
            return os.environ[name]
    if os.environ.get("LOCALAPPDATA"):
        return os.path.join(os.environ["LOCALAPPDATA"], "WinslowWhisper")
    return os.path.join(os.path.expanduser("~"), ".local", "share", "winslow-whisper")


def model_dir(home, model):
    return os.path.join(home, "models", re.sub(r"[^A-Za-z0-9._-]", "_", model))


# ---------------------------------------------------------------------------
# NVIDIA libraries on Windows
# ---------------------------------------------------------------------------


def add_cuda_dlls():
    """Makes the pip-installed cuBLAS DLLs findable before CTranslate2 loads.

    CTranslate2 loads cublas64_12.dll by name at runtime, so the folder goes on PATH,
    is registered as a DLL directory, and the DLLs are loaded up front by full path.
    """
    if os.name != "nt":
        return []
    roots = list(site.getsitepackages())
    try:
        roots.append(site.getusersitepackages())
    except Exception:
        pass
    dirs = []
    for root in roots:
        dirs.extend(sorted(glob.glob(os.path.join(root, "nvidia", "*", "bin"))))
    for d in dirs:
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
        try:
            os.add_dll_directory(d)
        except (OSError, AttributeError):
            pass
    for name in ("cublasLt64_12.dll", "cublas64_12.dll"):
        for d in dirs:
            p = os.path.join(d, name)
            if os.path.exists(p):
                try:
                    ctypes.WinDLL(p)
                except OSError as err:
                    log(f"could not load {p}: {err}")
                break
    return dirs


def gpu_name():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Audio and text
# ---------------------------------------------------------------------------


def read_wav(data):
    """16-bit PCM WAV bytes -> mono float32 samples at 16 kHz."""
    import numpy as np

    try:
        with wave.open(io.BytesIO(data)) as w:
            if w.getsampwidth() != 2:
                raise ValueError("expected 16-bit PCM WAV")
            rate, channels = w.getframerate(), w.getnchannels()
            frames = w.readframes(w.getnframes())
    except (wave.Error, EOFError) as err:
        raise ValueError(f"not a WAV file ({err!r})") from err
    audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio[: len(audio) // channels * channels].reshape(-1, channels).mean(axis=1)
    if rate != SAMPLE_RATE and len(audio):
        n = max(1, int(round(len(audio) * SAMPLE_RATE / rate)))
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    return audio


def words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def is_hallucination(text):
    """A short output built around a phrase Whisper invents (a real long sentence is kept)."""
    t = text.lower()
    return len(words(text)) <= 12 and any(marker in t for marker in HALLUCINATION_MARKERS)


# Small words that don't count as real content next to a name ("hey Winslow", "thank you, Winslow").
FILLER_WORDS = {"hey", "hi", "hello", "yo", "oh", "um", "uh", "so", "okay", "ok", "yeah", "thank", "thanks", "you", "bye", "the", "a"}


def names_only(text, hotwords):
    """The hinted names a clip consists of (besides filler words), or an empty set if it has other content."""
    hint_words = set(words(hotwords or ""))
    distinct = set(words(text))
    names = distinct & hint_words
    if not names or distinct - hint_words - FILLER_WORDS:
        return set()
    return names


def similar(a, b):
    """Close enough for the same word heard twice ("Zomboid" and "zombie", "Winslow" and "wins")."""
    return a == b or difflib.SequenceMatcher(None, a, b).ratio() >= 0.7


# How sure Whisper must be of a clip that is only the bot's name to take it at its
# word. The name is given to Whisper as a hint, and on noise or unclear speech it
# sometimes answers with just the hint. Clear calls score above this; a less sure
# one is listened to again without the hint (see Transcriber.listen_without_hints).
# Real calls from some mics score as low as the phantom ones (-0.6 to -1.1), so
# the score alone never throws a call away.
WAKE_SURE_LOGPROB = -0.5
# A call kept only on the benefit of the doubt (see listen_without_hints) that Whisper
# was this unsure of is marked unsure_name: the bot listens without its "Yeah?". In live
# calls most of these were noise ("Babel" at -1.2 to -1.5 that was "you" or "Okay."
# without the hint), and a real one is still answered when the person goes on.
WAKE_DOUBT_LOGPROB = -1.0


def keep_segment(seg, hotwords):
    """Whisper's own 'this was silence' rule, plus a guard against echoing the name hints.

    Names are given to Whisper as hints so it spells them right, but on an unclear
    clip it can answer with just the hints, which would wake the bot by accident.
    So a clip that is only names (and filler words) must not look like silence by
    both of Whisper's measures. A clear "Winslow!" is always kept. (A clip made only
    of names is also listened to again without the hints, which is how a callout of
    several names it learned, like "Jett, Sova, Reyna", is told from an echo of the
    hints: see Transcriber.listen_without_hints.)
    """
    if seg.no_speech_prob > 0.6 and seg.avg_logprob < -1.0:
        return False
    if seg.compression_ratio > 2.4:  # stuck repeating itself
        return False
    names = names_only(seg.text, hotwords)
    if not names:
        return True  # no names, or real content beyond names
    keep = not (seg.no_speech_prob > 0.5 and seg.avg_logprob < -0.8)
    log(f"name-only clip {said(seg.text.strip())}: no_speech={seg.no_speech_prob:.2f} logprob={seg.avg_logprob:.2f} {'kept' if keep else 'dropped'}")
    return keep


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------


class Transcriber:
    def __init__(self, path, device="cuda", compute_type="float16", workers=2, beam_size=5, language="en", model_factory=None):
        self.path = path
        self.device = device
        self.compute_type = compute_type
        self.beam_size = beam_size
        self.language = language
        if model_factory is None:
            add_cuda_dlls()
            from faster_whisper import WhisperModel

            model_factory = WhisperModel
        self.model = model_factory(path, device=device, compute_type=compute_type, num_workers=workers, local_files_only=True)

    def warm_up(self):
        import numpy as np

        # A pass over a second of quiet audio (and one through the voice detector), so
        # the first real sentence isn't slow.
        silence = np.zeros(SAMPLE_RATE, dtype=np.float32)
        list(self.model.transcribe(silence, language=self.language, beam_size=1, vad_filter=False)[0])
        list(self.model.transcribe(silence, language=self.language, beam_size=1, vad_filter=True)[0])

    def transcribe(self, audio, hotwords=None, language=None, wake=None, wake_score=None):
        """wake_score: a function returning the name detector's score for this clip (or None)."""
        segments, info = self.model.transcribe(
            audio,
            language=language or self.language,
            beam_size=self.beam_size,
            vad_filter=True,
            vad_parameters=VAD_PARAMETERS,
            condition_on_previous_text=False,
            without_timestamps=True,
            # No retries at higher temperatures: on an unclear clip they sample random
            # guesses (a sound-alike of its name instead of the name), and take longer.
            temperature=0.0,
            hotwords=hotwords or None,
        )
        kept = [s for s in segments if keep_segment(s, hotwords)]
        text = " ".join(s.text.strip() for s in kept).strip()
        if text and is_hallucination(text):
            text = ""
        wake_words = set(words(wake or ""))
        names = names_only(text, hotwords) if text else set()
        unsure_name = False
        if names:
            # A clear call of the bot's own name is trusted as heard: ignoring a real
            # "Winslow!" is worse than the odd false start. Any other clip made only of
            # hinted names, or a call Whisper wasn't sure of, is listened to again.
            is_wake = bool(names & wake_words)
            lowest = min(s.avg_logprob for s in kept)
            sure = lowest >= WAKE_SURE_LOGPROB
            heard = wake_score() if (is_wake and not sure and wake_score) else None
            if heard is not None and heard >= WAKE_TRUST_SCORE:
                # The name detector heard it too: no need to listen again.
                log(f"name-only clip {said(text)}: name detector {heard:.2f} -> kept")
            elif not (is_wake and sure):
                if heard is not None:
                    log(f"name-only clip {said(text)}: name detector {heard:.2f}, listening again without the hint")
                text, doubt = self.listen_without_hints(audio, names, text, language, wake=is_wake, wake_words=wake_words)
                # (Unsure of every part of it: one clear "Winslow" in the clip is enough.)
                best = max(s.avg_logprob for s in kept)
                unsure_name = doubt and best < WAKE_DOUBT_LOGPROB
                if unsure_name:
                    log(f"name-only clip {said(text)}: unsure ({best:.2f}), so the bot listens without answering")
        elif text and wake_words:
            # Its name inside a longer sentence: how sure Whisper was (not the words), to tune the above.
            for s in kept:
                if any(re.sub(r"'?s$", "", w) in wake_words or w in wake_words for w in words(s.text)):
                    detector = wake_score() if wake_score else None
                    log(
                        f"name in a longer clip: no_speech={s.no_speech_prob:.2f} logprob={s.avg_logprob:.2f}"
                        + (f" detector={detector:.2f}" if detector is not None else "")
                    )
        result = {
            "text": text,
            "segments": len(kept),
            "speech_seconds": round(getattr(info, "duration_after_vad", 0) or 0, 2),
        }
        if unsure_name:
            result["unsure_name"] = True
        return result

    def listen_without_hints(self, audio, names, text, language=None, wake=False, wake_words=frozenset()):
        """Listens to a names-only clip again, without the name hints. Returns what was said,
        and whether the bot's name was kept only on the benefit of the doubt (below).

        On noise, or even on a real sentence, Whisper sometimes answers with the
        hints themselves ("Weevil, Zomboid" for "That's not what it's worth").
        If it hears one of those names on its own, the names were really said and
        are kept. If not, what it hears without hints is used instead when it's
        real speech, and otherwise the clip is dropped.

        The bot's own name (wake) gets the benefit of the doubt: without the hint,
        Whisper often can't make out a real but unclear "Winslow" and answers with
        its stock filler ("Thank you.", "You."), or a sound-alike ("Wednesday",
        "Vincent"). Missing a real call is worse than an odd "Yeah?", so the call
        only loses when Whisper clearly heard a different phrase instead (two or
        more real words, like "What are you doing?").
        """
        segments, _ = self.model.transcribe(
            audio,
            language=language or self.language,
            beam_size=self.beam_size,
            vad_filter=True,
            vad_parameters=VAD_PARAMETERS,
            condition_on_previous_text=False,
            without_timestamps=True,
            temperature=0.0,
            no_speech_threshold=None,  # just the words, even if it sounds like silence
        )
        segments = list(segments)
        heard = " ".join(s.text.strip() for s in segments).strip()
        scores = (
            f"logprob={min(s.avg_logprob for s in segments):.2f} no_speech={max(s.no_speech_prob for s in segments):.2f}"
            if segments
            else "nothing"
        )
        # Its own name may come back as a look-alike; a word it learned must come back as
        # itself ("zombie" doesn't confirm "Zomboid": it was learned from its look-alike).
        def same(name, word):
            return similar(name, word) if name in wake_words else name == re.sub(r"'?s$", "", word)

        if any(same(name, word) for name in names for word in words(heard)):
            log(f"name-only clip {said(text)} without hints: {said(heard)} ({scores}) -> kept")
            return text, False
        # Whisper's usual silence and repetition rules apply to what it heard instead.
        real = " ".join(s.text.strip() for s in segments if keep_segment(s, None)).strip()
        content = set(words(real)) - FILLER_WORDS if real and not is_hallucination(real) else set()
        if wake and len(content) < 2:
            log(f"name-only clip {said(text)} without hints: {said(heard)} ({scores}) -> kept, nothing clearly different")
            return text, True
        if content:
            log(f"name-only clip {said(text)} without hints: {said(heard)} ({scores}) -> used that instead")
            return real, False
        log(f"name-only clip {said(text)} without hints: {said(heard)} ({scores}) -> dropped")
        return "", False


# ---------------------------------------------------------------------------
# Extras on the processor: is the speaker done (Smart Turn), was the bot's name
# said (its own wake word model). Both are small and optional: without their
# files the server works as before.
# ---------------------------------------------------------------------------


EXTRAS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extras")
SMART_TURN_FILE = "smart-turn-v3.2-cpu.onnx"
WAKE_FRONTEND_FILES = ("melspectrogram.onnx", "embedding_model.onnx")
# A clip that is only the bot's name, and that Whisper wasn't sure of, is trusted
# without a second listen when the name detector scores it at least this high.
WAKE_TRUST_SCORE = 0.5


def cpu_session(path):
    """An onnxruntime session on one processor thread (these models are tiny)."""
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.inter_op_num_threads = 1
    so.intra_op_num_threads = 1
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    try:
        so.add_session_config_entry("mlas.disable_kleidiai", "1")  # wrong results on some ARM builds
    except Exception:
        pass
    return ort.InferenceSession(path, sess_options=so, providers=["CPUExecutionProvider"])


def _mel_filters_slaney(n_bins=201, n_mels=80, sample_rate=SAMPLE_RATE):
    """Slaney-scale triangular mel filters, as Whisper's feature extractor makes them."""
    import numpy as np

    def hz_to_mel(f):
        f = np.atleast_1d(np.asarray(f, dtype=np.float64))
        m = 3.0 * f / 200.0
        high = f >= 1000.0
        m[high] = 15.0 + np.log(f[high] / 1000.0) * (27.0 / np.log(6.4))
        return m

    def mel_to_hz(m):
        m = np.atleast_1d(np.asarray(m, dtype=np.float64))
        f = 200.0 * m / 3.0
        high = m >= 15.0
        f[high] = 1000.0 * np.exp(np.log(6.4) / 27.0 * (m[high] - 15.0))
        return f

    edges = mel_to_hz(np.linspace(hz_to_mel(0.0)[0], hz_to_mel(sample_rate / 2)[0], n_mels + 2))
    fft_freqs = np.linspace(0, sample_rate // 2, n_bins)
    diff = np.diff(edges)
    slopes = edges[None, :] - fft_freqs[:, None]
    down = -slopes[:, :-2] / diff[:-1]
    up = slopes[:, 2:] / diff[1:]
    filters = np.maximum(0.0, np.minimum(down, up))
    return filters * (2.0 / (edges[2 : n_mels + 2] - edges[:n_mels]))[None, :]


_MEL_FILTERS = None


def whisper_log_mel(audio):
    """Whisper-style log-mel features (80 x 800) for exactly 8 s of 16 kHz audio (Smart Turn's input)."""
    import numpy as np
    from numpy.lib.stride_tricks import sliding_window_view

    global _MEL_FILTERS
    if _MEL_FILTERS is None:
        _MEL_FILTERS = _mel_filters_slaney()
    x = np.asarray(audio, dtype=np.float32)
    n = SAMPLE_RATE * 8
    x = np.pad(x, (0, n - x.size)) if x.size < n else x[:n]
    x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)
    padded = np.pad(x.astype(np.float64), (200, 200), mode="reflect")
    window = np.hanning(401)[:-1]
    frames = sliding_window_view(padded, 400)[::160]
    power = np.abs(np.fft.rfft(frames * window, axis=-1)) ** 2
    mel = np.log10(np.maximum(1e-10, _MEL_FILTERS.T @ power.T))[:, :-1]
    mel = np.maximum(mel, mel.max() - 8.0)
    return ((mel + 4.0) / 4.0).astype(np.float32)


class TurnDetector:
    """Smart Turn v3 (Daily): from the sound of the last 8 s, is the speaker done talking?"""

    def __init__(self, path):
        self.session = cpu_session(path)
        self.input = self.session.get_inputs()[0].name

    def complete(self, audio):
        """Probability (0-1) that they finished their turn, judged at the end of the audio."""
        import numpy as np

        n = SAMPLE_RATE * 8
        x = np.asarray(audio, dtype=np.float32)[-n:]
        if x.size < n:
            x = np.pad(x, (n - x.size, 0))  # silence before a short clip
        out = self.session.run(None, {self.input: whisper_log_mel(x)[None]})
        return float(np.asarray(out[0]).reshape(-1)[0])


class WakeWord:
    """The bot's name as a sound rather than a word: its own small model, trained on
    synthetic voices with livekit-wakeword. Scores a clip for the name anywhere in it."""

    EMBEDDING_WINDOW = 76  # mel frames per embedding
    EMBEDDING_STRIDE = 8
    EMBEDDINGS = 16  # embeddings the classifier looks at (about 2 s)
    # Discord sends nothing between words, so clips and the padding around them would
    # be exact digital silence, which the detector never heard in training (its clips
    # have background noise or a quiet floor all the way through). This floor, about
    # what a quiet mic picks up, goes under everything instead.
    FLOOR_DBFS = -60.0

    def __init__(self, model_path, extras_dir=EXTRAS_DIR):
        self.name = os.path.splitext(os.path.basename(model_path))[0]
        mel_file, embedding_file = (os.path.join(extras_dir, f) for f in WAKE_FRONTEND_FILES)
        self.mel = cpu_session(mel_file)
        self.embedding = cpu_session(embedding_file)
        self.classifier = cpu_session(model_path)
        self.mel_input = self.mel.get_inputs()[0].name
        self.embedding_input = self.embedding.get_inputs()[0].name
        self.classifier_input = self.classifier.get_inputs()[0].name
        self.batched = None  # whether the classifier takes several windows at once

    def score(self, audio, last_seconds=None):
        """Highest score (0-1) for the name anywhere in the audio (or in its last few seconds)."""
        import numpy as np

        clip = np.asarray(audio, dtype=np.float32)
        if last_seconds:
            clip = clip[-int(last_seconds * SAMPLE_RATE):]
        # Quiet floor before (the model looks at 2 s at a time), under the clip, and a little
        # after (the name may end the clip). Seeded, so the same clip always gets the same score.
        before, after = 2 * SAMPLE_RATE, SAMPLE_RATE // 3
        noise = np.random.default_rng(len(clip)).standard_normal(before + len(clip) + after)
        x = (noise * 10 ** (self.FLOOR_DBFS / 20)).astype(np.float32)
        x[before:before + len(clip)] += clip
        # The mel model takes 16-bit sample values (openWakeWord's convention, which the
        # detector was trained with), not -1..1 floats.
        x = np.clip(x, -1.0, 1.0) * 32768.0
        mel = np.asarray(self.mel.run(None, {self.mel_input: x[None]})[0], dtype=np.float32)
        mel = mel.reshape(-1, mel.shape[-1]) / 10.0 + 2.0  # (frames, 32)
        n = (mel.shape[0] - self.EMBEDDING_WINDOW) // self.EMBEDDING_STRIDE + 1
        if n < self.EMBEDDINGS:
            return 0.0
        windows = np.stack([mel[i * self.EMBEDDING_STRIDE : i * self.EMBEDDING_STRIDE + self.EMBEDDING_WINDOW] for i in range(n)])
        windows = windows[..., None].astype(np.float32)  # (n, 76, 32, 1)
        embeddings = np.concatenate(
            [np.asarray(self.embedding.run(None, {self.embedding_input: windows[i : i + 64]})[0]).reshape(-1, 96) for i in range(0, n, 64)]
        )
        sequences = np.stack([embeddings[i : i + self.EMBEDDINGS] for i in range(n - self.EMBEDDINGS + 1)]).astype(np.float32)
        return float(max(self._classify(sequences)))

    def _classify(self, sequences):
        import numpy as np

        if self.batched is not False:
            try:
                out = self.classifier.run(None, {self.classifier_input: sequences})[0]
                self.batched = True
                return np.asarray(out).reshape(-1)
            except Exception:
                if self.batched:
                    raise
                self.batched = False  # exported for one window at a time
        return np.array([float(np.asarray(self.classifier.run(None, {self.classifier_input: s[None]})[0]).reshape(-1)[0]) for s in sequences])


class Extras:
    """Whatever extras could be loaded; each one is None if its file is missing or broken."""

    def __init__(self, turn=None, wake=None, wake_model=None):
        self.turn = turn
        self.wake = wake
        # The name detector it was asked to load (even if that failed), so the bot can tell
        # this copy runs with its current settings and doesn't restart it over a bad file.
        self.wake_model = wake_model

    @classmethod
    def load(cls, wake_model=None, extras_dir=EXTRAS_DIR):
        turn = wake = None
        turn_file = os.path.join(extras_dir, SMART_TURN_FILE)
        if os.path.isfile(turn_file):
            try:
                turn = TurnDetector(turn_file)
            except Exception as err:
                log(f"end-of-turn model didn't load ({err!r}); sentences end after the usual pause")
        if wake_model:
            if not os.path.isfile(wake_model):
                log(f"no name detector at {wake_model}; names are only heard as words")
            else:
                try:
                    wake = WakeWord(wake_model, extras_dir)
                except Exception as err:
                    log(f"name detector didn't load ({err!r}); names are only heard as words")
        log(f"extras: end-of-turn {'on' if turn else 'off'}, name detector {wake.name if wake else 'off'}")
        requested = os.path.splitext(os.path.basename(wake_model))[0] if wake_model else None
        return cls(turn, wake, requested)

    def describe(self):
        return {"turn": bool(self.turn), "wake": self.wake.name if self.wake else None, "wake_model": self.wake_model}


class Background:
    """Runs a function in a thread now; .get() waits for its result (None if it failed)."""

    def __init__(self, fn, *args, **kwargs):
        self.value = None
        self.thread = threading.Thread(target=self._run, args=(fn, args, kwargs), daemon=True)
        self.thread.start()

    def _run(self, fn, args, kwargs):
        try:
            self.value = fn(*args, **kwargs)
        except Exception as err:
            log(f"name detector failed on a clip: {err!r}")

    def get(self, timeout=2.0):
        self.thread.join(timeout)
        return self.value


# ---------------------------------------------------------------------------
# HTTP server (127.0.0.1 only)
# ---------------------------------------------------------------------------


MAX_FAILURES_IN_A_ROW = 3
# A transcription takes well under a second. One still running after this long means
# the graphics card is hung, and nothing can stop that from inside: the server exits
# so the bot can start a fresh copy (Deepgram covers meanwhile). /health reports how
# long the oldest one has been running (busy_s).
STUCK_EXIT_S = 30


class State:
    def __init__(self, transcriber, model_name, idle_exit):
        self.transcriber = transcriber
        self.model_name = model_name
        self.idle_exit = idle_exit
        self.started = time.time()
        self.last_seen = time.time()
        self.requests = 0
        self.errors = 0
        self.failures_in_a_row = 0
        self.stop = None  # set by serve(): shuts the server down
        self.lock = threading.Lock()
        self.running = {}  # transcriptions in progress: number -> when it started
        self.count = 0
        self.stuck_exit_s = STUCK_EXIT_S
        self.extras = Extras()  # end-of-turn and name detector, when loaded

    def request_stop(self, reason):
        log(reason)
        if self.stop:
            threading.Thread(target=self.stop, daemon=True).start()

    def touch(self):
        with self.lock:
            self.last_seen = time.time()

    def begin(self):
        with self.lock:
            self.count += 1
            self.running[self.count] = time.time()
            return self.count

    def end(self, number):
        with self.lock:
            self.running.pop(number, None)

    def stuck_for(self):
        """How long the oldest transcription in progress has been running (0 if none)."""
        with self.lock:
            return time.time() - min(self.running.values()) if self.running else 0.0


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        server_version = "WinslowWhisper/1"

        def log_message(self, fmt, *args):  # quiet: one line per request would flood the log
            pass

        def send_json(self, code, payload):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def allowed(self):
            # Only the bot on this PC: no web pages (they send Origin), no other host names.
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
            if self.headers.get("Origin") or host not in ("127.0.0.1", "localhost"):
                self.send_json(403, {"error": "local use only"})
                return False
            return True

        def do_GET(self):
            if not self.allowed():
                return
            url = urllib.parse.urlparse(self.path)
            if url.path != "/health":
                return self.send_json(404, {"error": "not found"})
            # The app's status checks (peek) don't count as using it, so it still exits
            # and frees the graphics memory when the bot is off.
            if "peek" not in urllib.parse.parse_qs(url.query):
                state.touch()
            t = state.transcriber
            self.send_json(
                200,
                {
                    # Still ok while a transcription is stuck: the port is taken until this copy
                    # exits by itself, so a second copy couldn't start anyway.
                    "ok": True,
                    "busy_s": round(state.stuck_for(), 1),
                    "model": state.model_name,
                    "device": t.device,
                    "compute_type": t.compute_type,
                    "beam_size": t.beam_size,
                    "language": t.language,
                    "code": CODE,
                    "uptime_s": round(time.time() - state.started),
                    "requests": state.requests,
                    "errors": state.errors,
                    **state.extras.describe(),
                },
            )

        def do_POST(self):
            if not self.allowed():
                return
            state.touch()
            url = urllib.parse.urlparse(self.path)
            if url.path == "/shutdown":
                self.send_json(200, {"ok": True})
                return state.request_stop("asked to shut down")
            if url.path not in ("/transcribe", "/turn"):
                return self.send_json(404, {"error": "not found"})
            if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() not in ("audio/wav", "audio/x-wav"):
                return self.send_json(415, {"error": "send audio/wav"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_UPLOAD_BYTES:
                return self.send_json(413 if length > MAX_UPLOAD_BYTES else 400, {"error": "send a WAV body"})
            data = self.rfile.read(length)
            query = urllib.parse.parse_qs(url.query)
            hotwords = (query.get("hotwords") or [""])[0][:400]
            wake = (query.get("wake") or [""])[0][:200]
            SHOW_WORDS.on = (query.get("log_text") or ["0"])[0] == "1"
            language = (query.get("language") or [""])[0][:8] or None
            started = time.time()
            if url.path == "/turn":
                return self.check_turn(data, query, started)
            number = state.begin()
            detector = None
            try:
                audio = read_wav(data)
                # The name detector runs on the processor alongside Whisper on the graphics card.
                if state.extras.wake:
                    detector = Background(state.extras.wake.score, audio)
                result = state.transcriber.transcribe(
                    audio, hotwords=hotwords, language=language, wake=wake, wake_score=detector.get if detector else None
                )
                if detector:
                    score = detector.get()
                    result["wake"] = None if score is None else round(score, 3)
            except ValueError as err:
                return self.send_json(400, {"error": str(err)})
            except Exception as err:  # CUDA out of memory, driver problems, ...
                with state.lock:
                    state.errors += 1
                    state.failures_in_a_row += 1
                    give_up = state.failures_in_a_row >= MAX_FAILURES_IN_A_ROW
                log(f"transcription failed: {err!r}")
                self.send_json(500, {"error": str(err)[:300]})
                if give_up:
                    # Likely a lost graphics card connection (driver update, GPU reset).
                    # Exiting lets the bot start a fresh copy; Deepgram covers meanwhile.
                    state.request_stop(f"{MAX_FAILURES_IN_A_ROW} transcriptions failed in a row; exiting so the bot can restart me")
                return
            finally:
                state.end(number)
            with state.lock:
                state.requests += 1
                state.failures_in_a_row = 0
            result["ms"] = round((time.time() - started) * 1000)
            self.send_json(200, result)

        def check_turn(self, data, query, started):
            """POST /turn: during a pause, is the speaker done (complete), and did they say the name (wake)?"""
            extras = state.extras
            try:
                audio = read_wav(data)
            except ValueError as err:
                return self.send_json(400, {"error": str(err)})
            want_wake = (query.get("wake") or ["0"])[0] == "1"
            seconds = (query.get("seconds") or [""])[0]
            try:
                last = float(seconds) if seconds else None
            except ValueError:
                last = None
            result = {"complete": None, "wake": None}
            try:
                if extras.turn and (query.get("turn") or ["1"])[0] != "0":
                    result["complete"] = round(extras.turn.complete(audio), 3)
                if extras.wake and want_wake:
                    result["wake"] = round(extras.wake.score(audio, last_seconds=last), 3)
            except Exception as err:
                log(f"end-of-turn or name check failed: {err!r}")
                return self.send_json(500, {"error": str(err)[:300]})
            result["ms"] = round((time.time() - started) * 1000)
            self.send_json(200, result)

    return Handler


class LocalServer(ThreadingHTTPServer):
    """127.0.0.1 only, and the port is ours alone (Windows would otherwise let two servers share it)."""

    daemon_threads = True
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(__import__("socket"), "SO_EXCLUSIVEADDRUSE"):
            import socket

            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def serve(state, httpd, ready_event=None, hard_exit=os._exit):
    state.stop = httpd.shutdown

    def watchdog():
        while True:
            time.sleep(1)
            # A transcription that never finishes (hung graphics card) can't be stopped
            # from here, so the whole server goes; the bot starts a fresh one.
            stuck = state.stuck_for()
            if stuck > state.stuck_exit_s:
                log(f"a transcription has been running for {stuck:.0f} s (graphics card hung?); exiting so the bot can start a fresh copy")
                hard_exit(3)
                return
            # Nobody asked anything for a while (the bot was closed): free the graphics memory.
            if state.idle_exit and time.time() - state.last_seen > state.idle_exit:
                log(f"idle for {state.idle_exit} s, shutting down")
                httpd.shutdown()
                return

    threading.Thread(target=watchdog, daemon=True).start()
    if ready_event:
        ready_event.set()
    log(f"listening on http://127.0.0.1:{httpd.server_address[1]}")
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        httpd.server_close()


# ---------------------------------------------------------------------------
# Model download (resumable, checked against Hugging Face's published hashes)
# ---------------------------------------------------------------------------


def _open(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "winslow-whisper-setup", **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def list_model_files(repo, base=HF_BASE):
    with _open(f"{base}/api/models/{repo}/tree/main") as res:
        tree = json.load(res)
    files = []
    for item in tree:
        if item.get("type") != "file":
            continue
        path = item["path"]
        if not any(path == p or (p.endswith(".") and path.startswith(p)) for p in MODEL_FILE_PATTERNS):
            continue
        lfs = item.get("lfs") or {}
        files.append({"path": path, "size": int(lfs.get("size") or item.get("size") or 0), "sha256": lfs.get("oid")})
    return files


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def download_file(url, dest, size, sha256=None, report=log):
    """Downloads to dest.part (resuming if a partial file is there), checks it, then renames."""
    part = dest + ".part"
    if os.path.exists(dest):
        if (not size or os.path.getsize(dest) == size) and (not sha256 or sha256_file(dest) == sha256):
            report(f"  {os.path.basename(dest)}: already downloaded")
            return
        os.remove(dest)  # damaged or from an older version of the model: fetch it again
    have = os.path.getsize(part) if os.path.exists(part) else 0
    if size and have > size:
        os.remove(part)
        have = 0
    # A complete .part (setup was closed while checking it) only needs checking.
    attempts = range(0) if size and have == size else range(1, 6)
    for attempt in attempts:
        try:
            headers = {"Range": f"bytes={have}-"} if have else {}
            with _open(url, headers, timeout=60) as res:
                if have and res.status != 206:  # server ignored the range: start over
                    have = 0
                mode = "ab" if have else "wb"
                next_report = 0
                with open(part, mode) as out:
                    while True:
                        chunk = res.read(4 * 1024 * 1024)
                        if not chunk:
                            break
                        out.write(chunk)
                        have += len(chunk)
                        if size and have >= next_report:
                            report(f"  {os.path.basename(dest)}: {have * 100 // size}% of {size / 1e9:.2f} GB" if size > 1e8 else f"  {os.path.basename(dest)}")
                            next_report = have + max(size // 10, 1)
            break
        except urllib.error.HTTPError as err:
            if err.code == 416 and have and (not size or have >= size):
                break  # nothing left to download
            if attempt == 5:
                raise
            report(f"  download problem (HTTP {err.code}); retrying in {attempt * 3} s")
            time.sleep(attempt * 3)
            have = os.path.getsize(part) if os.path.exists(part) else 0
        except Exception as err:
            if attempt == 5:
                raise
            report(f"  connection problem ({err}); retrying in {attempt * 3} s")
            time.sleep(attempt * 3)
            have = os.path.getsize(part) if os.path.exists(part) else 0
    if size and os.path.getsize(part) != size:
        raise RuntimeError(f"{os.path.basename(dest)} is {os.path.getsize(part)} bytes, expected {size}")
    if sha256:
        report(f"  checking {os.path.basename(dest)}")
        got = sha256_file(part)
        if got != sha256:
            os.remove(part)
            raise RuntimeError(f"{os.path.basename(dest)} failed its checksum (got {got}); run setup again")
    os.replace(part, dest)


def download_model(model, home, base=HF_BASE, report=log):
    repo = MODEL_REPOS.get(model, model if "/" in model else None)
    if not repo:
        raise SystemExit(f"unknown model {model!r}; use one of: {', '.join(MODEL_REPOS)}")
    dest_dir = model_dir(home, model)
    os.makedirs(dest_dir, exist_ok=True)
    files = list_model_files(repo, base)
    if not any(f["path"] == "model.bin" for f in files):
        raise RuntimeError(f"{repo} has no model.bin")
    report(f"Downloading {repo} to {dest_dir}")
    for f in files:
        url = f"{base}/{repo}/resolve/main/{urllib.parse.quote(f['path'])}"
        download_file(url, os.path.join(dest_dir, f["path"]), f["size"], f["sha256"], report)
    report("Model ready.")
    return dest_dir


def model_ready(path):
    return os.path.isfile(os.path.join(path, "model.bin")) and os.path.isfile(os.path.join(path, "config.json"))


# ---------------------------------------------------------------------------


def main(argv=None):
    p = argparse.ArgumentParser(description="Local Whisper speech-to-text for the bot")
    p.add_argument("--home", default=default_home(), help="where the model lives")
    p.add_argument("--model", default="large-v3")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--device", default="cuda", help="cuda (graphics card) or cpu")
    p.add_argument("--compute-type", default="float16")
    p.add_argument("--beam-size", type=int, default=5)
    p.add_argument("--workers", type=int, default=2, help="sentences it can work on at once")
    p.add_argument("--language", default="en")
    p.add_argument("--idle-exit", type=int, default=300, help="quit after this many seconds without requests (0 = never)")
    p.add_argument("--wake-model", help="the bot's name detector (an .onnx file in whisper/extras), if it has one")
    p.add_argument("--log", help="also append log lines to this file")
    p.add_argument("--download", action="store_true", help="download the model and exit")
    p.add_argument("--check", action="store_true", help="load the model on the graphics card, print how it went and exit")
    p.add_argument("--self-test", metavar="WAV", help="load the model, transcribe this file, print the result and exit")
    args = p.parse_args(argv)
    global LOG_FILE
    LOG_FILE = args.log

    if args.download:
        download_model(args.model, args.home)
        return 0

    path = model_dir(args.home, args.model)
    if not model_ready(path):
        log(f"The {args.model} model isn't downloaded yet ({path}). Run Whisper setup (on Home in the app, or setup-whisper.bat).")
        return 2

    # Take the port before the slow model load, so a clash shows up right away.
    httpd = state = None
    if not (args.check or args.self_test):
        state = State(None, args.model, args.idle_exit)
        try:
            httpd = LocalServer(("127.0.0.1", args.port), make_handler(state))
        except OSError as err:
            log(f"could not listen on port {args.port} (another program is using it?): {err}")
            return 5

    gpu = gpu_name() if args.device == "cuda" else None
    log(f"loading {args.model} on {args.device} ({gpu or 'no GPU info'}), {args.compute_type}")
    t0 = time.time()
    try:
        transcriber = Transcriber(path, args.device, args.compute_type, args.workers, args.beam_size, args.language)
        transcriber.warm_up()
    except Exception as err:
        log(f"could not load the model: {err!r}")
        if "msvcp" in str(err).lower() or "dll load failed" in str(err).lower():
            log("A Windows library is missing: install the Microsoft Visual C++ Redistributable (x64) from https://aka.ms/vs/17/release/vc_redist.x64.exe")
        elif args.device == "cuda":
            log("Check that the NVIDIA driver is up to date (NVIDIA app or nvidia.com/drivers).")
        if httpd:
            httpd.server_close()
        return 3
    load_ms = round((time.time() - t0) * 1000)
    log(f"model loaded in {load_ms} ms")

    if args.check:
        print(json.dumps({"gpu": gpu, "model": args.model, "device": args.device, "load_ms": load_ms}), flush=True)
        return 0

    if args.self_test:
        with open(args.self_test, "rb") as f:
            audio = read_wav(f.read())
        t1 = time.time()
        result = transcriber.transcribe(audio, hotwords="")
        result["ms"] = round((time.time() - t1) * 1000)
        print(json.dumps({"gpu": gpu, "model": args.model, "load_ms": load_ms, "audio_seconds": round(len(audio) / SAMPLE_RATE, 1), **result}), flush=True)
        return 0 if result["text"] else 4

    state.transcriber = transcriber
    state.extras = Extras.load(args.wake_model)
    serve(state, httpd)
    return 0


def run():
    try:
        return main()
    except SystemExit:
        raise
    except BaseException:  # pythonw has nowhere to print a crash: put it in the log
        import traceback

        log("crashed:\n" + traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(run())
