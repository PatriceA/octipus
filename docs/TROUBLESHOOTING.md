# Troubleshooting

> **First stop: run `octi doctor`.** It runs 15 environment checks (bun, .env, vault keys, storage mode, base persona, Ollama, LiteLLM, postgres, redis, backend, MCP server build, browser extension, log sanity, disk space) and prints exactly what's wired and what's missing, with a one-line hint per failure. Add `--json` for machine-readable output. Most of the sections below are reachable from a doctor warning.

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

**Solution**:
```bash
mkdir -p src/db/migrations/meta
```
Create `src/db/migrations/meta/_journal.json`:
```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1708000000000,
      "tag": "0000_initial",
      "breakpoints": true
    }
  ]
}
```

## Collation Version Mismatch Warning

**Problem**: PostgreSQL warns about collation version mismatch.

**Cause**: Database created with a different OS/glibc version. Harmless.

**Solution** (optional):
```sql
ALTER DATABASE octipus REFRESH COLLATION VERSION;
```

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

## Valkey Connection Failed

```bash
cd ~/docker-services && docker compose ps valkey
docker compose up -d valkey
docker exec <valkey-container> valkey-cli ping
```

## LiteLLM Not Running

```bash
cd ~/docker-services
docker compose up -d litellm
docker compose logs litellm
curl http://localhost:4000/health
```

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
bunx playwright install chromium
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
- If you keep hitting this on the Orchestrator, bump `LEVEL_DEFAULT[0].tokens` in `src/core/swarm/types.ts`. Wall-clock does **not** cascade, only tokens.

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

## Orchestrator Fails with "Value looks like object, but can't find closing '}'"

**Problem**: Chat fails after a few seconds with logs like:
```
ERROR: Orchestrator agent failed
  error: { reason: "tool_call_invalid", message: "{\"error\":\"Value looks like object, but can't find closing '}' symbol\"}", providerHint: "ollama" }
```

**Cause**: The orchestrator is the only role in the swarm that *must* emit valid tool-call JSON every turn (it routes work via `spawn_child` / `create_pipeline`). Some local models produce JSON that Ollama's strict Go-side parser rejects — the body text quoted above is verbatim from Ollama, not Octipus. Octipus already classifies this as retryable, but retries don't help when the problem is structural to the model.

**Local-model orchestrator compatibility (observed 2026-05-12 QA run)**:

| Model | As orchestrator | Notes |
|---|---|---|
| `glm-4.7-flash:latest` | ✅ Works | Tested end-to-end; recommended baseline for local orchestrator. |
| `qwen2.5:32b+` | ✅ Generally works | Proven tool-calling track record at 32B+. |
| `qwen3:*`, `qwen3.6:*` (any size up to 35B observed) | ❌ Fails | All Qwen3 family sizes tested fail with the unbalanced-JSON parser error. Not recommended at any local size below ~35B; even 35B Qwen3 has been observed to fail. The `known-bad-orchestrators` list auto-swaps these to a working alternative if one is configured. |
| `qwen3-vl:*` | (vision-only, not for orchestrator) | Distinct family, not on the bad list — but a VL model shouldn't be the orchestrator anyway. |

**Recommended setup**:
- **Local-only**: install `glm-4.7-flash:latest` in Ollama and bind it as default. Use Qwen models for *workers* (writing, coding, etc.) where their output is plain text, not tool-call JSON.
- **Hybrid**: keep a cloud model (Deepseek, OpenAI, Anthropic, Gemini) as the orchestrator default; auto-swap will fall back to it if a Qwen model is somehow assigned.

**Solution**:
1. In **Models → add model**, pull `glm-4.7-flash:latest` (or any cloud model) and set it as the default for the orchestrator topic.
2. Restart the backend or trigger a model reload — the next chat turn will pick the new default.
3. If you keep Qwen as default, the auto-swap logic in `src/core/orchestrator/model-selector.ts` will warn and swap to another tool-capable model in the registry. If no swap candidate exists, the chat still fails — that's why the manual recommendation above matters.

To add new known-good or known-bad orchestrator models, edit `src/core/orchestrator/known-bad-orchestrators.ts`. The pattern is a regex matched case-insensitively against the model id.
