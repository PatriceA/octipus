# Tool & Expert Routing

## How Messages Get Routed

### Message Classification

Every message runs the same agent turn: the root agent, holding the general
toolset plus `spawn_child`. The keyword classifier
(`src/core/orchestrator/classifier.ts`) does **not** decide whether an agent
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
| coding | coding | filesystem, shell, git, knowledge, task_state, repo_registry, skill-distill, mcp | "implement", "write code", "fix bug", "refactor", "typescript", "react", "git commit" |
| research | research | websearch, knowledge, task_state, filesystem, profiles, artifacts, artifacts_toolbox, repo_registry, skill-distill, mcp | "research", "investigate", "search the web", "compare", "find out", "tell me about" |
| devops | devops | shell, docker, git, filesystem, mcp | "docker", "kubernetes", "deploy", "CI/CD", "nginx", "terraform" |
| security | security | shell, filesystem, browser, browser-ext, websearch, knowledge, task_state, mcp | "vulnerability", "audit", "OWASP", "threat model", "security review" |
| data | data | shell, filesystem, knowledge, task_state, artifacts, artifacts_toolbox, mcp | "database schema", "SQL query", "migration", "ETL", "data pipeline" |
| writing | writing | filesystem, browser, websearch, knowledge, task_state, messaging | "documentation", "write docs", "readme", "technical writing", "changelog" |
| design | design | browser, filesystem | "UI design", "UX", "wireframe", "mockup", "accessibility" |
| finance | finance | browser, websearch, filesystem | "budget", "financial analysis", "ROI", "cost analysis" |
| communication | communication | google-workspace, microsoft365, messaging, scheduling, profiles, email-processor, voice | "email", "gmail", "calendar", "phone call", "call me", "outlook" |
| automation | automation | shell, docker, filesystem, scheduling, mcp | "schedule", "cron", "recurring task", "remind me", "automate" |
| architecture | architecture | filesystem, shell, knowledge, task_state, websearch, repo_registry, mcp | "architecture", "system design", "requirements", "technical specification", "design document" |
| qa | qa | browser, browser-ext, shell, docker, filesystem, knowledge, task_state, visual, artifacts, artifacts_toolbox | "run tests", "test suite", "validate", "verify", "validation" |
| review | review | filesystem, shell, git, github, knowledge, task_state, repo_registry, visual | "review the code", "code review", "linting", "test coverage" |
| ai | ai | shell, filesystem, browser, browser-ext, websearch, knowledge, task_state, mcp | "ML model", "RAG", "training", "neural network", "embedding" |
| general | general | filesystem, browser-ext, websearch, messaging, knowledge, notes, tasks, task_state, scheduling, profiles, email-processor, artifacts, artifacts_toolbox, skill-distill, mcp | "browser", "screenshot", "telegram", "send message", "knowledge base" |
| pm | pm | filesystem, messaging, skill-distill | "project plan", "estimates", "timeline", "deliverables" |

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
  → (matched by orchestrator system prompt) → qa role → browser, shell, docker tools

"Who is my wife?"
  → (matched by orchestrator system prompt) → general role → profiles tool

"Take a screenshot of my browser"
  → general → general role → browser-ext tool

"Write API documentation for the auth module"
  → writing → writing role → filesystem, knowledge tools

"Scan the app for SQL injection vulnerabilities"
  → security → security role → shell, browser, websearch tools

"Analyze the cost of migrating to AWS"
  → finance → finance role → browser, websearch tools
```

### Special Routing Rules (from orchestrator system prompt)

These override keyword classification:

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

The orchestrator:
1. Loads the expert from the database (name, description, role, system prompt)
2. Builds expert system prompt with: security preamble + expert identity + role prompt + critical rules + deliverable template + success metrics + domain knowledge from skills
3. Spawns a worker with the expert's role tools and system prompt

### Available Built-in Tools

| Tool ID | Actions |
|---------|---------|
| filesystem | read_file, write_file, create_file, list_directory, search_files, create_directory, delete_file, copy_file, move_file, file_info |
| shell | execute_command |
| git | status, diff, log, commit, push, pull, branch, checkout, clone, create_repo |
| browser | navigate, click, type, hover, drag, screenshot, pdf, get_content, evaluate |
| browser-ext | get_tabs, navigate, click, type, screenshot, get_content, cookies, storage, console, network |
| websearch | search |
| docker | ps, logs, exec, images, build, run, stop, remove |
| google-workspace | gmail_list, gmail_read, gmail_send, calendar_list, calendar_create, drive_list, drive_download, contacts_list, tasks_list |
| microsoft365 | outlook_list, outlook_read, outlook_send, calendar_list, calendar_create, onedrive_list, todo_list, contacts_list |
| knowledge | search_knowledge, index_knowledge, delete_knowledge |
| profiles | search_profiles, list_profiles, create_profile, add_profile_fact, update_profile |
| scheduling | list_hooks, create_hook, update_hook, delete_hook |
| voice | initiate_call, continue_call, end_call, get_status, list_calls |
| email-processor | process_emails |
| messaging | send_message |
| mcp | mcp_list_tools, mcp_call_tool (lazy discovery of external MCP tools) |

## Model Selection

When a worker is spawned, the model is selected based on:
1. **Topic-based routing** — each role has a `defaultTopic` that maps to a model via `ModelRegistry.getModelForTopic(topic)`
2. **Tool support validation** — if the topic-bound model lacks tool support, the spawner swaps to a local Ollama tool-capable model
3. **Fail-loud** — if no topic-specific model is bound, the spawner throws with a message directing the user to the Models page (no default model fallback for workers)
4. **Expert preference fallback** — expert's `modelPreference` (if set) is used only when no topic binding exists
5. **Voice topic** — voice calls use a dedicated fast model for low latency

Configure per-topic model routing in Settings → Models or via the API.
