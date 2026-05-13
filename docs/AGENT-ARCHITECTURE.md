# Agent Architecture

## Core Concepts

### Tools
Executable capabilities with functions and permissions. Each tool module provides one or more functions that agents can call.

**Examples:** shell (run, env), filesystem (read, write), git (commit, push), browser (navigate, click), docker (run_container), github (create_issue), google-workspace (send_email), websearch (search)

**Location:** `src/tools/` — each extends `BaseTool`, registered in `ToolRegistry`

### Skills
Domain knowledge sets that provide expertise to agents via system prompt injection. Skills contain principles, best practices, anti-patterns, and relevant frameworks.

**Examples:** software-architecture, test-automation, security-practices, financial-analysis, ai-engineering, design-principles

**Location:** DB table `skills`, seeded from `src/db/seed-skills.ts`, managed via `SkillRegistry` and `/api/skills` CRUD

### Experts
Pre-configured agent personas that combine a role, tools, skills, and system prompt. Experts bypass the orchestrator for direct, focused task execution.

**Examples:** Coder (coding role + architecture/data-structures skills), DevOps Engineer (devops role + CI/CD/containers skills), Security Analyst (security role + OWASP/networking skills)

**Location:** DB table `presets`, seeded from `src/db/seed-experts.ts`

#### Structured Expert Prompts

Every system expert includes three structured prompt sections that are automatically injected into the agent's system prompt:

| Field | Schema Column | Purpose |
|-------|--------------|---------|
| **Critical Rules** | `criticalRules` (string[]) | Hard constraints the agent must follow (e.g., "Never commit directly to main", "Always validate user input") |
| **Deliverable Template** | `deliverableTemplate` (text) | Expected output format — defines the structure of the agent's final response (e.g., code review format with sections for issues, suggestions, summary) |
| **Success Metrics** | `successMetrics` (string[]) | Evaluation criteria for the agent's output (e.g., "All tests pass", "No security vulnerabilities introduced") |

These fields are defined on the `presets` table and populated for all 15 system experts. Custom experts can also define them via the API or web UI.

### Agents (Workers)
Runtime instances that execute tasks using an LLM tool loop. Each agent has a context (session, user, model, role) and iterates: call LLM → parse tool calls → execute tools → repeat.

**Location:** `src/core/agent-worker.ts`, managed by `AgentManager`

### Orchestrator
Depth-0 root of the swarm. Classifies incoming messages and either responds directly (casual / read-only) or delegates sub-topics to specialist Agents via the `spawn_child` meta-tool. Owns the final user-facing reply.

**Location:** `src/core/orchestrator/service.ts`, role prompt at `src/core/orchestrator/roles/orchestrator/prompt.md`

### Swarm (3-Level Hierarchy)

Delegation runs through a fixed 3-level tree: **Orchestrator → Agent → Subagent**. Depth is structural, not configurable.

| Kind | Depth | Spawned by | Can spawn? | Lifetime |
|---|---|---|---|---|
| **Orchestrator** | 0 | `OrchestratorService.handleMessage()` | Yes → Agents | Per session |
| **Agent** | 1 | Parent's `spawn_child` | Yes → Subagents | Ephemeral, per topic |
| **Subagent** | 2 | Parent's `spawn_child` | **No** (leaf) | Ephemeral, per subtopic |

The LLM-facing tool is `spawn_child`. Agents also get `escalate_to_different_expert` (1/Agent lifetime) to retry a task with a different expert of the same role when children hit budget or timeout.

**Location:** `src/core/swarm/` — `spawner.ts`, `call-graph.ts`, `types.ts`, `errors.ts`, `escalate-tool.ts`, `swarm-tool.ts`, `orphan-reaper.ts`, `fan-out-budget.ts`, `node-repository.ts`. DB table `swarm_nodes`. The full design lives in `.octipus/swarm-design.md`.

## Execution Paths

```
User Message
    │
    ▼
Orchestrator (depth 0)
    │
    ├─ Expert bypass? ──► Spawn worker with expert's role + tools + skills
    │
    ├─ Casual message? ──► Direct LLM response (no tools)
    │
    └─ Task message? ──► Orchestrator runs with meta-tools
                              │
                              ├─ spawn_child(role, topic, subtopic, taskBrief)
                              │     ──► Agent (depth 1) with resolved expert,
                              │         topic-bound model, intersected tools
                              │         │
                              │         └─ spawn_child / escalate_to_different_expert
                              │                ──► Subagent (depth 2), hard leaf
                              │
                              ├─ Multiple spawn_child calls with same parallelGroup
                              │     ──► Promise.all fan-out (cap 4/turn)
                              │
                              └─ create_pipeline(type) ──► Sequential stages
                                    Stage 1 → Stage 2 → ... → Stage N
```

### Delegation Priority

1. **`spawn_child`** (single) — default for single-role delegation with structured output.
2. **`spawn_child`** (multiple, parallel or sequential) — when the task has distinct sub-topics.
3. **`create_pipeline`** — last resort; only when the user explicitly asks for staged/reviewable handover, or the task requires a human gate between stages. Pipelines are Orchestrator-only; Agents and Subagents cannot call `create_pipeline`.

The legacy `spawn_worker` and `spawn_team` meta-tools are **removed from the LLM-visible tool surface**. The `worker-spawner.ts` internals still back pipeline stages (sequential handover, non-LLM) but the LLM no longer sees either primitive.

### Swarm Budgets

Every node has a hard budget envelope enforced pre-LLM-call inside `AgentWorker.loop()`. Breach throws a structured error (`BudgetExceededError`, `ChildTimeoutError`, `CascadedCancellationError`) which the spawner maps to `ChildResult.status`.

| Level | Tokens (cap) | Wall-clock (cap) | Fan-out (cap) |
|---|---|---|---|
| Orchestrator (0) | 200k | 10 min | 6 |
| Agent (1) | 80k | 4 min | 4 |
| Subagent (2) | 30k | 4 min | 0 |

- **Tokens cascade** (pool-shared): `child.tokens.cap = min(LEVEL_DEFAULT[depth], parent.remaining.tokens − 10% RESERVE)`.
- **Wall-clock does NOT cascade**: each node gets its own `LEVEL_DEFAULT` wall cap. Parent's clock excludes time spent awaiting children via `AgentWorker.pausedMs`.
- **Fan-out**: per-node cap enforced synchronously by the spawner before concurrency/cache/budget math. Per-turn parallel cap (4) is a secondary guard in `tool-executor.ts`; overflow returns `concurrency_limit`.

Defaults live in `src/core/swarm/types.ts` (`LEVEL_DEFAULT`, `BUDGET_RESERVE_FRACTION`).

### Cycle / Duplicate Protection

`SwarmCallGraph` per-root-session keeps a fingerprint set of `(topicPath, normalized(taskBrief), inputArtifact refs)`. Duplicate spawns within a session return `cancelled` with a `parentNotice` so the parent LLM can synthesize against the in-flight result. Ancestor-chain collisions are rejected as a second guard. Fingerprints are released on child failure so the parent may respawn with a refined brief.

### Cascade Cancel

Parent abort propagates to children via an `AbortSignal` chain rooted on the Orchestrator. `AgentManager.stop(id, { cascade: true })` walks the in-memory `childrenByParent` index synchronously and fires a background DB walk so zombie descendants flip to `cancelled` in `swarm_nodes`.

### Permission Inheritance

`child.allowedToolIds = parent.allowedToolIds ∩ requiredToolIds`. The root Orchestrator's `allowedToolIds` is the **union** of all role `toolIds` — so children inherit their role's full toolbox via intersection rather than an empty set. Children that need a tool the parent lacks escalate via `request_user_approval`.

### Observability

Gateway events (`src/core/gateway/protocol.ts`): `swarm.node_spawned`, `swarm.node_completed`, `swarm.node_status`, `swarm.budget_warning`, `swarm.call_graph_cycle_blocked`. UI subscribes with the `swarm.*` pattern and renders a live tree per session. The replay buffer keeps swarm events for reconnection; `/api/swarm/nodes?rootSessionId=…` is the REST fallback for tree rehydration after the buffer ages out.

### QA Retry Loop

Pipeline stages can be typed as `qa_validation`. When a QA stage fails, the pipeline automatically retries the previous implementation stage with the QA feedback injected into context. This loop continues up to 3 retries (configurable via `maxRetries` on the pipeline step). After max retries are exhausted, the pipeline escalates to the user for manual approval.

Pipeline step fields for QA retry:

| Field | Type | Purpose |
|-------|------|---------|
| `stageType` | `"implementation"` \| `"qa_validation"` \| `"review"` | Classifies the stage for retry logic |
| `maxRetries` | number | Maximum retry attempts before escalation (default: 3) |
| `retryTargetStage` | string | Which stage to retry on failure (typically the preceding implementation stage) |

### Handoff Context Documents

When work passes between pipeline stages, a structured **handoff document** is automatically generated and forwarded to the next stage's agent. Each handoff contains:

- **Completed work summary** — what the previous stage accomplished
- **Key decisions** — architectural or implementation choices made
- **Open questions** — unresolved issues for the next stage to address
- **Artifacts produced** — files created/modified, endpoints added, etc.
- **Role-aware instructions** — context tailored to the receiving agent's role

The full handoff chain is accumulated across all stages, so later stages have visibility into the entire pipeline history. This prevents context loss and reduces redundant work across sequential stages.

### Automatic Expert Selection

When the orchestrator (or an Agent) calls `spawn_child` with a `role` and no explicit `expertId`, the swarm spawner matches a system expert from the database by role. The matched expert provides:

- **System prompt** — expert-specific instructions and persona (with `SECURITY_PREAMBLE` deduplicated)
- **Domain knowledge** — skills loaded via `SkillRegistry.buildPromptFragment()` and appended
- **Model preference** — the expert's preferred model (as a fallback; see topic→model below)

**Priority chain:** Explicit `expertId` on `spawn_child` > Explicit UI expert selection > Auto-matched expert by role > Generic role config.

### Topic → Model Routing (Authoritative)

Children resolve their model strictly (no parent-model inheritance, no hardcoded defaults):

1. Expert `modelPreference` — if the matched expert has an explicit preference, use it.
2. `ModelRegistry.getModelForTopic(role)` — otherwise, use the model bound to the child's topic.
3. Fail loud — if neither resolves, `SwarmSpawner.resolveChildModelAndExpert` throws with a message pointing the user at the Models page. No default-model fallback.

Children **inherit topic bindings, not the parent's model**. If a research Agent spawns a security Subagent, the Subagent resolves the model bound to `security`, not the parent's research model. `ModelRegistry.getModelForTopic()` is the single authoritative entry point. `litellm-client.ts:embed()` and `visual/analyzer.ts` resolve embedding/vision models the same way (or throw if unbound).

## How They Relate

| Concept | What it is | When created | Lifetime |
|---------|-----------|--------------|----------|
| **Tool** | Executable module (shell, git...) | App startup | Singleton |
| **Skill** | Domain knowledge | App startup | Singleton |
| **Expert** | Agent configuration | DB seed / user-created | Persistent |
| **Agent** | Running worker instance (depth 1) | Per `spawn_child` | Request-scoped, tracked in `swarm_nodes` |
| **Subagent** | Leaf worker (depth 2) | Per `spawn_child` from an Agent | Request-scoped |
| **Swarm** | Full tree for a session | Per root message | Session-scoped, persisted in `swarm_nodes` |
| **Pipeline** | Sequential stage chain | Per-request | DB-tracked (pipelines table) |

## Agent Roles

| Role | Tools | Default Skills | Use Case |
|------|-------|---------------|----------|
| orchestrator | meta-tools only | — | Routes tasks to specialists |
| coding | filesystem, shell, git, knowledge | architecture, data-structures, db-design, api-design | Code implementation |
| review | filesystem, git, knowledge | architecture, testing, security, performance | Code review |
| research | browser, browser-ext, websearch, knowledge, filesystem | technical-writing | Investigation |
| design | browser, filesystem | design-principles, design-frameworks | UI/UX |
| devops | shell, docker, git, filesystem | devops, containers, cloud, networking | Infrastructure |
| security | shell, filesystem, browser, browser-ext, websearch, knowledge | security, networking, cloud | Security analysis |
| data | shell, filesystem, knowledge | db-design, data-engineering, performance | Data/DB work |
| ai | shell, filesystem, browser, browser-ext, websearch, knowledge | ai-engineering, ML, data-structures | AI/ML tasks |
| qa | browser, browser-ext, shell, docker | test-automation, performance | Testing |
| finance | browser, websearch, filesystem | financial-analysis | Financial work |
| automation | shell, docker, filesystem | automation-patterns, devops | Workflows |
| pm | filesystem, messaging | project-management, technical-writing | Project mgmt |
| writing | filesystem, browser, websearch, knowledge | technical-writing, api-design | Documentation |
| communication | google-workspace, microsoft365, messaging | — | Email/calendar |
| general | filesystem, shell, messaging, knowledge, browser-ext | — | Fallback |

## Thinking Token Management

Some models (Qwen3, DeepSeek) emit `<think>...</think>` reasoning blocks that consume output tokens. The system handles this at multiple levels:

- **Model-level:** "Disable Thinking" checkbox in the model Add/Edit dialog sets `extraBody: { think: false }` — prevents the model from generating reasoning tokens entirely (Ollama)
- **Agent workers (orchestrator AND experts):** Strip `think:false` from extraBody so the model can reason before emitting tool calls. Empirically (2026-05-12 QA), Ollama with `think:false` produces malformed tool-call JSON that the Go-side parser rejects ("Value looks like object, but can't find closing '}'"); with thinking ON, the same models emit valid tool calls. The override applies to every role that uses tools, not just experts.
- **LLM client safety net:** `<think>` blocks are stripped from both sync and streaming responses before delivery, so users never see raw reasoning output

**Strategy:** Keep thinking enabled for any agent that emits tool calls (orchestrator, experts) — the cost in tokens is much smaller than the cost of a failed tool call + retry storm. Disable thinking only for casual chat (`direct-response.ts`), where there are no tool calls to corrupt.

## Steering Messages

Steering messages allow users to inject corrections or guidance into a running agent session without interrupting the current tool execution.

### How It Works

1. Client sends `{ type: 'steer', sessionId, content }` over the WebSocket gateway
2. The message is queued on the session
3. After the current tool call completes, the queue is drained
4. Steering content is injected as a system-level message before the next LLM call

### When to Use

- Redirect an agent that is going down the wrong path ("focus on the API layer, not the UI")
- Add constraints mid-run ("don't modify any test files")
- Provide clarification the agent needs without aborting and restarting

Steering messages are non-disruptive — they never interrupt a tool that is already executing. The agent sees them as additional context on its next LLM turn.

## Context Compaction

When a conversation grows large, the system compacts it using LLM-based summarization rather than simple message truncation.

### Approach

- An LLM call summarizes the conversation history into a condensed form
- **File operation metadata is preserved** — which files were read, written, created, or deleted — so the agent retains awareness of filesystem state even after compaction
- Tool call/result pairs are condensed but their essential outcomes are kept
- The compacted summary replaces older messages while recent messages remain intact

This preserves more useful context per token than naive truncation, especially for long coding sessions where file state matters.

## File Mutation Queue

Concurrent agents (teams, parallel pipeline stages) may attempt to write to the same file simultaneously, causing race conditions or corrupted output.

### How It Works

- A per-file write queue serializes all mutation operations (write, append, patch) targeting the same file path
- Read operations are not queued — only writes acquire the lock
- Each file path gets its own independent queue, so writes to different files proceed in parallel
- The queue is transparent to tool implementations — serialization is handled at the tool executor level

## Thinking Budgets

Reasoning models (Qwen3, DeepSeek, o-series) benefit from thinking tokens but consume output capacity. The system auto-manages thinking budgets.

### Levels

| Level | Thinking Budget | Use Case |
|-------|----------------|----------|
| **off** | 0 tokens | Orchestrator routing, casual chat |
| **low** | ~1024 tokens | Simple tool calls, classification |
| **medium** | ~4096 tokens | Multi-step tool reasoning |
| **high** | ~8192+ tokens | Complex planning, code generation |

### Behavior

- **Auto-detection**: The system detects reasoning-capable models and assigns a default budget based on the agent's role
- **Scaling**: Budget scales with task complexity — orchestrator gets `off` or `low`, agent workers get `medium` or `high`
- **Agent worker override**: Workers always enable thinking even if the model config disables it, since complex tool-use benefits from reasoning
- Thinking tokens are stripped from output before delivery to users

## Adding New Components

### New Tool
1. Create `src/tools/<name>/index.ts` extending `BaseTool`
2. Register in `src/tools/index.ts`

### New Skill
Create via the API (`POST /api/skills`) or add to `SYSTEM_SKILLS` in `src/db/seed-skills.ts` for system skills.

### New Expert
1. Add entry to `SYSTEM_EXPERTS` in `src/db/seed-experts.ts`
2. If new role needed, add to `AgentRole` type and `ROLE_CONFIGS`

## Knowledge Base (RAG)

Agent outputs are automatically indexed into the knowledge base on completion, enabling future agents to retrieve past work. Most specialist roles have access to the `knowledge` tool for search and manual indexing.

See **[RAG Documentation](RAG.md)** for full details on setup, configuration, and architecture.
