# Voice live-conversation — fixes & next steps

> **Status: in progress.** Phase 4 (realtime voice) is fully merged to `main`. This
> plan captures the post-launch fixes from live testing (2026-07-13/14) and the
> remaining work. Written as a context-reset handoff.

## Where things stand

**Phase 4 — MERGED to `main`** (squash, in order), each /code-review'd before PR:
- #210 4a — `src/voice/audio-codec.ts` (resample/accumulator/μ-law) + `WhisperEngine.streamTranscribe` on `FrameAccumulator`, `streamWindowSeconds` default **2 s**.
- #211 4b — `src/api/voice-ws.ts` (`/voice` duplex WS) + `web/hooks/useVoiceRealtime.ts` (AudioWorklet@16kHz, client VAD). Verified e2e on real audio.
- #212 4c — barge-in + per-sentence streaming TTS in `useVoiceRealtime.ts`.
- #213 4d — `src/api/voice-media-ws.ts` (`/voice/media/:provider` Twilio) + `src/voice/telephony/media-bridge.ts` + `reply.ts`. Behind `voice.streaming` setting, Twilio-only.

**PR #214 — OPEN, not merged** (`fix/mistral-tts-default-voice`): "make the spoken loop usable":
- `src/voice/tts.ts` — Mistral TTS now defaults voice to `en_paul_neutral` (Voxtral 400s with no voice → every `/speak` was 500ing → replies came back as text only). **This was the root cause of "answers in text, not voice."**
- `src/voice/stt.ts` — `stripNonSpeech()` filters whisper `[BLANK_AUDIO]`/`[ Silence ]`/`(inaudible)` at the root (all callers). Tested in `stt.test.ts`.
- `web/lib/voice-speech.ts` (new) `stripForSpeech()` — strips the orchestrator's `_Sources: …_` footer + markdown before TTS; wired into **both** `useVoiceRealtime.ts` and `useVoiceConversation.ts`.

**Deployment state (user's live box, `:3005`):**
- Backend restarted on the `fix/mistral-tts-default-voice` branch → default-voice + blank-audio filter are **LIVE**.
- **Web NOT rebuilt** → the Sources/markdown stripping is **NOT live yet** (it's in web hooks; needs `cd web && bun run build` + restart the `next-server` on :3007). Bundle this rebuild with the next web change.

## Environment facts (verified on this machine)
- whisper: `models/whisper/linux-x64/whisper-cli` + `ggml-base.bin` (base model) + ffmpeg present.
- Mistral key in vault (works); Twilio connected; **`voice.publicUrl` UNSET** (blocks 4d live call).
- Providers with keys in system vault: openai, gemini, deepseek, xai, openrouter, voyage, mistral, litellm. Anthropic now stored too (was an intermittent `/models/test` hiccup).
- `voice.ttsEnabled: true`, `ttsProvider: mistral`.

## Remaining work (priority order)

### 1. Narrator redesign — the big one (fixes the stale-repeat bug)
**Problem:** the voice speaks "latest assistant message on the turn falling edge" (`useVoiceConversation.ts` / `useVoiceRealtime.ts` — the `pendingSpeakRef` + `getAssistantReply()` scan). For a long agent turn (e.g. 3-min research), it reads a *stale* message ("Inadequate. Specify topic…" from a prior turn). Voice is coupled to the slow pipeline.

**Step 1 (do first — safe, frontend only):** change the trigger from "speak latest on turn-edge" to **"speak each NEW assistant message as it arrives, deduped by message id."** Track last-spoken id. Decouples voice from turn timing; every assistant message narrated once, in order; no stale repeats. Apply to both hooks.
- Seam: the chat page (`web/app/chat/page.tsx`) owns `messages`; pass new-message events (or the messages array) into the hooks and speak on append. Replace `pendingSpeakRef`/turn-edge logic.

**Step 2 (the full vision — needs orchestrator seam check):** immediate spoken ack for agent-spawning turns ("On it — started research, I'll update you. Anything else?") + narrate agent lifecycle. The web already receives `orchestrator_event` + `agent_event` over `/ws` (see `src/api/websocket.ts`; chat page tracks `trackedAgents`). **Open question to resolve:** does the orchestrator emit an immediate ack message on a spawn turn, or only the final result? (`src/core/orchestrator/service.ts:82 handleMessage`, `router-turn.ts`, `worker-spawner.ts`). If only final, add an ack. User explicitly wants immediate ack + narration + "voice always talks."

### 2. Speech accuracy — whisper base → small
User reports transcription inaccuracy. Base model is the floor. Wire download of `ggml-small.bin` and point config at it (`config.voice.whisperModelPath`; install path in `src/voice/whisper.ts` / `octi setup`). ~2× model, still real-time. Offer/confirm before downloading.

### 3. Dashboard — provider availability, not model config
User's spec: show a provider as **available/configured when its KEY is present + valid**, NOT when a model is registered. Current dashboard infers "enabled" from registered models + health (empty until models discovered) — that's the mismatch.
- Fix: add a provider-status source returning `{ provider, hasKey, healthy }` = vault key presence + a light `checkHealth()` probe; drive the Models/Providers dashboard "available" indicator off that.
- Seams: `src/api/routes/models.ts` (`/providers/:provider/available` does live discovery today), `src/services/provider-service.ts`, provider `checkHealth()`; web Models page component. Own branch/PR.

### 4. Anthropic native-provider protocol divergence (lower priority)
`src/models/providers/anthropic-provider.ts`: `checkHealth()`/discovery use **native** API (`GET /v1/models`, `x-api-key`) but `complete()` uses **OpenAI-compat** (`https://api.anthropic.com/v1/`, `/chat/completions`, Bearer) — so `/models/test` (which calls `complete()`) can fail while health passes. The working `custom-anthropic` uses native Messages consistently (`src/models/providers/custom/anthropic-compat-provider.ts`). Harden by routing `complete()` through native Messages, OR fix the test's model id. Couldn't reproduce live (no key was stored at investigation time). Get the exact error before rewriting.

## Gotchas learned (save future debugging)
- **CI backend job = `typecheck · lint · test`.** Run `bun run lint` (biome) before pushing — `tsc`/`bun test` alone miss biome's `useConst` etc. (all 4 Phase-4 PRs failed CI on one `let→const`).
- Elysia auto-parses a JSON WS frame into an **object**, not a string — a string-only `typeof` check misses the `{type:"stop"}` control frame (bit 4b).
- Mistral Voxtral TTS **requires `voice_id`** (400 "Either ref_audio or voice must be provided"); voices via `GET https://api.mistral.ai/v1/audio/voices` (e.g. `en_paul_neutral`).
- whisper **1 s windows return empty** on the base model; **2 s** works — keep `streamWindowSeconds` ≥ 2.
- Standalone scripts against the running backend need `initializeVault()` + `initializeStorage({mode, redis})` before vault/session/repo calls; sessions are Redis-backed so a script can mint a token the live server accepts (`getSessionManager().create(userId,{ttlMs})`).
- Stacked PRs: after a squash-merge, rebase the next branch with `git rebase --onto <new-main> <branch>~1 <branch>` to drop the stale parent commit, then force-push + retarget base to main.
