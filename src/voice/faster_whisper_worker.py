#!/usr/bin/env python3
"""Persistent faster-whisper worker for FasterWhisperEngine (src/voice/stt.ts).

whisper.cpp reloads its model per window, which caps realtime STT at the `base`
model on CPU. faster-whisper (CTranslate2, int8) is ~4x faster AND loads once,
so `small`/`medium` transcribe a 2 s window well under realtime — a real quality
jump. This process holds the loaded model and transcribes windows on demand.

Protocol over stdio, one window at a time (parent serialises requests):
  stdin:  4-byte big-endian uint32 length N, then N bytes of 16 kHz mono s16le PCM
  stdout: one JSON line per window:
            {"text": "...", "segments": [{"start": s, "end": s, "text": "..."}], "language": "en"}
          or {"error": "..."} when that window could not be transcribed
          (plus {"ready": true, "device": "cpu|cuda"} once the model has
          loaded, so the parent can wait out the load).

--model is a size (small), a release name (large-v3-turbo, turbo,
distil-large-v3) or a CTranslate2 repository on Hugging Face. --device auto
uses a GPU when CTranslate2 finds one and falls back to the CPU, saying so on
stderr, when the GPU cannot load the model.

Run via `uv run --with faster-whisper` so no global install is needed; the model
itself is auto-downloaded to the HF cache on first use.
"""
import sys
import json
import struct
import argparse

import numpy as np


def read_exact(f, n):
    """Read exactly n bytes, or None on EOF (parent closed stdin → shut down)."""
    buf = bytearray()
    while len(buf) < n:
        chunk = f.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def preload_cuda_libs():
    """cuBLAS / cuDNN installed as pip wheels are not on the loader path: load them by file."""
    import ctypes
    import glob
    import os
    for pkg in ("nvidia.cublas.lib", "nvidia.cudnn.lib"):
        try:
            mod = __import__(pkg, fromlist=["__path__"])
        except ImportError:
            continue
        for lib_dir in list(mod.__path__):
            for lib in sorted(glob.glob(os.path.join(lib_dir, "*.so*"))):
                try:
                    ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                except OSError as err:
                    print(f"faster-whisper: could not preload {lib}: {err}", file=sys.stderr)


def load_model(name, device, compute_type):
    """The model on the asked device; `auto` tries a GPU first, then the CPU (loudly)."""
    import ctranslate2
    if device in ("auto", "cuda"):
        preload_cuda_libs()
    from faster_whisper import WhisperModel
    want_gpu = device == "cuda" or (device == "auto" and ctranslate2.get_cuda_device_count() > 0)
    if want_gpu:
        try:
            return WhisperModel(name, device="cuda", compute_type=compute_type or "float16"), "cuda"
        except Exception as err:  # noqa: BLE001 — any GPU load failure falls back, loudly
            if device == "cuda":
                raise
            print(f"faster-whisper: GPU could not load {name} ({err}); using the CPU", file=sys.stderr)
    return WhisperModel(name, device="cpu", compute_type=compute_type or "int8"), "cpu"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="en")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--compute-type", default="")
    a = ap.parse_args()

    model, device = load_model(a.model, a.device, a.compute_type)
    emit({"ready": True, "device": device})

    # "en-US" → "en"; "auto" or empty → let the model detect the language.
    language = (a.language or "").split("-")[0].lower()
    if language in ("", "auto"):
        language = None

    stdin = sys.stdin.buffer
    while True:
        header = read_exact(stdin, 4)
        if header is None:
            break
        n = struct.unpack(">I", header)[0]
        if n == 0:
            emit({"text": "", "segments": []})
            continue
        pcm = read_exact(stdin, n)
        if pcm is None:
            break
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        # vad_filter (Silero) drops non-speech before decoding. Without it,
        # Whisper hallucinates YouTube-caption phantoms ("Thank you.", "You")
        # on silent/near-silent windows — and the realtime loop streams a window
        # every 2 s whether or not anyone is talking, so those repeat forever.
        try:
            segments, info = model.transcribe(audio, language=language, vad_filter=True)
            parts = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]
        except Exception as err:  # noqa: BLE001 — one bad window must not kill the resident worker
            emit({"error": str(err)})
            continue
        emit({"text": " ".join(p["text"] for p in parts).strip(), "segments": parts, "language": info.language})


if __name__ == "__main__":
    main()
