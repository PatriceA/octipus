# Prompt Generation & Provider Efficiency Audit — 2026-07

Full audit of (1) prompt generation, (2) provider-specific tool use vs current
API docs, (3) primary/backup/executor model routing, (4) CLI-model prompting
and tool/skill discovery. Successor to `llm-prompt-compression.md` /
`-followups.md` (whose phases are all shipped); this file lists what those
plans did NOT cover, verified against provider docs fetched 2026-07-19.

Items marked ✅ were fixed in the branch that added this file; everything else
is a ranked backlog.

---

## 1. Prompt generation

The caching architecture (static → semi-static → volatile bucketing,
`cache_control` split at the `CURRENT DATE` marker) and progressive skill/tool
disclosure are solid. Remaining findings:

| # | Finding | Impact | Where |
|---|---|---|---|
| ✅ F7 | **Cache-busting placement bug**: the `# Topic Skills` fragment is ranked against the per-task MESSAGE (hybrid `discoverSkillIds`) but was pushed into `staticParts` — the "static" prefix changed spawn-to-spawn, silently negating Phase 2a prefix caching for every hybrid-skill worker. Moved to `volatileParts`, after the date marker. | HIGH (cache correctness) | `worker-spawner.ts` |
| F1 | Orchestrator `prompt.md` is ~2,500 tok (4× the next-largest role prompt, 4× its own lite variant); internally redundant (delegate-everything stated 3×). Frontier models always get the full version. This is follow-up Item C, still un-A/B'd. | HIGH | `roles/orchestrator/prompt.md` |
| F2 | Delegation instructions triplicated: orchestrator DELEGATION/ROUTING sections (~1,000 tok) + runtime classification appendix (~250 tok, effectively volatile) + `buildDelegationGuidance` role catalog. Shrink the appendix to one line; keep the role catalog in one place. | HIGH | `orchestrator-runner.ts:251-253`, `swarm-tool.ts` |
| F3 | `AGENTS_MD_INSTRUCTION` (~190 tok) injected into every worker of every role — including writing/finance/pm/communication which never touch a repo. Gate on `GIT_AWARE_ROLES` or `devProjectPath`. | MEDIUM | `worker-spawner.ts` |
| F4 | Workspace-constraint + plugin-directory hint (~150 tok) injected for roles with no filesystem/shell tools. Gate on the role's toolset. | MEDIUM | `worker-spawner.ts:654-691` |
| F5 | Large-model "Response Guidelines" block added only on the `/expert` path, not the auto-expert path; same rules also duplicated inside most role prompt.md files. Hoist once into the role layer. | MEDIUM | `worker-spawner.ts:173-179` |
| F6 | Volatile blocks are cache-correct but verbose: date block is a ~110-tok paragraph re-billed every turn; recent history is 10 msgs × 500 chars. Terse-ify the date line; token-budget the history. | MEDIUM | `orchestrator-runner.ts:188-189, 242` |
| F8 | Lazy tool advertisement is Ollama-only; a 14-tool role ships ~1,600 tok of schema to every provider (cached after turn 1 where caching works — acceptable, revisit only for very large tool roles). | LOW | `worker-spawner.ts:806-839` |

## 2. Provider tool-use vs current API docs

Doc sources checked: platform.claude.com (OpenAI-compat + prompt caching),
developers.openai.com (reasoning), ai.google.dev (OpenAI-compat), DeepSeek
tool_calls/reasoning guides, docs.x.ai function calling, platform.kimi.ai,
docs.z.ai. Top issues, ranked:

1. **Reasoning/thinking is never actually engaged.** `applyThinkingBudget`
   (`providers/index.ts:395-433`) only bumps `maxTokens`; `supportsThinking`
   (`thinking-budget.ts:49-54`) misses `gpt-5`, `claude-*`, `gemini-*`. OpenAI
   `reasoning_effort`, Anthropic `thinking` (works on compat via `extra_body`),
   and Gemini `reasoning_effort`/`thinking_config` are all never sent.
2. **Anthropic caching covers only the system prefix** (1 of 4 allowed
   breakpoints). The growing tool-result history re-bills at full input price
   every agentic iteration. Add a rolling breakpoint on the last history block
   (`prompt-cache.ts`, `custom/anthropic-compat-provider.ts:137`,
   `openrouter-provider.ts:56`).
3. **gpt-5 400s on temperature**: `omitsTemperature` only matches `^o\d`
   (`openai-provider.ts:49-51`).
4. **Gemini structured output needlessly disabled**: `response_format` is
   stripped (`gemini-provider.ts:87-88, 241-242`) though the compat endpoint
   supports it; the Flash `max_tokens ≥ 8192` inflation workaround
   (`:73-77`) is obsolete for the same reason.
5. **Grok ignores `tool_choice`** — hardcoded `'auto'` (`grok-provider.ts:65,
   166`), so forced-tool escalation silently no-ops.
6. **Vertex**: no Gemini schema sanitization on tools (can 400 on complex
   schemas), hardcoded tool_choice, raw `JSON.parse` instead of the shared
   repair parser (`vertex-provider.ts:55, 90, 116`).
7. **`MIN_CACHEABLE_CHARS = 4000` (~1k tok) is below the 4096-tok per-model
   minimum** for some Anthropic models → breakpoint is a silent no-op there.
   Make it model-aware (`prompt-cache.ts:19`).
8. **Pairing sanitizer skipped on grok/zai/moonshot/vertex** — they call bare
   `formatMessages` instead of `transformMessagesForProvider`, so a compacted
   history can send `tool_calls` without the matching tool reply → 400
   (`grok:282, zai:295, moonshot:268, vertex:204`).
9. **Anthropic compat stream double-yields tool args** at finish
   (`anthropic-provider.ts:209-217`) — inconsistent with every other provider;
   reconcile before a consumer accumulates arguments twice.
10. **Compat path still sends `response_format` to Anthropic** — documented as
    ignored; json_object silently degrades to prose (`anthropic-provider.ts:65`).

Correct and worth keeping as-is: toolshim (a gated last-resort recovery, not a
token-wasting prompt shim), Mistral provider (tool-id remap, cache key),
DeepSeek template-leak recovery, Ollama dual native/v1 path, per-provider
tool flags in `capabilities.ts` (except understated `structuredOutput` for
gemini/ollama).

## 3. Primary / backup / executor routing

Now documented in **`docs/MODEL-ROUTING.md`** (resolution order, planner→
executor split, backup semantics). Root cause of "executor never used":

- The one prompt surface that mentioned it (`EXECUTOR AVAILABLE`) reaches only
  depth-1 children whose lane binds an executor; the `plan` param was the
  last-listed optional param with an "ONLY when…" framing and no example;
  the static delegation guidance never mentioned cost; nothing measured it.
- Design intent (per the maintainer): the **orchestrator stays executor-blind**
  — it routes experts by topic. The **topic/expert-bound agent** is the
  planner; its planned sub-work runs on the lane executor.

✅ Fixed in this branch:
- `spawn_child` `plan` description rewritten (mechanics + cost + example) and
  moved above the other optional params (`swarm-tool.ts`).
- `buildDelegationGuidance` rule 5: mechanical + fully-specified ⇒ pass a
  `plan` (depth-1 agents only — the orchestrator never sees this text).
- `parsePlan` accepts bare-string steps (lenient shorthand).
- Observability: `octipus_swarm_spawns_total` gained a `planned` label; the
  plan-less-skip breadcrumb raised debug→info; new info logs when the executor
  is selected and when an expert `modelPreference` shadows it.
- Docs: `docs/MODEL-ROUTING.md`; fixed the wrong precedence claim in
  `EXPERT-TOPIC-SKILL-ROUTING.md` (expert `modelPreference` WINS over the
  topic binding — it does not "only apply when no topic binding exists").

Backlog (needs a live A/B before hard enforcement):
- If planned-spawn rates stay ~0 after the prompt changes, consider hard
  enforcement: auto-synthesize/require a plan for mechanical
  `expectedOutput.shape`s (list/json/code-diff) in `validateSpawnChildArgs`,
  or invert the default (executor unless the parent flags `needsJudgment`).
- Decide the expert-`modelPreference`-vs-executor precedence explicitly
  (currently preference wins; now at least logged).
- Fallback (backup) selection is failure-only and never cost-aware — fine, but
  document per-topic backups as the cost lever, not the breaker chain.

## 4. CLI models (Claude Code / Codex / Antigravity / vibe / GLM / Kimi)

The maintainer's instinct is right: CLI agents can't take injected tool
schemas (`registerTools` is a no-op in `cli-agent-worker.ts:101-104`) and MCP
is the intended bridge — and it is MOSTLY BUILT: a 26-tool-module standalone
server (`mcp-server/`), per-spawn ephemeral `--mcp-config` for Claude-family
CLIs, `VIBE_HOME` TOML injection for vibe, global config stamping for
codex/agy via `bin/octi`. Gaps, ranked:

1. ✅ **Skill-tool name mismatch (the skill-discovery breaker).** System
   prompts tell agents to call `get_skill`, but over MCP the tool was only
   `octipus_get_skill` — a CLI agent following the prompt called a tool that
   doesn't exist. Fixed by registering `get_skill` / `list_skills` aliases in
   `mcp-server/src/tools/skills.ts` and adding a Skills bullet (with the name
   mapping) to the CLI-only MCP prompt block in `worker-spawner.ts`.
2. **`mcp-server/dist` is not built by default** — `bin/octi` hard-skips MCP
   config stamping without it, so codex/agy get no octipus MCP at all until
   someone runs `cd mcp-server && npm run build`. Build it during
   install/start.
3. **Per-spawn MCP wiring is inconsistent**: Claude/GLM/Kimi/vibe get
   per-spawn config; codex/agy rely on a global mutable file (fragile under
   concurrency/rotation; codex supports per-invocation `-c mcp_servers…`,
   agy reads `~/.gemini/settings.json`). Unify on per-spawn ephemeral config
   in `cli-adapters.ts` (`buildCodexArgs`, `buildAntigravityArgs`).
4. **Silent no-MCP launches**: vibe without `~/.vibe/config.toml` and keyless
   configs launch with zero octipus access and no warning — emit a worker
   warning event (`cli-agent-worker.ts:602-609`).
5. Optional: materialize octipus skills to disk (`.claude/skills/*/SKILL.md`)
   in the agent cwd so Claude Code's native skill discovery works without an
   MCP round-trip (read side already exists in `skills/external-loader.ts`).

Clarification worth keeping in mind: `src/mcp/` is the inbound MCP *client*
(octipus consuming external servers); the outbound server CLI agents connect
to is the repo-root `mcp-server/`.

## Suggested sequencing

1. Provider correctness one-liners: gpt-5 temperature, Grok tool_choice,
   pairing transform on grok/zai/moonshot/vertex, drop Anthropic-compat
   `response_format`, reconcile the double-yield. (Small, testable.)
2. Caching yield: rolling history breakpoint for Anthropic-family +
   model-aware min length; terse date block (F6).
3. Reasoning enablement (issue 2.1) — new capability flags + per-provider
   param mapping; eval-gated.
4. CLI/MCP: build dist in install, unify per-spawn wiring, loud no-MCP
   warning.
5. Prompt slimming (F1–F5) — eval-gated, one role at a time.
6. Executor: watch the `planned` spawn rate; escalate to hard enforcement if
   prompting alone doesn't move it.
