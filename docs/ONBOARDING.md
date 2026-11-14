# The setup guide

`octi setup` installs Octipus: storage, secrets, the admin account, one model
and a few optional tools. The **setup guide** on the web app's home page does
the rest. It asks what you will use Octipus for, asks a few questions per use
case, shows you the list of changes it will make, then makes them.

It also opens on its own page at `/onboarding`, for setting up more later.

## The shortest path

After installation, sign in at `http://localhost:3007` with the account you
created in the terminal. Choose **Start with the basics** in the setup guide.
It asks only about the AI model, checks the connection, and offers **Try your
first chat**. If the terminal already configured the model, keep it: the guide
checks the existing connection without changing its topic assignments.

You do not need a mailbox, an embedding model, a project folder, a second AI
model, background agents or Companion supervision to start chatting. Those
can be added later in Settings or by running `/onboarding` again. API usage
is billed by the provider; a consumer chat subscription alone is not an API
key. A coding CLI instead needs its own installation and sign-in on the
machine running Octipus.

The dedicated guide is centered in the workspace and uses the same surfaces,
typography and Companion accent as the rest of the app, including dark mode.

## What it asks

**1. Basics or a tailored setup.** Start with the basics, or pick one or more:

| Use case | What it sets up |
|---|---|
| **Build software** | Coding CLIs as models (Claude Code, Codex, Gemini CLI), the folder with your repositories, a GitHub token, your issue tracker, a coding agent for your tasks |
| **Run my company** | Your mailbox, the inbox watch, standing instructions, permissions for background agents, an agent for your ideas |
| **Product management** | Your issue tracker, a product agent (role `pm`), calendar check-ins |
| **Research and knowledge** | Document search (an embedding model), a research agent |

**2. A few questions, one section at a time.** Four sections are asked of
everyone; the others come with a use case:

| Section | For | Questions |
|---|---|---|
| AI models | everyone (admins only) | API key, a coding CLI or Ollama; a second model that checks work; document search |
| Areas of work | everyone | separate areas (personal workspaces), a shared space for a team, one login per company with its own mailbox |
| Your chat | everyone | Telegram (bot token and link code), Slack, Teams or WhatsApp |
| Images & audio | everyone (admins only) | generate images (OpenAI or Gemini, bound to the Image generation lane); voice on this server (faster-whisper and Kokoro) or in the cloud (OpenAI or Mistral), bound to the Transcription and Speech lanes. Both start at "no": nothing is bound unless chosen. A provider without a stored key asks for one, or leaves a to-do |
| Building software | Build software | coding CLIs, coding lane, repositories folder, GitHub token, coding agent and how it works tasks |
| Issue tracker | Build software, Product management | GitHub Issues (through the GitHub tool, nothing to connect), or, for admins, another tool by its MCP address |
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
- An API/local model must pass its connection check before it is assigned to
  all work. A CLI check confirms the executable is available; the first chat
  also checks its authentication.
- Partial setting-write errors count as failures even when the HTTP request
  returned 200. Failed or skipped required steps prevent marking the install
  complete; an incomplete run is not recorded as finished onboarding.
- Save errors stay visible. A failed refresh does not retry against an old
  snapshot.
- A failed step stops only the steps that depend on it.
- A step that needs you waits for you: a sign-in in a popup, a chat link code
  you type in, or something on another page. You can skip it.
- The last screen lists what was done, what failed and what was left for later.

Run the guide again at any time: what is already in place is listed as done
and left alone. **Finish the rest** plans again from the same answers; what the
last run did counts as done.

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
- **The first step switches on modules** ([MODULES.md](MODULES.md)). The use
  cases picked bring their modules:
  - `company`: cases, contacts and records; mail; scan folders; protection
    levels; the email inbox; people and profiles.
  - `product`: live artifacts, people and profiles.
  - `research`: recall and live artifacts; its research agent is the
    `research` role's agent, set up in the guide's Research section. Reader and Research are
    the example plugins ([PLUGIN-PACKAGES.md](PLUGIN-PACKAGES.md#bundled-plugins)),
    not product features, so the guide does not offer them.
  - `development`: none, so a developer gets the core only.
  - A chat picked to talk to Octipus from (Telegram, Slack, …) turns on the
    chat channels. Voice no use case brings: choosing voice under Images &
    audio turns it on (its engines are set through `POST /api/voice/engines/use`),
    or tick it in the picker below, or turn it on in Settings → Modules. Only an admin's run has this step.
  It only turns modules on, never off, so running the guide again with fewer
  use cases changes nothing that is on. It calls `POST /api/modules/enable`.
- **The plan review has a module picker** (admins). The modules the use cases
  bring are ticked; any other can be ticked too (contacts and records for a
  one-person business that builds software), and a ticked one unticked. One
  already on is shown ticked and cannot be unticked here, nor one the answers
  need (the chat channels for a chat picked to talk from, the email inbox for
  the inbox watch). The choice is the
  `modules.picked` answer; picking other use cases starts it again.
- **`GET /api/onboarding`** reports what is already set up
  (`src/core/onboarding/state.ts`). Install-wide facts (model rows, provider
  keys, MCP servers, CLI tools on the host) are only read for admins. Every
  source fails soft to "not set up".
- **`GET /api/onboarding/progress`** returns only the saved progress. The home
  page reads it first, and reads the full state only when the guide is shown.
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

## Setup journey and readiness boundaries

The installer automatically installs Octipus's application dependencies.
`octi start` also checks the lockfiles and installs changed application
dependencies before rebuilding. It does not install Node or arbitrary host
programs: those remain system prerequisites or optional capabilities.

The entry paths share the same terminal wizard (`scripts/setup-wizard.ts`):
Linux/macOS/WSL use `scripts/install.sh`, Windows uses `scripts/install.ps1`,
and Docker uses remote setup against the container API. The quick installer
builds the application and starts the web UI. The full wizard prints the
start command; it does not leave the whole web stack running automatically.

| Stage | What it does | What that proves |
| --- | --- | --- |
| Installer | Checks Git/Node/npm, installs dependencies, builds the application | The application can start on that machine; it does not install every optional program |
| Terminal setup | Chooses storage, creates/reuses secrets, starts a temporary backend, registers/logs in the admin | A reachable backend and an administrator account |
| Model setup | Stores the provider key in the vault, registers a model and assigns the text lanes | Configuration exists; the terminal wizard does not itself run a model completion |
| Basic web guide | Reads existing setup, collects any missing model details, runs the model check, then binds a newly chosen model | An API/local model responds, or the selected CLI executable is present; tool use and CLI sign-in still need a real chat |
| Tailored web guide | Reviews and applies optional modules, areas, tools, accounts and background settings | Only steps whose receipts succeeded; skipped sign-ins and failed steps stay outstanding |
| First chat | User sends a request through the real agent | The chosen model and chat execution work together |

The guide preserves existing model assignments when you choose “keep”. It
does not automatically enable supervision, grant workstation-wide access,
or start unattended work. Those choices belong in Settings → Companion &
automation and Settings → Environments & Access. Document search is left
off by default until someone chooses and configures an embedding model.

Remaining limits for a completely beginner-friendly install:

- The installer still requires Git and a supported Node/npm installation.
  Missing prerequisites produce instructions, not automatic installation.
- API providers require an account, credentials and any required billing.
  Local models need Ollama and a downloaded model; the optional terminal
  hardware recommendation can help, but the web guide does not download a
  model just because its name was entered.
- Model checks prove connectivity, not tool-calling quality or successful
  completion of arbitrary work. Custom providers without standard connection
  details and non-admin users need their administrator to verify the model.
- Mail OAuth clients, remote services, phone/USB access and installed-program
  credentials require their own configuration. Optional setup can be deferred;
  it should not be mistaken for a finished integration.
- Companion supervision is a separate optional configuration and model
  binding. A working ordinary chat does not imply supervision is enabled.
