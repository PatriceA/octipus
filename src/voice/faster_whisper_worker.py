#!/usr/bin/env python3
"""Persistent faster-whisper worker for FasterWhisperEngine (src/voice/stt.ts).

whisper.cpp reloads its model per window, which caps realtime STT at the `base`
model on CPU. faster-whisper (CTranslate2, int8) is ~4x faster AND loads once,
so `small`/`medium` transcribe a 2 s window well under realtime — a real quality
jump. This process holds the loaded model and transcribes windows on demand.

Protocol over stdio, one window at a time (parent serialises requests):
  stdin:  4-byte big-endian uint32 length N, then N bytes of 16 kHz mono s16le PCM
  stdout: one JSON line per window: {"text": "..."}\n  (plus {"ready":true} once
          the model has loaded, so the parent can wait out the load).

Run via `uv run --with faster-whisper` so no global install is needed; the model
itself is auto-downloaded to the HF cache on first use.
"""
import sys
import json
import struct
import argparse

import numpy as np
from faster_whisper import WhisperModel


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="en")
    ap.add_argument("--compute-type", default="int8")
    a = ap.parse_args()

    model = WhisperModel(a.model, device="cpu", compute_type=a.compute_type)
    emit({"ready": True})

    stdin = sys.stdin.buffer
    while True:
        header = read_exact(stdin, 4)
        if header is None:
            break
        n = struct.unpack(">I", header)[0]
        if n == 0:
            emit({"text": ""})
            continue
        pcm = read_exact(stdin, n)
        if pcm is None:
            break
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        # vad_filter (Silero) drops non-speech before decoding. Without it,
        # Whisper hallucinates YouTube-caption phantoms ("Thank you.", "You")
        # on silent/near-silent windows — and the realtime loop streams a window
        # every 2 s whether or not anyone is talking, so those repeat forever.
        segments, _ = model.transcribe(audio, language=a.language, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
        emit({"text": text})


if __name__ == "__main__":
    main()
