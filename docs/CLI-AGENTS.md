# CLI agents

Octipus can run work through vendor CLIs using their existing login and
configuration. This is intended to make existing subscriptions useful inside
Octipus where providers allow it. Eligibility, third-party usage policies,
quotas, subscription coverage and additional charges are provider decisions.
A successful CLI login does not establish that a particular request is included
in a subscription.

Pi supplies the TUI components. It is not an additional agent integration.

## How tools and context work

Each managed CLI run receives a private loopback bridge, authenticated with a
random capability that ends with the run. The bridge exposes that worker's
registered Octipus tools, including its role-specific tools, skill loaders,
connectors and applicable plan/delegation tools. Calls run through the native
`ToolExecutor` with the original agent, user, session and workspace. The bridge
never accepts an identity or session override from tool arguments and does not
use the standalone MCP server's bootstrap admin token.

Claude Code (including the GLM/Kimi variants), Codex and Vibe receive a per-run
MCP configuration. Antigravity can reach the same bridge through a supplied
terminal helper. The helper supports listing tools and calling a named tool with
JSON arguments; credentials are inherited privately through the environment.

The working directory remains the session's project or user workspace. System
instructions are passed with the invocation. Octipus does not temporarily
rewrite `AGENTS.md` or `GEMINI.md` in a shared project.

These controls scope **Octipus bridge calls**. They do not turn the vendor CLI
into an OS-isolated tenant: vendor-native tools, host files, account credentials,
hooks and local configuration remain subject to the vendor's runtime and
sandbox. Use a trusted local execution account. Claude, Codex and Vibe isolate
their configured MCP list for the run; Antigravity's host integrations are not
isolated by its terminal-helper connection.

## Plans, feedback and delegation

A CLI root receives `get_work_plan` and `update_work_plan` when the root tool set
includes them. Its durable plan appears in the same web/TUI view as a native
root's plan. CLI children receive their own assigned tools; they do not acquire
root-only plan editing privileges merely by being CLI agents.

`get_cli_run_context` returns the plan, complete feedback history and queued user
guidance. Octipus tool responses also include fresh context when its repository is available.
A failed context refresh does not turn a successful tool operation into an error. The CLI is
instructed to check before further affected work and before its final answer.
This is delivery at a tool boundary, not immediate interruption of a running
vendor-native command.

Claude/Codex can make up to two follow-up invocations when guidance or unhandled
root-plan feedback remains, within the remaining run budget. When no follow-up
is possible (buffered adapters, an exhausted turn budget, or the follow-up
limit), the run still completes with its result: Octipus appends a visible note
naming how many guidance items were not applied and emits a `guidance_pending`
event. Plan feedback stays pending in the durable record and steering text is
already in the session history, so the next user message carries both. Feedback
marked `needs_clarification` remains visible for the user to answer.

Bridge calls are serialized per worker so the native executor sees one call at
a time. `get_cli_run_context` and `get_work_plan` bypass that queue, so a CLI can
still read guidance while an awaited delegation holds it.

Delegation uses the actual native `spawn_child` handler and its role, depth and
budget constraints, including detach mode: a CLI can fan out several children,
keep working, and pick their results up with `collect_children`. Every Octipus
tool response lists still-pending children in the run context. A CLI that
finishes without collecting gets one bounded follow-up turn to merge the
results (or, for adapters that report only at completion, the results appended
to its answer); children still pending after that are cancelled. Cancellation is
propagated through the worker's abort signal. Vendor-native subagents outside
Octipus's bridge are not members of Octipus's managed child tree.

## Permissions and limits

| Adapter | Octipus tools | Vendor planning mode | Activity | Vendor approval relay |
| --- | --- | --- | --- | --- |
| Claude Code / GLM / Kimi | Scoped MCP | `plan` | Structured stream | Claude permission control requests enter Octipus approvals |
| Codex CLI | Scoped MCP | `read-only` sandbox | Structured stream | Vendor's noninteractive sandbox policy; no interactive relay |
| Mistral Vibe | Scoped MCP | `plan` agent | Buffered | Vendor agent mode; no interactive relay |
| Antigravity | Terminal bridge | `plan` mode | Buffered text | Vendor mode; no interactive relay |

All **Octipus tool** calls use Octipus permissions. Attended sessions can approve
through their existing UI/TUI/channel; unattended ASK is blocked. Claude's own
tool approvals are relayed as toolId `cli-native:<Tool>` (for example
`cli-native:Bash`). The default rule set allows the read-only tools (Read, Glob,
Grep, LS, NotebookRead, WebFetch, WebSearch, TodoWrite); everything else uses the
ASK default. Operators who set their own `permissions.rules` replace that list
and can add per-tool entries such as `cli-native:Read(*)`. Rules can match
arguments, e.g. `cli-native:Bash(git:*)`. Existing `cli-native` policies and rules
remain effective: a denial under either identity wins, and legacy scoped grants
keep their conditions, expiry and usage limits. A new per-tool policy takes
precedence over a non-denying legacy policy; legacy ASK rules still take
precedence over the new read-tool defaults. Vendor-native
permissions are separate and vary by adapter. A vendor bypass/auto-approve mode
still bypasses that vendor's prompts; it does not authorize an Octipus tool that
Octipus denied. Prompt instructions tell the CLI not to work around denials, but
are not an enforcement boundary for arbitrary vendor-native shell actions.

When a Claude Code model row sets no permission mode, managed runs use
`workspace` (`acceptEdits`): edits inside the workspace proceed, and every other
native tool raises a permission request that the stdio relay routes through
Octipus' ALLOW/ASK/DENY rules. The previous default, `bypassPermissions`, never
emitted those requests, so the relay was inert unless an operator chose a mode.
Set `permissionMode: full` on the model row to restore bypass.

Adapters that report no token usage (Mistral Vibe, Antigravity) are accounted
with a character-based estimate (about four characters per token) flagged as
`estimated` on the cost row, so token budgets and pipeline pools no longer treat
those runs as free. The prompt handed to every CLI (and every native agent run)
is written to `~/.octipus/prompts` as an owner-only file swept after seven days;
turn the `agent.promptDumps` setting off to write nothing.

Plan mode overrides the configured vendor permission mode for the invocation.
Native plan mode itself is not a complete shell sandbox; neither is this mapping.
Managed runs reject extra arguments that could override permission, MCP, input,
output, directory or budget settings, both when the model is saved and at spawn. The supported additive flags are Claude's
`--no-session-persistence`, `--no-chrome`, `--disable-slash-commands` and
`--effort`; Codex's `--strict-config` and `--color`; and Antigravity's
`--disable-slash-commands` and `--effort`. Vibe has no additive flags currently.
Use the dedicated model settings for model choice and permissions.

The run's active-work timeout excludes Octipus approval and delegation waits.
Claude, Codex and Vibe's bridge tool requests have a separate two-hour vendor
wall-clock timeout, including those waits; exceptionally long calls can still
exceed that transport limit.
Reported usage is accumulated, with duplicate Claude message fragments deduped.
Claude/Vibe receive turn caps, and Vibe receives its own token cap. Exact token
accounting remains unavailable for adapters that do not report usage; Antigravity
has a timeout backstop, not a measured token-limit guarantee. Observed bridge
file changes and permission denials contribute to execution evidence, without
counting the outer MCP envelope a second time. Native vendor telemetry can be
incomplete, so counts are observed evidence rather than a complete audit of the
host filesystem.

## Authentication and fallback

By default the child uses the vendor CLI's stored login/configuration. Octipus
does not automatically inject the backend's API-key environment variables.
Operators who intentionally want that behavior can set
`metadata.cliAgent.inheritApiKeys: true` on the model. Claude's explicit OAuth
token environment variable remains supported. The GLM/Kimi Claude adapters
continue to use their explicitly configured vendor credentials/endpoints.

The CLI's own configuration may itself select metered API authentication; Octipus
cannot infer the final bill from a login. There is no implicit retry from a
failed CLI to the default/API model. Explicit topic backup bindings are still
an operator-configured fallback and can have different billing.

Build the bridge with `npm run build --prefix mcp-server` along with the backend.
Missing compiled bridge files fail at startup of the run. Capability details are
shown in the model settings and `/work-plan` for a CLI root.

## Validation scope

Deterministic tests cover private capabilities, cross-run isolation, invalid
configuration, compiled stdio transport, tool errors, context identity, plan
updates, feedback, permission denial, cancellation, follow-up turns, late
guidance reporting, unqueued context reads, Codex discovery and adapter
arguments. The vendor flags themselves (`--permission-prompt-tool stdio`,
`--input-format stream-json`, Codex `-c mcp_servers=…`, agy `--mode plan`) are
only exercised by the opt-in live test and can drift with vendor releases. An
opt-in test (`OCTIPUS_LIVE_CLI=claude-code`, `codex`, `vibe` or `antigravity` with Vitest's
`src/core/cli-agent-bridge.test.ts`) exercises a configured real CLI login against
isolated sample tools and an in-memory plan repository. It does not contact
personal connectors or modify project files, but consumes vendor usage.

Approximately 90% coverage of useful everyday workflows is the implementation
target, not a measured compatibility percentage or a promise of feature parity.
