# Chat continuity

## Midrun messages

Root Claude Code and Codex CLI public assistant text is forwarded to chat once
subsequent work confirms it is an intermediate message. The last answer keeps
the normal completion path. Thinking/reasoning blocks, tool output and child
agent prose are not forwarded as chat messages. Buffered CLI adapters still
deliver their text at completion.

Both these updates and `send_status_update` are saved as assistant messages
with progress metadata before being published. WebUI and TUI show them without
ending the active turn; they remain in history after a reload. Stable message
IDs prevent duplicate delivery, and generation checks reject updates from a
conversation cleared while the agent was running.

The instructions ask agents to work quietly and speak only for meaningful
findings, blockers or changes of direction. There is no timed narration quota.
User decisions still use `request_user_approval`; a progress message does not
pause execution or wait for an answer.

## CLI compaction

For a session with a saved root CLI conversation, `/compact` compacts that vendor
conversation and retains its ID, fingerprint, and acknowledgement cursor. It runs
under the same conversation lock as root turns. Child CLI conversations are not
compacted by this command.

- Claude Code (including adapters using its protocol): resumes the exact session
  in its workspace and sends `/compact [focus]` through stdin. Success requires a
  `compact_boundary` event for that session; an ordinary answer is not success.
- Codex CLI: resumes the exact thread through app-server, calls
  `thread/compact/start`, and waits for the compaction item and successful turn
  completion. The command does not create a thread or send a normal prompt.
  Focus instructions are unsupported by this API and are rejected explicitly.

Failures retain the existing session mapping. Maintenance disables unrelated MCP
servers and tools where supported; it does not fall back to an Octipus summary.
Reported token usage is recorded against the session as `cli_compaction`;
missing vendor usage is marked unavailable rather than presented as measured zero.
Automatic Octipus summarization skips sessions with root CLI conversations,
leaving automatic context management to the vendor. Sessions without a saved CLI
conversation retain Octipus's existing checkpoint summarization.

The CLI transports are covered with protocol fixtures; these tests do not compact
an operator's live CLI history. Codex's protocol is documented in the
[official app-server reference](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction).

## Pasted attachments

The web UI uploads pasted or selected files to the authenticated session's
workspace through `POST /api/sessions/:id/attachments`. Limits are ten attachments
per message and 10 MiB per file. Generated directories prevent name collisions.
The message records each file path, and both WebSocket and REST delivery carry
the file references. Those text references survive history reloads.

Image context includes its exact path for a CLI image-reading tool. When a vision
model is configured, its description and extracted text are also supplied to the
general agent. Missing configuration or failed analysis is explicit in the agent
context. This is a file reference plus optional vision analysis, not automatic
injection of raw image bytes into every vendor CLI prompt.

### TUI images

Use `Alt+V`, `F9`, or `/attach` to attach an image from the local clipboard.
`Ctrl+V` works when the terminal forwards that key to the application; terminal
paste bindings can intercept it. `/attach "path/to/image.png"` works without a
clipboard helper, including over SSH. The file is read on the TUI host and its
bytes are sent to the gateway, so the backend need not share its filesystem.

The composer inserts `[image1]`, `[image2]`, etc. and the transcript confirms
local receipt. Send the marker with your question; deleting it omits that image.
The gateway stores the file and appends its reference to the durable user message.
Images require a full turn and cannot be reduced to text-only mid-turn steering.

Windows uses the system clipboard through PowerShell. macOS requires `pngpaste`;
Linux uses `wl-paste` (Wayland) or `xclip` (X11). Clipboard failure is explicit,
with the file-path command as the fallback. No inline terminal image renderer is
required. Limits and backend image handling match the web chat.

## History refresh

Messages update as soon as their request returns, independently of agent history.
Reconciliation retains live messages until persistence catches up and matches
optimistic rows one-for-one. Older responses cannot overwrite newer applied
snapshots. Clearing the UI invalidates requests already in flight.
