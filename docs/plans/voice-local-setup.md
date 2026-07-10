# Voice local setup: detect · gate · install (cross-platform)

> **Status: implemented** (Linux-verified; macOS/Windows to spec, unrun on this host).
> Makes local voice (whisper.cpp STT) a first-class, self-provisioning
> dependency across **Linux, macOS, and Windows**: detect whether it actually works, gate
> the voice feature off when it doesn't, and offer to build+install it from source at
> `octi setup`. Confirmed with user: build-from-source, all-in-one, all three OSes.

## Why

The repo ships `models/whisper/whisper-cpp` **dynamically linked to `libwhisper.so.1` /
`libggml*.so` that aren't committed** — so on a clean machine it exits 127 and STT silently
fails. Nothing provisions the binary; nothing checks it runs. Voice looks enabled but isn't.

Three things fix that: **detect** real availability, **gate** the UI on it, **install** it
on demand.

## Design

### 1. Platform-aware binary + availability — `src/voice/whisper.ts` (new)

Central module; `stt.ts` and `/voice/status` both consume it (no logic duplication).

- `whisperDir()` → `models/whisper/<platform>-<arch>/` (e.g. `linux-x64`, `darwin-arm64`,
  `win32-x64`), falling back to the legacy `models/whisper/` for the committed layout.
- `whisperBinaryPath()` → `<dir>/whisper-cli` (`.exe` on win32). whisper.cpp renamed
  `main`→`whisper-cli`; we build that.
- `probeWhisper()` → actually **runs** the binary (`--help`) and stats the model. Returns
  `{ binaryOk, binaryReason, modelOk, modelPath }`. `binaryOk:false` on exit 127 / missing
  libs / ENOENT — the check the current code never does.
- `getVoiceAvailability()` → `{ stt: { local, external, available, reason }, tts: {...} }`.
  `local = binaryOk && modelOk`; `external = hasMistralKey || hasOpenAIKey`;
  `available = local || external`.

`getBundledWhisperBinary()` in `stt.ts:7` becomes a thin re-export of `whisperBinaryPath()`
so every caller inherits OS/arch awareness.

### 2. ffmpeg becomes optional (browser sends conformant WAV)

To avoid a *second* cross-platform native dep, the web loop encodes **16 kHz mono s16 WAV
in the browser** via native `OfflineAudioContext` (decode → resample → PCM → WAV). Then:

- `WhisperEngine.transcribe` **skips ffmpeg when the input is already conformant WAV**
  (reuse the `stripWavHeader` param parse from #190); only non-conformant inputs
  (non-web callers) invoke ffmpeg. Result: **the web voice path needs only whisper — no
  host ffmpeg.** #192's ffmpeg convert stays as the safety net for other callers.

### 3. Real availability in `/voice/status` + install endpoint — `src/api/routes/voice.ts`

- `/voice/status` returns `getVoiceAvailability()` (real), not the config flags. Keeps the
  old fields for compat, adds `sttAvailable` / `ttsAvailable` / `reason`.
- `POST /voice/install` (auth-gated) runs `installWhisper()` on the host and streams
  progress (mirrors the capability-install pattern). Long-running; guarded against
  concurrent runs.

### 4. The installer — `installWhisper()` in `src/voice/whisper.ts`

Build-from-source, one code path, per-OS specifics:

1. **Toolchain probe** — `cmake`, a C/C++ compiler (`cc`/`clang`/`cl`), `git` via
   `Bun.which`. Missing → throw with the exact per-OS remedy (Linux: distro `base-devel`/
   `build-essential`+`cmake`; macOS: `xcode-select --install` + `brew install cmake`;
   Windows: VS Build Tools + CMake, or `winget install Kitware.CMake`). **Never** try to
   install a compiler ourselves.
2. **Clone** whisper.cpp at a **pinned tag** into a build temp dir.
3. **cmake** configure + build (`-DBUILD_SHARED_LIBS=ON`, Release). Per-OS generator
   defaults are fine (Ninja/Make/MSVC).
4. **Stage** `whisper-cli(.exe)` + the produced libs (`*.so*` / `*.dylib` / `*.dll`) into
   `whisperDir()` — co-located so lib resolution is local, not system-wide.
5. **Model** — fetch `ggml-base.bin` if absent (it's committed today, so usually a no-op).

**Lib loading at spawn** (per OS): co-located libs + `LD_LIBRARY_PATH` (Linux) /
`DYLD_LIBRARY_PATH` (macOS); Windows finds DLLs next to the `.exe` automatically. Set in
the `spawn` env in `WhisperEngine`.

### 5. Gate the web toggle — `web/app/chat/page.tsx`

Fetch `/api/voice/status` once where `voiceMode` lives; when `sttAvailable` is false, hide
/disable the live-voice toggle with a reason ("run `octi setup` to enable local voice").
Removes the "toggle does nothing" confusion. (`prompt-input` already accepts a `voiceError`
slot; add a `voiceAvailable` gate.)

### 6. `octi setup` step — `scripts/setup-wizard.ts`

New step in `runApiPhase` (after `pickCapabilities`), copying that pattern + the
confirm-before-download idiom of `maybeRecommendModel`:

- Probe availability. If `stt.available` → show ✓, skip.
- Else if local missing **and** no external provider → offer: *"Install local voice
  (builds whisper.cpp from source — needs cmake + a C++ compiler)? [y/N]"*. On yes → drive
  `POST /voice/install`, stream progress. On missing toolchain → print the per-OS remedy
  and continue (non-fatal).
- `OCTIPUS_SETUP_INSTALL_VOICE` env for the non-interactive branch (mirrors
  `OCTIPUS_SETUP_INSTALL_CAPS`).

## Verification

- **Linux (executable here):** run `installWhisper()`, assert binary+libs load
  (`whisper-cli --help` exits 0), then drive `WhisperEngine.transcribe` on a real
  webm→browser-WAV clip end-to-end. `/voice/status` flips `sttAvailable` false→true.
- **Gating:** with no binary and no keys, `/voice/status.sttAvailable===false` and the web
  toggle is hidden.
- **macOS/Windows:** implemented to spec, **not executable on this host** — flagged in the
  PR as needing a real run on each OS. Toolchain-missing paths degrade to actionable text.

## Out of scope

Prebuilt-binary download and OS-package-manager installs (rejected in favor of one
build-from-source path). GPU/Metal/CUDA whisper builds (CPU only). Bundling libs in the
repo (the installer provisions them per host instead).
