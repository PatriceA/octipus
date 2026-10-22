# The setup guide

`octi setup` installs Octipus: storage, secrets, the admin account, one model
and a few optional tools. The **setup guide** on the web app's home page does
the rest. It asks what you will use Octipus for, asks a few questions per use
case, shows you the list of changes it will make, then makes them.

It also opens on its own page at `/onboarding`, for setting up more later.

## What it asks

**1. What will you use Octipus for?** Pick one or more:

| Use case | What it sets up |
|---|---|
| **Build software** | Coding CLIs as models (Claude Code, Codex, Gemini CLI), the folder with your repositories, a GitHub token, Jira or Linear, a coding agent for your tasks |
| **Run my company** | Your mailbox, the inbox watch, standing instructions, permissions for background agents, an agent for your ideas |
| **Product management** | Jira or Linear, a product agent (role `pm`), calendar check-ins |
| **Research and knowledge** | Document search (an embedding model), a research agent |

**2. A few questions, one section at a time.** Three sections are asked of
everyone; the others come with a use case:

| Section | For | Questions |
|---|---|---|
| AI models | everyone (admins only) | API key, a coding CLI or Ollama; a second model that checks work; document search |
| Areas of work | everyone | separate areas (personal workspaces), a shared space for a team, one login per company with its own mailbox |
| Your chat | everyone | Telegram (bot token and link code), Slack, Teams or WhatsApp |
| Building software | Build software | coding CLIs, coding lane, repositories folder, GitHub token, coding agent and how it works tasks |
| Issue tracker | Build software, Product management | Jira (Atlassian), Linear, or another tool by its MCP address |
| Your company | Run my company | name and what it does, inbox watch, what is urgent, draft or send replies, check interval, idea agent |
| Product work | Product management | product agent, calendar check-ins |
| Mailbox and calendar | Run my company, Product management | Google or Microsoft |
| Research | Research and knowledge | research agent |

When something is already set up, the question says so ("Every kind of work
already has a model") and starts from the current value. A section where
everything is already in place is marked "set up" in the row of sections.

**3. Review.** A numbered list of everything the guide will do; steps that
need you are marked "needs you". Below it, **Already set up, left as it is**
lists what the guide found in place and will not touch, such as a connected
mailbox, a linked chat, an agent that is already on, or a permission that is
already Allow. Setup done by hand before the guide counts.

A step that depends on something already in place runs straight away. For
example, the inbox watch needs a connected mailbox, and an already connected
mailbox counts.

**4. Set it up.** The steps run one at a time:
- A failed step stops only the steps that depend on it.
- A step that needs you waits for you: a sign-in in a popup, a chat link code
  you type in, or something on another page. You can skip it.
- The last screen lists what was done, what failed and what was left for later.

Run the guide again at any time: what is already in place is listed as done
and left alone.

## How it works

- **Questions and plan** live in `src/shared/onboarding/`:
  - `use-cases.ts` holds the use cases, sections and questions;
  - `plan.ts` holds `buildPlan`, a pure function from answers and the current
    state to steps.

  The web guide and the tests use the same code.
- **The steps** run through the ordinary API routes, with your own session.
  Every check those routes make still applies: admin-only settings,
  workspace-root limits, known roles, permission levels. A step whose result
  already exists becomes a `done` step: it is listed, and nothing is called.
- **`GET /api/onboarding`** reports what is already set up
  (`src/core/onboarding/state.ts`). Install-wide facts (model rows, provider
  keys, MCP servers, CLI tools on the host) are only read for admins. Every
  source fails soft to "not set up".
- **`PUT /api/onboarding/progress`** saves your choices in
  `users.preferences.onboarding`, minus every secret. Secrets go straight to
  the call that stores them (settings, vault) and are cleared from the page
  once the run ends.
- **`PUT /api/onboarding/standing-instructions`** writes the heartbeat's
  standing-instructions note at user level and pins it. If you already have
  one, the guide appends to it under a dated heading.

## Separate companies

Octipus connects one Google and one Microsoft mailbox per login. Companies
that each have their own mailbox each need their own login. When an admin
picks **Run my company** and separate areas, the guide offers to create those
logins:
- each gets a random password, shown once at the end;
- sign in as each login to connect that company's mailbox and run the guide
  for it.

Areas of work (personal workspaces) keep chats, tasks, notes and documents
apart, but they share your mailbox and chat.

## Who can do what

Someone who is not an admin does not see the AI models section, and the guide
plans no install-wide change for them. Where something only an admin can do
is needed, such as turning on the server's heartbeat, the guide says so as a
step to hand to the admin.
