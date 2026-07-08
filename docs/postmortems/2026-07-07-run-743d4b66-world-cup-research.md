# Post-mortem: Run 743d4b66 — World Cup research drift (2026-07-07)

**Status:** code-enforceable fixes applied 2026-07-08 (items 2, 3, 4, 6, 8). Deferred: 1 (infra — SearXNG container network), 5 (budget binding — needs runtime investigation), 7 (capability gate — larger redesign).
**Severity:** high — user-visible failure, 85 minutes of wasted compute, ~25 unrequested files written to the workspace
**Session:** `1966368e-51cb-440d-834d-64dc1f62bfdd`
**Agents:** orchestrator `743d4b66…` (gemini-3.1-flash-lite, lite/router mode, 59m 23s, 7 iter) → research child #1 `36f16e1d…` (qwen3.5:9b, 3m 35s, 10 iter, 150k tokens) → research child #2 `3d43199e…` (qwen3.5:9b, 85m 7s, 37 iter)

## TL;DR

The user asked a trivial question: *"WM 2026 — who played yesterday, what was the score, who plays today and tomorrow?"*

The search infrastructure was dead (the SearXNG container has no outbound network), octipus reported every tool failure as success, and a 9B model whose entire system prompt was two copies of "Technical Writing / Diátaxis" domain knowledge confabulated a documentation task out of its own tool list. The `ai-docs/` spam is the model literally documenting the tools it saw in its prompt. Every layer that should have caught this — error surfacing, role prompts, budgets, drift detection — failed.

Evidence sources: prompt dumps in `~/.octipus/prompts/2026-07-07T10-00-*`, full event streams via `octipus_get_agent_events` (all three agents read end-to-end), live verification of the SearXNG container. Rogue files landed in `~/.octipus/workspace/users/8c2e983c-*/workspaces/default/files/sessions/2026-07-07-research-1966368e/ai-docs/`.

## Timeline

| Time (UTC) | Event |
|---|---|
| 10:00:22 | Orchestrator starts. Message pre-classified `research` (confidence 0.40). |
| 10:00:24 | `spawn_child` #1 (role research). Framework force-detaches the spawn. |
| 10:00:25–10:03:59 | Child #1: 4 searches → all `{resultCount: 0}` in ~3.005s each, `status: "ok"`. 4 fetches → fifa.com twice `text: ""`, ESPN bot-wall ("JavaScript is disabled… verify that you're not a robot"), Wikipedia 404 page — all `status: "ok"`. Concludes (fabricated): *"My current tools are disabled for web scraping to prevent spam detection issues."* Uses 150,473 tokens against an 80k cap. |
| 10:04:46 | Orchestrator — whose prompt says "Delegate ONCE… do not retry" — spawns child #2, brief: *"Retrieve live tournament match schedule and scores by checking fifa.com directly … since current infrastructure lacks sports feed integration"* (the rationale is hallucinated). |
| 10:04–10:07 | Child #2 actually researches: opens fifa.com in the extension browser, `wait_for` times out (10s), calls a **hallucinated tool** (`browser-ext__get_html` → "Unknown tool"), `evaluate` blocked by CSP, `fetch_page` empty, headless `browser__open` redirects to the German locale with empty title, takes a **373 KB base64 screenshot** — fed raw to the 9B text model. |
| 10:07–10:10 | **The drift point.** Three consecutive model turns with no useful action (one produced no tool call at all; the loop silently re-invoked). Context compaction events (visible as messageCount drops) dilute the FIFA task. The agent never mentions football again. |
| 10:10–11:25 | Child #2 writes ~25 files: `ai-docs/structure/DIATAXIS-DECISION.md`, reference pages for **its own tools** (`spawn_child.md`, `profiles__add_fact.md`, …), getting-started guides, an OAuth/PKCE walkthrough (141 OAuth/PKCE mentions in the log vs 23 "fifa"), YAML workflow templates, a changelog dated `### 2024-*`, and overwrites the top-level `README.md`. |
| 10:04:47–10:10:22 | Orchestrator's `collect_children` waits 336s → returns `status: timeout, STILL RUNNING… keep waiting`. |
| 10:10–10:57 | Orchestrator blocks silently for ~47 minutes (auto-collect force-wait against its remaining wall clock). |
| 10:59:45 | Orchestrator gives up and answers the user ("consult the official FIFA World Cup website"). Child #2 is still running. |
| 11:29:53 | Child #2 — now an **orphan**, 30 minutes past its parent's death and 75 minutes past its own 10-minute wall cap — declares victory: *"I've successfully created a comprehensive documentation structure for your AI workspace using Diátaxis principles! … Happy documenting! 🚀"* Not one word about football. |

No guardrail fired at any point. The event stream contains zero budget warnings, zero iteration-limit events, zero relevance checks.

## Root causes

### RC1 — SearXNG container has no outbound network (infrastructure)

Verified live:

```
$ curl "http://localhost:8888/search?q=test&categories=general&format=json"
HTTP 200 in 3.004s
{"query":"test","number_of_results":0,"results":[],…,
 "unresponsive_engines":[["brave","timeout"],["duckduckgo","timeout"],
 ["google","timeout"],["startpage","timeout"],["wikipedia","timeout"]]}
```

`wget https://duckduckgo.com` from inside the `searxng` container fails. Every engine times out at SearXNG's internal 3.0s limit (hence the identical 3,005ms search durations in the run). **Fixing this alone would have made the run succeed.**

### RC2 — Every tool failure is reported as success (`src/tools/websearch/index.ts`)

- `searchViaSearxng` (index.ts:103–130) treats HTTP 200 with zero results as success and **ignores `unresponsive_engines`**. The Playwright/Google/DDG fallback chain (index.ts:149–163) only engages if SearXNG *throws* — so a dead-network SearXNG poisons all searches while looking healthy.
- `fetch_page` (index.ts:271–332) uses `domcontentloaded` + a fixed 1s `waitForTimeout` (index.ts:296) — far too short for JS-heavy SPAs like fifa.com — then returns `{textLength: 0, text: ""}` with `status: "ok"` (index.ts:319–324). Bot walls and empty renders are silent successes.
- In the event stream, **not a single tool call in either child had `status != "ok"`** — empty searches, empty pages, CSP violations, and unknown-tool errors were all smuggled inside "ok" results. A small model cannot distinguish "infrastructure broken" from "information doesn't exist"; child #1's fabricated "tools are disabled for spam detection" is the direct product.

### RC3 — Swarm children get no role prompt (`src/core/swarm/spawner.ts:988`)

The research child's **entire system prompt** was:

```
# Domain Knowledge (expert)
## Technical Writing
… Frameworks: Diátaxis, ADR, OpenAPI, Mermaid, Docs-as-Code

# Domain Knowledge (topic)
## Technical Writing
(identical block, again)
```

Three stacked defects:

1. **No role-prompt fallback.** `spawner.ts:988` sets `systemPrompt = expert.systemPrompt || undefined` — null for seeded experts — with no fallback to `roles/research/prompt.md`. That file is *good*: it has an HONESTY section ("Report only what tools actually returned"), time-boxing, anti-patterns, citation rules — exactly what would have prevented both the fabrication and the drift. The other spawn path (`worker-spawner.ts:137`) *does* fall back to the role template; the swarm path drops it. The expert's `criticalRules` are likewise injected only on the worker path.
2. **Wrong knowledge for the task.** The Researcher expert's only skill is `technical-writing` (`seed-experts.ts:95`), and `seed-skill-topic-assignments.ts:75` assigns the same skill to the `research` topic.
3. **No dedup** between expert-skill and topic-discovered fragments (`spawner.ts:1016` vs `:1030`) — the same block injected twice, doubling its weight.

For a 9B model, system prompt = task identity. When the real task died, "Diátaxis" was all that remained — hence `ai-docs/`.

### RC4 — Contradictory orchestrator prompt assembly

- `prompt.lite.md:34`: *"Delegate ONCE per request… do not spawn again."* Then `orchestrator-runner.ts:233` appends the classifier block: *"Delegate to specialists via spawn_child **(one or more calls per turn)**"* and advertises `create_pipeline` — a tool lite mode doesn't expose. Small models are literal; this contradiction is the proximate cause of the rule-breaking second spawn. "Delegate ONCE" has **no code enforcement** in lite mode (only the LLM-less `router` mode is structurally single-spawn, `router-turn.ts:40–92`).
- **Prompt says await, tool does detach.** The lite prompt describes a synchronous flow ("After the child returns, reply") and never mentions `collect_children`, but `swarm-tool.ts:184` force-detaches every spawn when hooks are wired — so the model's first tool result orders it to call a tool its system prompt never described.

### RC5 — Budgets exist but did not bind

Depth-1 children are capped at **80k tokens / 10-minute wall** (`src/core/swarm/types.ts:89–91`). Child #1 used **150,473 tokens** (~1.9×); child #2 ran **85 minutes** (~8.5×). Enforcement in `agent-worker.ts` (per-iteration budget check :544+, wall abort :599) was evidently advisory or bypassed on this path — needs its own investigation. Additionally, the child outlived its parent by 30 minutes (orphan; the recent periodic orphan-reaper commit is the right direction, but cascade-cancel on parent finalization would be stronger).

### RC6 — No drift detection, no write-scope enforcement, blind logging

- An agent that stopped mentioning its task after iteration 8 ran 29 more iterations to a self-declared success. Nothing watches actions against the brief.
- `roles/research/config.ts:8` grants research the whole `filesystem` group (write/delete), profiles CRUD, artifacts CRUD, repo_registry. Tool groups are all-or-nothing; "READ-ONLY" exists only as prose the orchestrator is told to put in briefs (`prompt.lite.md:36`) — and didn't.
- `thought` events log only `{model, messageCount}` — the model's actual pivot reasoning is unrecoverable. Every future post-mortem will hit the same wall.

### RC7 — Model routing has no capability gate on the swarm path

`spawner.ts:1090–1095` explicitly refuses tier clamps ("Topic bindings are authoritative"). Nothing checks context-window size or vision support before handing a 9B text model a 373KB screenshot and a ~120-tool surface. The tool-support fallback exists only on the worker path (`model-selector.ts:109–190`). Also fragile: gemini-3.1-flash-lite lands in "lite" mode only because its name contains no `NNb` parameter-count token (`mode-selector.ts:98–115`).

## Prompt review vs. current OpenAI / Anthropic guidance

Reviewed against OpenAI's prompt-guidance (small models are literal; need explicit execution order, scoped instructions, no conflicts; explicit retrieval budgets with stopping rules) and Anthropic's prompting best practices (clear+direct, critical constraints first, agentic guardrails against overeagerness/file creation, research-task structure).

**What's already good:**
- `roles/research/prompt.md` is close to textbook: clear role, workflow, anti-patterns, honesty/citation contract, output format. It just never reaches swarm children (RC3).
- The security preamble's anti-fabrication rule 8 is well written — but it, too, was absent from the child prompts.
- The Octipus persona is distinctive and consistent.

**Gaps:**

| Issue | Location | Guideline violated |
|---|---|---|
| "Delegate ONCE" vs "(one or more calls per turn)" contradiction | `prompt.lite.md:34` vs `orchestrator-runner.ts:233` | Non-conflicting, scoped instructions for small models |
| Prompt describes await; tool force-detaches; `collect_children` undocumented in lite prompt | `prompt.lite.md` vs `swarm-tool.ts:184` | Tool behavior must match prompt contract |
| ~120 tools as a flat comma list inside the task *message* | `spawner.ts:1225–1228` | Tools belong in structured definitions; the name-dump became content the model drifted into documenting |
| 56-line persona + security preamble + router rules for a flash-lite model | orchestrator assembly | Lean prompts for small models; critical constraints first |
| No stopping rule for failed retrieval ("N consecutive empty/error results → stop and report verbatim") | worker prompts | OpenAI: explicit retrieval budgets with stopping rules |
| No file-creation constraint ("create only files the deliverable requires") | worker prompts | Anthropic: reduce file creation / overeagerness guidance |
| Duplicate domain-knowledge fragments | `spawner.ts:1016,1030` | Context is a public good; duplication skews small-model attention |

## Prevention — prioritized fix list

1. **Fix the SearXNG container's outbound network/DNS** (infra, minutes). Add a health check that runs a canary search and alerts on `unresponsive_engines`.
2. **Surface tool failures as failures** (`src/tools/websearch/index.ts`): treat 200-with-0-results + unresponsive engines as an error so the browser fallback engages; flag `textLength === 0` fetches as "page rendered no text (likely JS-heavy or bot-blocked)"; detect bot-wall signatures; give SPAs a longer settle (`networkidle` or ≥5s).
3. **Swarm spawner prompt assembly** (`spawner.ts:988–1044`): fall back to `roles/<role>/prompt.md` when `expert.systemPrompt` is empty; inject `criticalRules`; dedup skill fragments across the expert/topic paths; remove `technical-writing` from the `research` topic assignment (and give the Researcher expert a research-appropriate skill or none).
4. **Fix the lite orchestrator contract**: lite-specific classifier appendix (no "(one or more calls per turn)", no `create_pipeline` mention); either await-mode spawns in lite mode or document detach/`collect_children` in `prompt.lite.md`; optionally hard-disable `spawn_child` after the first successful collect in lite mode.
5. **Make budgets bind**: investigate why the 80k-token and 10-min wall caps were exceeded 1.9×/8.5×; cascade-cancel children when the parent finalizes.
6. **Narrow role tool grants**: split `filesystem` into read/write capabilities; research gets read-only by default. Add a stopping rule and a file-creation constraint to worker prompts.
7. **Capability gate at model binding**: refuse (or warn on) bindings where the task's tool surface, expected context, or image inputs exceed the model's capabilities; stop deriving orchestrator mode from a param-count token in the model name.
8. **Log assistant text in `thought` events** (truncated is fine) so the next post-mortem can see the pivot reasoning.

## Lessons

- **A silent-failure tool stack turns small models into fiction writers.** Every "ok"-wrapped failure was a step toward "my tools are disabled for spam detection."
- **For small models, the system prompt is the task.** Inject the wrong domain knowledge and, when the real task stalls, the model will *do the domain knowledge*.
- **Prose guardrails ("Delegate ONCE", "READ-ONLY") are not guardrails** unless code enforces them — especially on sub-10B models.
- **Budgets that don't abort are decorations.** 8.5× wall-cap overrun, orphaned past its parent, self-declared success.
