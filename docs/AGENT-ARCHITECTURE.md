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

### Agents (Workers)
Runtime instances that execute tasks using an LLM tool loop. Each agent has a context (session, user, model, role) and iterates: call LLM → parse tool calls → execute tools → repeat.

**Location:** `src/core/agent-worker.ts`, managed by `AgentManager`

### Orchestrator
Classifies incoming messages and routes them to the appropriate execution path. Uses meta-tools to spawn workers, teams, or pipelines.

**Location:** `src/core/orchestrator/service.ts`

## Execution Paths

```
User Message
    │
    ▼
Orchestrator
    │
    ├─ Expert bypass? ──► Spawn worker with expert's role + tools + skills
    │
    ├─ Casual message? ──► Direct LLM response (no tools)
    │
    └─ Task message? ──► Spawn orchestrator agent with meta-tools
                              │
                              ├─ spawn_worker(role) ──► Single specialist worker
                              │
                              ├─ spawn_team(members) ──► Parallel workers
                              │
                              └─ create_pipeline(type) ──► Sequential stages
                                    Stage 1 → Stage 2 → ... → Stage N
```

## How They Relate

| Concept | What it is | When created | Lifetime |
|---------|-----------|--------------|----------|
| **Tool** | Executable module (shell, git...) | App startup | Singleton |
| **Skill** | Domain knowledge | App startup | Singleton |
| **Expert** | Agent configuration | DB seed / user-created | Persistent |
| **Agent** | Running worker instance | Per-request | Request-scoped |
| **Team** | Parallel agent group | Per-request | Request-scoped |
| **Pipeline** | Sequential stage chain | Per-request | DB-tracked |

## Agent Roles

| Role | Tools | Default Skills | Use Case |
|------|-------|---------------|----------|
| orchestrator | meta-tools only | — | Routes tasks to specialists |
| coding | filesystem, shell, git | architecture, data-structures, db-design, api-design | Code implementation |
| review | filesystem, git | architecture, testing, security, performance | Code review |
| research | browser, websearch, knowledge, filesystem | technical-writing | Investigation |
| design | browser, filesystem | design-principles, design-frameworks | UI/UX |
| devops | shell, docker, git, filesystem | devops, containers, cloud, networking | Infrastructure |
| security | shell, filesystem, browser, websearch | security, networking, cloud | Security analysis |
| data | shell, filesystem | db-design, data-engineering, performance | Data/DB work |
| ai | shell, filesystem, browser, websearch | ai-engineering, ML, data-structures | AI/ML tasks |
| qa | browser, shell, docker | test-automation, performance | Testing |
| finance | browser, websearch, filesystem | financial-analysis | Financial work |
| automation | shell, docker, filesystem | automation-patterns, devops | Workflows |
| pm | filesystem, messaging | project-management, technical-writing | Project mgmt |
| writing | filesystem, browser, websearch | technical-writing, api-design | Documentation |
| communication | google-workspace, microsoft365, messaging | — | Email/calendar |
| general | filesystem, shell, messaging | — | Fallback |

## Adding New Components

### New Tool
1. Create `src/tools/<name>/index.ts` extending `BaseTool`
2. Register in `src/tools/index.ts`

### New Skill
Create via the API (`POST /api/skills`) or add to `SYSTEM_SKILLS` in `src/db/seed-skills.ts` for system skills.

### New Expert
1. Add entry to `SYSTEM_EXPERTS` in `src/db/seed-experts.ts`
2. If new role needed, add to `AgentRole` type and `ROLE_CONFIGS`
