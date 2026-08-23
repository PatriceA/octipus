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

### 0. DONE / IN PROGRESS (2026-07-14, this branch)
- **whisper base → small: DONE.** `models/whisper/ggml-small.bin` (487 MB) downloaded; setting `voice.whisperModelPath = ./models/whisper/ggml-small.bin` written to the live store; `voice-media-ws.ts:135` (Twilio) fixed to honor the config override too. **Needs backend restart on :3005.**
- **Narrator Phase A backend: DONE + verified (typecheck/lint/self-check).** Decision after user review of the two references (ada_local, rileyjarvis — both turned out wake-word request-reply, NOT proactive): build a **read-only backend narrator** (narrates, never spawns → zero runaway, no confirm dialog needed), phased **A (event-templater) → B (LLM on the assigned voice model)**, **defer** octipus-navigation tools + unprompted chatter.
  - **Key seam finding:** `/voice` (voice-ws.ts) is half-duplex and **closes after each utterance** — it can't carry narration across a long turn. The narrator rides the **persistent `/ws`** (websocket.ts), which already gets `orchestrator.onEvent`.
  - `src/voice/narrator.ts` — pure `narrate(event)` templater + `demo()` self-check. Event shapes: `worker_spawned`/`worker_completed` `data:{role,workerId,model,...}` (roles `octipus`/`direct` = silent), `chat_response` `data.response` = the final answer, `status_update` `data:{message,stage}` (not narrated in A).
  - `websocket.ts` — `WebSocketData.voiceOn`; `{type:'voice',on}` control frame sets it; orchestrator callback emits `{type:'speak',text}` when `voiceOn && narrate(event)`.
- **Narrator Phase A frontend: TODO (next — needs `cd web && bun run build` + restart :3007 + e2e verify):**
  1. Expose `speak()` from `useVoiceRealtime`/`useVoiceConversation` (they currently only speak internally on turn-edge).
  2. `web/app/chat/page.tsx` `handleWsMessage`: add `case 'speak':` → call the active hook's `speak(text)`.
  3. Send `{type:'voice',on:true/false}` over `/ws` when `voiceMode`/`realtimeMode` toggles.
  4. **Remove the stale-parrot path:** drop the `getAssistantReply` turn-edge speak in both hooks — the final answer now arrives as a `chat_response` → `speak` frame. This is the actual bug fix.

### 0e. Code review + fixes — DONE (2026-07-14, high-effort workflow review, 9 confirmed)
Voice topic bound → **Gemini 3.1 Flash Lite** (`scripts/bind-voice-topic.ts`; restart clears the topic cache). Then a high-effort multi-agent review found 9 confirmed bugs; **7 fixed, 2 deferred (cleanup)**:
- **FIXED (correctness):** (1) denials ("no"/"stop"/"abort") were tagged 'approval' by the classifier and EXECUTED the refused plan → gate now checks cancellation first and ignores the classifier's approval flag, using its own word-checks. (2) refinements starting with a yes-word ("go deeper on pricing") executed the coarse plan → `isAffirmation` now requires EVERY word to be an affirmation word. (3) removing the turn-edge effect wedged the mic in 'thinking' on error/empty reply → re-added `isTurnActive` to both hooks as a pure unstick safety-net (not the speak trigger). (4) typed replies were spoken aloud when mic on → `voiceTurnRef` gates reply-speak to voice-initiated turns. (5) `voiceSessions` flag leaked on disconnect/switch → WS `close()` clears it via tracked `voiceSessionId`; frontend sends voice-off for the previous session on switch. (6) execute path dropped attached files → `PendingPlan` carries `attachedFiles` through refinements + replay on confirm. (7) narration was userId-scoped → now `event.sessionId === voiceSessionId`.
- **DEFERRED (cleanup, `ponytail:` noted in code):** (8) narration + reply share one Audio element (collide only if <~seconds apart; ack plays now, answer lands minutes later). (9) execute re-dispatch persists workMessage twice (cosmetic transcript dup).
- Re-verified: gate tests 10 pass, 253 orchestrator tests, backend+web `tsc` 0, `bun run lint` clean, `bun run build` OK.

### 0d. Frontend wiring — BUILT + verified (2026-07-14)
Reply now spoken from the **`chat_response` WS message** (page.tsx `handleWsMessage`) — the fresh, complete, per-turn reply; no stale-latest scan. `narrate()`'s dead `chat_response` case removed (orchestrator never emits it) → narrator does LIFECYCLE only, so no double-speak.
- Both hooks (`useVoiceConversation`, `useVoiceRealtime`): dropped `isTurnActive`/`getAssistantReply` + the turn-edge speak effect + `pendingSpeakRef`; now **expose `speak()`**. Reply speaking is driven by the page.
- `page.tsx`: `speakRef` (routes to whichever mode owns the mic, no-op when off) called at `case 'chat_response'` (the reply) and new `case 'speak'` (narrator lifecycle acks). An effect sends `{type:'voice',on,sessionId}` over `/ws` on voiceMode/realtimeMode/session change → backend `setVoiceMode`.
- Verified: full web `tsc` exit 0, biome clean, `bun run build` succeeds.
- **Deploy: restart backend :3005 AND restart next-server :3007 (build is done).** Then map a fast model to the `voice` topic for snappy planning turns (optional; falls back to default).

### 0c. Orchestrator gate — BUILT + verified (2026-07-14)
`src/core/orchestrator/voice-plan-gate.ts` (+ `.test.ts`, 9 pass) — `VoicePlanGate.decide()` state machine: cold task→propose, pending+affirm→execute, pending+cancel→passthrough, pending+else→refine/re-propose. Affirmation = classifier `type:'approval'` OR leading-token regex.
Wired in `service.ts handleMessageInner` (after classification, before casual/work split): gated on `this.voiceSessions.has(sessionId)`; propose runs `directResponse` with `VOICE_PLANNING_DIRECTIVE` on the **fast voice-topic model** (`resolveVoiceModel()`→`selectForWorker('voice')`, falls back to complexity routing if unmapped); execute re-dispatches via new `bypassVoiceGate` param. `directResponse` gained a `modelOverride` arg. `setVoiceMode(sessionId,on)` public; `websocket.ts` `case 'voice'` calls it with `parsed.sessionId`. Full `tsc` + `bun run lint` + 252 orchestrator tests green.
**Still needed to go live:** (a) frontend sends `{type:'voice',on,sessionId}` on mic toggle + routes `speak` frames to TTS + drops stale-parrot (§0 frontend TODO); (b) map a fast model to the `voice` topic (else planning uses the default — works, just not as snappy); (c) web rebuild + restart + e2e.

### 0b. FINAL narrator architecture (2026-07-14, after user design review) — SUPERSEDES §0's "read-only narrator"
The read-only event-narrator is **rejected** — reading machine plumbing aloud ("spawned research agent") has no conversational value. Final design:
- **Talk DIRECTLY to the orchestrator** (no front agent/layer — the orchestrator IS the orchestration layer; a layer on top is repetitive). The change lives INSIDE `handleMessageInner`.
- **Propose-then-confirm gate, VOICE-ONLY:** a work-classified turn does NOT spawn immediately. It runs the persona (`directResponse`) in a "planning" mode → proposes an approach + asks "want me to start?" → stores `pendingPlan{message,approach}` on the session. Next turn: affirmation (reuse `classification.type==='approval'` + `approvalManager.tryResolveFromMessage`) → execute `runOrchestrator(pendingPlan.message)`; refinement → re-propose; new topic → drop plan, handle fresh. **Gated to voice** via a session voice-mode flag (set by the mic toggle — reuse the `{type:'voice',on}` /ws frame, persist to session metadata); typed chat keeps instant execution.
- **Confirmation is conversational** ("want me to kick this off?"), one per real task — NOT a modal on every turn. This is where the user's original "confirmation dialog but not annoying" instinct belongs.
- **Two speed regimes (latency fix):** conversation/planning turns must be FAST → route via `selectForWorker('voice')` (the voice topic). Post-handoff execution can be slow (user already told "I'll let you know") → normal routing.
- `narrate()`/`speak` frame (already built, §0) becomes the POST-HANDOFF progress updates, not the headline.

**Model/latency findings (live box, `octipus_list_models` 2026-07-14):**
- Default = `deepseek-v4-flash` (litellm) → this is what voice chat runs on today (flash tier, cloud round-trip).
- `selectByComplexity('simple')` fast-path is DEAD here: every non-cli model is priority 50, nothing below the default(50), so it always returns the default.
- **No model is mapped to the `voice` topic** → `selectForWorker('voice')` is unwired. Closing this is the latency fix.
- Fast candidates already registered: `Gemini 3.1 Flash Lite` (custom-openai, fast cloud) · keep `deepseek-v4-flash` · local `qwen3.5:9b` (32k ctx; `qwen3:8b` too tight at 4k). Map one to `voice`, measure round-trip.

### 1. Narrator redesign — the big one (fixes the stale-repeat bug)  [Step-1/2 framing below SUPERSEDED by §0b]
**Problem:** the voice speaks "latest assistant message on the turn falling edge" (`useVoiceConversation.ts` / `useVoiceRealtime.ts` — the `pendingSpeakRef` + `getAssistantReply()` scan). For a long agent turn (e.g. 3-min research), it reads a *stale* message ("Inadequate. Specify topic…" from a prior turn). Voice is coupled to the slow pipeline.

**Step 1 (do first — safe, frontend only):** change the trigger from "speak latest on turn-edge" to **"speak each NEW assistant message as it arrives, deduped by message id."** Track last-spoken id. Decouples voice from turn timing; every assistant message narrated once, in order; no stale repeats. Apply to both hooks.
- Seam: the chat page (`web/app/chat/page.tsx`) owns `messages`; pass new-message events (or the messages array) into the hooks and speak on append. Replace `pendingSpeakRef`/turn-edge logic.

**Step 2 (the full vision — needs orchestrator seam check):** immediate spoken ack for agent-spawning turns ("On it — started research, I'll update you. Anything else?") + narrate agent lifecycle. The web already receives `orchestrator_event` + `agent_event` over `/ws` (see `src/api/websocket.ts`; chat page tracks `trackedAgents`). **Open question to resolve:** does the orchestrator emit an immediate ack message on a spawn turn, or only the final result? (`src/core/orchestrator/service.ts` `handleMessage`, `orchestrator-runner.ts`, `worker-spawner.ts` — `router-turn.ts` was deleted with the routing hop in Phase 9). If only final, add an ack. User explicitly wants immediate ack + narration + "voice always talks."

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
