# Tool & Expert Routing

## How Messages Get Routed

### Message Classification

Every message runs the same agent turn: the root agent, holding the general
toolset plus `spawn_child`. The keyword classifier
(`src/core/agent/classifier.ts`) does **not** decide whether an agent
runs, and has not chosen the specialist since Phase 2 — a capable model reads
the request better than a regex table. What it still does: scope memory
retrieval by topic, and, for a small (lite-tier) model only, ride along as a
hint the request itself can override.

1. **Casual patterns** — greetings, thanks, yes/no. Recorded on the turn; the
   root answers them itself, the same way it answers everything else.
2. **Task keywords** — matched against 14 categories with scoring:
   - Multi-word keywords get 1.5x weight (more specific)
   - Single-word keywords use word boundary matching
   - Score >= 1.5 → high confidence routing
   - Score 1 with > 2 words → moderate confidence
3. **Ambiguous** — falls through to LLM decision

### Task Categories → Roles → Tools

The roles the root can delegate to with `spawn_child`, and what each holds. The
root itself runs as `general`, so anything in that row it does without spawning.

| Category | Role | Tools Available | Trigger Keywords (examples) |
|----------|------|----------------|----------------------------|
| coding | coding | filesystem, shell, git, github, knowledge, task_state, repo_registry, skill-distill, mcp | "implement", "write code", "fix bug", "refactor", "typescript", "react", "git commit" |
| research | research | websearch, knowledge, task_state, filesystem, profiles, artifacts, artifacts_toolbox, documents, repo_registry, skill-distill, mcp | "research", "investigate", "search the web", "compare", "find out", "tell me about" |
| devops | devops | shell, docker, git, filesystem, mcp | "docker", "kubernetes", "deploy", "CI/CD", "nginx", "terraform" |
| security | security | shell, filesystem, browser, browser-ext, websearch, knowledge, task_state, mcp | "vulnerability", "audit", "OWASP", "threat model", "security review" |
| data | data | data, shell, filesystem, knowledge, task_state, artifacts, artifacts_toolbox, documents, mcp | "database schema", "SQL query", "migration", "ETL", "data pipeline", "query the database", "analyse this CSV" |
| writing | writing | filesystem, browser, websearch, knowledge, task_state, messaging, documents | "documentation", "write docs", "readme", "technical writing", "changelog" |
| design | design | browser, filesystem | "UI design", "UX", "wireframe", "mockup", "accessibility" |
| finance | finance | browser, websearch, filesystem | "budget", "financial analysis", "ROI", "cost analysis" |
| communication | communication | google-workspace, microsoft365, messaging, scheduling, profiles, notes, email-processor, voice | "email", "gmail", "calendar", "phone call", "call me", "outlook" |
| automation | automation | shell, docker, filesystem, scheduling, mcp | "schedule", "cron", "recurring task", "remind me", "automate" |
| architecture | architecture | filesystem, shell, knowledge, task_state, websearch, repo_registry, mcp | "architecture", "system design", "requirements", "technical specification", "design document" |
| qa | qa | browser, browser-ext, shell, docker, filesystem, knowledge, task_state, visual, artifacts, artifacts_toolbox | "run tests", "test suite", "validate", "verify", "validation" |
| review | review | filesystem, shell, git, github, knowledge, task_state, repo_registry, visual | "review the code", "code review", "linting", "test coverage" |
| ai | ai | shell, filesystem, browser, browser-ext, websearch, knowledge, task_state, mcp | "ML model", "RAG", "training", "neural network", "embedding" |
| general | general | filesystem, shell, browser-ext, websearch, messaging, knowledge, notes, tasks, task_state, scheduling, profiles, email-processor, artifacts, artifacts_toolbox, documents, skill-distill, mcp, mcp_admin | "browser", "screenshot", "telegram", "send message", "knowledge base" |
| pm | pm | filesystem, messaging, tasks, knowledge, github, atlassian, skill-distill | "project plan", "estimates", "timeline", "deliverables", "jira", "confluence" |

### Prompt Examples → Routing

```
"Fix the login bug in auth.ts"
  → coding role → filesystem, shell, git tools

"Search the web for React state management best practices"
  → research → research role → websearch, knowledge tools

"Deploy the Docker container to production"
  → devops → devops role → shell, docker, git tools

"Check my Gmail inbox"
  → communication → communication role → google-workspace tools

"Call +1234567890 and tell them the meeting is moved"
  → communication → communication role → voice tool

"Create a daily reminder at 9 AM"
  → automation → automation role → scheduling tool

"Run the test suite"
  → (matched by root agent system prompt) → qa role → browser, shell, docker tools

"Who is my wife?"
  → (matched by root agent system prompt) → general role → profiles tool

"Take a screenshot of my browser"
  → general → general role → browser-ext tool

"Write API documentation for the auth module"
  → writing → writing role → filesystem, knowledge tools

"Scan the app for SQL injection vulnerabilities"
  → security → security role → shell, browser, websearch tools

"Analyze the cost of migrating to AWS"
  → finance → finance role → browser, websearch tools
```

### Special Routing Rules (from root agent system prompt)

These are prompt guidance and examples, not deterministic routing rules. The general root can perform work itself when its tools suffice:

| Pattern | Routes To | Reason |
|---------|-----------|--------|
| "use my browser", "check this website" | general | Has browser-ext + messaging |
| "run tests", "test suite" | qa | Discovers and runs project tests |
| "review the code" | review | Read-only analysis + linters |
| "gmail", "calendar", "call me" | communication | Google Workspace + voice |
| "who is my wife", "my dog" | general | Has profiles tool |
| "remember this", "save this" | general | Stores in profiles + knowledge |
| "create a schedule", "every morning" | automation | Built-in scheduling tool |

## Expert Agents

### What Are Experts?
Experts are pre-configured personas with structured prompts, critical rules, deliverable templates, and success metrics. They provide deeper specialization than roles.

### Triggering Experts

Experts are triggered explicitly via the `/expert` command in any channel:
```
/expert coder Implement a REST API for user management
/expert security-analyst Audit the authentication flow
/expert devops-engineer Set up GitHub Actions CI/CD
```

The root agent:
1. Loads the expert from the database (name, description, role, system prompt)
2. Builds expert system prompt with: security preamble + expert identity + role prompt + critical rules + deliverable template + success metrics + domain knowledge from skills
3. Spawns a worker with the expert's role tools and system prompt

### Available built-in tools

The role table above lists tool containers, not individual callable functions.
Use `GET /api/tools`, `GET /api/tools/all`, or `GET /api/tools/role-map` for
current handler names, schemas, and role bindings. Manifests in `src/tools/`
are authoritative; callable names and permission action names can differ.
Tool availability does not authorize execution: ASK needs an attended approval
surface or a valid reviewed grant; unattended ASK is blocked.

## Model selection

Planned children use a configured lane executor first; otherwise an expert's
explicit model preference precedes the topic primary. Unresolved specialist
bindings fail with a configuration error. The root can use the configured
default. See [Model routing](MODEL-ROUTING.md) for executor, backup, and worker
path details; model capabilities and routing behavior differ by execution path.
