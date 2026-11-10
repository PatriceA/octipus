# Workspace, navigation, and settings design studies

The approved Project Desk v2 direction is now implemented in the application.
See [Project Desk and settings](../../WORKSPACE_DESK.md) for the actual data
sources, state meanings, settings destinations, and validation. The standalone
preview below remains illustrative and isolated from live data.

Interactive preview: <http://localhost:3007/design-preview/index.html>.
Source: `web/public/design-preview/index.html`. All data is illustrative. No API
requests, agent calls, permission changes, or actual work are performed. The
preview is a standalone public page, separate from the application routes.

## Three directions

| Direction | Lead experience | Strength | Tradeoff |
| --- | --- | --- | --- |
| 01 · Calm workspace | Companion and one decision, followed by current sessions | Familiar, balanced entry point | Some supporting information remains below the fold |
| 02 · Companion first | A short cross-project briefing and message composer | Makes the coordinator the natural front door | Relies on a reliable, fresh, evidence-backed Companion summary |
| 03 · Project desk · v2 — selected direction | Observable session states, current activity, verified outcomes, and next steps | Working application feel with a persistent Companion and session inspector | Requires fresh, evidence-backed status; no inferred completion percentage |

The second iteration follows owner feedback: Project Desk is the preferred base,
the initial versions felt too much like websites, and plan percentages are
misleading when the scope changes. Project Desk v2 removes the large welcome
copy, metric tiles, and all progress bars. The menu now has a clear filled
selection, a distinct Companion entry, and an amber decision count. A compact
supervision strip and message bar keep Companion present while work stays central.

Each session shows **state → current activity → latest verified outcome → next
step**. The adjacent inspector shows timestamped changes and scope notes. An
expanded plan is reported as a change, never as a drop in completion. “Ready”
describes an available result, not completion of the entire project. The preview
filters sessions by explicit state, not a numeric percentage.

On phones the list stays compact, selecting a session opens its inspector in a
dialog, and the Companion message bar stays at the bottom. Composer drafts and
keyboard focus survive changing the selected session or filter.

Work-state rules for implementation:

- **Working:** name the observed activity and when it was last observed.
- **Needs you:** give a concrete decision, with an action to resolve it.
- **Blocked:** identify a technical dependency; do not turn it into consent by default.
- **Paused by you:** preserve the deliberate pause; do not imply Companion will resume it.
- **Ready to read:** an output is available; the whole project may still continue.
- **Unknown / stale:** the status could not be confirmed; never infer “working” or “done”.

The current example contains the first, second, and fifth states. A concrete,
bounded operation such as a file transfer may have its own progress indicator;
that must not be presented as the project's overall completion. Plan changes
should say what was added or changed, with access to the current plan.

These are layout alternatives, not three themes for the same layout. Dark mode
and light mode should ultimately be available independently of the chosen layout.
The studies use the existing deep-ink, sea-glass, warm-paper identity and product
mark. They are not copies of the reference dashboards.

## What changes on Home

- Start new work, open Companion, and continue a specific session are all visible
  together. New work starts a focused session; Companion remains an ongoing chat.
- At most a small number of owner decisions lead the attention area. An agent
  failure is not automatically a request for owner consent. Investigate technical
  failures before escalating them.
- Replace the expansive away digest with a compact result summary and a link to
  Activity. Group worker events under the resulting session or deliverable.
- Distinguish decisions, working sessions, ready results, and saved ideas with
  words as well as color. Do not make the owner decode agent roles or run IDs.
- Move provider inventories, agent counts, cache ratios, request totals, detailed
  costs, and service checks into their relevant operational pages. A meaningful
  outage still appears on Home. Show unavailable/stale state explicitly.
- The known cost in the top bar must retain its qualification; deeper billing
  views distinguish reported, estimated, and unknown amounts.
- New installs need a small, dismissible setup checklist only for incomplete
  prerequisites. Shared and remote workspaces need context-specific actions and
  permissions. They must not inherit a personal Companion or expose private work.

## Navigation proposal

Keep a stable core: **Home, Companion, Sessions, To-dos, Activity, Library,
Automation**, and **Settings** anchored at the bottom. Every icon has an accessible
name. Collapsing to icons is an explicit, persistent choice. Page changes do not
collapse sections or reset navigation state. On mobile, navigation is a drawer.

This reduces top-level choices; it does not remove enabled capabilities:

| Existing destinations | Proposed destination |
| --- | --- |
| Overview | Home |
| Chat / individual session | Sessions, opening the specific conversation directly |
| Companion chat / supervision | Companion; supervision is a secondary view; configuration links to Settings |
| Tasks / my work | To-dos for queued work; session deliverables in Library → Outputs; preserve existing links |
| Inbox / notifications / away digest | Activity → Decisions, Results, All events |
| Research / documents / notes / knowledge / recall / artifacts | Library with searchable type views; preserve dedicated editors and readers (the Reader is now the example plugin, a plugin page) |
| Mission control / roster / pipelines | Automation → Runs, Pipelines, Agent diagnostics |
| Triggers / hooks / schedules | Automation → Schedules; setup controls have canonical Settings destinations |
| Cases / contacts / records | A contextual Business destination when the module is enabled; excluded from these personal-home mockups |
| Rooms / people / shared work | A contextual Team destination in shared spaces; retain space switching and remote-space restrictions |
| Email / mailboxes / calendar | Contextual Mail & Calendar work destination when enabled; account setup in Settings |
| Models / topics / tools / MCP / permissions / persona / profiles / memory / skills / secrets / evaluations / users | Canonical Settings categories; diagnostic work views can deep-link to their configuration |

The contextual destinations need explicit implementation designs before migration.
No feature should disappear merely to meet a sidebar item count. Favorites and
recent destinations could be added later if actual usage warrants them.

The current sidebar already has a persisted width toggle; the frustrating section
behavior comes from `<details open={group.items.some(...activeHref)}>`, tying each
group's open state to the current route. The preview removes those automatic
accordions. A production migration could instead retain user-controlled groups
if needed for contextual modules.

## Settings: one owner per control

| Group | Contents |
| --- | --- |
| You & your workspace | Profile, appearance/persona, notifications, voice/mobile, people/spaces |
| Companion & automation | Companion binding, supervision, Companion budget, Heartbeat, pipelines/schedules, recovery preferences |
| Models & knowledge | Model providers, topic assignments, skills/memory, knowledge sources/indexing |
| Connected accounts | Service accounts, multiple mailboxes/calendars, messaging channels, MCP/extensions |
| Machines & access | Canonical workspace folders, execution environments, program/identity access, explicit permissions/exceptions, secrets/API tokens |
| System | Feature modules, usage/limits, health/updates, advanced configuration; admin controls gated by role |

Search includes synonyms: `gh` → Environments & Access; `email` → Mailboxes &
calendars; `heartbeat` → Heartbeat. Search matches word prefixes so `gh` does not
accidentally match `overnight`.

Do not simply hide duplicate controls under prettier categories. A migration must
identify the actual owner of every control, preserve its persisted value and
permission boundary, and replace other copies with links to the canonical page.
“General”, “Configuration”, and “Integrations” stop being catch-all destinations.
Keep advanced fields searchable, but outside the everyday forms. Deep links,
back navigation, saved/unsaved feedback, and search must refer to stable settings
URLs in the production implementation.

Representative detail examples are included for Heartbeat, Companion, and
Environments & Access. Other detail destinations are explicitly labelled as
unfinished design areas. The preview does not claim they are implemented.

## Design rules

1. One clear lead action in each section. Primary buttons are filled; secondary
   actions have lower visual weight. Use specific verbs.
2. One strong visual anchor per page. Consistent heading, section, label, and body
   hierarchy replaces a grid of equally loud cards.
3. Green indicates working/normal state; amber requests a decision; red requires
   a confirmed failure. Include text labels and keep colors accessible.
4. Surface short human summaries and concrete next actions. Keep technical logs
   one level deeper without removing evidence or consequences from approvals.
5. Use generous spacing and restrained borders. Reserve monospace for technical
   material. Charts require a useful question and real data.
6. A compact empty state is better than a large empty panel. Missing data must
   never be presented as success or zero activity.
7. Keyboard, mobile, reduced-motion, and saved navigation state are part of the
   design. Prototype controls must not pretend to have performed live work.

## Review and validation

Run `node docs/design/workspace-2026-11/check-preview.mjs` against the preview URL
(override with `DESIGN_PREVIEW_URL`). It captures the screenshots in this folder
and checks all directions, search, navigation persistence, dialog focus, mobile
overflow, and illustrative interactions. It also verifies no API requests occur.

Independent review found modal shortcut/focus and mobile search-label issues;
these were corrected before the browser check. Production source and backend
behavior are unchanged.
