# Visible work plans

Octipus can attach a short, structured plan to substantial work in a conversation.
The root agent publishes and updates it through `get_work_plan` and
`update_work_plan`. Simple questions and small edits may have no plan. Publishing
and maintaining a plan depends on the model following these instructions; the UI
does not invent steps from tool activity.

## Web workspace

The conversation's plan panel shows the goal, completed-step count, and steps
marked pending, working, done, blocked, or skipped. Expand a step to inspect its
recorded evidence. A done step means the agent reported the work completed; it is
not an independent verification badge. File results open in the existing in-chat
file viewer. Detailed execution records remain under Activity & settings.

On narrow screens, the panel becomes a collapsible summary above the conversation.
The conversation selector lets you switch work without relying on the desktop
session list. The main navigation remains accessible through its mobile button.

Choose **Adjust plan** to submit feedback. It is saved as pending immediately.
Before its next model call, the built-in root worker receives the updated plan,
all recorded feedback (including applied items), and an explicit pending count.
An empty pending queue does not mean the feedback history is empty. The agent can mark feedback applied with an explanation or
request clarification. Existing tool calls may finish before that boundary.
Feedback submitted after a turn finishes is retained for the next turn: send a
message to continue. Saving feedback alone does not start execution.

**Enable plan-first mode** uses the existing `/plan on` command. **Allow
implementation** uses `/plan off`; send a subsequent message to start work.
Neither command grants tool permissions. Plan mode filters known file-mutating
tools and provides instructions; it is not a shell sandbox. Normal work does not
require approval of every plan.

## Terminal workspace

The pi TUI uses the same session plan and feedback records:

- A progress line above the status bar shows the completed-step count and the
  last reported working or blocked step. It is a plan summary, not proof that an
  external action is still running.
- `/work-plan` displays the full current plan, evidence, and feedback in the
  conversation.
- `/plan-feedback <change>` saves feedback as pending for the root agent.
- `/plan on` and `/plan off` retain their existing planning-mode behaviour.
- `/stop` retains its existing cancellation behaviour; plans do not add
  checkpointed pause/resume.

The dark terminal palette uses Deep Sea's sea-glass accents and muted text. The
terminal retains its own background and font, and the light palette is retained.
The graphical clients use the website's white octopus logo and favicon.

## Persistence and limits

Plans are stored under the owning session's metadata, with user-scoped reads and
atomic revision checks. Feedback and agent updates cannot overwrite a newer
revision silently. Completed steps and their evidence are retained when revising
a plan; additional work belongs in a follow-up step. Starting a new plan archives
the current one. The web view exposes up to 20 previous plans and the most recent
100 revision summaries per plan. Each plan supports up to 20 steps and 50 feedback
entries. Revision summaries are not full snapshots of every intermediate version.

Web clients reconcile the record every three seconds. The TUI requests a compact
summary every four seconds while connected. Read failures are shown as unavailable;
previously loaded progress may be stale. Persistence does not mean an interrupted
agent can resume automatically.

Native roots receive plan tools and refresh feedback before model calls. CLI
roots now receive the same registered plan tools through their private run
bridge. Their tool responses carry current feedback and queued guidance;
delivery is at a tool boundary rather than immediate interruption. When a
CLI root cannot take a follow-up turn, its result is kept and carries a visible
note that feedback or guidance is still pending; send another message to
continue. Buffered adapters always need that new message. Vendor-native plans
are not automatically imported. See [CLI agents](CLI-AGENTS.md) for adapter limits.

When a root delegates to a child, the root reflects that work in its own plan.
The user's to-do board, pipeline definitions, and Markdown documents remain
separate concepts.

The API exposes `GET /api/sessions/:id/plan` and
`POST /api/sessions/:id/plan/feedback` (body: `planId`, `revision`, `text`). Both
follow the session's access rules. Agent updates use the same durable record.


## Recovery approval

Pipeline resume and rewind can repeat actions from earlier execution. Octipus
asks for a separate replay review before restarting prior work. Tool mutations
with unresolved outcomes also require review; read-only checks remain available.
See [Action recovery](ACTION-RECOVERY.md) for the behavior and its limits.
