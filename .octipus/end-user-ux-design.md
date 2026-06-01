# End-User UX Initiative — Workspace, Live Work Stream & In-Chat Files

> Design note, 2026-06-01. Strategic response to the Odysseus comparison
> (`.octipus/` reading + chat analysis): Octipus is strong on the professional/
> platform side (swarm, typed roles, multi-channel, multi-tenant security) but
> thin on **end-user daily-driver UX** and the "fun" surface. This note scopes
> the features we're adapting from Odysseus / opencode, grounded in what Octipus
> already has so we extend rather than reinvent.

Companion to the hardware-fitting note (separate). Owners decide sequencing;
each section below is independently shippable.

---

## Guiding principle

We are NOT reinventing the editor/agent-IDE wheel. opencode and Odysseus have a
proven base (live tool stream with inputs/outputs, an in-chat file/diff/image
view, edit-and-continue). We adopt that interaction *model* and back it with
Octipus's existing subsystems (artifacts host, filesystem tool, gateway events,
WorkspaceFS). Three threads, in priority order:

1. **Rich live work stream** (fixes "Code arm used file_read")
2. **In-chat file view** (reader / editor / image / diff) with edit-and-continue
3. **Chat/work split** ("just answer" vs "work in the file view")

---

## Thread 1 — Rich agent work stream

### Problem (today)
`agent-worker.ts` emits an `action` event carrying only `{ toolName, toolId }`
(or, on the text-tool path, a `argsSummary` truncated to 80 chars). **Tool
results are never streamed to the client** — they go into `this.messages` for
the model only. So `agent-activity-card.tsx` / `side-panel.tsx` can render
nothing better than "Code arm used file_read". The data to do better doesn't
reach the browser.

### What opencode/Odysseus show instead
Per tool call: the tool name, a human phrasing ("Read `poem.md`", "Edited
`app.ts` (+12 −3)", "Ran `npm test` → exit 0"), the **inputs** (path, command,
query), and a **result preview** (first N lines, a diff, exit code + tail,
row count) — expandable to full output.

### Design
A typed, per-tool **work-stream event** with three phases, emitted from
`tool-executor.ts` (which already has both the args and the result — the
natural seam, vs `agent-worker.ts` which only sees the call):

```
ToolActivityEvent {
  id: string                 // correlate start/end
  agentId, sessionId
  toolId, toolName
  phase: 'started' | 'completed' | 'failed'
  title: string             // human one-liner per renderer (below)
  input?: ToolInputPreview  // structured, capped (path/command/query/url…)
  result?: ToolResultPreview // structured, capped (diff | text | exitCode | rows | image-ref)
  durationMs?, error?
}
```

- **Per-tool "renderer" registry** (server-side, pure functions): maps a tool
  call + result → `{ title, input, result }`. `filesystem.file_write` →
  `{ title: "Edited poem.md (+8 −0)", result: { kind:'diff', patch } }`;
  `shell.run` → `{ title: "Ran npm test", result: { kind:'exit', code, tail } }`;
  `websearch` → `{ title: "Searched: …", result: { kind:'list', items } }`.
  Falls back to a generic `{ title: "Used <tool>", input: <capped JSON> }` so
  every tool degrades gracefully (the T2 conformance suite can assert each
  built-in tool has — or safely falls back to — a renderer).
- **Caps + redaction**: previews are size-capped server-side; run resolved
  secret values through the M2 `redactSecretValues` before they hit the stream
  (a streamed result is an egress sink too).
- **Transport**: extend the gateway `agent.action` event payload; the existing
  `event-bridge.ts` (now typed, post-M18) forwards it. Web `agent-activity-card`
  and the TUI `gateway-adapter` render the new shape; both already consume
  `agent.action`.

### Scope guard
Don't stream full file contents through the work-stream event — stream a
*preview + a ref* (sessionId + path + version) that the file view (Thread 2)
fetches on demand. Keeps the event bus cheap (the existing swarm bandwidth
concern that made us filter `thought` events).

---

## Thread 2 — In-chat file view (reader / editor / image / diff)

### Why it's essential for end-users
"Agent, write me a poem" should be able to **work in a file**, not dump a wall
of text in chat. The file view is what makes an agent feel like a workspace
instead of a chatbot — and edit-and-continue (user tweaks the file, agent keeps
going) is the difference between a collaborator and a copy-paste loop.

### What we already have (reuse, don't rebuild)
- **`src/core/artifacts/`** — a mature host: bundler, CSP, render, lifecycle-bus,
  share-links, rate-limit, token. Oriented at *rendered widget output* today,
  but the hosting/security/versioning plumbing is exactly what a file view needs.
- **`src/tools/filesystem/`** — `file_read`/`file_write`/edit ops, RAG
  auto-index on write, and **WorkspaceFS** path containment (the H2/SSRF-grade
  resolver) — the safe backend for reads/writes from the UI.
- The artifacts web route (`web/app/artifacts/[id]`) already renders hosted
  content in an iframe with CSP.

### Design
A **chat side-panel "Files" tab** (the chat already has `side-panel.tsx`) that
hosts a lightweight viewer with three modes, keyed by mime/extension:
- **Text/code** — read-only with syntax highlight; "Edit" flips to an editable
  buffer. Use a small embeddable editor (CodeMirror 6 — ~tens of KB, framework-
  agnostic; **not** a full Monaco/IDE). opencode/Odysseus prove CM-class is
  enough; we don't need an IDE.
- **Image** — inline `<img>` with zoom/fit (the browser/visual tools already
  produce images; artifacts already base64-handles them).
- **Diff** — when a tool edited a file, show before/after (we have the patch
  from Thread 1's renderer).

**Backend**: a small **session-scoped file API** — `GET/PUT /api/sessions/:id/
files?path=…` — backed by WorkspaceFS (containment + null-byte rejection
already done in the H2 work), tenant-scoped via the existing scoped-repo
principal. Versioned so edit-and-continue has a concurrency story (ETag/version;
reject a stale PUT loudly per DESIGN.md fail-loud).

### Edit-and-continue (the key interaction)
1. Agent writes `poem.md` → work stream shows "Created poem.md" → Files tab opens it.
2. User edits a line in the Files tab → `PUT` saves a new version.
3. User says "make it rhyme" → the orchestrator's next turn sees the **current
   file version** (injected as context / re-read by the agent), not the chat
   transcript. No copy-paste.

This needs a small protocol addition: the chat message can carry an **attached
file ref** (`{ sessionId, path, version }`) so the agent knows "operate on this
file" — reuse the existing attachment plumbing in the gateway message shape
rather than inventing a new channel.

---

## Thread 3 — Chat/work split ("just answer" vs "work in a file")

The same prompt has two good answers: a poem *in chat*, or a poem *in a file you
can edit*. Let the user (and the orchestrator) choose:
- Default heuristic in the orchestrator: short/conversational → inline; anything
  document-shaped, long, or explicitly "write me a …/build …/draft …" →
  produce a file + a short chat summary that links to it (opens the Files tab).
- A UI affordance (toggle / per-message) to force one mode.
- This is a **routing/prompt** change (orchestrator classifier + a deliverable
  convention), so it must pass `bun run eval` — add eval scenarios for
  "inline vs file" routing.

---

## opencode adoption note

opencode (SST) is **MIT-licensed** and **TypeScript** — a clean match for our
stack. We are adopting its **interaction model** (tool stream with inputs/
outputs, in-chat/in-terminal file/diff view, edit-and-continue), not vendoring
its code — our backend (Bun/Elysia/swarm) and theirs differ. Where a specific
component is cleanly liftable (e.g. a diff renderer or a CodeMirror setup),
evaluate copying with attribution rather than rebuilding. Keep the MIT licence
note in any PR that borrows code. (opencode is TUI-primary with desktop + web,
so its TUI patterns also inform our `tui-pi` work-stream rendering.)

---

## Sequencing (proposed, owner to confirm)

1. **Thread 1** (rich work stream) — highest ratio of value to risk; pure
   additive event + renderers + existing card UI. Makes the product *feel* alive
   immediately and unblocks Thread 2's diff view.
2. **Thread 2a** (read-only file view: text/code/image/diff in the Files tab) —
   the visible end-user win.
3. **Thread 2b** (editor + session file API + edit-and-continue) — the
   collaborator unlock; needs the versioned API + protocol attachment.
4. **Thread 3** (chat/work split routing) — needs 2 in place; eval-gated.

Each thread = its own PR(s), typecheck/lint/eval green, per the audit workflow.

## Explicitly out of scope (for now)
Full IDE (LSP, multi-file project tree, debugger), real-time multiplayer
cursors. We're building a *focused* file collaborator, not VS Code.
