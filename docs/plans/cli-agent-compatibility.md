# CLI agent compatibility

The product requirement is to let users run Octipus work through existing vendor
CLI logins and subscriptions where providers permit it. Pi remains the TUI
library; integrating Pi as another agent runtime is outside this work.

Provider eligibility, usage policies, quotas and extra charges remain provider
controlled. A CLI login is not proof that every action is included in a plan.
Octipus must not silently substitute a separately billed API model when a CLI
fails. Explicit topic backup bindings remain operator configuration.

## Implementation sequence

1. Replace spawned CLI access to the broad admin MCP token with a private,
   expiring run capability. Expose the actual registered handlers through the
   native executor with the original user/session/workspace and permission flow.
   Verify source and bundled launch paths and protocol isolation.
2. Connect durable plans, feedback, skill loading and native delegation through
   that bridge. Deliver queued guidance at bridge responses; bound any follow-up
   turn. Preserve execution evidence and cancellation through descendants.
3. Configure each CLI per run without rewriting global authentication or shared
   project instructions. Translate plan mode, improve supported approval
   protocols, and preserve CLI-managed authentication by default. No implicit
   inherited server API keys. Retain adapters where they can support the common
   workflows; a wholesale ACP migration is not required for this iteration.
4. Show practical capabilities and limits in the UI/TUI documentation. Verify
   the common workflows using deterministic subprocess/MCP tests and bounded
   live subscription-backed smoke checks where a configured login is available.

Run an independent agent code review after substantial changes and address
findings before final validation. Reviewers must distinguish native vendor tools
from calls through Octipus's bridge: the bridge is scoped, but it does not sandbox
all actions available to the host's authenticated CLI account.

## Acceptance workflows

- Correct user, session and project directory.
- Discover and call allowed Octipus tools; deny unavailable tools and foreign tokens.
- Load registered skills and use original-context connectors.
- Publish a visible plan, update steps/evidence, preserve handled feedback.
- Receive new user guidance and pending feedback during work.
- Delegate through the native child tree and cancel owned descendants.
- Route Octipus tool approvals through the initiating channel.
- Apply supported planning/permission modes to vendor execution.
- Preserve errors, cumulative budgets and observed file/permission evidence.
- Keep existing CLI authentication; report failures instead of choosing paid API fallback.

The target is broad coverage of everyday workflows, approximately 90% of useful
native-agent behavior. This is a prioritization target, not a measured product
claim. Session forking, exact cross-provider token accounting, automatic import of
all vendor-native plans, and uniform multimodal support remain secondary.

## Implementation verification (2026-09-11)

The four implementation stages are implemented. Independent agent reviews
covered the bridge and transport, delegation and cancellation, adapter
configuration, failure handling, and model settings; their blocking findings
were addressed and reviewed again.

Live smoke checks passed with the locally configured Claude Code, Codex, Vibe
and Antigravity CLIs. Each used an isolated sample tool, published a durable
plan in the test repository and marked its step complete. These checks consumed
vendor usage; they do not establish subscription billing eligibility or full
connector compatibility. GLM/Kimi share the Claude transport but were not tested
with live vendor requests.

The compiled MCP transport tests, focused subprocess/permission tests, browser
model-settings persistence and plan tests, TypeScript checks and production
builds passed. The broader browser run exposed three stale selectors from the
DeepSea redesign; the affected tests passed after updating them to the visible
navigation and activity controls.

The orchestration eval in unit mode passed five checks and could not validate
seven routing checks that require a running backend. This is not evidence of
full end-to-end orchestration coverage. The remaining adapter differences,
including Antigravity host integrations, buffered steering and incomplete
vendor-native telemetry, are documented in [CLI agents](../CLI-AGENTS.md).

The final backend suite reported 5,419 passing tests and one suite setup failure:
PGlite could not create an already-existing internal directory in the knowledge
graph fixture. All five tests in that suite passed on an isolated rerun. The
compiled MCP suite passed all 19 tests. No production database was reset to
obtain these results.
