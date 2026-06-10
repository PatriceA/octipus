# Follow-up — agent-quality issues observed 2026-06-10

Observed while running the multi-user e2e on `feat/multiuser-only` against a
live stack (orchestrator = `deepseek-v4-flash`). None are caused by the
multi-user change; they are pre-existing agent-quality / observability gaps
surfaced by the run. Logged here for follow-up PRs.

Evidence is from `~/.octipus/backend.log` (run of 2026-06-10 ~20:11–20:15).

---

## 1. Orchestrator silently falls back to **lite** for external models

### Symptom
```
WARN: Could not determine model size for orchestrator mode — defaulting to lite
INFO: Orchestrator mode resolved   orchestratorMode: "lite"
```
`deepseek-v4-flash` (~128B per the user) is registered as the orchestrator.
`deriveParamCount` (`src/core/orchestrator/mode-selector.ts:46`) can only read
the size from `metadata.paramCount` or an Ollama-style id tag (`…:32b`,
`…8x7b`). An external model id like `deepseek-v4-flash` carries no `<N>b`
token, so it returns `undefined` → `resolveOrchestratorMode` defaults to
**lite** (`mode-selector.ts:105-110`).

### Impact
Lite mode is single-step delegation — it **cannot run the full swarm**
(parallel siblings, 3-level chains). This very likely explains the two
"failures" in the e2e run:
- `Agent spawns Subagent — 3-level chain` (swarm node did not succeed)
- `Parallel fan-out — siblings overlap` (all spawns ran sequentially)

i.e. those are not bugs in the swarm — the orchestrator was running in lite
mode the whole time because its size couldn't be inferred.

### Proposed fixes (pick 1–2)
1. **Surface `metadata.paramCount` in the Models UI** so the operator can set
   the size for any model. `deriveParamCount` already prefers it
   (`mode-selector.ts:47`); today there's no UI/most external rows leave it
   null. *Low effort, highest leverage.*
2. **Honor an explicit per-deploy mode override more visibly.**
   `config.orchestrator.mode` already accepts `'full' | 'lite' | 'router'`
   (not just `'auto'`) and pins the mode regardless of size
   (`mode-selector.ts:102`). It's only reachable via env/settings today; add a
   first-class control (Models/Settings page) so "auto-detect failed → force
   Full" is a one-click action. The user explicitly asked for this.
3. **Widen the heuristic** for known external families (a small id→params
   table, or treat "flash/mini/nano" vs "pro/large" tiers) so common ids
   don't dead-end at lite. *Brittle; do (1)+(2) first.*

Note: when the size is unknown the current default is **lite**, which is the
*least* capable middle band. Consider whether "unknown → full" (assume capable
unless told otherwise) is the safer default for a configured orchestrator.

---

## 2. Tool failures are logged as `error: {}` — real cause is masked

### Symptom
```
ERROR: Tool execution failed   toolId: "filesystem"  tool: "search_files"   error: {}
ERROR: Tool execution failed   tool: "read_file"      error: {}
ERROR: Tool execution failed   tool: "list_directory" error: {}
```
The user counted `filesystem__search_files` failing 7/8 and
`filesystem__list_directory` 3/5. The agent is calling the **correct**
prefixed tools — they are genuinely throwing, but the cause is invisible
because an `Error` is logged as a bare object: its `message`/`stack` are
non-enumerable, so `{ error }` serializes to `{}`.

Two log sites do this:
- `src/tools/base-tool.ts:211` — `toolLogger.error({ error, … }, 'Tool execution failed')`
- `src/core/tool-executor.ts:512` — `agentLogger.error({ error, … }, 'Tool execution failed')`

### Impact
- We can't tell *why* the filesystem tools fail (ENOENT on an empty per-user
  workspace? `resolveAndValidate` sandbox rejection? a thrown `readdir`?).
- The agent burns iterations retrying a tool whose error it can't see either.

### Proposed fix (do this FIRST — it unblocks diagnosing everything else)
Log the message/stack, not the raw object. Pino has a built-in `err`
serializer, so the minimal change is to log under the `err` key:
```ts
// base-tool.ts:211 and tool-executor.ts:512
toolLogger.error({ err: error, toolId: this.id, tool: toolName }, 'Tool execution failed');
```
(or `{ error: (error as Error).message, stack: (error as Error).stack }`).
Then re-run and capture the real failure. Strong suspicion: the relocated +
per-user workspace root (`~/.octipus/workspace/users/<id>/workspaces/default/
files`) is empty or not yet created for the e2e user, so `readdir`/`readFile`
throw ENOENT. `WorkspaceFS.ensureRoot()` exists — confirm the read/list/search
paths call it (or treat "missing dir" as "empty result" rather than throwing).
*Note: `search_files` already returns `{ results: [], error }` for a bad regex
but **throws** on a bad path — inconsistent; a missing dir should probably
return empty, not throw.*

---

## 3. No tool-NAME normalization / router (wasted iterations on near-misses)

### Observation
Models periodically emit the wrong tool name (`read_file` instead of
`filesystem__read_file`, `search_files` instead of `filesystem__search_files`).
In this run the agent layer always received the prefixed names, but the
provider/agent has no recovery if it doesn't: `tool-executor` does a strict
`this.tools.get(name)` and returns `Unknown tool: <name>` on any miss
(`src/core/tool-executor.ts:247`). There is normalization for tool-call **IDs**
(`src/models/message-transform.ts:normalizeToolCallId`) but **nothing for tool
names**.

### Impact
A single wrong name = a wasted iteration (the model gets "Unknown tool", has to
re-plan). Compounded with #2, runs accumulate many dead iterations.

### Proposed fix
Add a small name-normalization step before the `Unknown tool` path in
`tool-executor.handleToolCalls`:
1. **Exact alias map** for the common bare→prefixed misses across all tool
   groups (`read_file`→`filesystem__read_file`, `search_files`→
   `filesystem__search_files`, `list_directory`→`filesystem__list_directory`,
   …). Build it from the registry: any unambiguous sub-tool name (one tool
   group owns it) maps to its prefixed form.
2. **Fuzzy fallback**: if still unmatched, pick the closest registered name
   (Levenshtein ≤ 2) and either auto-route or return a "did you mean
   `filesystem__read_file`?" error so the next iteration is corrected cheaply.
   Auto-route only for *unambiguous* matches to avoid silently calling the
   wrong tool.

---

## Suggested order
1. **#2 logging fix** (tiny) — so we can actually see tool errors.
2. **#1 mode override** (UI `paramCount` + force-mode) — restores full-swarm
   behavior for external orchestrators; should make the two e2e swarm tests
   deterministic.
3. **#3 name router** — recovers wasted iterations from near-miss tool names.

Each is independent and small; suggest one PR per item.
