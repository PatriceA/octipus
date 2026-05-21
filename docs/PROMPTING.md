# Prompting Guide

How to configure and prompt Octipus to trigger different features.

## Prerequisites

Before using advanced features, ensure:

1. **Backend running**: `bun run dev` (or `bun run src/index.ts`) on port 3005
2. **PostgreSQL + Valkey**: Docker services running (`docker compose up -d`)
3. **LLM model available**: At least one model configured in LiteLLM (default: `qwen3:14b`)
4. **Web UI**: Access at `http://localhost:3007` (auto-started with backend)

### Optional Configuration

| Feature | Requirement |
|---------|-------------|
| Telegram notifications | Set `telegram.botToken` in settings |
| Browser extension | Install Chrome extension, connect to `ws://localhost:3005/ws/browser-bridge` |
| GitHub tools | `gh` CLI authenticated |
| Google Workspace | OAuth configured in settings |
| Microsoft 365 | OAuth configured in settings |
| N8N workflows | N8N URL + API key in settings |

## Basic Chat

Simple messages are handled directly by the LLM without tools:

```
Hello, how are you?
What is the capital of France?
Thanks for the help!
```

These are classified as "casual" and get a quick response without spawning agents.

## Orchestrator Persona

The orchestrator (the entity you talk to) has a per-user identity layered between `SECURITY_PREAMBLE` and the role prompt at every turn. Default is **Octipus** — an octopus-machine that refers to itself in the third person, uses "we" for the swarm, and gives short dry replies. The voice applies to the casual-chat path AND the orchestrator's narration of swarm work ("Octipus dispatches a research arm.", "qa arm failed. Predictable.").

Customize via `/persona name <X>`, `/persona tone <…>`, `/persona say <fact>`. Switch presets with `/persona use mentor`. Six presets ship; full list at [CHAT-COMMANDS.md](CHAT-COMMANDS.md#personas-orchestrator-identity).

Specialist children do **not** inherit the persona — they stay role-defined (Coder, Reviewer, etc.). The persona is host-level only.

## Expert Agents

Experts are pre-configured agent personas with specific tools and skills. The system automatically routes to the right expert based on your message, or you can specify one explicitly.

### Auto-Routing (Orchestrator)

The orchestrator classifies your message and spawns the right specialist:

```
# Routes to Coding expert
Fix the bug in src/utils/parser.ts where it fails on empty input

# Routes to DevOps expert
Deploy the staging environment and check container health

# Routes to Security expert
Scan the API endpoints for XSS vulnerabilities

# Routes to Research expert
Research the top 5 alternatives to Redis for caching

# Routes to QA expert
Test the login flow on the staging site and report any issues

# Routes to Data expert
Write a SQL query to find users who signed up in the last 30 days

# Routes to Communication expert
Check my Gmail for unread emails from today
```

### Direct Expert Chat (via API/MCP)

Bypass the orchestrator by specifying an `expertId`:

```json
POST /api/chat
{
  "message": "Review the authentication module",
  "expertId": "security-analyst"
}
```

### Available Experts

| Expert | Specialization | Key Tools |
|--------|---------------|-----------|
| Coder | Code implementation, debugging | filesystem, shell, git |
| Code Reviewer | Code review, architecture analysis | filesystem, git |
| Researcher | Web research, investigation | browser, websearch, knowledge |
| Designer | UI/UX evaluation | browser, filesystem |
| DevOps Engineer | CI/CD, containers, infrastructure | shell, docker, git |
| Security Analyst | Vulnerability scanning, auditing | shell, browser, websearch |
| Data Engineer | Database, queries, data pipelines | shell, filesystem |
| AI Engineer | ML, RAG, prompt engineering | shell, browser, knowledge |
| QA Engineer | Testing, bug finding | browser, browser-ext, shell |
| Finance Analyst | Market analysis, financial data | browser, websearch |
| Automation Engineer | Workflow automation | shell, docker |
| Project Manager | Planning, status tracking | filesystem, messaging |
| Technical Writer | Documentation | filesystem, browser |
| Communications | Email, calendar, messaging | google-workspace, microsoft365 |

## Swarm Delegation (`spawn_child`)

Delegation is a 3-level tree: **Orchestrator → Agent → Subagent**. The orchestrator (and depth-1 Agents) call `spawn_child` to hand a focused sub-topic to a specialist. Multiple `spawn_child` calls in one LLM turn with the same `parallelGroup` run in parallel via `Promise.all` (capped 4/turn).

Trigger by requesting work that naturally splits across specialists:

```
Research the latest React frameworks, then build a comparison table
and design a migration plan from our current setup.

Analyze our codebase for security vulnerabilities, performance
bottlenecks, and test coverage gaps — give me a combined report.

Check our production logs for errors, review the deployment pipeline
configuration, and audit the Docker container resource limits.
```

The orchestrator recognizes multi-faceted tasks and fans out via parallel `spawn_child` calls. You can also be explicit:

```
Use the swarm: have one agent research competitors, another analyze
our pricing data, and a third draft a market positioning document.
```

### Delegation Priority

1. **Single `spawn_child`** — default for a single-role task with structured output.
2. **Multiple `spawn_child`** — when the task has distinct sub-topics; use `parallelGroup` to fan out.
3. **`create_pipeline`** — last resort, only when you explicitly want staged/reviewable handover or a human gate between stages. Pipelines are Orchestrator-only.

Children inherit the model bound to their role's topic (via `ModelRegistry.getModelForTopic`), not the parent's model. If a topic has no binding the spawner throws loudly — no silent default model.

### Role Selection for `spawn_child`

Pick the child's `role` from the same 16 roles as direct experts (see below). The spawner auto-matches a system expert by role unless you pass an explicit `expertId`. If an Agent exhausts its fan-out budget and children return `budget`/`timeout`, it can call `escalate_to_different_expert` once per lifetime to retry with a different expert of the same role.

### Deprecated Primitives

`spawn_worker` and `spawn_team` are **removed from the LLM-visible tool surface**. If you're reading old prompts or logs that reference them, they now map to `spawn_child`. The internal `worker-spawner.ts` still backs pipeline stages (non-LLM, sequential handover).

## Pipelines (Sequential Stages)

Pipelines execute stages in order, optionally requiring approval between stages:

```
Create a pipeline: first research best practices for API rate
limiting, then implement it in our Express middleware, then
write tests, and finally review the code.

Run a full code review pipeline on the authentication module:
analyze → identify issues → propose fixes → implement.
```

Pipeline stages pass output from one to the next. At approval checkpoints, you'll see a summary and can approve, modify, or stop the pipeline.

### Pipeline Approval Responses

When a pipeline asks for approval:

```
approve / yes / go ahead    → Continue to next stage
deny / no / stop            → Cancel the pipeline
```

## Tool Usage

Tools are automatically available to agents based on their role. Some prompts that trigger specific tools:

### Browser (Isolated)

```
Open https://example.com and take a screenshot
Navigate to the docs page and extract all the API endpoints
```

### Browser Extension (Real Browser)

```
Open my GitHub notifications in the browser
Check my open PRs on GitHub (use the real browser)
Take a screenshot of the current page in my browser
```

### Shell Commands

```
Run npm test and show me the results
Check disk usage on the server
List all running Docker containers
```

### Git Operations

```
Show me the git log for the last 10 commits
Create a new branch called feature/auth-refactor
Commit these changes with message "Fix login bug"
```

### GitHub

```
List open issues on our repo
Create a PR from the current branch
Review PR #42 and leave comments
```

### Knowledge Base (RAG)

```
Search our knowledge base for authentication patterns
Index the docs/ folder into the knowledge base
What do we know about the deployment process?
```

### Web Search

```
Search for "bun vs node performance 2024"
Find the official documentation for Elysia framework
```

### Messaging

```
Send a message to the Telegram channel: "Deployment complete"
List available messaging channels
```

### Google Workspace

```
Check my Gmail for unread emails
What meetings do I have today?
Create a calendar event for tomorrow at 3pm
```

### Docker

```
Show logs for the postgres container
Restart the redis container
List all running containers with their resource usage
```

## Hooks

Hooks automate actions based on events. Configure them in the Hooks page (`/hooks`).

### Hook Triggers

| Trigger | When it fires |
|---------|---------------|
| `message_received` | New message arrives on any channel |
| `agent_completed` | An agent finishes its task |
| `agent_failed` | An agent encounters an error |
| `webhook` | External HTTP request hits `/api/webhooks/:path` |
| `schedule` | Cron schedule fires |

### Hook Actions

| Action | What it does |
|--------|-------------|
| `notify` | Send a message to a channel (Telegram, Slack, etc.) |
| `spawn_agent` | Start an agent (direct or through orchestrator) |
| `webhook` | Send an outgoing HTTP request |
| `n8n_workflow` | Trigger an N8N automation workflow |
| `execute_tool` | Run a specific tool action |

### Example Hook Configurations

**GitHub PR Review Webhook:**
- Trigger: `webhook` (path: `github`)
- Action: `spawn_agent` (orchestrated)
- Prompt: `Review the PR changes: {{webhook.body.pull_request.html_url}}`

**Daily Summary via Telegram:**
- Trigger: `schedule` (cron: `0 9 * * *`)
- Action: `spawn_agent` (orchestrated)
- Prompt: `Check my emails, calendar, and open GitHub issues. Send a morning summary.`

**Error Notification:**
- Trigger: `agent_failed`
- Action: `notify`
- Channels: `telegram:YOUR_CHAT_ID`
- Message: `Agent failed: {{agent.topic}} — {{agent.error}}`

### Notify Action — Channel Format

The `notifyChannels` field uses the format `type:channelId`:

```
telegram:123456789        # Telegram chat ID
slack:C0123ABCDEF         # Slack channel ID
webchat:session-uuid      # WebChat session
```

To find your Telegram chat ID, send a message to the bot and check the backend logs.

### Template Variables

Hook prompts and messages support template interpolation with `{{path}}`:

| Variable | Available in |
|----------|-------------|
| `{{message.content}}` | message_received |
| `{{message.channelType}}` | message_received |
| `{{message.userId}}` | message_received |
| `{{agent.id}}` | agent_completed, agent_failed |
| `{{agent.topic}}` | agent_completed, agent_failed |
| `{{agent.status}}` | agent_completed, agent_failed |
| `{{tool.name}}` | tool_executed |
| `{{webhook.body.*}}` | webhook |
| `{{schedule.cronExpression}}` | schedule |

### Execution Log

Every hook and recurring task execution is logged. View the execution history in the Hooks page under the "Execution Log" tab. Each entry shows:

- Status (success/error)
- Source (hook/recurring task/manual test)
- Duration
- Full result data and trigger context (expandable)

Use this to debug hooks that don't seem to work — check if they're firing and what errors occur.

## Recurring Tasks

Recurring tasks run on a cron schedule. Configure them in the Recurring Tasks page.

### Cron Expression Format

```
* * * * *
│ │ │ │ │
│ │ │ │ └── Day of week
│ │ │ └──── Month
│ │ └────── Day of month
│ └──────── Hour
└────────── Minute

Examples:
*/5 * * * *     → Every 5 minutes
0 * * * *       → Every hour
0 9 * * *       → Daily at 9am
0 9 * * MON-FRI → Weekdays at 9am
```

### Example Recurring Tasks

**Hourly health check:**
- Cron: `0 * * * *`
- Action: `spawn_agent`
- Prompt: `Check if all Docker services are healthy and report any issues`

**Daily code review:**
- Cron: `0 10 * * MON-FRI`
- Action: `spawn_agent`
- Prompt: `Review open PRs on our repo and summarize findings`

## Skills

Skills provide domain knowledge to agents. They can be markdown content (recommended) or structured data. Manage them in the Skills page (`/skills`).

### Using Skills

Skills are automatically injected into agent system prompts based on the expert configuration. To add custom knowledge:

1. Go to the Skills page
2. Click "Create Skill"
3. Use Markdown mode to paste skill content (e.g., Claude Code skills, coding guidelines)
4. Assign it to an expert in the expert configuration

### Markdown Skills

The recommended format — just paste a markdown document:

```markdown
# My Coding Standards

## Principles
- Always write tests first
- Prefer composition over inheritance

## Patterns
- Use repository pattern for data access
- Use dependency injection for services
```

## Troubleshooting

### Hooks say they ran but no messages received

1. Check the **Execution Log** tab on the Hooks page
2. Verify the `notifyChannels` format: must be `type:channelId` (e.g., `telegram:123456`)
3. Ensure the channel is connected (Telegram bot running, Slack app installed)
4. Check the backend log: `tail -f ~/.octipus/backend.log`

### Pipeline approvals not appearing

1. The WebSocket connection must stay alive during long pipelines
2. If disconnected, pending approvals are polled automatically on reconnect
3. Check the chat UI — approval prompts appear as special message cards

### Agent doesn't use expected tools

1. The agent's role determines available tools
2. Check which expert was selected (visible in response metadata)
3. Be specific: "use the browser to open..." vs just "check..."
