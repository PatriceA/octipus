#!/usr/bin/env python3
"""Kokoro TTS worker for KokoroEngine (src/voice/tts.ts).

Synthesises one utterance and exits. Run via `uv run --with kokoro-onnx --with
soundfile` so no global install is needed; the ONNX model + voices live in
--model-dir (provisioned by installKokoro in src/voice/provision.ts).

  kokoro_tts_worker.py <input.txt> <output.wav> --model-dir DIR [--voice V] [--speed S] [--lang L]
"""
import sys
import os
import argparse

import soundfile as sf
from kokoro_onnx import Kokoro


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--voice", default="af_sarah")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--lang", default="en-us")
    a = ap.parse_args()

    onnx = os.path.join(a.model_dir, "kokoro-v1.0.onnx")
    voices = os.path.join(a.model_dir, "voices-v1.0.bin")
    kokoro = Kokoro(onnx, voices)

    with open(a.input) as f:
        text = f.read().strip()
    samples, sr = kokoro.create(text, voice=a.voice, speed=a.speed, lang=a.lang)
    sf.write(a.output, samples, sr)
    print(f"kokoro: wrote {a.output} ({len(samples)} samples @ {sr}Hz)", file=sys.stderr)


if __name__ == "__main__":
    main()
