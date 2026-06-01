# Email — Triage-Lite Inbox (over the existing headless backend)

> Design note, 2026-06-01. Feature #7 from `end-user-enrichment-plan.md`.
> The one we were torn on. Recommendation (carried from the master plan): build
> a focused **triage assistant**, not a full mail client. The backend already
> exists and is the strong part — it's *headless*. Adding a thin, visual inbox
> over it delivers the "watch the agent do real work" value at a fraction of the
> cost of a real email client.
>
> **Status: scope recommended, build decision still owner's to confirm.** This
> note specs the lite scope so it's ready when greenlit.

## What we already have (the strong part)
- **gmail tool** (`src/tools/google-workspace/gmail.ts`): `gmail_list`,
  `gmail_search`, `gmail_read`, `gmail_send` — real IMAP-equivalent via the
  Google API, OAuth-backed.
- **microsoft365 mail tool** (`mail.ts`): the Outlook equivalent.
- **email-processor tool** (`src/tools/email-processor/`): "process emails
  one-by-one with AI-driven classification and actions… batch with per-email
  decisions." This is the triage brain — already built, already AI-driven.
- OAuth tokens in the **per-user vault**; scoped repos for tenancy.

So the inbox is the *only* missing piece. Everything it shows/does already has a
tool behind it.

## Goal & non-goals
**Goal:** a read + assist inbox: list recent mail, show the AI triage/priority
the email-processor already computes, and offer one-click agent actions —
**summarize thread, draft a reply (in the file/draft view), archive, create a
task (#6)**. Visual, daily, and a flagship demo of the agent working on
something real.

**Explicit non-goals (this is the whole point of "lite"):** full compose UX,
folders/labels management, server-side search UI, threading reconstruction,
real-time push sync, attachments management, offline. Defer all of it. If the
triage view earns demand, revisit "full client" as a separate, larger effort.

## Design
### Backend (thin glue over existing tools)
- An **inbox read endpoint** `/api/email/inbox` that calls the configured
  provider's `*_list`/`*_search` (gmail or m365, whichever is connected) and
  returns a normalized list:
  ```
  InboxItem {
    id, provider, from, subject, snippet, receivedAt, unread,
    triage?: { priority: 'high'|'normal'|'low', category, reason }  // from email-processor
  }
  ```
- **Triage** reuses `email-processor`'s classification — compute lazily per item
  (or batch on open), cache briefly. Don't re-run on every poll.
- **Actions** map to existing tools: summarize/draft → model + `gmail_read`/
  `_send`; archive → provider API; "create task" → Tasks tool (#6) with
  `sourceRef` = the message.
- **Drafts open in the file/draft view (#2)** — the agent writes a reply draft,
  the user edits it inline (edit-and-continue), then one click sends via
  `gmail_send`/m365. This is where the work-stream + file-view features pay off.

### Tenancy & trust (important — email is high-trust)
- All access is the **calling user's** mailbox via their vault OAuth token,
  through scoped repos. No cross-tenant read, ever.
- Mailbox content is sensitive: run drafts/summaries through **M2
  `redactSecretValues`** before they hit logs/work-stream, and never index full
  mail bodies into shared RAG without explicit opt-in.
- Send is an **ASK-level** action (explicit per-send confirmation), never auto.
  Archive likewise confirmable. This is the agent-does-real-work-but-you-approve
  posture — exactly our permission model's strength.

### Surface
- **Web**: a `web/app/email/` inbox — list with triage badges (high/normal/low),
  open an item → read pane + AI action toolbar (summarize / draft reply /
  archive / create task). Draft reply opens the editable file/draft view.
- **Chat**: "what needs my response today?" → triage summary; "draft a reply to
  Bob's email" → draft in the file view; "summarize the thread from Acme".

## Why lite is the right call
- **~80% of the value** (visible AI triage, draft-assist, one-click actions) for
  **~20% of the surface** — no folders/search/compose/sync/offline rabbit hole.
- **Reuses everything**: gmail/m365 tools, email-processor, vault OAuth, scoped
  repos, the work-stream (#1) and file view (#2) we're building anyway.
- **Showcases our moats**: per-user OAuth in the vault + ASK-level send approval
  is a *stronger, safer* email story than a coarse "agent has mailbox access".
- Keeps the door open: if it lands, "full client" is a deliberate next step, not
  a regret.

## Risks / open questions (for the build decision)
- **Trust surface**: even read-only mail access is significant; make the OAuth
  scope and what the agent can see explicit in the UI.
- **Provider differences**: gmail vs m365 normalization — keep `InboxItem`
  provider-agnostic; start with whichever one provider is connected.
- **Triage cost**: classifying every message with a model has a token cost —
  batch + cache, and make triage opt-in per inbox-open if needed.
- **Scope creep magnet**: every user will ask for "just folders" / "just
  search". Hold the line on lite until it's earned.

## Testing
- **Normalization**: unit — provider list responses → `InboxItem[]` (fixtures
  for gmail + m365).
- **Tenancy**: a user only ever reads their own mailbox token (scoped); no
  cross-tenant path.
- **Send is gated**: send action requires explicit approval (permission test).
- Live provider calls are integration-only.

## Sequencing (only if greenlit)
1. `/api/email/inbox` normalization over the connected provider + fixtures.
2. Web inbox list + read pane (read-only first — already valuable).
3. Triage badges (wire email-processor).
4. Actions: summarize → draft-in-file-view → ASK-gated send; archive; create
   task. (Depends on file view #2 + Tasks #6.)

## Dependencies
- **File view (#2)** for draft-and-send (core to the value).
- **Tasks (#6)** for "create task from email".
- gmail/m365 tools + email-processor + vault OAuth (all exist).
