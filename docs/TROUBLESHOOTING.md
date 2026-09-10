# Troubleshooting

> **First stop: run `octi doctor`.** It runs 16 environment checks (node, .env, vault keys, shell sandbox, storage mode, base persona, Octipus home, Ollama, LiteLLM, postgres, backend, capabilities, MCP server build, browser extension, log sanity, disk space) and prints exactly what's wired and what's missing, with a one-line hint per failure. Add `--json` for machine-readable output. Most of the sections below are reachable from a doctor warning.

## pgvector Extension Requires Superuser

**Problem**: `CREATE EXTENSION vector` fails with "permission denied".

**Solution**: Install using the database superuser:
```bash
docker exec <db-container> psql -U <superuser> -d octipus \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
```
The migration handles this gracefully — if the extension can't be created, it logs a warning and continues without vector search.

## Migration Error: "Can't find meta/_journal.json"

**Problem**: Drizzle ORM migrations fail because the metadata journal file is missing.

**Solution**: restore `src/db/migrations/meta/_journal.json` from the same
repository revision as the migration SQL files (or reinstall the matching
release). Do not invent a one-entry journal: it can omit migrations while
making the install appear initialized. Then run `npm run db:migrate` against
the intended database and inspect the result.

## Collation Version Mismatch Warning

**Problem**: PostgreSQL warns about collation version mismatch.

**Cause**: Database created with a different collation-library version. This
can affect index ordering; do not dismiss it as harmless.

**Solution**: follow the PostgreSQL upgrade/reindex procedure for your
installation before refreshing the recorded collation version. Refreshing the
version alone does not rebuild affected indexes.

## Model Registry Duplicate Key on Restart

**Problem**: Server crashes with `Key (name)=(cli/codex-cli) already exists`.

**Status**: Fixed — the model registry now checks existence regardless of `isEnabled` status.

## Database Connection Failed

```bash
# Check PostgreSQL is running
cd ~/docker-services && docker compose ps db

# Start if stopped
docker compose up -d db

# Verify connection
docker exec <db-container> psql -U <user> -d octipus -c "SELECT 1;"
```

## LiteLLM Not Running

```bash
cd ~/docker-services
docker compose up -d litellm
docker compose logs litellm
curl http://localhost:4000/health
```

## LiteLLM 401 / "unreachable" when adding a model

The proxy enforces a master key but Octipus has none set **at system scope**.
Set it via **Secrets → LiteLLM Proxy → LiteLLM Master Key** (do *not* use the
generic Add-Secret table — that stores at user scope, which the backend never
reads). Full guide: **[LiteLLM Proxy](./LITELLM.md)**.

## Port Conflicts

```bash
lsof -i :3005   # Backend
lsof -i :3007   # Web UI

# Or change ports in .env
API_PORT=3008
WEB_PORT=3009
```

## Browser Tool: Playwright Not Installed

```bash
npx playwright install chromium
```

## "No model bound to topic X"

**Problem**: An agent fails to spawn with an error about an unbound topic, for example `No model bound to topic 'security'` or `No model bound to topic 'embedding'`.

**Cause**: Topic→model routing is authoritative and fails loud — no hardcoded default model. Every role has a matching topic, and the corresponding topic must have a model assigned before any agent of that role can spawn. Embedding and vision topics (`embedding`, `vision`, `ocr`) have the same requirement.

**Solution**: Bind a model to the topic:
1. Web UI → Settings → Models → click a model → Edit.
2. Select the offending topic under **Topics**.
3. Save. Swarm spawns retry on the next message.

Alternatively `PATCH /api/models/:name` with `{ "topicRoles": { "security": "primary" } }` (or similar) via the REST API.

## "Insufficient token budget for child spawn"

**Problem**: `spawn_child` returns `ChildResult{ status: 'budget' }` before the child runs a single LLM call.

**Cause**: Token budgets cascade — the child's cap is `min(LEVEL_DEFAULT[child.depth].tokens, parent.remaining − RESERVE)` where RESERVE is 10% of the parent's cap. A parent that has already consumed most of its token pool leaves too little for the child. Common with deep trees or heavy parent reasoning before delegation.

**Solution**:
- **Delegate earlier** — move `spawn_child` calls before expensive parent synthesis.
- **Reduce fan-out** — parallel children divide the parent's remaining pool. Four parallel subagents after heavy parent use can each get very little. Prefer sequential spawns or fewer parallel groups.
- **Escalate instead of respawn** — if all parallel children return `budget`, use `escalate_to_different_expert` (1/Agent lifetime) rather than respawning tighter.
- If you keep hitting this on the Root agent, review `swarm.levelDefaults.root.tokens` in Settings. Wall-clock does **not** cascade, only tokens.

## Rate-limit 429 on Free OpenRouter Models

**Problem**: Health check or agent run spits 429s on free-tier OpenRouter models (`:free` suffix).

**Cause**: Free-tier OpenRouter models are aggressively rate-limited — a minute-probe health loop will trip them immediately. By design, the health check now **skips OpenRouter entirely** (OpenRouter has its own `/auth/key` endpoint used elsewhere); it also skips OCR/vision/TTS/transcription models since they don't respond to the text-completion probe.

**Solution**:
- If you see 429s from a running agent (not health check), the user request itself is hitting the free-tier limit. Either wait, switch to a paid model via the topic binding, or split the work across more `spawn_child` calls so each child makes fewer calls.
- If the health dashboard shows an OpenRouter model as red, check `/api/models/health` — it should skip OpenRouter rows. If it doesn't, the filter may have regressed; file an issue.

## MCP Server Stuck Disconnected After Repeated Failures

**Problem**: A configured MCP server refuses to reconnect; the UI shows it permanently disconnected.

**Cause**: The MCP circuit breaker opened after 3 consecutive failures. Subsequent calls fail fast without hitting the server until the exponential backoff elapses.

**Solution**: Check breaker state and reset after fixing the underlying issue:
```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3005/api/mcp/circuit
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://localhost:3005/api/mcp/circuit/<serverId>/reset
```
If failures continue after reset, the breaker will trip again — diagnose the server, don't loop on resets. See [MCP-INTEGRATION.md](./MCP-INTEGRATION.md) for breaker states.

## Knowledge Base Not Ready

**Problem**: `/api/knowledge/search` or `/api/knowledge/index` returns 503 with `{ kb: { ready: false, reasons: [...] } }`.

**Cause**: The KB self-check (`src/core/rag/health.ts`) failed at startup — either the DB probe, the embedding-model resolution (no model bound to topic `embedding`), or the vector write probe. The readiness endpoint is now fail-loud by design.

**Solution**:
1. `curl /api/knowledge/readiness` to see the exact reasons.
2. Bind a model to the `embedding` topic (see "No model bound to topic X" above).
3. Ensure `pgvector` extension is installed and the embedding migration ran.
4. Re-hit `/api/knowledge/readiness` — it re-runs the self-check on demand.

## Root agent Fails with "Value looks like object, but can't find closing '}'"

**Problem**: Chat fails after a few seconds with logs like:
```
ERROR: Root agent agent failed
  error: { reason: "tool_call_invalid", message: "{\"error\":\"Value looks like object, but can't find closing '}' symbol\"}", providerHint: "ollama" }
```

**Cause**: the provider rejected a malformed tool call. The root runs as a
general agent and can answer without a tool call; tool JSON failures can affect
both the root and specialists.

Earlier May 2026 QA runs found failures with some Qwen3/Ollama combinations.
Those observations do not establish compatibility for current model releases,
quantizations, or parser versions. Run the model capability probe and a small
representative task using the exact configuration you intend to deploy.

Check `supportsTools`, prompt tier, context size, and the provider error. If the
model cannot reliably call the required tools, explicitly select another tested
model. Octipus does not automatically replace an entire model family based on
the old compatibility list. See [Small models](SMALL-MODELS.md).
