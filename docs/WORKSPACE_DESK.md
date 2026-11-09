# Project Desk and settings

The start screen focuses on session state, not installation statistics. It has
direct entry points to a new session, the saved Companion conversation, current
sessions, and ideas saved as to-dos. Shared and remote workspaces open their rooms
and next steps instead of showing personal sessions or Companion data.

## What the state means

| State | Evidence |
| --- | --- |
| Working | A live owner worker was observed; read-only Companion briefing helpers are excluded |
| Needs you | An actual pending request or a pipeline awaiting approval |
| Needs investigation | A recorded failure or blocked plan step; this is not automatically a consent request |
| Paused | The session, pipeline, or last run is paused/stopped; no automatic resume is implied |
| Updated | A run finished; this does not certify completion of the project |
| No active run | No active work is recorded in the available observations |
| Status unconfirmed | An observation is missing, a stored running worker is not live, or a declared pipeline cannot be read |

Plans can grow. The desk shows current activity, recorded outcomes, next steps,
and plan revision summaries without converting a task count into project
completion. The inspector shows recent recorded changes and a compact excerpt of the latest plan revision; on smaller screens it
opens as a keyboard-accessible dialog.

`GET /api/sessions/desk` returns one bounded owner-scoped snapshot. It starts with
30 recent personal sessions, adds up to 30 old pending-request sessions and up
to 30 live execution sessions, and reads at most four recent runs per session.
Candidates and pipeline references are checked for owner, workspace, and session
ownership independently of admin-wide diagnostic privileges. Raw session context,
tool arguments, and credential material are not returned.

The browser refreshes this snapshot every 30 seconds while visible. Failed or
older-than-90-second snapshots show unconfirmed state instead of retaining a
“Working” badge. Partial source failures are visible, with a retry. The list
shows at most four entries from the selected filter, prioritizing decisions and
live work; the complete conversation list remains accessible from “View all
sessions.”

The Companion composer uses the saved supervisor session ID and the shared
gateway. It does not create a replacement controller or infer identity from a
title. An unsent draft survives filtering and selection. Saving an idea uses the
normal task API and protects the draft until the save succeeds; errors retain
the text. Long ideas retain their full content in the task notes.

## Navigation and page language

The shared application uses a light work canvas, an ink navigation rail, clear
filled selection, distinct Companion highlighting, restrained panels, and human
reading typography. Commands, paths, and technical material retain monospace.
Headers, status badges, and dialog surfaces use the same language across pages.
Page transitions no longer fade every navigation as if opening a landing page.

Daily destinations stay visible. Supporting sections open only when the user
chooses, and their open state and sidebar width persist across page changes and
reloads. A closed section containing the current page remains highlighted.
Configuration has an anchored Settings entry. Existing module visibility and
admin restrictions remain in effect.

## Settings ownership

Settings opens with search and six groups:

- You & your workspace
- Companion & automation
- Models & knowledge
- Connected accounts
- Machines & access
- System

`web/components/settings/settings-map.ts` is the destination map used by search
and cards. Search recognizes aliases such as `gh`, `oc`, `email`, and
`heartbeat`. A detail section has a stable `?tab=…` URL and a return to All
settings. Existing detail URLs remain supported, with module/admin visibility
applied before rendering a panel.

Workspace folder controls live in Machines & access → Workspace folders.
Accounts & services links to that destination and Environments & Access instead
of repeating folder and CLI controls. Profile and system health have separate
destinations. Advanced configuration is available under System rather than being
the everyday settings interface. Dedicated model, topic, skill, permission, and
other configuration pages remain reachable from the map and retain their URLs.

Usage accounting, spend budgets, and provider health move off Home into their
Settings destinations. The old `/#budgets` address redirects to Settings → Usage
& budgets. The detailed away digest is retained as an optional visit summary on
Activity, loaded only after expansion.

## Validation

Backend regressions cover false live state, failures versus decisions, expanding
plans, missing observations, personal/shared boundaries, old pending sessions,
briefing helpers, foreign/missing pipeline references, and per-session history
limits. Browser coverage includes actual gateway dispatch, failed/slow idea
saves, selection and filter drafts, mobile focus restoration, new session setup,
settings discovery/back navigation, stale snapshots, menu persistence, and the
existing app page flows.
