# Execution reliability audit

Audited on 2026-09-12. This review covers execution, tool permissions,
cancellation and restart reconciliation. It is not a certification of every
provider, tool or deployment mode.

## Changes

- Tool dispatch checks cancellation before internal tools, parallel child
  groups and execution after asynchronous permission or hook work. Cancellation
  travels through a runtime execution scope, rather than serialized agent data.
- Shell tools pass that signal to the subprocess runner. A cancelled call does
  not start a new subprocess; a running local command is terminated with its
  process group. Deadlines still apply when the immediate child has exited but
  descendants retain its output pipes.
- Failed shell commands appear as failures and retain their diagnostic output.
  Expected nonzero outcomes, such as grep finding no matches, remain distinct
  from errors.
- Shutdown waits for worker execution and tool batches to settle, including
  workers removed from the visible registry. This wait is bounded; the result
  reports work that remains unsettled when the deadline expires.
- Cancellation during final synthesis cannot overwrite stopped status with
  completed status. Native workers release permission subscriptions when their
  run ends.
- Approval creation and waiting follow cancellation, including cancellation
  during database insertion and vendor CLI permission requests. An early answer
  or cancellation is retained until the caller consumes it.
- Audit logging failures after a saved approval decision or a successful action
  are logged separately. They do not turn that action into a contradictory tool
  failure or leave the approval waiter blocked. The audit record itself can
  still be missing; these changes do not add durable audit retries.

## Automated checks

The regression tests exercise production worker, executor and middleware code
with controlled providers and repository failures. Database-backed tests use
embedded PGlite or a disposable Docker PostgreSQL instance. Shell checks include
real local subprocesses and a check that pre-aborted execution never calls spawn.

| Area | Evidence |
| --- | --- |
| Dispatch after cancellation | Internal tools, parallel groups, cancellation between calls and during a pre-tool hook |
| Middleware cancellation | An abort during auditing prevents a real filesystem write |
| Approvals | Creation/decision audit failures, cancellation during insertion, early cancellation, parent cancellation, CLI signal propagation |
| Shell | Actual executor-to-middleware-to-process cancellation, deadlines with surviving descendants, pre-aborted no-spawn check |
| Terminal state | Cancellation during child-result synthesis and a provider returning after cancellation cannot complete the worker |
| Shutdown | Status becoming stopped before execution settles, bounded waits, removed workers still draining |
| Restart reconciliation | Persisted interrupted pipeline fixtures become paused/resumable; completed pipelines stay completed; live stages reset |
| Permissions and persistence | Existing real-middleware authorization, workspace, tenant isolation and task-state repository tests |

Validation recorded for this change:

- Broad core/security/shell suite: 2,941 passed, 56 skipped.
- Final targeted regressions after the last review fixes: 68 passed, one live
  vendor CLI check skipped. These overlap the broad suite; counts are not additive.
- Selected Docker database checks: 66 passed.
- Typecheck and lint of changed production files passed.

Reproduce the broad core checks:

```sh
npm test -- src/core src/security src/tools/shell
npm run typecheck
```

Run the selected external-database checks separately; the runner creates and
removes its disposable database container:

```sh
npm run test:integration -- src/core/agent/pipeline-interrupted.test.ts src/core/swarm/ledger.test.ts src/security/permissions.isolation.test.ts src/security/workspace-fs.test.ts src/db/repositories/task-state-repository.test.ts
```

The core suite needs localhost sockets, Git subprocesses and, where available,
the process sandbox runner. Restricted execution environments can prevent those
checks from running correctly.

## Follow-up: action replay protection

[Action recovery](ACTION-RECOVERY.md) adds durable mutation records, separate
recovery consent for unresolved outcomes and a pipeline replay review before
checkpoint changes. This follow-up addresses silent replay risk without claiming
exactly-once delivery or automatic vendor reconciliation.

## Limits and next work

- **One active backend per database:** boot-time orphan approval and pipeline
  reconciliation do not establish ownership leases between backend instances.
  Starting a second backend against a live backend's database can invalidate
  active work. Multi-instance recovery needs a separate ownership design.
- **Recovery is not exactly-once execution:** resuming a pipeline can rerun its
  interrupted stage. A process can crash after an external action succeeds but
  before its result is persisted. Unresolved mutations now require recovery review; pipeline replay also asks
  before rerunning prior work. Tool-specific idempotency or reconciliation is
  still needed for stronger automatic guarantees.
- **Cancellation cannot undo completed actions:** local shell process groups are
  covered; remote services and tools that do not cooperate with cancellation
  may continue work already submitted. Shutdown has a timeout, not an unlimited
  guarantee that all external work has stopped.
- **Restart evidence is fixture-based:** tests exercise the shipping boot
  reconciliation code against interrupted database records. This audit did not
  kill the user's running backend during a paid provider session.
- Native Windows process trees, live vendor outages, backup/restore,
  scheduling and semantic memory quality need their own checks. The broad core
  run exercises existing tests in some of these areas but does not replace a
  dedicated audit.
