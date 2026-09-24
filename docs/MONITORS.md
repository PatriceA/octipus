# Session monitors

An agent can arm a persistent, one-shot monitor and end its turn. Octipus checks the condition without an LLM and resumes the same session when it matches or reaches its deadline. A session can keep working on other tasks while a monitor waits.

The chat sidebar shows waiting, paused, ready, continuing, finished, cancelled, and needs-review states, with last/next checks, deadlines, errors, and pause/resume/cancel controls. The agent has `monitor__create`, `monitor__list`, `monitor__pause`, `monitor__resume`, and `monitor__cancel`.

## Browser pipeline example

After starting a run, capture its specific tab, URL, and status selector, then call `monitor__create`:

```json
{
  "name": "Wait for pipeline run 123",
  "source": {
    "kind": "browser",
    "tabId": 42,
    "url": "https://ci.example/runs/123",
    "selector": "[data-testid='run-status']",
    "condition": {
      "path": "text",
      "operator": "in",
      "value": ["Succeeded", "Failed", "Cancelled"]
    }
  },
  "intervalSeconds": 30,
  "timeoutSeconds": 1800,
  "continuation": "Inspect run 123. On success collect the artifacts; on failure inspect the logs and report the cause. On timeout report the last observed status."
}
```

The agent can end its turn after creation succeeds. An agent-created tab referenced by an active monitor is protected from automatic end-of-turn cleanup. The monitor reads the exact tab, verifies its exact URL, and reads only the selected element. It never switches to the active tab, clicks, navigates, or executes agent-supplied JavaScript. Missing elements, navigation to login, and extension disconnection are recorded as errors and retried until the deadline. Tabs retained for a monitor remain open for the continuation/user to inspect and close.

Reload the browser extension after updating: its background script now implements `observe`. The browser must remain available; the server cannot inspect a closed browser. Octipus must be running to check or continue work.

## Sources and conditions

- `browser`: `tabId`, exact HTTP(S) `url`, `selector`, and `condition` (normally `path: "text"`). Uses existing browser `extract` permissions.
- `tool`: `name` (full `container__action`), `args`, and `condition`. Only actions declared read/list/search/inspect or explicitly marked read-only by their tool implementation are accepted. Current tool permissions still apply, using the creator's role and current session workspace. Arbitrary shell commands, page evaluation, and writes cannot be polling probes.
- `event`: exact gateway event `type`, `condition`, and optional `fallback` tool source. Gateway observations have `{payload, sessionId, source}`. Match the particular run/agent identity, not just a broad completion event. Events lacking an owner are ignored. A read-only fallback reconciles completion if an event was missed while Octipus was offline.
- `time`: `at` in UTC ISO format, before the monitor deadline.

Conditions select a dotted `path` (empty means the whole result) and support `equals`, `in`, `contains`, and `changed`. `changed` records the first successful observation as its baseline. A missing field is unavailable, not a successful change. Intervals are 10–3600 seconds, deadlines 30 seconds–7 days; defaults are 30 seconds and 30 minutes. There is a limit of 20 active monitors per session.

Authenticated integrations can post an event to `POST /api/sessions/:id/monitors/events` with `{ "type": "ci.completed", "payload": { "id": 123 } }`. The session scope and owner are checked before accepting the event. `GET /api/sessions/:id/monitors` lists monitors; `POST /api/sessions/:id/monitors/:monitorId/control` accepts `{ "action": "pause" | "resume" | "cancel" }`.

## Persistence and continuation

Migration `0110_session_monitors` stores monitor definitions, check leases, observations, and wake-up states. Normal server startup applies migrations. Checks run with bounded concurrency; slow probes do not block delivery. Matching is deterministic and uses no model calls.

`armed → ready → delivering → completed` is the normal lifecycle. Errors while observing leave a visible error on the armed monitor. Expiration creates a timeout wake-up carrying the last error/observation. Pause does not extend the deadline. Cancellation invalidates pending checks and wake-ups; it cannot undo a continuation that already started. Clearing, deleting, or archiving the session prevents an old monitor from resuming that conversation.

Ready wake-ups survive restart. Claiming delivery is atomic, and session turns share an in-process queue so a monitor waits behind an active user turn. Duplicate events cannot deliver a one-shot monitor twice. Interactive `/stop`, `/clear`, `/status`, `/cancel`, and `/help` bypass the turn queue. Replies are published to webchat/gateway clients and sent back to the original messaging conversation/thread. Failed or cancelled continuations appear as Needs review even when an agent ID was assigned. A stopped/crashed delivery has an uncertain outcome: after its lease expires it becomes `blocked` (Needs review), rather than blindly repeating external actions. Review the session and create another monitor if appropriate.

Monitors use the unattended `monitor` channel. They inherit normal tool permissions; an action needing fresh human approval cannot silently proceed. External observations are explicitly marked as data in the continuation message.

The gateway event bus is in-memory: events lost before persistence are not replayed after a crash. Use a tool fallback for important event waits, or have an external sender retry the authenticated event endpoint. Session turn serialization currently assumes the existing single Octipus agent-server process; running multiple agent servers against the same database requires distributed session coordination before it is supported. Browser push/DOM subscriptions, screenshot interpretation, recurring monitors, and composite boolean conditions are not part of this first version.
