# Expert, Topic & Skill Routing

How experts, topics, skills, and models connect to each other.

## Core Principle

**Topic = Role.** Every role has a matching topic with the same name. When you assign a model to a topic, that model is used for all agents with that role — whether spawned by the orchestrator, a pipeline, or the `/expert` command.

## The Chain

```
User message
  ↓
Classifier (keyword matching)
  ↓
Role (determines tools + system prompt)
  = Topic (determines which model)
  ↓
Model Registry: getModelForTopic(topic)
  1. Check topicRoles[topic] = 'primary'
  2. Fall back to legacy topics array
  3. Fall back to default model
  ↓
Agent spawned with: role tools + topic model + expert prompt + skills
```

## Roles & Topics (1:1 mapping)

| Role / Topic | Tools | Use Case |
|---|---|---|
| `general` | filesystem, browser-ext, websearch, messaging, knowledge, scheduling, profiles, email-processor, mcp | Multi-purpose, browsing, messaging |
| `coding` | filesystem, shell, git, knowledge, mcp | Code generation, debugging, git |
| `research` | browser, browser-ext, websearch, knowledge, filesystem, profiles, mcp | Web search, investigation |
| `architecture` | filesystem, shell, knowledge, websearch, mcp | System design, requirements, specs |
| `review` | filesystem, shell, git, knowledge | Code review, linting, testing (read-only) |
| `qa` | browser, browser-ext, shell, docker, filesystem, knowledge | Test suites, UI testing, bug reports |
| `communication` | google-workspace, microsoft365, messaging, scheduling, profiles, email-processor, voice | Email, calendar, phone calls |
| `design` | browser, filesystem | UI/UX design, mockups |
| `devops` | shell, docker, git, filesystem, mcp | CI/CD, Docker, infrastructure |
| `security` | shell, filesystem, browser, browser-ext, websearch, knowledge, mcp | Vulnerability analysis, hardening |
| `data` | shell, filesystem, knowledge, mcp | Databases, data pipelines, SQL |
| `ai` | shell, filesystem, browser, browser-ext, websearch, knowledge, mcp | ML/AI, RAG, model training |
| `finance` | browser, websearch, filesystem | Financial analysis, market data |
| `automation` | shell, docker, filesystem, scheduling, mcp | Cron tasks, hooks, workflows |
| `pm` | filesystem, messaging | Project planning, tracking |
| `writing` | filesystem, browser, websearch, knowledge, messaging | Documentation, technical writing |

Special topics (no role equivalent — used for model capability routing only):
| Topic | Purpose |
|---|---|
| `chat` | Casual conversations (orchestrator direct response) |
| `embedding` | Vector embeddings (knowledge base) |
| `ocr` | Text extraction from images |
| `vision` | Image understanding |
| `voice` | Phone call conversations (low latency) |

## Experts

Experts are pre-configured personas that add structure on top of roles. Each expert has:
- **Role** → determines tools and topic
- **Skills** → domain knowledge injected into the system prompt
- **Critical Rules** → behavioral constraints
- **Deliverable Template** → expected output structure
- **Success Metrics** → evaluation criteria
- **Model Preference** → optional model override (bypasses topic routing)

### Expert → Role → Topic Mapping

| Expert | Role/Topic | Skills |
|---|---|---|
| Coder | `coding` | software-architecture, data-structures, database-design, api-design, plugin-development |
| Reviewer | `review` | software-architecture, test-automation, security-practices, performance-engineering |
| Researcher | `research` | technical-writing |
| UI/UX Designer | `design` | design-principles, design-frameworks |
| DevOps Engineer | `devops` | devops-practices, container-orchestration, cloud-platforms, networking |
| Security Analyst | `security` | security-practices, networking, cloud-platforms |
| Data Engineer | `data` | database-design, data-engineering, performance-engineering |
| AI Engineer | `ai` | ai-engineering, machine-learning, data-structures |
| QA Engineer | `qa` | test-automation, performance-engineering |
| Financial Analyst | `finance` | financial-analysis |
| Automation Engineer | `automation` | automation-patterns, devops-practices |
| Project Manager | `pm` | project-management, technical-writing |
| Technical Writer | `writing` | technical-writing, api-design |
| Communicator | `communication` | — |
| General | `general` | — |

### How `/expert` Works

```
/expert Coder "implement login"
  ↓
1. Look up "Coder" in experts table → role: "coding"
2. getRoleConfig("coding") → tools: [filesystem, shell, git, ...]
3. getModelForTopic("coding") → model with coding topic assigned
4. Build prompt: security preamble + expert identity + role prompt + rules + skills
5. Spawn worker with role tools + topic model + expert prompt
```

Works the same in WebUI, TUI, Telegram, Slack, and Teams. The `activeExpertId` persists in the session until `/expert reset`.

## Skills

Skills are domain knowledge documents (markdown with principles, best practices, anti-patterns, frameworks). They are injected into the expert's system prompt — not tied to a specific topic or model.

### Skill → Expert Mapping

| Skill | Used By |
|---|---|
| software-architecture | Coder, Reviewer |
| data-structures | Coder, AI Engineer |
| test-automation | Reviewer, QA Engineer |
| design-principles | UI/UX Designer |
| design-frameworks | UI/UX Designer |
| devops-practices | DevOps Engineer, Automation Engineer |
| container-orchestration | DevOps Engineer |
| security-practices | Security Analyst, Reviewer |
| cloud-platforms | DevOps Engineer, Security Analyst |
| financial-analysis | Financial Analyst |
| ai-engineering | AI Engineer |
| automation-patterns | Automation Engineer |
| database-design | Data Engineer, Coder |
| api-design | Coder, Technical Writer |
| project-management | Project Manager |
| technical-writing | Researcher, Project Manager, Technical Writer |
| performance-engineering | Data Engineer, Reviewer, QA Engineer |
| data-engineering | Data Engineer |
| machine-learning | AI Engineer |
| plugin-development | Coder |
| networking | DevOps Engineer, Security Analyst |

## Pipeline Stages

Pipeline stages specify a `topic` field that determines both the role (tools) and model:

| Pipeline | Stage | Topic |
|---|---|---|
| Full Development Cycle | Research & Discovery | `research` |
| Full Development Cycle | Requirements & Architecture | `architecture` |
| Full Development Cycle | Implementation | `coding` |
| Full Development Cycle | Testing | `qa` |
| Full Development Cycle | Code Review | `review` |
| Full Development Cycle | QA Validation | `qa` |
| Full Development Cycle | Summary & Handoff | `general` |
| Research & Analysis | Deep Investigation | `research` |
| Research & Analysis | Analysis & Recommendations | `general` |
| Bug Fix | Reproduce & Diagnose | `coding` |
| Bug Fix | Implement Fix | `coding` |
| Bug Fix | Verify Fix | `coding` |

## Model Configuration

To assign a model to a topic, use the **Models** page in the web UI:
1. Click on a model → Edit
2. Select the topic(s) this model should handle
3. The model will be used when agents with that role/topic are spawned

**Fail-loud, no default fallback.** `ModelRegistry.getModelForTopic(role)` is the single authoritative entry point. If a topic has no model bound, the swarm spawner throws — there is no silent "default model" fallback. Same rule applies to the `embedding` / `vision` / `ocr` topics: the knowledge base self-check (`/api/knowledge/readiness`) surfaces a 503 if no embedding model is bound.

## Swarm Children Inherit Topic Bindings

When an Agent spawns a Subagent via `spawn_child`, the child resolves its model through the **child's topic** — not the parent's. A research Agent (`research` topic) spawning a security Subagent (`security` topic) gets the model bound to `security`, independent of what the parent is using. This means configuring each topic once produces consistent behaviour regardless of how deep the swarm tree goes.

Expert `modelPreference` is a fallback and only applies when no topic binding exists.

## Skill Embedding Backfill

`scripts/backfill-skill-embeddings.ts` (re-)computes description embeddings
for skills missing them or whose `description_hash` no longer matches the
current `name + description`.

Run manually:

    npm run db:backfill-skill-embeddings

Recommended: cron every 15 minutes. Skill description edits invalidate the
embedding immediately at write time; the cron refills lazily. With no
embedding model configured, the script exits cleanly — discovery still
works via triggers + always_inject + stale-fallback.
