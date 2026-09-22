# Prompt effectiveness audit — 2026-09-17

## Assessment and scope

Follow-up: the user clarified the cost rationale for General’s early-delegation
rule. The [cost-aware delegation implementation](cost-aware-delegation-2026-09-17.md)
records the subsequent scoped changes; the findings below describe the audited
state before that implementation.

Octipus has useful foundations: role-specific responsibilities, tool-backed evidence,
visible proposal/execution plans, runtime permission checks, stable instruction
prefixes, and on-demand MCP/skill retrieval. It is **not yet consistently guided**
across its execution paths. Removing contradictions and repairing composition and
discovery contracts matters more than shortening prose.

This is a source-based audit of all 16 full/lite role pairs, expert seeds, General
assembly, direct experts, pipeline workers, swarm children, tool/MCP/skill loading,
workspace/memory context, and permission guidance. Two independent agents reviewed
these areas; findings were cross-checked against current source. No prompts,
permissions, or agent execution behavior were changed by this audit. User-created
expert/skill rows in a live database and installed third-party prompt hooks were
not inspected. No live model-quality or cost benchmark was run.

The concurrent TUI change is separate: wheel reporting is always active;
Shift+drag uses native terminal selection; Alt+M and `/mouse` were removed.
Existing unrelated changes in `src/shared/work-plan*` were preserved.

## Four different composition paths

| Entry point | Assembly | Domain knowledge | Built-in lazy schemas |
| --- | --- | --- | --- |
| Normal General | `core/agent/root-runner.ts` → manager | Global skill loaders; no automatic topic index in root assembly | Gate enabled for capable models with a role core set |
| Ordinary `spawn_child` | `core/swarm/spawner.ts` → manager | Expert/topic skill indexes | No advertisement configuration: full handler schemas |
| Pipeline/legacy worker | `core/agent/worker-spawner.ts` | Selected expert rules/templates/metrics, skill indexes, topic context | Gate enabled |
| Direct `/expert` | Direct expert builder → `spawnWorker` | Full assigned skill bodies for larger models; index for small models | Gate enabled |

Direct `/expert` bypasses root orchestration but later receives `spawnWorker`'s
instruction that “the rootAgent handles all user communication.” Condition that
instruction on an actual parent; direct experts need an accurate response contract.

The normal root and ordinary swarm **do not** pass through `spawnWorker`. Its
profile, Git-status, prior-action, and worker-output instructions must not be
reported as universal root behavior.

General assembles security/output rules and its role template, persona/project
hooks, delegation policy plus a separate delegation document, expert catalog,
and workspace/repository context. Date, current attachments/memory/guard context,
output mode, plan-mode instructions, and topic/ambiguity hints are appended as
turn-specific guidance. Canonical history and checkpoints are loaded separately
in the worker lifecycle. The September 15–16 session work already improved stable
prefixes and history continuity; this audit does not propose undoing it.

Workers additionally assemble expert rules, skills, project instructions, profile
facts, memory, prior actions, and sometimes Git status. Custom expert prompts can
replace default role text. These sources need explicit precedence and provenance,
not merely concatenation.

## Highest-priority correctness findings

### 1. Expert additions can replace the actual role instructions

In [`worker-spawner.ts`](../../src/core/agent/worker-spawner.ts), lines 598–642 start
`expertPrompt` from an optional custom prompt, then append critical rules, templates,
metrics and skill indexes. At line 752 any nonempty result wins over `roleTemplate`.
Seeded experts intentionally store a null custom prompt
([`seed-experts.ts`](../../src/db/seed-experts.ts), lines 402–423). Their additions can
therefore suppress the role workflow, lite variant, output rules and security
preamble. The manager accepts the supplied system text without repairing it.

The ordinary swarm correctly falls back to the role before appending additions
(`spawner.ts`, lines 2067–2085), but a nonempty custom expert prompt there can still
omit the canonical security preamble. Direct `/expert` explicitly prepends it.

**Change:** one shared composition contract: canonical security/output invariants,
role/custom specialization, then expert additions. Preserve intentional custom
specialization without dropping global invariants. Do not rewrite
`SECURITY_PREAMBLE`; fix where it is assembled. Test default, custom and seeded
experts in full/lite mode across all four entry points.

### 2. Lazy built-in discovery has an incomplete execution contract

[`tool-discovery.ts`](../../src/tools/tool-discovery.ts) returns a described tool's
schema as tool-result text and tells the model to call that name directly. However,
[`agent-worker.ts`](../../src/core/agent-worker.ts), `getAdvertisedToolHandlers`,
continues filtering out long-tail handlers on subsequent requests. The executor
knows them; the provider's advertised function array still does not.

This is a structural gap, **not proof that every provider fails**: some models or
compatibility paths may emit an undeclared function. Existing schema-return tests
do not establish provider-portable discover → execute behavior. CLI discovery
already has a guarded dispatcher, and MCP has `mcp_call_tool`.

**Change:** use executor-backed invocation or promote explicitly described schemas
for the run. An invocation wrapper must retain argument validation, permission,
plan/read-only checks, audit and cancellation. Do not invoke raw handlers to bypass
middleware. Validate the wire request and eventual side effect on each execution
path, then compare discovery overhead and task success.

### 3. Reading one file blocks subsequent coding delegation

[`swarm-tool.ts`](../../src/core/swarm/swarm-tool.ts), lines 302–322, refuses a coding
child after any root file read. This is runtime behavior, not just advice. It blocks
legitimate discovery followed by handoff, explicit user-requested delegation, and
independent remaining work. Reading requirements does not prove General should
implement the entire task.

**Change:** prevent overlapping or duplicate assignments using a concrete handoff
and ownership boundaries. Let General inspect enough to choose well, then delegate
remaining specialist work with context already learned. Avoid handing off completed
implementation merely to repeat it.

### 4. Exact skill/expert lookup lacks the listing visibility scope

[`skill-loader.ts`](../../src/tools/skill-loader.ts), `get_skill`, ignores the caller
when invoking `renderSkill`; registry lookup reaches a plain ID query. Listing is
user-aware. Topic discovery likewise does not take user/org visibility context.
A requested `expertId` in [`spawner.ts`](../../src/core/swarm/spawner.ts), line 1828,
is selected by ID alone.

**Change:** apply the same owner/system/organization visibility policy to listing,
search, assignments, exact retrieval and prompt assembly. Test two users, shared
content and unavailable IDs. These findings establish missing checks in source;
no cross-account exploitation or production data access was attempted.

### 5. Generic connector availability differs by entry point

Root omits per-user generic connector handlers. Swarm adds handlers identified as
`connector`, then intersects allowed tool IDs from role configurations, which use
`connector:<id>` bindings rather than a generic `connector` allowance. The loaders
can disappear. The swarm loading call also lacks the bound-connector filter used
by `spawnWorker`. This finding concerns generic connector handlers, not every
built-in tool or every MCP connection.

**Change:** share connector assembly and carry explicit connector scopes through
delegation. Test an allowed bound connector, an unbound connector and a missing
connection on root, direct expert, pipeline and swarm paths. Do not fix missing
capabilities by granting every connector to every role.

## General, coding and swarm guidance

Current policy repeats one benchmark anecdote and turns it into hard rules. The
General full prompt is 1,740 tokens and the appended delegation document alone is
2,795 tokens using `cl100k_base`; together they are 4,535 tokens before security,
policy, catalogs, context and schemas. Those are reproducible source-text counts,
not a live assembled prompt size or provider bill.

The important defects are semantic:

- General and coding prohibit rereading just-written files. General additionally
  prohibits test files unless explicitly requested and says to run the named
  verification command once; coding asks for relevant typecheck/lint/test commands.
  A successful write proves persistence, not correctness. Permit changed-region or
  diff inspection and meaningful tests; repeat checks after relevant fixes.
- Direct experts are told to stop after five tool calls, independently of task or
  actual budget. Discovery plus skill loading can consume that allowance. Replace
  arbitrary ceilings with progress-aware stopping and the real execution budget.
- Root policy allows pipelines only on an explicit multi-stage request, while the
  delegation document and development-session guidance prefer them for broad
  implementation. Choose one criterion: dependent stages with useful handoffs and
  verification, or an explicit requested workflow.
- The delegation document says uncertainty means direct action; the later
  ambiguity-classification block says uncertainty means delegate. Full mode still
  receives this classifier-based steering. A vague request should prompt scoped
  investigation or clarification, not an automatic routing decision.
- A browser-session task is listed as requiring a child even though General has
  `browser-ext`. Tool capability should come from the actual available registry.
- The no-respawn rule permits only two narrow exceptions (conditional multi-step
  work and structured referral to another role), preventing same-role corrective
  follow-up. Near-verbatim relay of one child's answer also discourages gap repair. Scorers can check files, JSON and commands;
  they cannot establish complete reasoning or fulfillment of every requirement.
- `spawn_child ALWAYS returns immediately` overstates the runtime: hookless and
  depth-limited paths can await completion. Shared-filesystem wording also wrongly
  implies agents cannot see each other's writes; they can, but lack synchronization.
- General names nonexistent `index_knowledge`; coding incorrectly promises code
  writes are automatically indexed to the knowledge base. Use actual storage tools
  and keep source-code indexing separate from document knowledge.

**Recommended policy:** General owns completion. It acts directly when the task is
bounded, its tools suffice and it can verify the outcome. It uses specialists for
sustained domain judgment, a distinct toolset, independent verification or useful
parallel work. It can reassess after initial investigation. Each child gets scope,
paths, known findings, ownership, constraints, acceptance criteria and requested
evidence. General collects, checks and synthesizes; it may request a bounded,
specific correction when evidence shows a gap. It does not blindly retry a denial
or repeat an unchanged failing action. Swarm remains an important capability,
without either mandatory fanout or a General-does-everything bias.

## Permissions, plans and role contracts

- The runtime distinguishes attended ASK from unattended blocking and enforces
  DENY. Statements that a child cannot obtain approval are stale. The comment in
  `roles/types.ts` about automatic ASK approval is also stale; it does not describe
  today's runtime. Preserve denial non-circumvention and actual scoped grants.
- Permission guidance should distinguish user intent, unresolved decisions and
  runtime authorization. Existing explicit authorization should not trigger a
  second conversational confirmation, but it must not bypass a required runtime
  approval. Never imply tools or a published plan confer authorization themselves.
- General's proposal/execution distinction is a strength: future implementation
  stays pending; planning research is not completed implementation. Keep it.
- Plan mode filters `FILE_CHANGE_TOOLS`, not every side effect. Messaging, tasks,
  scheduling and other mutations are not comprehensively withheld by that filter.
  Shell tests can also write generated files. Treat current plan mode as guidance
  plus partial filtering, not a comprehensive read-only boundary. Define permitted
  planning-record writes explicitly and enforce other action categories at runtime.
- PM demands backlog creation even for a plan-only request. Make actual to-do writes
  conditional on user intent; a proposal belongs in the visible work plan first.
- Security says READ-ONLY but instructs saving a report and lacks `readOnly: true`.
  Align the contract: audit results to the parent for persistence, with enforced
  action restrictions, or explicitly describe a report-writing role. The existing
  file-write filter alone is not a complete shell/integration sandbox.
- Communication/devops require blanket reconfirmation in cases where an exact send
  or operation may already be authorized. Ask when target/content/scope is missing;
  otherwise let the permission mechanism handle required approvals.
- Seeded “critical rules” need scrutiny: index every predicate/join/sort column,
  log all model inputs/outputs, and benchmark every critical flow are unsuitable
  universal requirements. Qualify these by workload, privacy and requested scope.

## Coverage of all full/lite role pairs

Counts below are source-text tokens using `js-tiktoken` / `cl100k_base`, excluding
shared rules, expert additions, schemas and dynamic context. They are not targets.
Full/lite pairs are mostly aligned; the assembly-path differences are more serious
than prose drift between those pairs.

| Role | Full / lite tokens | Retain | Specific improvement |
| --- | --- | --- | --- |
| general | 1740 / 968 | Correct personal-tool routing, visible proposal semantics | Correct nonexistent storage tool; remove verification bans and conflicting delegation rules |
| coding | 932 / 495 | Focused diffs, read-before-edit, project-native checks, exit-code evidence | Permit useful rereads/tests; correct approval and code-indexing claims |
| review | 997 / 709 | Read-only configuration, file/line findings, scoped whole-diff review | Distinguish unrun checks from demonstrated defects; retain evidence discipline |
| qa | 1435 / 950 | Authoritative validators, test discovery, reproducible failures | Do not rerun unchanged suites after merely proposing test source in the reply |
| security | 676 / 443 | Scoped threats, confidence, remediation | Resolve read-only versus report-writing contradiction and config mismatch |
| architecture | 579 / 424 | Alternatives, consequences, actionable roadmap, read-only configuration | Make implementation a handoff to the parent rather than imply direct dispatch |
| research | 933 / 635 | Source cross-checking, citations, retrieval-failure honesty | Save reports when requested/useful; remove external five-call ceiling |
| automation | 699 / 448 | Inspect existing hooks, avoid duplicates, require actual receipts | Correct create/update argument examples and implement real timezone support |
| pm | 955 / 586 | Dependencies, risks, estimate uncertainty | Do not create user backlog entries for every plan; future steps remain pending |
| data | 1620 / 1055 | Query provenance, parameterized SQL, artifact validation | Qualify universal indexing rules and avoid needless repeated visibility questions |
| ai | 433 / 295 | Baselines, smallest useful experiment, measured metrics | Replace blanket model-I/O logging with scoped, privacy-aware diagnostics |
| communication | 813 / 528 | Resolve contacts, report actual delivery IDs | Respect exact existing authorization; clarify unresolved send/call details |
| devops | 567 / 384 | Minimal changes, local/dry-run checks, command evidence | Distinguish authorized exact operations from unresolved destructive scope |
| design | 534 / 340 | Existing tokens, contrast, concrete properties, responsive checks | Align inline audit versus saved deliverable with the request |
| finance | 432 / 292 | Sources, units, dates, formulas and sensitivity | No major role-specific blocker; preserve sufficient multi-source verification |
| writing | 695 / 446 | Audience, authoritative sources, examples, untested labels | Execute examples only in an appropriate environment; otherwise label validation limits |

**Automation needs a contract repair, not just nicer wording.** Both prompts teach
`triggerConfig: { cronExpression, timezone }` and nested `actionConfig`; the actual
`create_hook` schema in `src/tools/scheduling/index.ts` (lines 63–77) accepts flat
`cron_expression`, `notify_message`, `agent_prompt`, `orchestrated` and
`max_executions`. It has no timezone input, although the prompt says always supply
one. The manager defaults missing timezone to UTC. Fix both the tool contract and
full/lite/seed examples; validate example arguments against the actual schema and
check that the stored hook fires in the requested timezone. Do not claim the prompt
can deliver local-time scheduling while the tool cannot express it.

## Targeted lazy loading and context quality

| Source | Keep immediately available | Load or select when needed |
| --- | --- | --- |
| Global instructions | Security, evidence, authorization, role boundaries, completion/delegation criteria | Never hide essential behavioral invariants behind discovery |
| Tools | Reliable core actions and compact capability discovery | Long-tail schemas through a tested execution contract |
| MCP | Connection availability, bounded search and exact-schema lookup, guarded call wrapper | Per-tool schemas and requested resources/prompts; no wholesale catalog dump |
| Skills | Short relevant index and explicit activation criteria | Full relevant skill bodies; share behavior across direct experts and swarm |
| Experts | Role summaries and useful configured specialties | Searchable exact expert details when the index cap is reached |
| Repositories | Actual target paths, boundary instructions and provenance | Relevant guide sections and dependency/symbol detail through repo tools |
| Profiles/memory | Relevant user preferences and task facts within a budget | Unrelated or large personal profiles on demand |
| Workflow recipes | Direct vs specialist vs pipeline criteria, safe handoff contract | Detailed domain recipes when that workflow is selected |

Specific follow-ups:

1. Ordinary swarm fanout currently ignores built-in lazy advertisement; extend the
   shared mechanism only after discover → execute works reliably.
2. Direct experts eagerly receive full skill bodies for larger models. Match the
   index-and-load approach, with an option to eagerly provide a clearly essential
   small assigned skill when that avoids a needless discovery turn.
3. `list_tools` without a successful query can return the entire long tail, and
   `list_skills` is unbounded. Add search/pagination with an explicit more-results
   path; do not silently hide needed capabilities behind a count cap.
4. Every `spawnWorker` receives all of the user's own profile facts, even for coding;
   related profiles also include every fact. Select relevant facts with a visible
   budget and preserve a retrieval route.
5. Git context uses the dev project or global workspace/process directory, which may
   not be the task repository. Resolve and label the actual repo before injection.
6. Prior-action suppression uses a 15-minute session window as if it identified the
   current root run. A new explicit repeat request must remain possible. Scope
   deduplication to run/task identity; label older records as historical evidence.
7. Project-guide slices can omit relevant instructions without a useful disclosure.
   Include provenance and truncation state, then load applicable content. Do not
   truncate safety or repository constraints merely to meet a prose-size target.
8. Preserve stable-before-volatile ordering. Direct-expert overrides currently mix
   attachments/security reminders into text treated as a stable base. Carry typed
   sections with source, scope, stability and budget across every entry point.

Do not make every source lazy. Extra discovery calls also cost latency and tokens;
cacheable stable context can be useful. Measure end-to-end task success, necessary
verification, first useful action, total tool/model calls, cache usage and cost.

## Implementation order and acceptance criteria

1. **Composition and isolation:** shared prompt envelope, seeded/custom fallback,
   skill/expert visibility and connector scopes. Test the four entry points with
   system/custom experts, full/lite models, missing skills and two users. Require
   global invariants exactly once and preserved role instructions.
2. **Reliable discovery:** repair built-in invocation, then extend to ordinary swarm;
   paginate tool/skill catalogs. Verify discover → describe → execute, denied calls,
   stale tools, read-only mode and provider wire schemas. Preserve CLI/MCP guards.
3. **Coherent behavioral guidance:** one delegation policy, remove file-read coding
   blockade and arbitrary call ceilings, permit relevant verification, correct
   actual tool names/schemas, resolve security/PM/QA/communication contradictions.
4. **Relevant context:** bounded profile facts, correctly scoped repo/Git context,
   root-run prior actions, direct-expert skill loading and typed stable/volatile
   fragments. Keep essential instructions eager and truncation inspectable.
5. **Quality evaluation before claiming optimization:** compare current and candidate
   prompts on small direct fixes, multi-repo implementation, independent review,
   explicit delegation after reading, failed-child correction, approved vs denied
   actions, plan-only requests, connector discovery, private skills, automation
   schedules and direct-expert work needing more than five calls. Include full/lite,
   direct-provider and CLI paths. Grade actual artifacts and side effects as well as
   routing. Record model/config, tools, tokens, latency and user-visible outcome.

Deterministic regression tests prove contracts, not model quality. A live-model
comparison should use representative fixed tasks and report failures as well as
savings. Do not accept a token reduction that worsens completion, evidence,
permission correctness or the ability to use specialists when they help.

## Validation of the accompanying TUI change

- TUI suite: **349 passed**, including real POSIX PTY tests for both chat/editor,
  always-on wheel input, keyboard history, resize, draft retention and OSC 52 copy.
- Complete repository suite: **5,991 passed, 179 skipped, zero failures**
  (519 passing test files, 14 skipped).
- Typecheck, lint, production build and `git diff --check` passed. Lint reports only
  the existing Biome schema-version informational notice.
- Independent TUI review found no open code blockers. PTY tests cannot establish
  physical Shift+drag behavior or clipboard acceptance in the user's desktop
  terminal. The native selection override is documented with its terminal-dependent
  limitation in [the TUI guide](../guides/tui.md).
- Initial sandbox-only socket/process EPERM failures were rerun successfully with
  the required execution permissions; they are not remaining test failures.
- Prompt findings are source evidence, not regressions newly fixed or measured model
  improvements. No prompt/routing edits were made, so no live prompt eval was run.
- No commit, push, deployment or server restart was performed.
