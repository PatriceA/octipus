# Consolidation implementation and evidence

2026-09-10. Phases 1–4 shipped on `main` in commit `93296268`; all eight
GitHub Actions workflows for that commit completed successfully. This records
repository and CI evidence, not a deployment or release. The broad execution
refactor (phase 5) is deliberately deferred.

## Behavior and migration

- Unattended `ASK` now blocks before execution. This includes direct tool API calls
  (HTTP 409, `approval_required`) and unattended children. Attended children inherit
  the initiating session’s approval channel. Stored denials beat broad allow rules.
- Tool middleware no longer skips system/unattended calls. Read-only registrations
  explicitly name their existing manifest permission action, so normal reads keep
  their declared defaults while stored denials apply. Hooks are checked after
  argument rewriting; a receipt for different arguments cannot authorize a call.
- Settings → Scoped permissions provides a reviewed grant with action, scope and
  expiry, plus revocation. A grant is one override per user/tool/action: saving a
  new scope replaces the earlier scope for that action. Revoke changes it to ASK;
  it does not restore a potentially broader default. A scoped grant cannot replace
  a stored DENY; reviewing that denial is a separate policy edit on Tools.
- Existing run token/time budgets remain in force; a grant does not add a new cost
  ceiling. Session/workspace scopes compare trusted context. Path/command patterns
  filter arguments; they are not shell/filesystem sandboxes. Prefer a session or
  workspace grant for ordinary automation, and review any broad existing ALLOW.
- MCP calls now check at the bridge boundary, including artifact refreshes. Their
  common permission identity is tool `mcp`, action `<server-id>.<remote-tool-name>`.
  Previous expanded-handler overrides under `mcp:<server-id>` must be reviewed and
  recreated using that identity. Calls without a principal cannot reach transport.
- Effective authorization source is recorded in the audit trail. Approval waits
  are installed before notification, cancelled waits cannot execute, and duplicate
  answers do not execute twice. Restart expires orphaned requests; there is no
  claim of automatic mid-turn continuation.

## User experience

Dashboard values distinguish loading, valid zero, unavailable and stale data,
with last-success time and retry. Project discovery shows failures alongside
partial results. Chat refreshes durable messages on reconnect and exposes failed
history/session reads. Research reports identify missing saved documents and
polling failures; a client polling deadline does not mark backend work complete.

Navigation groups existing routes under Work, Library, Automations, Connections
and Settings. Advanced controls and deep links remain. The dashboard starts the
three everyday workflows; expert, topic, persona and profile pages explain their
purpose without requiring that configuration before ordinary chat.

Source-derived tasks with stable URL/message/document references now have an
idempotent identity per user/workspace/source/title. Concurrent ingestion retries
return the same stored task. Changed titles intentionally produce separate tasks;
inputs without stable provenance keep ordinary create behavior.

## Verification

- Full backend suite: 452 files passed, 13 skipped; 5,340 tests passed, 166 skipped
  before the final MCP boundary addition. The final focused pass adds MCP
  authorization coverage: 350 tests passed, five skipped; its shell-sandbox check
  required an unrestricted rerun because nested bubblewrap cannot run inside the
  workspace sandbox. That rerun passed all nine tests.
- Production artifact acceptance: local scripted model boundary, real HTTP,
  filesystem and embedded database; chat, actual write, unattended refusal and
  restart recovery passed. Authentication must be renewed after restart.
- Research/task acceptance: saved Markdown is reread independently, source hash
  and URL checked, duplicate task creation raced, and boot recovery distinguishes
  completed and interrupted jobs.
- Full browser suite: 81 passed. Fixtures cover dashboard errors/stale data/retry,
  navigation/deep links, scoped-grant review, missing research document and partial
  project discovery.
- Backend/web typecheck, lint, build and generated catalog are checked locally.

## Limits and next review

The live-provider lane is configured but no paid provider was exercised here.
Its report must say unmeasured until a dedicated backend and spending limit are
configured. It does not establish overall task quality, adversarial robustness,
or direct-versus-delegated superiority. Latency/cost gates need an actual baseline.

Browser failure tests use API fixtures. The production harness is headless HTTP;
full browser-to-provider reconnect/approval replay and the entire seven-scenario
production matrix are not yet covered by one harness. Existing cancellation tests
remain the evidence for descendant cleanup. Representative new-user walkthroughs
also remain to be conducted; navigation tests are not usability research.

For the execution-code review, prioritize external CLI-worker authority and
cancellation, canonical resource resolution versus argument-based grants, pending
approval recovery across processes, and persisted run-state reconciliation. Keep
that review separate from a structural rewrite of the worker/pipeline modules.
