# Action recovery

Octipus records mutating tool calls before executing them. If a call's outcome
cannot be established, later mutations in the same user/session require a
separate recovery approval. This protects against silently repeating an action
that may already have happened.

For example, a tool sends a message and its connection then fails. Octipus must
not assume the message was never sent. A shell command that performs an action
and subsequently times out has the same problem.

## What the user sees

The normal approval interface shows **Review uncertain actions before
continuing**, with the previous tool names, timestamps, record IDs and the next
tool being attempted. Check the task's tool output and the external service
before deciding. Tell the agent which work already happened and which work it
should skip.

- Approving permits further mutations, including a retry if that is still the
  proposed action. It does not prove the previous action failed.
- Denying prevents that mutation and preserves the unresolved evidence.
- Read-only tools remain available for checking external state. Arbitrary shell
  commands are conservatively treated as mutations, even when the intended
  command would only inspect something.
- Normal permission denials still apply. Recovery approval cannot grant a tool
  permission revoked while the prompt was open.
- Unattended work cannot approve its own recovery. It reports that review is
  required.

The review covers specific records, in batches of up to 20. An action that
becomes uncertain while the user is deciding needs its own review. Recovery
approval does not become a permanent tool permission.

## Pipeline resume and rewind

Resuming or rewinding reruns work from a checkpoint. Even tools that returned
successfully in an earlier run can be called again when their stage reruns.
Octipus therefore requests **Review pipeline replay** before changing recovery
checkpoints or starting workers when the pipeline has previous execution.
The review conservatively covers the pipeline's prior action records, rather
than trying to infer every stage that a changed graph will revisit.

Older runs and vendor-native CLI tools may have no action journal records.
Missing records do not establish that no action happened: the replay prompt
explicitly warns about that uncertainty. A pipeline paused before any stage
ran does not need this replay review.

Rejecting a replay preserves the checkpoints. Concurrent resume requests
cannot start a second walker while the first request is awaiting review.

## Implementation and guarantees

The `tool_actions` table records an action ID, user/session/agent ownership,
pipeline/node correlation where present, tool identity, an argument hash,
timestamps, outcome and any recovery review ID. It does not store argument or
result bodies. Session or user deletion removes the associated journal records.

The execution boundary writes `started` before calling the tool. If that write
fails, the tool does not execute. A return is recorded as `completed`,
including a structured failure the tool reported itself (a non-zero exit, a
`success: false` result): the tool ran to the end and its outcome is known.
An exception, or a result flagged timed out, killed or aborted, is treated as
`uncertain`, because partial side effects may have occurred. Cancellation or
permission revocation before the body starts is `not_executed`.

If the tool returns but its completion record cannot be saved, its known output
is preserved and the persisted `started` record blocks later mutations pending
review. An acknowledgement is separate from the outcome: reviewing an
uncertain action does not relabel it as completed.

BaseTool handlers record after middleware authorization and argument rewriting.
Other external handlers dispatched through ToolExecutor are recorded there.
Trusted read-only declarations bypass mutation recording. Internal orchestration
and context tools remain available and do not create duplicate outer records
around delegated work.

This assumes one active backend per database. Process-local tracking separates
currently running actions from orphaned `started` records after a restart.

## Boundaries

This is **replay protection, not exactly-once delivery**. It does not undo an
external action, automatically inspect every vendor's state, or inject a generic
idempotency key into unrelated APIs. Use read-only checks and human review where
an outcome cannot be determined. Provider-specific reconciliation and
idempotency adapters can extend this without weakening the default gate.

A new session has a separate journal scope. Successful actions are not globally
deduplicated: explicitly sending the same message again remains possible.
Existing runs before this migration have no per-action evidence. Direct vendor
CLI actions outside the Octipus tool bridge, standalone integrations that bypass
these execution boundaries, and arbitrary effects inside plugin hooks are not
individually journaled. Pipeline replay warns about work without records; that
warning is not per-tool coverage of a vendor CLI.

## Validation

Regression tests cover:

- A real side effect followed by completion-write failure, database close/reopen,
  and denied retry without repeating the effect.
- A shell command that appends to a file and then times out.
- Intent-write failure blocking execution, and one journal entry through the
  combined executor/BaseTool path.
- Read-only reconciliation, policy revocation during recovery approval, exact
  review scope, cross-user/session isolation and cancellation of queued calls.
- Denied rewind preserving checkpoints, concurrent resume exclusion, and stop
  during reconstruction preventing restarted workers.
- Embedded migrations, session deletion cleanup and external PostgreSQL journal
  persistence.

Validation for this change: 3,525 tests passed in the broad core, security,
tools, connectors and pipeline API run (56 skipped); four selected external
PostgreSQL tests passed. The broad run includes the embedded database reopen
and real subprocess failure scenarios described above.

Run the focused checks with:

```sh
npm test -- src/core/action-recovery src/core/agent/pipeline-loop.test.ts
npm run test:integration -- src/db/repositories/tool-action-repository.test.ts src/core/agent/pipeline-interrupted.test.ts
```
