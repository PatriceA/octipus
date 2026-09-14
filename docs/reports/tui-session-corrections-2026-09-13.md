# TUI and desktop session corrections — 2026-09-13

## Findings and changes

- **Permissions across clients:** the legacy permission socket only acknowledged
  its own responses. Decisions now broadcast from the permission manager to all
  owner-scoped subscribers, including gateway/TUI clients and expiration on stop.
  Snapshot hydration preserves concurrent decisions; clients remember resolved
  IDs so delayed duplicate requests cannot reopen them. Permission request IDs
  now use canonical UUIDs, matching their database representation.
- **Session usage:** an unregistered UUID format rejected valid session IDs with
  HTTP 422. Explicit UUID validation fixes the endpoint. The usage component was
  also a direct child of the horizontal chat layout, producing an extra column.
  It now belongs to the conversation header and preserves totals with a stale
  label during failed refreshes.
- **Subagents:** TUI decoding recognized the retired `rootAgent` node kind but
  not the current `root`, so it counted the root as its own subagent. Finished
  real children were also removed after eight seconds, including on Alt+S.
  Root filtering now matches the backend, and completed children remain
  inspectable until the next turn/reset.
- **Transcript:** a fullscreen viewport does not put its entire history into
  terminal scrollback. Mouse wheel and keyboard navigation now scroll retained
  application history, with visible controls. Width changes reflow earlier
  messages. Composer and status remain at the bottom of the application frame.
- **Model binding:** task turns now use the General expert's model preference or
  assigned lane, with the configured root default when unbound. Explicit session
  overrides still win. Conversational turns use the Chat lane.
- **History and counts:** the live ring holds only 200 events. Agent detail and
  chat restoration now use paginated durable events, with one stable DB cursor.
  Live and historical tool calls merge by call ID. Labels distinguish model
  turns, recorded events and tool calls.
- **Run limits:** new native runs persist a structured turn/time-limit reason,
  which the UI displays separately from normal completion. Older runs lack that
  field and are not retroactively relabeled from model prose.
- **Recovery approval:** proven shell preflight rejection and normal process
  exit failures no longer require uncertainty review before the next mutation.
  Timeouts, post-start interruption, missing durable completion and unknown
  remote outcomes retain the review requirement. The prompt names the earlier
  tool and timestamp. Historical uncertain records remain unchanged.
- **Desktop identity:** the native binary was still named `app`. It is now
  `octipus`, uses GTK ID `cc.octipus.desktop`, and ships the website's white
  octopus icons. `octi desktop` installs matching per-user launcher/theme icons.
  The running Linux window was verified to advertise WM_CLASS `octipus` /
  `Octipus` and the matching GTK ID.

- **Chat header and dropdowns:** the redundant top session selector is replaced
  by the session title; session switching stays in the sidebar. Native dropdowns
  and options use Deepsea colors rather than browser-default grey/white controls.
- **Test isolation:** a timestamp-based cleanup could delete another concurrent
  test invocation's database, or unrelated live application scratch. Each test
  invocation now owns one exclusive temporary root, inherited by workers and
  subprocesses, and cleanup removes only that root.

## Inspected run

The reported agent (`6090da7b`) has **25 model turns, 243 persisted events and
53 distinct completed tool calls**. The earlier 200-event/44-tool view reflected
only the tail of the live ring, not the complete run.

Eleven calls were marked failed:

- Eight shell commands used pipes, chaining or redirects without `useShell:true`.
  Those were correctly rejected before execution; the agent repeatedly ignored
  the actionable error instructions.
- Two `flutter test` invocations exited 1. Their output reports a missing
  `CupertinoPageTransitionsBuilder` at `theme.dart:210` and shader asset manifest
  errors involving `shaders/ink_sparkle.frag`. Both runs reported 128 passing and
  six failing tests. These are actual test failures; this investigation did not
  change the mobile app or establish that both causes share one fix.
- One directory listing exited 2 because the requested directory did not exist.

Two additional `grep` exits of 1 were correctly recorded as expected no-match
outcomes, rather than execution failures.

The agent's final response said it reached its iteration budget and left work
unfinished. It overstated parts of its investigation: the compile error was not
itself evidence of a shader problem, and the existing code/documentation did not
prove that the requested fixes had been delivered. No model-authored success
statement should substitute for validation of changed files and tests.

Failed shell calls also lost their structured exit-code/output preview in the
UI: the renderer's “has result” flag was passed as false for failures, and stdout
could displace stderr. Both rendering issues are corrected.

## Validation scope

Regression coverage includes real embedded-database permissions and recovery,
WebSocket notification delivery and hydration, browser permission reconciliation,
usage refresh layout, swarm hydration, paginated history, model selection, and
PTY transcript scrolling/resizing. The desktop passed Cargo checking and its
launcher/icon registration was verified locally. No new live-model run or mobile
Flutter repair was performed as part of this correction.


The final backend/unit/database suite passed **5,689 tests** (168 skipped).
The separate TUI/PTY suite passed **341 tests**. Typecheck, root lint,
backend/TUI build and generated-catalog checks passed.
A separate conversation-classification eval passed 2/2; it did not call models
and does not establish live model quality. A read-only lookup against the
reported session's actual usage records also succeeded.

The combined browser regression run passed **17 tests**, covering permissions,
agent history, chat navigation, usage, work plans and dropdown styling. The
compact session drawer also passed keyboard focus, Escape and restoration checks.

## Follow-up: copying and plan-only deliverables

The captured mobile multi-backend session had a revision-1 plan with five completed
planning activities, but no stored implementation specification. The historical
record was inspected read-only and has not been rewritten.

Plan-only deliverables now use a proposal kind, pending implementation steps, and
durable Markdown details. Plan mode forces proposal semantics; submission stores
the full document with revision checks. The reduced model tool set now includes
the submission tool. Leaving plan mode enables change tools but does not approve
or dispatch implementation. General-agent instructions distinguish writing a
proposal from completing the work proposed; outside plan mode, classification of
a plan-only request still depends on the model following those instructions.

The desktop plan panel renders the specification and proposal status. The TUI
automatically opens the first discovered plan, detects revisions even when step
counts stay the same, and respects subsequent collapse, including delayed errors.

Both terminal interfaces support Alt+M or /mouse off for native selection,
 /mouse on for wheel capture, and /copy last or /copy transcript for an explicit
OSC 52 clipboard request. Clipboard support remains terminal-dependent; the TUI
reports a request rather than claiming confirmed clipboard success.

Validation: 5,708 tests passed, 168 skipped in the full suite; the separate terminal
suite passed 348 tests including real PTY checks. Four browser tests passed,
including persistent specification rendering and a narrow viewport. The final
presenter regression suite passed five tests. Root/web typechecks, lint, catalog
checks and independent agent reviews passed. Headless checks cannot confirm the
user's terminal clipboard policy or physical text selection.

## Follow-up: General binding for ambiguous requests

The 20:30:51 backend log shows an ambiguous TUI request entering the General loop
with the Chat model. The stored binding was correct: General used the Writing
lane, which selected Gemini. The earlier selector fix only applied that binding
to the classifier's task category. Non-casual categories now all use General's
binding, with explicit session overrides still taking precedence.

Short authoring requests exposed another path to Chat: “write this as a plan”
hit the six-word casual shortcut, while “draft plan” hit the two-word shortcut.
The existing document-authoring detector now exempts these requests from casual
shortcuts. No deployment-specific model names were added to routing code.

The focused classifier/model tests passed (46 tests), and the new plan
classification eval passed 4/4 without model calls. Independent review passed.
The generic routing eval's six specialist-spawn assertions cannot run in unit
mode; they reported that integration mode is required, rather than exercising
live provider routing. Backend build, typecheck and lint passed.

## Follow-up: research pipeline provider failure

At 20:50:25, the research stage failed with Gemini INVALID_ARGUMENT through the
custom Anthropic-compatible provider, immediately after history compaction.
The parent create_pipeline tool returned that stage failure and ended tool use
for its turn. The subsequent filesystem/worker failures claimed in the answer
have no corresponding executions in the log.

The parent now receives explicit reporting guidance after tool use ends:
describe the recorded failure and unfinished stages, without inventing further
executions or treating one stage's error as a system-wide outage. Empty-response
retries in this state request a final report instead of another tool call.
This is model guidance, not a guarantee that every generated claim is accurate.
Review also found that prose-to-tool recovery lacked the disabled-tools guard
already used for native calls. Both paths now respect the same end-of-tools
boundary and receive the reporting reminder. The regression sends executable
tool JSON in the final response and verifies it does not execute.
The compactor now preserves the nearest user turn when it fits the remaining
budget. Oversized user turns remain summarized. Anthropic message conversion
also inserts a bounded user continuation before an otherwise leading tool-use
turn, covering previously sliced histories for both complete and streaming
requests. Exact removed-message accounting preserves the material to summarize.
Focused provider/compaction tests passed 57 cases; worker reporting tests passed
25 cases. Independent reviews, typecheck, lint and build passed. These checks
reproduce the malformed request structure without making paid provider calls.
