# Plan: agent-spawn hardening (follow-ups)

Running backlog for the swarm/spawn work. Seeded from the run-743d4b66
post-mortem (`docs/postmortems/2026-07-07-run-743d4b66-world-cup-research.md`);
items 2/3/4/6/8 of that post-mortem shipped in PR #179. This file tracks what's
left and what we found since.

## Candidate items

### NEW — subagent discoverability at depth 1 (fan-out never happens)

**Symptom:** a depth-1 agent has `spawn_child` but no idea what it can spawn.

**Findings (investigation 2026-07-08):**
- Depth-0 (orchestrator) knows its menu: `prompt.md` has a ROUTING table
  (task-signal → role) and `prompt.lite.md` has a `## Roles` list with
  descriptions. Fine.
- Depth-1 (agent) does NOT. Its system prompt is just its role prompt
  (`roles/<role>/prompt.md`), which never mentions subagents or fan-out. The
  only guidance is the `DELEGATION POLICY` paragraph injected into the task
  message (`spawner.ts:1259`) — generic, with one same-role example, and it
  never enumerates the 16 roles or says what each does.
- The `spawn_child` `role` param is a bare `enum` (`swarm-tool.ts:27`) with
  description "Specialist role for the child" — no per-role descriptions at
  either level.
- Net: a depth-1 agent knows role *names* but not capabilities, and has no
  identity as a delegator → cross-specialist fan-out is undiscoverable; even
  same-role fan-out rides on one buried sentence.

**Fix (proposed):** give depth-1 agents a compact "roles you can spawn"
catalog — inject a one-line-per-role menu into the delegation block (reuse the
orchestrator's role descriptions; don't hand-copy them — extract one source),
and/or add per-role `enum` descriptions to the tool schema. Add a short
"you may fan out" note to the role prompts (or the shared delegation block).

**Effort:** small–medium. One source of role blurbs, injected on the depth-1
path. Low risk (prompt-only). Directly unlocks the fan-out the architecture
already supports.

### NEW — stale DETACH MODE guidance (prompt/tool contract mismatch)

`spawner.ts:1270` tells depth-1 agents to pass `mode="detach"`, default to
`"await"`, and that "await is always safe" — but `spawn_child` has no `mode`
param and ALWAYS detaches (`swarm-tool.ts:401`). Same class as RC4. The
"await is safe" mental model is simply wrong now.

**Fix:** rewrite the block to the real contract (always detached; spawn
siblings freely; you MUST `collect_children` before finalizing or pending
children are cancelled). Prompt-only, trivial. Bundle with the item above.

### RC5 — budgets that don't bind (DIAGNOSED 2026-07-08, read-only)

Depth-1 caps are 80k tokens / 10-min wall; the failed run used 1.9× tokens and
8.5× wall, and a child outlived its parent by 30 min.

**Root cause:** the caps are NOT lost or bypassed. `deriveChildBudget`
(`spawn-budget.ts:63-99`) produces the correct 80 000 / 600 000 ms, threaded
intact into the worker (`spawner.ts:602-603` → `agent-manager.ts:151-152` →
`AgentWorker.config`). Both gates are live. The overruns come from WHAT the
checks measure and WHEN, plus a missing kill on the orphan path.

Defects:

- **D1 — token cap measures provider-reported usage, which under-counts.**
  `agent-worker.ts:752` grows the counter from `completion.usage.totalTokens`;
  the gate is `agent-worker.ts:546`. CLI providers report `0` on purpose
  (`cli-vibe.test.ts:41-42`, `cli-antigravity.test.ts:29-30`) → the counter
  never grows → gate is a permanent no-op. Ollama (`ollama-provider.ts:348-349`)
  fills usage from `eval_count`, which ignores image-input tokens — the 373 KB
  base64 screenshot into a 9B text model weighed ~150k real, ≪80k reported.
- **D2 — token check is loop-top / pre-call only.** `:546` runs before the LLM
  call, so a child at 79k can make one image-ingesting call and land at 150k in
  a single step; the cap only notices next iteration. No pre-flight "would this
  call cross the cap?".
- **D3 — cancel-cascade fires only on parent FAILURE.** The abort +
  `detached.cancelAll()` lives only in `run()`'s catch block
  (`agent-worker.ts:432-433`); the normal-completion path (`:345-395`) does
  neither. The orchestrator answered the user (normal completion) while child #2
  was still detached → never signalled → 30-min orphan.
- **D4 — the orphan reaper only rewrites DB rows.** `node-repository.ts:135-197`
  is pure `UPDATE ... SET status='cancelled'`; `orphan-reaper.ts` calls it on a
  timer. Never touches the running `AgentWorker`/`AbortController`. Reaping makes
  the record say cancelled while the process keeps burning. Cadence
  (~2 min sweep, ~10 min staleness) also lags.
- **D5 (contributing) — wall check is loop-top-only and `elapsed()` is
  discountable.** `elapsed()` (`:138`) subtracts `pausedMs`, and self-timed
  tools (`hasFinalToolCall`, `collect_children`, `:867-869`) aren't raced, so a
  child parked in a blocking tool can exceed 10 min of real time. Combined with
  D3/D4, once orphaned nothing external enforces the wall.

**Smallest fixes, ranked by leverage:**
1. **Kill the worker in the reaper, don't just relabel** (fixes D4). ✅ DONE —
   but SCOPED to the unambiguous orphans: only `reapUncollectedDetached`
   (detached child whose parent is already terminal) is actively `stop()`ed. The
   age-based `reapOrphans` stays DB-relabel only, because it keys on `createdAt`
   and would otherwise kill a healthy agent legitimately alive >10 min (e.g. an
   orchestrator waiting on children). See follow-up below.
2. **Add the cancel-cascade to the normal-completion path** (fixes D3). ✅ DONE —
   `agent-worker.ts` success return now aborts + `cancelAll()`s any detached
   child still pending after auto-collect, mirroring the catch path. This catches
   the run-743d4b66 case at the source (parent answered the user → child killed).
3. **Stop trusting provider usage; estimate when it's 0/absent** (fixes D1).
   ✅ DONE. `estimateRequestTokens()` (chars/4) is used via `accountedTokens()`
   whenever the provider reports 0/absent usage, at all three accounting sites
   (budget + both session message-counts). Image handling is split: a base64
   blob in STRING content counts full length (the text-model incident), a
   structured `image_url` part counts a fixed ~1500 (so vision agents aren't
   false-aborted).
4. **Make the token gate a pre-flight** (fixes D2). ✅ DONE. Right before the LLM
   call (post-compaction), abort if `used + estimateRequestTokens() >= cap` — so
   one giant call can't overshoot in a single step. Known minor conservatism:
   for prompt-caching models the full-input estimate can stop an agent slightly
   early once context alone nears the cap (safe direction).
5. **Race self-timed tools against a hard ceiling** (tightens D5). ✅ DONE, but
   scoped to `collect_children` only. A generous absolute backstop (`raceAbsolute`,
   default 2h, `selfTimedToolCeilingMs`) bounds a never-settling collect wait.
   `final`/pipeline tools are deliberately left fully unraced — they legitimately
   block on human approval (`approvalTimeoutMs`, hours), so any ceiling there
   would kill a run mid-approval.

**Heartbeat-based reap — ✅ DONE.** The reaper no longer trusts `createdAt`
alone. AgentWorker keeps an in-memory heartbeat (`lastActivityAt`, bumped each
iteration) and a `blockedSince` flag (set while awaiting a tool, an LLM call, or
human approval). `getActivity()` exposes both. The age-based pass now
`findRunningOlderThan` → per-candidate liveness: a worker not in memory (zombie)
or in memory + not blocked + no heartbeat for >30 min (wedged) is
cancelled+stopped; a blocked or recently-active worker is left running (its row
stays `running` instead of being falsely relabeled). No DB migration or
per-iteration DB write — the heartbeat is in memory, cross-referenced via the
AgentManager. This completes the active age-based kill RC5 #1 deferred.

**Status:** #1 (scoped), #2, #3, #4 shipped. The 1.9× token overrun and the
orphan/8.5× wall class are both closed. Remaining: #5 (self-timed tool ceiling,
optional) and the heartbeat-based reap (to safely enforce the age-based wall
class). RC5 is otherwise done.

### RC7 — capability gate at model binding — ✅ DONE (mostly)

Turned out to be three targeted changes, not a routing rewrite — the capability
columns (`contextWindow`, `supportsVision`, `supportsTools`, `provider`) already
exist; they were just under-populated and unused on the swarm path.

1. **Populate `metadata.paramCount` at install** (`hwfit/install.ts`). The
   catalog already has exact `params`; `buildModelEntry` now writes it. So the
   mode selector uses a real number instead of parsing the model id tag. (The
   selector already *preferred* `metadata.paramCount` — it was just never set.)
2. **Cloud-model mode fallback** (`mode-selector.ts`). Unknown size + a
   non-local-weight provider ⇒ `full` (was: always `lite`). Stops `gpt-4o` /
   `claude-*` (no `Nb` tag) being throttled to lite. Threaded `provider` through
   the two callers.
3. **Capability gate on the swarm spawn path** (`spawner.ts`). Before returning
   the child's model: log `staticCapabilityWarnings` for a weak model, and if it
   can't do tool-calling, reroute to a tool-capable local model via the shared
   `findToolCapableFallback` (extracted from the worker path's `ensureToolSupport`
   so both reroute identically). Warn-and-reroute — never blocks a spawn.

**Context-window gate — ✅ DONE.** At spawn, after composing the child's initial
brief, warn if its estimated tokens already exceed 90% of the bound model's
`contextWindow` — the model would truncate/fail before doing any work. Warn-only.

**Still deferred:**
- Per-task VISION gating at spawn — the spawner can't know a child will receive
  images (they arrive from tool output mid-run), so there's no deterministic
  signal to gate on. Would need a per-task "expects images" hint.
- Persisting discovery-fetched capabilities for non-hwfit models. Bigger than it
  looks: `discover()` returns only the *curated shortlist* (hides non-tool /
  preview / deprecated models, so the model being registered may be absent),
  needs the user's credentials, and hits the vendor API — none of which belongs
  in the DB create path. Better fixed at the UI layer: have create-from-discovery
  pass `contextWindow`/`supportsVision`/`supportsTools` (the create route already
  accepts them), or add a dedicated un-curated `discover-by-id` lookup with cred
  threading. Left for a focused change.

## Status

Shipped: subagent discoverability (#180), RC5 #1–#4 (#181, #182), RC7 (this PR).

Remaining backlog:
- **Heartbeat-based reap** — to safely enforce the wall cap on the age-based
  orphan class (unblocks the part RC5 #1 deliberately left DB-only).
- **RC5 #5** (optional) — hard ceiling on self-timed tools.
- **RC7 deferrals** — per-task vision/context gating; persisting
  discovery-fetched capabilities for non-hwfit models.
