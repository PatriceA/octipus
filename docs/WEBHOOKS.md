# Webhooks

Receive events from external services (GitHub, GitLab, Stripe, etc.) and react with AI agents, notifications, or tool executions.

## How It Works

```
External Service ──POST──▶ /api/webhooks/:path ──▶ Hook Manager ──▶ Action
                   (HMAC verified)                  (match by path)
```

1. An external service sends an HTTP POST to `https://<your-domain>/api/webhooks/<path>`
2. The webhook endpoint verifies the HMAC-SHA256 signature, over the raw request bytes, against each matching hook's `webhookSecret`
3. The endpoint answers `202 Accepted` straight away; every hook whose signature verified is then triggered in the background
4. Each hook's action runs — spawn an agent, send a notification, call another webhook, etc.
5. If `notifyOwner: true` is set on a `spawn_agent` action, the agent's output is automatically sent to the owner's linked channels (Telegram, etc.)

## Responses and Delivery Semantics

Both webhook endpoints, `POST /api/webhooks/:path` and `POST /api/hooks/incoming/:hookId`, authenticate the request, answer at once, and run the hook actions in the background. A `spawn_agent` action can take far longer than a sender waits: GitHub gives up after about 10 seconds and redelivers, which used to start a second agent run.

| Status | Body | Meaning |
|--------|------|---------|
| `202` | `/api/webhooks/:path`: `{ "received": true, "accepted": true, "hooks": <n> }`<br>`/api/hooks/incoming/:id`: `{ "status": "accepted", "accepted": true, "hookId", "hookName", "hooks": 1 }` | Authenticated and queued. `hooks` is how many hooks will run. |
| `200` | `{ "received": true, "duplicate": true }` (incoming: `{ "status": "duplicate", "duplicate": true, ... }`) | This delivery id was already seen for this hook; nothing fired. |
| `401` | `{ "error": ... }` | Missing or invalid signature / secret. |
| `404` | `{ "error": ... }` | No hook for this path (or id). |
| `429` | `{ "error": ... }` + `Retry-After: 30` | Too many runs in progress; the sender should retry. |

**Removed response fields.** `/api/hooks/incoming/:hookId` used to wait for the action and return `status: "processed"`, `executed`, `succeeded`, `failed` and a per-hook `results` array. The action hasn't run when the response goes out, so those fields are gone, and an action failure no longer turns into a `500`.

**Where to see results.** Every run, including failures, is recorded in the hook's execution log:

```bash
curl http://localhost:3005/api/hooks/<hook-id>/executions \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" | jq '.executions[0]'
```

A failure before the action started (for example, the database was unavailable) is logged there too, with `status: "error"`.

### Idempotency (duplicate deliveries)

If the sender includes a delivery id, it is remembered per hook, and a repeat is answered `200 {duplicate: true}` without firing. The headers are read in this order: `X-GitHub-Delivery`, `X-Gitea-Delivery`, `X-Gogs-Delivery`, `X-Gitlab-Event-UUID`, `X-Gitlab-Webhook-UUID`, `svix-id`, `webhook-id`, `Idempotency-Key` and `X-Idempotency-Key`. Generic tracing ids such as `X-Request-Id` are not used.

- The id is claimed only after the signature verifies, so an unauthenticated caller can't use up ids.
- While the run is in progress the claim lasts 15 minutes. If the process dies mid-run, a redelivery can run again after that.
- Once an action has run, successfully or not, the claim lasts 24 hours. A redelivery, including GitHub's manual **Redeliver**, is dropped then, because the action's side effects may already have happened. To re-run it, send the delivery without its id, or use **Hooks → Test**.
- If no action ran (conditions didn't match, cooldown, `maxExecutions` reached, or an error before the action), the claim is released, so a redelivery can try again.
- Claims live in the shared key-value store, so dedupe works across API processes. If the store is unreachable, dedupe falls back to a per-process cache.

### Concurrency limits

Each hook runs at most **2** webhook deliveries at once, and all hooks together run at most **20**. Past that, the endpoint answers `429` with `Retry-After` before claiming the delivery id, so the sender's retry is treated as new. Cooldown and `maxExecutions` are enforced when a run starts: the run is reserved in the database first, so concurrent deliveries can't slip past them.

On shutdown, the server waits up to 1 second for background webhook runs to finish.

## Prerequisites

Before setting up webhooks, you need:

### 1. Public URL

The Octipus backend must be reachable from the internet. Options:

- **Cloudflare Tunnel** (recommended) — add an ingress rule in your tunnel config:
  ```yaml
  # cloudflare/config.yml
  ingress:
    - hostname: app.your-domain.com
      service: http://localhost:3005
  ```
  Then add a CNAME DNS record: `app` → `<tunnel-id>.cfargotunnel.com` (proxied).

- **ngrok** — quick dev setup: `ngrok http 3005`
- **Reverse proxy** — nginx/caddy with TLS termination pointing to port 3005

### 2. Channel Bindings (for notifications)

If you want Octipus to notify you about webhook events:

1. Link your Telegram account in **Settings → Channels** (or via the `/link` command in Telegram)
2. Verify the binding — the channel must show as "verified" in your user profile
3. Set `notifyOwner: true` in the hook's action config

### 3. Webhook Secret

Generate a random secret for HMAC signature verification:

```bash
openssl rand -hex 20
```

Both sides (Octipus hook and the external service) must share this secret. **Never skip this** — hooks without a `webhookSecret` are rejected with 401.

## Setup Guide: GitHub

### Step 1: Create the Hook

Via MCP (Claude Code / Antigravity):

```
Use octipus_create_recurring_task:
  name: "GitHub Notifications"
  trigger: "webhook"
  trigger_config: '{"webhookPath": "github", "webhookSecret": "<your-secret>"}'
  action: "spawn_agent"
  action_config: '{"agentPrompt": "A GitHub webhook event was received. Analyze the payload and produce a concise summary. For PRs: title, author, action, URL. For issues: title, author, labels. For pushes: branch, commits, author. Format with emoji prefixes.", "agentTopic": "communication", "orchestrated": false, "notifyOwner": true}'
```

Via API:

```bash
curl -X POST http://localhost:3005/api/hooks \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "GitHub Notifications",
    "trigger": "webhook",
    "triggerConfig": {
      "webhookPath": "github",
      "webhookSecret": "<your-secret>"
    },
    "action": "spawn_agent",
    "actionConfig": {
      "agentPrompt": "A GitHub webhook event was received. Analyze the payload and produce a concise summary.",
      "agentTopic": "communication",
      "orchestrated": false,
      "notifyOwner": true
    }
  }'
```

Via UI: Go to **Hooks → Create Hook** and fill in the webhook trigger fields.

### Step 2: Configure GitHub

**Option A: GitHub CLI**

```bash
gh api repos/OWNER/REPO/hooks -X POST --input - <<'EOF'
{
  "name": "web",
  "active": true,
  "events": ["pull_request", "issues", "push"],
  "config": {
    "url": "https://app.your-domain.com/api/webhooks/github",
    "content_type": "json",
    "secret": "<your-secret>",
    "insecure_ssl": "0"
  }
}
EOF
```

**Option B: GitHub UI**

1. Go to repo **Settings → Webhooks → Add webhook**
2. **Payload URL**: `https://app.your-domain.com/api/webhooks/github`
3. **Content type**: `application/json`
4. **Secret**: the same secret from Step 1
5. **Events**: select "Pull requests", "Issues", "Pushes" (or "Send me everything")

### Step 3: Verify

GitHub sends a `ping` event immediately after creating the webhook. Check:

```bash
# GitHub delivery history
gh api repos/OWNER/REPO/hooks/<hook-id>/deliveries \
  --jq '.[0] | "\(.event) → \(.status_code)"'

# Octipus execution log
curl http://localhost:3005/api/hooks/<hook-id>/executions \
  -H "Authorization: Bearer $OCTIPUS_API_TOKEN" | jq '.executions[0]'
```

## Setup Guide: GitLab

### Step 1: Create the Hook

Same as GitHub, but use a different `webhookPath`:

```json
{
  "triggerConfig": {
    "webhookPath": "gitlab",
    "webhookSecret": "<your-secret>"
  }
}
```

### Step 2: Configure GitLab

1. Go to project **Settings → Webhooks**
2. **URL**: `https://app.your-domain.com/api/webhooks/gitlab`
3. **Secret token**: your webhook secret
4. **Triggers**: Push events, Merge request events, etc.

Note: GitLab uses `X-Gitlab-Token` header (not HMAC). The current webhook endpoint verifies via `X-Hub-Signature-256` (GitHub-style HMAC). For GitLab, you may need to add a signature verification adapter or use the webhook without HMAC and rely on the secret token header.

## Setup Guide: Generic Webhook

Any service that sends JSON POST requests with HMAC-SHA256 signatures works out of the box.

### Signature Format

The sender must include an `X-Hub-Signature-256` header:

```
X-Hub-Signature-256: sha256=<hex-encoded HMAC-SHA256 of raw request body>
```

### Example: Manual Test

```bash
PAYLOAD='{"event": "deploy", "status": "success", "environment": "production"}'
SECRET="your-webhook-secret"
SIG="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"

curl -X POST https://app.your-domain.com/api/webhooks/deploy \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$PAYLOAD"
```

## Action Types for Webhooks

### spawn_agent (AI analysis + notification)

Best for: events that need interpretation before notification.

```json
{
  "action": "spawn_agent",
  "actionConfig": {
    "agentPrompt": "Analyze this deployment event and summarize the status.",
    "agentTopic": "devops",
    "orchestrated": false,
    "notifyOwner": true
  }
}
```

- **`orchestrated: false`** — spawns a single agent directly (faster)
- **`orchestrated: true`** — routes through the root agent for role classification and tool access
- **`notifyOwner: true`** — automatically sends the agent's output to all verified channels when the agent completes

### notify (direct notification)

Best for: simple alerts that don't need AI processing.

```json
{
  "action": "notify",
  "actionConfig": {
    "notifyOwner": true,
    "notifyMessage": "Webhook received: {{webhook.body.event}} — {{webhook.body.status}}"
  }
}
```

### webhook (forward/chain)

Best for: forwarding events to other services.

```json
{
  "action": "webhook",
  "actionConfig": {
    "webhookUrl": "https://other-service.com/api/events",
    "webhookMethod": "POST"
  }
}
```

### execute_tool (run a tool directly)

Best for: automated responses like running a git pull or executing a shell command.

```json
{
  "action": "execute_tool",
  "actionConfig": {
    "toolId": "shell",
    "toolAction": "execute",
    "toolParams": { "command": "cd /app && git pull origin main" }
  }
}
```

## Webhook Context in Agent Prompts

When a webhook triggers a `spawn_agent` action, the webhook payload is automatically appended to the agent prompt:

```
<your prompt text>

--- Webhook Payload ---
{ "action": "opened", "pull_request": { ... } }
Event type: pull_request
```

The `Event type` line is extracted from the `X-GitHub-Event` or `X-GitLab-Event` header when present.

You can also use template variables in prompts:

| Variable | Description |
|----------|-------------|
| `{{webhook.path}}` | The webhook path (e.g., "github") |
| `{{webhook.method}}` | HTTP method (always POST) |
| `{{webhook.body.*}}` | Any field from the JSON payload |

## Security

- **HMAC-SHA256 required** — every webhook hook must have a `webhookSecret`. Hooks without one reject all requests with 401.
- **Signature verification** — uses `X-Hub-Signature-256` header with timing-safe comparison, computed over the raw request bytes (not re-serialised JSON).
- **Public endpoint** — `/api/webhooks/*` is excluded from bearer token auth (it uses HMAC instead).
- **Per-hook secrets** — each hook can have a different secret, so different services get different credentials.

## Troubleshooting

| Problem | Check |
|---------|-------|
| 401 on webhook | Verify the secret matches on both sides. Check `X-Hub-Signature-256` header is present. |
| 404 on webhook | Ensure the URL path matches `webhookPath` in trigger config (e.g., `/api/webhooks/github` needs `webhookPath: "github"`). |
| Hook not firing | Check hook is enabled. Verify `webhookPath` matches. Look at execution log for skipped entries. |
| 202 but nothing happened | The action runs after the response; check the hook's execution log for an `error` entry. |
| 200 `duplicate: true` | The delivery id was already processed for this hook (see Idempotency). Send without the id to force a re-run. |
| 429 on webhook | Too many runs of this hook (2) or overall (20) are in progress; the sender should retry after `Retry-After`. |
| Agent runs but no notification | Ensure `notifyOwner: true` is in action config. Verify channel bindings are verified in Settings → Channels. |
| Agent doesn't see payload | The payload is auto-appended to the prompt. Check execution log → trigger context for the raw data. |
| 502 from tunnel | Verify the backend is running on port 3005. Check cloudflared/tunnel config has the correct ingress rule. |

## Multiple Webhooks

You can create multiple hooks with different paths for different services:

```
/api/webhooks/github     → GitHub events
/api/webhooks/gitlab     → GitLab events
/api/webhooks/stripe     → Payment events
/api/webhooks/deploy     → CI/CD deploy notifications
/api/webhooks/monitoring → Alerting systems
```

Each path can have its own secret and action configuration.
