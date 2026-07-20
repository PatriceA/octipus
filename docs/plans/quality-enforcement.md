# Plan: semantic quality enforcement (audit validation + fix order)

Validation of an external audit (2026-07-20) against the code, plus the fix
order it implies. Every claim below was checked with file:line evidence by
independent readers; the audit's own numbers were re-measured.

Related: `docs/plans/swarm-v2.md` (designs most of the P1 work already),
`docs/plans/agent-spawn-hardening.md` (RC5/RC7 status),
`docs/postmortems/2026-07-07-run-743d4b66-world-cup-research.md` (the empirical case).

## 1. Audit scorecard

| # | Audit finding | Verdict | Note |
|---|---|---|---|
| 1 | Spawning strongly prompted, weakly enforced | **Partly true** | Thesis right. But role choice IS semantically rewritten (`spawner.ts:1060`), and a schema scorer IS auto-injected (`spawner.ts:941`) |
| 2 | No mandatory completion contract | **Partly true** | Conclusion right, evidence wrong. `expectedOutput` is schema-*required* (`swarm-tool.ts:423`); optionality comes from the validator defaulting `shape='summary'` (`swarm-tool.ts:505`) |
| 3 | QA optional / not auto-triggered | **Partly true** | A full QA engine with code-parsed verdicts, auto-retry and human escalation exists (`pipeline-manager.ts:339-489`). Only its *trigger* is prose ("PREFER…", `orchestrator-runner.ts:300`) |
| 4 | `ensureChildRelay` degrades output | **Partly true** | Wrong file — it's `output-guard.ts:178`. Fires on a two-gate AND (len <40% AND word-overlap <50%), and it *does* label the appendix. Scaffolding is stripped downstream (`service.ts:617`) |
| 5 | Prompts too contract-heavy for small models | **Partly true** | Volatility-bucketed ordering already exists on the worker path (`worker-spawner.ts:501-757`). It does not exist on the swarm path |
| 6 | Research role has write access; read-only is prose | **Confirmed** | `roles/research/config.ts:8` exact. Post-mortem claimed this shipped in #179; it did not |
| 7 | Relative writes redirect to session dir | **Confirmed** | `filesystem/index.ts:255` exact. Nuance: `PROJECT_MARKERS` already rescues `repo/src/foo.ts`; only bare `src/app.ts` redirects |
| 8 | Dev mode trusts arbitrary paths | **Confirmed** | `devmode.ts` is `return isAdmin`. It never receives the path |
| 9 | Capability detection incomplete | **Partly true** | Tool-capability gating is pre-execution, not post-routing (audit is wrong here). Vision + context-window gaps are real |
| 10 | Tests/coverage failing | **WRONG** | See below |

### Finding 10 is fabricated and should be discarded

Re-measured with the project's own CI command (`bun test src scripts --timeout 30000`):

| Audit claimed | Measured |
|---|---|
| 772 pass / 15 skip / **1 fail** | **3493 pass / 174 skip / 0 fail**, exit 0 |
| Coverage ratchet **FAILS**, 32.53% lines | Ratchet **PASSES**: 52.34% lines, 60.52% functions, *above* the 51.4/59.3 baseline and rising |
| `shell-sandbox.test.ts` fails, env-dependent | Passes 9/9; bwrap 0.11.2 present. The block is `describe.skipIf(!hasBwrap)` — a missing bwrap would *skip*, never *fail*. The claim is self-contradictory |

The audit ran ~21% of the suite: its own denominators (43918 lines / 2348 functions vs the real 77127 / 5615) prove a truncated run. `scripts/coverage-check.ts:91` anticipates exactly this mistake. Only real item: a cosmetic Biome `recommended`→`preset` deprecation at `biome.json:27`.

**Consequence:** treat the audit as a hypothesis generator, not a source of facts. It got the architecture story right by reasoning, and the measurements wrong by not running them.

## 2. What the audit missed (higher leverage than most of what it found)

**M1 — Receipts are invisible on the path the orchestrator actually uses.**
`formatReceiptBlock` is called only from `formatChildResult` (`swarm-tool.ts:578`), which runs on the *await* path. The default is detach (`swarm-tool.ts:259`, `maxPendingDetached: 6`). Detached results render via `formatCollectedResults` (`collect-tool.ts:100-131`), which mirrors `scorerOutcome` — its comment at `:121` says "Mirror the await-path surface" — but omits the receipt. So `filesChanged` is computed, persisted to `swarm_nodes`, and then dropped before the parent model sees it. The entire ground-truth mechanism is dead on the live flow. Looks like an oversight, not a decision.

**M2 — Swarm children get none of the small-model accommodations.**
`liteSystemPromptTemplate` has exactly two consumers, both `worker-spawner.ts` (`:146`, `:511`). `spawner.ts:1208` is unconditional, so a swarm child on a 9B model gets the full role prompt (research: 3753 B vs 2365 B lite). Same for the small-model tool cap (`worker-spawner.ts:495`) and the deliverable-template skip. 17 `prompt.lite.md` files exist; the population that most needs them never sees them — and that is precisely the population in the July 7 post-mortem.

**M3 — `ASK` permissions are a no-op for every worker.**
`filesystem/index.ts:183-188` sets write=`ASK`, delete=`ASK`. But `tool-executor.ts:530` and `base-tool.ts:129` both auto-approve when `role !== 'orchestrator'`. Any future "make research read-only" work must use role-scoped **DENY**; `ASK` will never bite.

**M4 — no telemetry on the relay fallback.** `output-guard.ts` imports no logger. Nobody knows how often synthesis fails hard enough to trigger the raw-append path. Surrounding code logs generously, so the omission is conspicuous.

**M5 — the capability reroute can silently give up.** `findToolCapableFallback` is local/ollama-only (`model-selector.ts:26`); with no candidate it logs "proceeding anyway" (`spawner.ts:1315`). Backup-model retry fires only on `provider_error`/`tool_error` (`spawner.ts:602`) — a capability mismatch that yields a plausible-but-wrong answer never triggers it.

## 3. Fix order

Principle: the machinery mostly exists. Wire it before designing anything new.

### Tier 0 — wiring (hours, no new concepts, no schema)

| # | Change | File | Size |
|---|---|---|---|
| T0.1 | Add `formatReceiptBlock` to the detached render — closes M1 | `collect-tool.ts:129` | ~3 lines |
| T0.2 | Use `liteSystemPromptTemplate` + small-model tool cap on the swarm path, mirroring `worker-spawner.ts:146` — closes M2 | `spawner.ts:1208` | ~6 lines |
| T0.3 | Log when the relay fallback fires (+ the two gate values) — closes M4 | `output-guard.ts:178` | ~2 lines |
| T0.4 | Validate the dev-mode path: exists, is-a-directory, not a system dir. Requires passing the path to `devModeAllowed` — closes finding 8 | `devmode.ts` + 2 call sites | ~15 lines |
| T0.5 | `biome migrate` for the deprecation | `biome.json:27` | 1 command |

T0.1 and T0.2 are the two highest-value lines in this document. Do them first.

### Tier 1 — cheap semantic gates on existing machinery

| # | Change | Approach |
|---|---|---|
| T1.1 | **Receipt-vs-claim scorer.** A child whose brief implies file work and whose `receipt.filesChanged === 0` returns `contract_failed`, not `ok`. | Auto-inject alongside the existing schema scorer at `spawner.ts:941`, reusing `scorers.ts`. This is the audit's "P0 mandatory completion contract" reduced to one scorer — no new tables, no new types. Depends on T0.1 |
| T1.2 | **Role-scoped filesystem DENY.** research / architecture / review / qa deny `write_file`/`delete_file`/`move_file`. | Extend `permission-rules.ts` to be role-aware, or intersect at `resolveChildTools` (`spawner.ts:1364`) which already filters by tool id. Must be DENY, not ASK (M3). Note `roles/research/prompt.md:18` actively tells research to `write_file` — fix the prompt in the same change |
| T1.3 | **Redirect warning on write.** Return `{requestedPath, redirected: true, reason}` when the session-dir redirect fires. | `filesystem/index.ts:312`. Removes the guesswork behind "file created in the wrong place" |
| T1.4 | **Non-vision image guard.** When a tool returns an image and the bound model has `supportsVision === false`, replace the blob with a text placeholder instead of dumping 373 KB of base64. | `tool-executor.ts:757` / `sanitize.ts:242`. This is the *cheap* answer to RC7's deferred vision gating — check at the point images appear, not at spawn where it is unknowable |

### Tier 2 — real design work (already specified in swarm-v2.md)

Do not re-design these; `swarm-v2.md` §3.1/§3.2/§3.5/§3.6 covers them. Confirmed unimplemented: no `validation_contracts` table, no `contextFilter`, no `seat` field.

- **T2.1 Deterministic verify trigger.** Today the choice is prose ("PREFER using the Full Development Cycle"). Make a file-mutating or code-producing task route to the QA-bearing pipeline in code. The QA engine, retry loop, verdict parser and escalation already exist and work — only the door is model-chosen.
- **T2.2 Drift detection.** Cheapest useful version: N consecutive iterations whose tool calls touch nothing matching the brief's scope → stop and report drift. The post-mortem's child #2 ran 29 iterations past its last on-task action.
- **T2.3 Outcome evals.** Current suites (`eval/capability-orchestration.yaml`, `capability-quality.yaml`) assert *classification* and *routing* — not whether the right files changed or tests ran. Add an outcome suite: correct files created/modified, no unrelated files, tests actually run, contract-failure detected.
- **T2.4 Per-section prompt token logging** before any global prompt budget. Nothing currently measures which block eats a small model's context (`spawner.ts:452` is a whole-input warn-only estimate). Measure, then cap.

### Explicitly not doing

- **A `requires: [...]` capability field on the task brief** (audit's finding 9 recommendation). The spawner cannot know a child will receive images — they arrive from tool output mid-run. Already reasoned through in `agent-spawn-hardening.md` RC7 deferrals. T1.4 solves the real case for ~10 lines.
- **A global prompt budget** as a project. Per-section budgets already exist (`AGENTS_MD_GUIDE_TOKEN_BUDGET`, memory 250, expert index 3000). Add logging (T2.4) before adding a ceiling.
- **Anything about coverage.** It passes, above baseline, rising.

## 4. Verification

- T0.1/T0.2: spawn a swarm child on a small local model; assert the orchestrator's context contains a `<Receipt>` block, and that the child's system prompt is the lite variant.
- T1.1: give a coding child a brief it cannot satisfy; assert `contract_failed` rather than `ok`.
- T1.2: research child calls `write_file` → permission denial, counted in `receipt.permissionDenials`.
- T1.4: point a text-only model at a screenshot tool; assert no base64 in the message and no budget blow-out.
- Full suite (`bun test src scripts --timeout 30000`) + `bun run coverage:check` after each tier.
