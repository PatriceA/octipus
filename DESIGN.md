# Octipus Design Principles

These principles guide changes to Octipus. They describe the intended direction,
not a guarantee that every existing path already meets it. Current execution
behavior is documented in [Agent Architecture](docs/AGENT-ARCHITECTURE.md);
implementation gaps and proposed changes belong in the
[consolidation plan](docs/plans/product-consolidation-2026-09.md).

## Start with one agent

The default interaction runs a root agent with tools. It can answer directly or
use `spawn_child` for a bounded task that benefits from delegation. There is no
separate model deciding whether the root runs. Classification supports context
selection and small-model hints; it does not choose the specialist for the root.

Delegation should earn its coordination cost through better results or shorter
completion time. Agent count is not a measure of success. Pipelines remain useful
for explicit stages, retries, and human input.

## Make handoffs explicit and verify outcomes

Resolve a worker's role, model, available tools, and budget before execution.
Describe the requested deliverable and the evidence needed to assess it. Validate
structured inputs at boundaries and reject malformed requests clearly.

Types and role metadata catch some incompatible requests. They cannot guarantee
that a model understands the task, that a tool succeeds, or that an answer is
correct. Prompt-defined deliverables are not enforced output schemas. Use tool
records and independent checks to assess completion; a model's own success claim
is insufficient.

## Give specialists a focused job

Keep specialist prompts and tool allowlists focused on their responsibilities.
Use explicit tool IDs rather than wildcards. The general root role necessarily
covers a broader range of work; tool availability is still separate from permission
to execute an action.

Add a role only when its distinct responsibilities justify it. Avoid multiplying
roles to compensate for an unclear prompt or workflow.

## Share mechanisms where they help

Prefer shared execution, permission, and lifecycle mechanisms over per-role
exceptions. Add an abstraction when multiple real paths need it, and keep its
inputs and ownership explicit. Do not build a general engine solely for a
hypothetical future use case.

Where both visual and text editing exist, make them projections of the same
stored definition. Do not promise interchangeable editors or arbitrary recursive
composition for capabilities that do not implement them.

## Keep channels as adapters

Channels should translate user input and execution events through shared backend
contracts. Put execution policy in the backend. Clients differ in what they can
render and whether they can deliver an approval prompt; document those differences
instead of assuming identical behavior across surfaces.

## Report failure and uncertainty accurately

A failed tool call must remain a failure in the worker's context and execution
record. Invalid input needs a specific error. Recovery and provider failover
should be inspectable, with the reason recorded.

The same principle applies to the UI: unavailable data is not zero, a disconnected
client is not evidence of an idle run, and an attempted save is not a saved file.
Distinguish loading, stale, unavailable, interrupted, and completed states. A
recoverable secondary failure may be logged without aborting the primary work,
but any missing deliverable must be apparent.

Error classification lives in `src/core/errors/classification.ts` and
`src/core/swarm/errors.ts`. Knowledge readiness is exposed through
`/api/knowledge/readiness`; callers should check actual write and indexing results.

## Keep execution permissions separate from prompt guidance

The `SECURITY_PREAMBLE`, input checks, and output guard provide model guidance and
prompt-injection mitigations. They are not substitutes for permission checks,
sandbox boundaries, or authorization at tool execution. Do not edit the preamble
without an issue and an argument.

**Current behavior:** `ASK` remains an approval requirement. Attended descendants
inherit their session’s approval surface; unattended calls return blocked. Stored
`DENY` wins over broad allow rules. Tool middleware rechecks authorization after
argument hooks, and the MCP bridge checks before sending to an external server.
Scoped grants bind a tool action to a session, workspace, or argument pattern and
an expiry. Existing run budgets still apply. An approval receipt is single-use and
bound to the caller, action, and arguments.

See [migration notes and evidence](docs/reports/consolidation-2026-09-10.md).
These checks do not establish the safety of external programs launched by CLI
workers or turn argument patterns into a filesystem/shell sandbox. Reviewing the
execution code and measuring live-provider quality remain separate work.

## Persist what users need after interruption

Messages, execution records, and saved deliverables belong in durable storage.
Typing indicators and live event transport may remain ephemeral. A durable record
does not mean the work itself can resume from any point.

Pipeline checkpoints support stage-level recovery; restarting a worker can repeat
work inside that stage. Background research jobs retain their records across a
restart, but interrupted computation is reported as an error rather than resumed
automatically. Make recovery boundaries and potentially repeated side effects
clear to the user.

## Bound delegation and account for its limits

Swarm delegation uses `spawn_child` in a fixed three-level tree: root agent →
Agent → Subagent. Token budgets cascade; cancellation follows the child tree.
Budget and timeout checks constrain execution, but are not a guarantee of exact
billing or immediate cancellation of external work already in progress.

Receipts record observed tool activity and unavailable evidence. They explicitly
do not certify correctness or security. See
[Swarm Reliability](docs/SWARM-RELIABILITY.md).

## Configure models explicitly

Resolve specialist models through topic bindings in `ModelRegistry`; unbound
worker topics fail at spawn time. The root can use the configured default model.
Children resolve their own topic bindings rather than simply inheriting their
parent's model. Keep deployment-specific model names out of implementation code.

Support local models and embedded storage as useful deployment options. Document
capability limits: tool calling depends on the model, retrieval needs embeddings,
and hosted models or external integrations require their respective services.
Self-hosting does not imply every configured workflow keeps its data local.

## Make behavior inspectable

Help users understand what ran, what changed, what evidence was checked, and what
remains unresolved. Reuse execution records for status views. Label estimated cost
and incomplete evidence, and keep detailed traces available without making users
read them to understand an ordinary result.

## Match evaluation claims to evidence

Changes to routing, prompts, roles, or tool selection should run the relevant eval
suite and report its configuration and results. Verify outcomes through files,
API state, or other independent evidence. Test both that a guard rejects its
failure case and that the shipping execution path actually reaches it.

Current CI includes unit tests, database integration, and browser tests with
stubbed API calls. The red-team workflow runs a **dry-run** that checks test-case
generation without calling a model. It does not establish adversarial model
performance, and it is not a live-model regression gate. See
[Testing](docs/TESTING.md) for the boundaries of each suite.

## Keep maintenance proportional to demonstrated value

The core is already substantial. Reduce coupling as it is touched, with tests at
execution boundaries, rather than promising a small core or starting a wholesale
rewrite. Every new tool, channel, and screen adds maintenance and validation work.
Prioritize reliable everyday workflows over catalog size.

Principles can change when implementation evidence supports a better approach.
Record the reason, current behavior, and migration implications together.
