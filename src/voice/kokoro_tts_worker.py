#!/usr/bin/env python3
"""Resident Kokoro TTS worker for KokoroEngine (src/voice/tts.ts).

Loads the ONNX model once and synthesises on demand, so a reply spoken
sentence by sentence does not pay a Python start and a model load per
sentence. Run via `uv run --with kokoro-onnx --with soundfile`; the ONNX model
and voices live in --model-dir (provisioned by installKokoro in
src/voice/provision.ts).

Protocol over stdio, one JSON line each way:
  stdout: {"ready": true} once the model has loaded
  stdin:  {"text": "...", "out": "/path.wav", "voice": "af_sarah", "speed": 1.0, "lang": "en-us"}
  stdout: {"ok": true, "sampleRate": 24000}
  stdin:  {"voices": true}
  stdout: {"voices": ["af_heart", ...]}
A request that fails answers {"error": "..."} and the worker keeps running.
"""
import sys
import os
import json
import argparse


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True)
    a = ap.parse_args()

    try:
        import soundfile as sf
        from kokoro_onnx import Kokoro
        kokoro = Kokoro(os.path.join(a.model_dir, "kokoro-v1.0.onnx"), os.path.join(a.model_dir, "voices-v1.0.bin"))
    except Exception as err:  # noqa: BLE001 — reported to the parent, which shows it
        emit({"error": str(err)})
        return
    emit({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get("voices"):
                emit({"voices": sorted(kokoro.get_voices())})
                continue
            samples, sr = kokoro.create(
                req["text"], voice=req.get("voice") or "af_sarah",
                speed=float(req.get("speed") or 1.0), lang=req.get("lang") or "en-us",
            )
            sf.write(req["out"], samples, sr, subtype="PCM_16")
            emit({"ok": True, "sampleRate": sr})
        except Exception as err:  # noqa: BLE001 — one bad request must not stop the worker
            emit({"error": str(err)})


if __name__ == "__main__":
    main()
