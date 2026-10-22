# Running a small company's digital work with Octipus

This guide sets Octipus up to look after a small company's day-to-day work.
Your ideas go on the to-do list and agents pick them up. Your inbox is
watched, and each new email is either left alone, turned into a task, flagged
to you, or answered with a draft. Approvals come to your phone. Everything
below is configuration: no code.

## What runs, and when

| Piece | What it does | Where to set it |
|---|---|---|
| **Heartbeat** | A check every few minutes, with no AI involved. When it finds something (a due task, a notification, a meeting soon, a failing pull request, new mail), it starts one agent turn. | Settings → Heartbeat |
| **Inbox watch** | Part of the heartbeat. New mail wakes it, and the agent decides what each message needs. | Settings → Heartbeat → *Watch my inbox* |
| **Role agents** | One agent per role (`coding`, `research`, `writing`, …). It works the tasks you assign to that role, either by itself or through a pipeline. | Tasks → Role agents |
| **Pipelines** | Multi-step runs (plan → work on each plan item → QA) for the bigger ideas. | Pipelines |
| **Chats** | Telegram, Slack, Teams or WhatsApp. You get messages and approvals there, and can answer them there. | Settings → Channels |

## Setting it up

The quickest way: on the home page, the setup guide's **Run my company** asks
these questions and does steps 2 to 7 for you ([ONBOARDING.md](../ONBOARDING.md)).
By hand:

1. **Turn the heartbeat on for the server** (admin): Settings →
   Configuration → `heartbeat.enabled`. Set `heartbeat.quietHoursTimezone`
   and the quiet hours to your own day.
2. **Connect your mailbox**: Settings → Integrations → Google or Microsoft 365.
3. **Link a chat** (for example Telegram): Settings → Channels. This is where
   you will be told about things and asked for approvals.
4. **Turn on your heartbeat**: Settings → Heartbeat → *Run my heartbeat*,
   *Check every 15 minutes* and *Watch my inbox*.
5. **Write your standing instructions**: create a note with the slug
   `heartbeat` and pin it. Every heartbeat turn reads it. For example:

   ```
   # HEARTBEAT
   I run Acme Design, a three-person studio. Clients: ...
   - Client emails asking for a quote: draft a reply and tell me on Telegram.
   - Invoices and payment reminders: add a task for Friday.
   - Anything from the bank or the tax office: tell me right away.
   - Newsletters, notifications, receipts: no action.
   - Never send email yourself.
   ```

6. **Let agents work on their own**: on the Tools or Permissions page, set to
   **Allow**:
   - the `tasks` tool's `write` action, so role agents can work the board and
     the inbox watch can file tasks;
   - the `messaging` tool's `send` action, so an agent can tell you something
     in your chat. It can only message *you* from a background run.

   Background runs cannot ask you for permission, so anything left on Ask is
   refused.
7. **Choose who works your ideas**: put an idea on the to-do list and assign
   it to a role (for example `research` for "find three bookkeeping tools",
   `coding` for "add a contact form to the website"). In the tasks page's
   **Role agents** panel, turn that role on. For larger ideas, set *Works each
   task* to *through the Full Development Cycle pipeline* (or *Research & Analysis*, or your own template).
8. **Decide about approvals**: a pipeline step that asks for approval waits
   for you, and the request comes to your chat, where you can reply "yes".
   For steps you are happy to let run on their own, tick *Approve
   automatically when no one is watching* in the pipeline editor.

## What happens with an email

1. Mail arrives. On the next check the heartbeat sees it is new: not seen
   before, and not in the promotions or social tabs.
2. One agent turn gets the list (sender, subject, a short preview) together
   with your standing instructions. Up to ten emails are handled per turn.
3. For each email the agent reads more if it needs to. It then does nothing,
   adds a task, sends you a short message, or saves a reply in your Drafts
   folder.
4. It records what it did. The Heartbeat tab shows the last ten outcomes.
   An email it skipped comes back later, at most three times.

Sending mail stays behind its own permission. Unless you set sending to Allow
*and* your instructions say to send, the agent only drafts.

## What happens with an idea

1. The role agent wakes on the heartbeat and takes the first ready task
   assigned to its role.
2. It either works the task itself, or starts a pipeline run for it. A run
   plans the work, carries out each step, checks it and comments on the task.
3. When the work is done, the task is closed with a summary. When the run
   cannot finish, the task comes back to you with a comment and a
   notification, and is not started again on its own.

## Limits worth knowing

- One heartbeat turn at a time per role, and at most `heartbeat.maxRunsPerDay`
  runs a day per person, counting every heartbeat.
- The inbox watch reads only mail that arrived after you turned it on, going
  back at most three days.
- An approval nobody answers within an hour pauses its pipeline as
  "unanswered". You can resume it from the Pipelines page.
- Sent email, deletions and other actions that leave Octipus keep their own
  permission settings. Standing instructions guide an agent but never grant
  it permissions.
