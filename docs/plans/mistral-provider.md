# Mistral provider — API + CLI (`vibe`)

**Status:** design / not started · **Authored:** 2026-06-16

Add Mistral to Octipus two ways:

1. **API provider** (direct) — `mistral-large`, `codestral`, `mistral-embed`, etc. via Mistral's OpenAI-compatible API.
2. **CLI provider** — wrap Mistral's `vibe` agentic CLI (installed binary `vibe`, v2.16.1) as a `CLIAgentWorker`, the same mechanism Claude Code / Gemini CLI / Codex use.

Two PRs, independent and cleanly separable. Sonnet code review before each PR (project rule). No Drizzle migration — `model_config.provider` is free-text, so no schema change and no journal entry.

---

## Background: how the CLI-agent mechanism works

Claude Code is wired in as a **CLI-type provider** — Octipus shells out to the `claude` binary instead of hitting an API.

- **Tool config** — `src/models/providers/cli-provider.ts` → `claudeCodeConfig` (a `CLIToolConfig`): binary, model patterns, quota detection, billing pointers. Registered in the `CLI_TOOLS` array.
- **Routing** — model row has `provider='cli'`, `model_id='cli/claude-code'`. `agent-manager.ts:156` calls `isCLIProvider()` → spawns a `CLIAgentWorker` instead of the API `AgentWorker`. `getCLIToolConfig()` (`cli-agent-factory.ts`) matches `model_id` against each tool's `modelPatterns`.
- **Spawn + I/O** — `cli-agent-worker.ts:executeCLI()` builds args via `CLIArgumentBuilder`, `spawn()`s the binary in the agent's workspace cwd, pipes the prompt, streams stdout.
- **Parse** — `CLIOutputParser` reads the tool's output (Claude/Gemini stream-json, Codex JSONL), accumulates tokens, surfaces file-op events, detects quota exhaustion.
- **Auth** — none stored by Octipus; relies on the host's own CLI login. (Never pass `--bare` to `claude` — breaks OAuth.)

**Key structural fact:** arg-building and output-parsing are **per-tool hardcoded** via `switch(toolName)` in `cli-adapters.ts` (both `CLIArgumentBuilder.build()` and `CLIOutputParser.parse()`). The `buildArgs`/`parseOutput` fields on `CLIToolConfig` are largely vestigial for the agent path — the real work is the switch. Adding a CLI vendor = adding a case in each switch + a `CLI_TOOLS` entry.

### Key files

| Purpose | File | Lines |
|---|---|---|
| Provider interface contract | `src/models/providers/interface.ts` | 7-28 |
| Provider router & registration | `src/models/providers/index.ts` | 76-119 |
| Rate-limit key resolution | `src/models/providers/index.ts` | 43-52 |
| Setup wizard registry | `src/setup/providers.ts` | 19-164 |
| Model DB schema (+ `CLIAgentConfig`) | `src/db/schema/models.ts` | 4-130 |
| CLI tool configs + `CLI_TOOLS` | `src/models/providers/cli-provider.ts` | 31-226 |
| CLI arg-build / output-parse switches | `src/core/cli-adapters.ts` | 99-115, 343-355 |
| Octipus MCP config generator | `src/core/cli-adapters.ts` | 12-43, 162-165 |
| CLI agent spawning | `src/core/cli-agent-worker.ts` | 280-560 |
| CLI detection helpers | `src/core/cli-agent-factory.ts` | 1-20 |
| Reference API providers | `src/models/providers/{openai,deepseek,grok}-provider.ts` | — |

---

## Part A — Mistral API provider (direct)

1. **Create `src/models/providers/mistral-provider.ts`** implementing `ModelProvider`:
   - `type = 'direct'`; `supportsModel()` matches `mistral-*` / `magistral-*` / `codestral-*` / `ministral-*`.
   - Implement `complete()`, `stream()`, `checkHealth()`, optional `embed()` (`mistral-embed`).
   - Clone `deepseek-provider.ts` — Mistral's `/v1/chat/completions` is OpenAI-compatible. Base URL `https://api.mistral.ai/v1`.
   - Key resolution: `MISTRAL_API_KEY` env → vault `mistral_api_key` (secrets live in vault, not `.env` — project rule).
   - Wrap errors with `classifyError(err, 'mistral')`.
2. **Register** in `src/models/providers/index.ts`: import + `this.providers.push(new MistralProvider())`; add a `mistral` case to `resolveRateLimitKey()` if needed; export the type.
3. **Setup registry** `src/setup/providers.ts`: add `'mistral'` to the `ProviderId` union and a `PROVIDERS` entry — `label: 'Mistral AI'`, `defaultModel: 'mistral-large-latest'`, `requiresApiKey: true`, `vaultKey: 'mistral_api_key'`. Optionally add `listModels` hitting `GET /v1/models`.
4. **Seed `model_config` rows** — `provider='mistral'`, `model_id='mistral-large-latest'`, `endpoint`, `apiKeyRef='mistral_api_key'`.
5. **Embeddings (optional)** — if exposing `mistral-embed`, bind it for the embedding topic.

---

## Part B — Mistral `vibe` CLI provider

### `vibe` CLI — verified findings (v2.16.1)

| Concern | Result |
|---|---|
| Programmatic mode | `vibe -p "<prompt>"` — send prompt → response → exit |
| Output format | `--output json` → **JSON array of all messages** at end; the last `role:"assistant"` element's `.content` is the answer. Reliable & fast. |
| Streaming | `--output streaming` (NDJSON) **hung in a non-interactive pipe → timeout/exit 124**. Avoid; use `json`. |
| Non-interactive must-haves | `--trust` (skip workdir trust prompt) + `--auto-approve` (else blocks on tool-approval prompts) |
| Token usage in output | **None** — JSON array carries no usage/cost fields → `parseOutput` returns usage `0` (same graceful path as the plain-text fallback) |
| cwd / file access | `--workdir DIR`, `--add-dir DIR` |
| Built-in budget caps | `--max-turns N`, `--max-price DOLLARS`, `--max-tokens N` — map onto `CLIAgentConfig.maxBudgetUsd` / token budget. **Prefer these** since usage isn't reported back. |
| Tool whitelist | `--enabled-tools` (glob / `re:` regex) → maps to `CLIAgentConfig.allowedTools` |
| Sessions | `-c`/`--continue`, `--resume [ID]` |
| Auth | `vibe --setup` stores key in `~/.vibe/.env`; `VIBE_HOME` overrides config dir. Octipus stores nothing (same as `claude`). |
| Context file | vibe reads `AGENTS.md` (per its own system prompt), not `CLAUDE.md` |

Sample `--output json` fixture captured at `/tmp/vibe_json.txt` (3-element array: system, user, assistant).

### B.1 — Tool config (`cli-provider.ts`)

Add `vibeCliConfig: CLIToolConfig` and append to `CLI_TOOLS` + the named export:
- `name: 'Mistral Vibe'`, `modelPatterns: ['cli/vibe','cli/mistral-vibe']`, `binaryPath: 'vibe'`
- `quotaProvider: 'mistral-vibe'`, `modelProvider: 'openai'`
- `modelFlag`: n/a — vibe selects model via config/agent, not a flag; set `''` and document
- `parseOutput`: `JSON.parse(stdout)` → `findLast(m => m.role==='assistant').content`; usage `0`; fallback to `stdout.trim()` on parse failure
- `isQuotaError`: `/rate.?limit|quota|exceeded|insufficient|limit reached/i`
- `billingInfo`: vendor `Mistral AI`, `billingMode:'api-key'`, pricing `https://mistral.ai/pricing`

### B.2 — Adapters (`cli-adapters.ts`) — the real work

- `CLIArgumentBuilder.build()`: add `case 'Mistral Vibe': return this.buildVibeArgs(...)`.
  Args: `['-p', prompt, '--output','json','--trust','--auto-approve','--workdir', cwd]` plus conditional `--max-price` / `--max-tokens` / `--max-turns` / `--enabled-tools` from settings / `CLIAgentConfig`. Prompt passed positionally (no stdin needed on non-Windows).
- `CLIOutputParser.parse()`: add `case 'Mistral Vibe'`. **Note:** vibe emits the whole array at process end, not incremental events. Simplest path is to let the worker run `toolConfig.parseOutput` on accumulated stdout at close (the buffer-at-end path) rather than per-event streaming.
  ⚠️ **Verify at implementation:** confirm `cli-agent-worker.ts:459-545` (stdout `data` accumulation + `close` handler) cleanly handles a tool that emits *no* stream events. If the close handler already falls back to `parseOutput` on the full buffer, the parser case is a near no-op; if it requires at least one parsed event, add a minimal branch.
- Add `'Mistral Vibe' → 'AGENTS.md'` to `contextFileMap` so the system prompt is written as `AGENTS.md`.

### B.3 — MCP injection (give vibe the Octipus MCP)

vibe has **no `--mcp-config` flag** (unlike Claude). MCP lives in `~/.vibe/config.toml` under `mcp_servers` — the **Gemini pattern** (config-side registration), not a per-call file.

**vibe MCP schema** (verified from package source `vibe/core/config/_settings.py`): `mcp_servers` is a discriminated union on `transport` (`stdio` | `http` | `streamable-http`). Octipus's MCP server is stdio:

```toml
[[mcp_servers]]
name = "octipus"          # prefixes tool names → octipus_<tool>
transport = "stdio"
command = "node"          # or "bun" when running from src
args = ["/abs/path/to/octipus/mcp-server/dist/index.js"]
# env = { KEY = "val" }   # dict, not list
# cwd = "/abs/path"
# startup_timeout_sec = 10.0, tool_timeout_sec = 60.0, disabled = false, disabled_tools = []
```

(`_MCPBase` fields: `name`, `prompt`, `startup_timeout_sec`, `tool_timeout_sec`, `sampling_enabled`, `disabled`, `disabled_tools`; stdio adds `command`/`args`/`env`/`cwd`. There is **no** `vibe mcp add` subcommand — config is edited directly.)

**Mechanism — ephemeral `VIBE_HOME` (recommended).** vibe honors `VIBE_HOME` to relocate its config dir. On spawn, build a temp dir seeded from the real `~/.vibe` (copy `.env` for the API key + `trusted_folders.toml`), write a `config.toml` with the octipus `[[mcp_servers]]` entry merged in, and pass `env: { VIBE_HOME: <tmpdir> }` in `spawn()` opts. Add `getOrCreateVibeHome()` in `cli-adapters.ts`, parallel to `getOrCreateMcpConfig()`.
- Isolated, multi-user-safe (Octipus is always multi-user — each user's agent gets its own `VIBE_HOME`), no global side-effects.
- Reuse `getOrCreateMcpConfig()`'s path-resolution (projectRoot + dist/src + node/bun detection) — factor it out so both the JSON (Claude) and TOML (vibe) generators share one resolver.

**Fallback — idempotent merge into `~/.vibe/config.toml`** (one-time, setup-wizard or lazy pre-spawn). Simpler but global/shared → bad fit for multi-user and races on concurrent registration. Use only if `VIBE_HOME` proves unreliable.

⚠️ **Verify at implementation:** that vibe with a seeded `VIBE_HOME` actually loads `mcp_servers` and exposes `octipus_*` tools in `-p` mode (some CLIs only load MCP interactively):
`VIBE_HOME=/tmp/vh vibe -p "list your tools" --output json --trust`

### B.4 — Routing / DB / auth

- Routing is automatic via `getCLIToolConfig()` once `model_id` starts with `cli/vibe`.
- Seed `model_config`: `provider='cli'`, `model_id='cli/vibe'`, `metadata.cliAgent` with `maxBudgetUsd` / `allowedTools`.
- Setup-wizard note: host must have run `vibe --setup` (no vault key — vibe manages its own creds in `~/.vibe`, like `claude`).

### B.5 — Tests

- Adapter unit tests: arg-build assertions + a captured `--output json` fixture (`/tmp/vibe_json.txt`) asserting last-assistant extraction and the plain-text fallback.
- `bun run test`.

---

## Open verifications (carry into execution)

1. `cli-agent-worker.ts` close-handler behavior for a buffer-at-end (non-streaming) tool — decides whether B.2's parser case is real or a no-op.
2. vibe loads `mcp_servers` from a seeded `VIBE_HOME` in `-p` mode and exposes `octipus_*` tools.
