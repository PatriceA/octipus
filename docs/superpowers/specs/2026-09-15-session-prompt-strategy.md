# Session Prompt Strategy — Spec

**Date:** 2026-09-15
**Status:** approved for planning

## Problem

One octipus session is not one provider session. Every octipus turn builds a
brand-new agent worker (`agent-manager.ts:195`, spawned from
`root-runner.ts:610`), and for CLI-backed models that means a brand-new vendor
CLI process with a brand-new vendor session. The whole octipus transcript is
re-serialised into the prompt on every turn (`cli-agent-worker.ts:553`
`buildPrompt`, fed by an unbounded `loadHistory()` at `:282`), while
`root-runner.ts:405-420` *separately* bakes the last ten turns into the system
prompt. Nine iterations of one question consumed ~497k tokens against a 200k
budget.

For direct API providers the process cost does not exist, but the same prompt
is re-sent each call with exactly one cache breakpoint, on the system block
(`custom/anthropic-compat-provider.ts:141`). Conversation and tool-result
growth inside a turn is re-read at full price every iteration.

## Goal

One octipus session uses one coherent prompting strategy per agent:

1. cache as much as the provider allows,
2. send only the delta when the far side already holds the context,
3. keep using the same vendor session where the vendor supports it,
4. a new octipus session always starts a new vendor session, and
5. the token counters keep telling the truth while (1)–(4) are true.

## Non-goals

- Reusing the *worker object* across turns. Workers stay per-turn; only the
  vendor session id is carried on the octipus session.
- Making octipus stateless. The octipus transcript remains the user-visible
  source of truth (`agent-worker.ts:519-527`).
- Session reuse for Antigravity or Vibe (see D1).

## Measured ground truth

Established by research on 2026-09-15; every claim below is load-bearing.

**G1. Resume does not, by itself, reduce vendor billing.** All four CLIs resend
their stored history to the model on every request. Resume saves *octipus*
from re-sending context; it does not stop the vendor from re-reading it. The
real savings are:
 - octipus's own prompt shrinks to the delta (this is the large, certain win —
   it is what produced the 497k),
 - Claude records the system prompt once and replays it verbatim on resume
   (`--system-prompt-snapshot on`), so CLAUDE.md and the octipus system prompt
   are not re-rendered per turn,
 - the vendor-side prompt cache stays warm (Claude: ~1h TTL; after that the
   history is reprocessed once),
 - vendor-side compaction replaces octipus re-sending a summary of a history
   the vendor already holds.

**G2. Only Claude Code lets the caller mint the session id** (`--session-id
<uuid>`). Codex must have its `thread_id` captured from `thread.started`.

**G3. Antigravity 1.1.5 (the installed build) emits no conversation id in
`--print` mode and silently starts a fresh conversation when handed a stale
id.** Silent forking is worse than no reuse.

**G4. Vibe is not installed on this machine** and its resume depends on
`log_interactions = true` staying set.

**G5. Only Claude can be compacted non-interactively** — `claude -p --resume
<id> "/compact <instructions>"`. Codex exposes only
`model_auto_compact_token_limit`; agy exposes nothing.

**G6. `inputTokens` includes cache reads by contract**
(`cost-tracker.ts:65-74`), and `normalizeUsage` (`usage.ts:53`) looks for
`cache_write_tokens`, which no Anthropic-upstream provider emits. Cache-aware
pricing returns `null` when rates are missing (`pricing.ts:17`) or when
`read + write > input` (`pricing.ts:9`).

**G7. `CLIOutputParser.reportedTokens` is per-parser-instance** and a fresh
parser is built per `executeCLI` (`cli-agent-worker.ts:700`). A resumed session
that replays cumulative usage would be counted from zero again
(`cli-adapters.ts:942`).

## Decisions

**D1. Reuse applies to Claude Code and Codex only.** Antigravity and Vibe keep
today's full-replay behaviour, for G3 and G4. The capability is declared per
adapter, not inferred.

**D2. Claude sessions use caller-minted ids; Codex sessions capture theirs.**
Claude: octipus generates a UUIDv4 for `(octipus session, adapter)` and passes
`--session-id <uuid>` on the first run, `--resume <uuid>` after. Codex: capture
`thread_id`, and `--ephemeral` must not be passed when reuse is enabled.

**D3. The id lives in `sessions.context.cliSessions`**, keyed by adapter. A new
octipus session has none, so it starts fresh — requirement (4) is satisfied by
construction. `/clear` clears it.

**D4. A vendor session is invalidated when the parameters that resume cannot
change, change:** model, permission mode, plan mode, or working directory.
Invalidation is a plain delete; the next run starts a fresh vendor session with
full replay.

**D5. When resuming, octipus sends only the delta.** `buildPrompt()` emits just
this turn's user message plus the run-context block, and root-runner suppresses
its "Recent conversation history" and "Previous conversation summary" volatile
blocks — the vendor already holds both.

**D6. Resume failure falls back to a cold run, once.** A missing session is
detected from the vendor's error, the stored id is dropped, and the turn is
retried with the full prompt. A user turn is never lost to a stale id.

**D7. Octipus compaction is piped through to Claude** as
`/compact <userInstructions>` on a resume run, fired from the existing
`maybeCompactSession` path. Codex has no equivalent (G5), so octipus rotates
the thread instead: drop the id and seed the next run from the compaction
summary.

**D8. Token accounting is corrected before any of this ships.** Cache reads
must stop inflating budget gates and quotas, and cache-creation tokens must be
recognised on every path. This is a prerequisite, not a follow-up.

**D9. Context tokens and billable tokens become different numbers.**
`contextTokens` (what the model read) keeps including cache reads; billable
gates (`maxTokenBudget`, swarm pools, daily quotas) move to fresh + output.

## Constraints

- Every behaviour change is off by default behind a setting, except the pure
  bug fixes in Plan A and the marker fixes in Plan C.
- No change may make a cost row read `unknown` that reads `estimated` today.
- Windows is the primary platform: no shell-quoting assumptions, prompts go via
  stdin or temp file as they do now.
- No new dependency.

## Plans

1. `2026-09-15-token-accounting-correctness.md` — prerequisite (D8, D9).
2. `2026-09-15-provider-prompt-caching.md` — direct providers, independent.
3. `2026-09-15-cli-session-reuse.md` — the session work (D1–D7).

## Open question carried into Plan 3

Claude re-negotiates MCP tool schemas on every launch and requires
`--mcp-config` to be re-passed on resume, so the per-run MCP config file
(`cli-adapters.ts:143`) must outlive a single run. Its lifetime moves from the
run to the vendor session; `launchCleanup` must stop deleting it while a
session id referencing it is still stored.
