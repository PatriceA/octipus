# Notes UX/UI Redesign — design note

Status: **implemented** (2026-06-13, Phases 1–4). Owner: Patrice.
Scope: `web/app/notes/` + fold in `web/app/graph/` + small `src/api/routes/notes.ts`
and repository additions. No DB migration required.

> Goal in one line: turn the cramped two-column notes page into a full-height,
> Obsidian-familiar knowledge workspace that uses the whole screen, groups notes
> visually, makes linking and tagging effortless (with autocomplete), and brings
> the graph back home where it belongs — without copying Obsidian or losing the
> things we already do well (suggested connections, backlinks, tags, filters).

## Locked decisions (from review)

1. **Layout:** 2-pane + collapsible context. The navigator is folded *into* the
   list pane (folder tree + tag tree + filter tabs live there). Three visible
   columns at desktop width: **Navigator/List | Editor | Context** — the editor
   and panes run full-height to the bottom of the screen; the Context panel is
   collapsible.
2. **Organization:** Folders derived from **slug paths** (nested, collapsible,
   Obsidian-style) + a nested **tag tree with counts** + a **Pinned** section +
   smart groups for **Daily** and **MOCs**. Uses data already in the DB — almost
   no backend. "Move note" = re-slug (link-rewrite deferred, see Risks).
3. **Graph:** Fold `/graph` into `/notes` as a `[ List | Graph ]` view toggle.
   Redirect the old `/graph` route, drop its separate sidebar entry. No per-note
   mini-graph in v1 (the API already supports it — cheap to add later).

## Why now (the complaints, mapped to causes)

| Complaint | Root cause in code |
|---|---|
| "window is quite small … lots of screen space not used" | `web/app/notes/page.tsx`: editor `<main>` is capped `max-w-3xl` (768px) and the body is a fixed `h-80` (320px) `<textarea>`; the shell wraps non-chat pages in `p-6` so nothing is full-bleed (`web/components/app-shell.tsx:51-58`, only `/chat` gets `p-0`). |
| "note list is too packed" | List rows pack title + `slug · kind` + up to 4 tag chips into a fixed `w-72` (288px) rail. |
| "easy to misclick on tags" | Tags are `role="button"` nested *inside* the note's `<button>` with `stopPropagation` (`page.tsx:221-234`) — overlapping hit targets. |
| "notes are not grouped visually" | The list is one flat `<ul>` ordered by `updatedAt`; filtering exists but there is no grouping/folders. |
| "graph is extra … should be with notes" | `/graph` is a separate page + sidebar entry, but `graphRoutes` only graphs the user's notes (`src/api/routes/graph.ts`). |

## What already exists (audit — reuse, don't rebuild)

Backend is rich; the gap is almost entirely frontend.

- **Schema** `src/db/schema/notes.ts`: `slug` (path-capable, e.g. `daily/2026-06-13`),
  `title`, `body`, `frontmatter` (jsonb), `tags[]` (GIN-indexed), `noteKind`
  (`note|daily|moc|literature`), `noteDate`, **`pinned`** (column exists, unused
  in UI), `archivedAt`. No migration needed for this redesign.
- **Routes** `src/api/routes/notes.ts`: `GET /notes` (filter kind/tag),
  `POST /notes` (save), **`POST /notes/query`** (Bases-style: kind+tag+frontmatter
  +sort — already built, currently unused by the UI), `POST /notes/capture`
  (daily), `GET /notes/:id` (+ backlinks + outgoing), `GET /notes/:id/suggestions`,
  `DELETE /notes/:id` (archive/hard).
- **Links** `src/db/repositories/knowledge-link-repository.ts`: `getBacklinks`,
  `getOutgoing`, `getBacklinksByRef` (tag → entities), ghost-edge resolution.
  `src/core/knowledge/graph.ts` `traverse()` powers a **local-neighborhood graph**
  (`GET /graph?entryType&entryId&hops` already implemented).
- **Suggestions** `src/core/knowledge/suggestions.ts`: semantic, returns
  `{type,id,title,similarity}`. Keep as-is.
- **Wikilink/tag parser** `src/core/knowledge/wikilink.ts`: the *only* place
  `[[ ]]`/`#tag` is interpreted; `slugify()` preserves `/` (so slug paths and
  nested tags `a/b` work). Autocomplete must produce strings this parser accepts.
- **Editor stack already installed (big win):** `@uiw/react-codemirror` +
  `@codemirror/{view,state,commands,lang-markdown,autocomplete}` are present in
  `web/node_modules`. So `[[`/`#` autocomplete is native CodeMirror, not a
  textarea hack.
- **Graph view** `web/app/graph/page.tsx`: dependency-free SVG Fruchterman–Reingold
  force layout, deterministic (ring-seeded, no `Math.random`), nodes colored by
  kind. Extract into a shared component and reuse.
- **Design language** `web/app/globals.css`: Material-3 tokens + terminal
  aesthetic, dark-only, `font-mono`, periwinkle `#8CACFF` primary, green
  tertiary, amber warning, orchid `#FFB7F9` accent (AI moments). Utility classes:
  `.section-label`, `.term-frame`, `.term-caret`, `.term-prompt`, `.dot/.dot-ok/
  .dot-warn`, `.animate-enter`, `.stagger`. **Keep this identity** — the notes
  page already uses the `octi:~/notes $` prompt motif; the redesign should feel
  like the same terminal, just bigger and better organized.

## Design principles for this redesign

Build with the **`frontend-design`** skill (production-grade, anti-generic) and
consult **`ui-ux-pro-max`** for layout/spacing/interaction patterns. Non-negotiables:

- **Earn the pixels.** Every pane runs to the viewport bottom; no dead gutters,
  no arbitrary max-width on the editor. Density is *comfortable*, not *cramped* —
  bigger row hit-targets, clear grouping headers, generous line-height in prose.
- **One target per click.** Tags never overlap a row's open-target. Tag
  navigation lives in the tag tree / a dedicated chip row, not stacked on the
  row button.
- **Familiar, not cloned.** Borrow Obsidian's *mental model* (folders answer
  "where does it live", tags answer "what is it about", backlinks/graph answer
  "what connects") but keep Octipus's terminal skin and our suggested-connections
  edge (Obsidian has no semantic suggester — that's our differentiator, keep it
  prominent).
- **Keyboard-first.** Quick-switch, `[[`/`#` autocomplete, save shortcut.
- **Progressive disclosure.** Context panel and navigator collapse; widths
  persist (localStorage). Responsive: context hides first, then the navigator
  becomes a drawer on narrow viewports.

## Target layout (chosen: 2-pane + context)

```
 octi:~/notes $                                   [ List | Graph ]   ⌘K
┌──────────────────────────┬─────────────────────────┬────────────────┐
│ NAVIGATOR + LIST         │ EDITOR                  │ CONTEXT  ⟨⟩     │
│ ⌕ search…                │ # Title                 │ Backlinks      │
│ [All][Pins][Daily][MOC]  │ ┌ props ──────────────┐ │  ← Roadmap     │
│ ★ Pinned (2)             │ │ #ai #ml · kind · date│ │  ← Specs       │
│   • Roadmap              │ └─────────────────────┘ │ Outgoing       │
│ ▾ 📁 projects/octipus    │ [Edit][Preview][Split]  │  → Architecture│
│     • Roadmap            │ ┌─────────────────────┐ │ Suggested ✦    │
│     • Specs              │ │ CodeMirror markdown │ │  + Ideas   82% │
│ ▾ 📁 daily               │ │ [[ autocomplete     │ │  + Backlog 74% │
│     • 2026-06-13         │ │ # tag autocomplete  │ │ Tags           │
│ ▾ # tags                 │ │ … grows to the      │ │  #ai #ml       │
│     ai        12         │ │ very bottom         │ │                │
│     ai/ml      4         │ │                     │ │                │
│     research   7         │ └─────────────────────┘ │                │
└──────────────────────────┴─────────────────────────┴────────────────┘
  resizable · collapsible    full-width · full-height   collapsible
```

- The **Navigator/List** pane combines search, filter tabs, the folder tree
  (from slug paths), the Pinned section, and the tag tree. It replaces today's
  flat `w-72` list. Resizable; collapses to icons on narrow screens.
- The **Editor** fills remaining width and full height. CodeMirror markdown with
  the existing formatting toolbar (rewired to CM commands), a **properties bar**
  (tags / kind / date, with tag autocomplete), and `Edit / Preview / Split`.
- The **Context** panel (collapsible, right) shows **Backlinks** (resolved to
  real titles, clickable), **Outgoing links**, **Suggested connections** (the
  `+`-to-link flow we keep), and **Tags**. (Per the graph decision, the per-note
  local graph is *deferred*; the API already supports it for a later add.)
- A top-bar **`[ List | Graph ]`** toggle switches the whole workspace to the
  full force-graph (extracted from `web/app/graph/page.tsx`).

## Backend changes (small, additive — no migration)

All in `src/api/routes/notes.ts` + `src/db/repositories/note-repository.ts`
(+ a touch of `knowledge-link-repository.ts`). Follow house rules: tenant-scoped,
fail-loud, 404 on cross-tenant.

1. **`GET /notes/index`** → `[{ id, title, slug, kind }]` for active notes — the
   data source for `[[` autocomplete. (Could reuse `GET /notes`, but a dedicated,
   cache-friendly endpoint keeps autocomplete fast as the vault grows.)
2. **`GET /notes/tags`** → `[{ tag, count }]` across the user's active notes —
   powers the tag tree *and* the `#` autocomplete (so we stop spawning
   near-duplicate tags with different spelling). Derive via `tags[]` aggregation
   (or `getBacklinksByRef`/a `GROUP BY` over the array).
3. **Resolve backlinks/outgoing to titles.** Enhance `GET /notes/:id` so
   backlink/outgoing edges return `{ type, id, title, slug }` instead of raw
   `note:1a2b3c4` ids — batch-load endpoints via the existing
   `NoteRepository.getByIds`. Fixes the ugly id display and makes them clickable
   to open.
4. **Pin support.** Add `NoteRepository.setPinned(userId,id,pinned)`, include
   `pinned` in `list()` selects, and either a `PATCH /notes/:id/pin` or accept
   `pinned` in `POST /notes`. Drives the Pinned section + a pin button.
5. (No new endpoint for folders or the graph view — folders are derived
   client-side from `slug` paths; the Graph view calls the existing `GET /graph`.)

## Frontend changes

Rewrite `web/app/notes/page.tsx` into a workspace with focused components under
`web/app/notes/` (or `web/components/notes/`):

- `notes-workspace.tsx` — full-bleed shell, `[List|Graph]` toggle, resizable +
  collapsible panes (persist widths/collapsed state in localStorage).
- `notes-navigator.tsx` — search, filter tabs, **folder tree** (parse `slug` on
  `/` into a nested, collapsible tree), **Pinned** section, **tag tree** (nested
  on `/`, with counts from `GET /notes/tags`). Smart groups Daily/MOCs by
  `noteKind`. This is where "grouped visually" + "less packed" + "no tag
  misclick" are solved.
- `note-editor.tsx` — CodeMirror 6 (markdown), full-height; formatting toolbar
  rewired to CM commands; `Edit/Preview/Split`; **properties bar** (tags via
  autocomplete, kind, date). Keep the dirty-check / save-only-on-change behavior
  and the "open in preview, edit on demand" rule from today's page.
- `note-context.tsx` — Backlinks (titles, clickable), Outgoing, Suggested
  connections (keep `+`-to-link), Tags. Collapsible.
- `knowledge-graph.tsx` — extract the SVG force layout from
  `web/app/graph/page.tsx` into a shared component used by the Graph view mode.

### Linking & tagging autocomplete (the headline new feature)

CodeMirror `autocompletion` with two `CompletionSource`s over `lang-markdown`:

- **`[[` wikilink source:** triggers after `[[`, queries `GET /notes/index`,
  fuzzy-matches title/slug, inserts `[[Exact Title]]` (parser-correct). Offers a
  **"Create '<typed>'"** option that stages a new linked note. Show title +
  folder (slug parent) as secondary text so duplicates are distinguishable.
- **`#` tag source:** triggers after a `#` that the parser would treat as a tag
  (start-of-word, has a non-digit — mirror `TAG_RE`), queries `GET /notes/tags`,
  ranks by frequency, and **prefers existing tags** to kill the "same tag,
  different spelling" problem. The properties-bar tag input uses the same source.

This directly delivers: *"note title suggestion when I start writing in the
`[[]]`"* and *"tag suggestion … choose existing ones … not the same tag with
different writing."*

### Graph merge

- Add `view=graph` to the workspace; render the extracted `knowledge-graph.tsx`
  (calls `GET /graph`). Keep selection → highlight-neighborhood behavior.
- Redirect `web/app/graph/page.tsx` → `/notes?view=graph`; remove the `graph`
  entry from `web/components/sidebar.tsx` (notes keeps `NotebookPen`).

## Phasing (each phase ships independently; verify before the next)

- **Phase 0 (optional, ~30 min):** with `frontend-design`, build a static
  clickable mockup of the new shell for visual sign-off before the rewrite.
- **Phase 1 — Space & shell (the headline fix):** opt `/notes` into full-bleed
  (generalize the app-shell `p-0` case, don't special-case one path twice);
  3-column responsive workspace; editor full-width/full-height; resizable +
  collapsible panes; `[List|Graph]` scaffold; move graph in + redirect + drop
  sidebar entry. *Verify:* on a wide screen the editor reaches the bottom and
  fills width; graph opens inside notes; `/graph` redirects.
- **Phase 2 — Navigator & organization:** folder tree from slugs, tag tree +
  counts, Pinned, filter tabs, search; fix row density + remove nested tag hit
  targets; pin endpoint + setter. *Verify:* notes group under folders; clicking a
  row never accidentally triggers a tag; tag counts correct.
- **Phase 3 — Editor power:** CodeMirror swap; `[[` autocomplete (`/notes/index`);
  `#` autocomplete (`/notes/tags`, dedup); properties bar; toolbar → CM commands.
  *Verify:* typing `[[` lists existing notes and inserts a working link; typing
  `#` offers existing tags; no duplicate-spelling tags created.
- **Phase 4 — Context polish:** resolve backlinks/outgoing to clickable titles;
  suggestions + tags in the panel. *Verify:* backlinks show real titles and open
  on click.
- **Phase 5 — Stretch:** ⌘K quick-switcher/command palette; split live-preview;
  daily-note quick capture surface; **link rename/move with backlink rewrite**;
  Bases-style table/card views (the `POST /notes/query` endpoint already exists);
  per-note local graph in the Context panel (API ready).
- **Verification throughout:** `bun run typecheck && bun run lint && bun test`;
  exercise in a browser with the **`webapp-testing`/`playwright`** skill (notes
  are auth-gated + multi-user — drive a logged-in session). UI changes are not
  "done" on typecheck alone (CLAUDE.md).

## Risks & open decisions

- **Re-slug breaks inbound links.** Folders are derived from `slug`, so "move" =
  change slug. Existing `[[old-slug]]` references would dangle. **v1: folders are
  read-only grouping** + create-into-folder (slug prefix). Rename/move *with*
  backlink rewrite is **Phase 5** (Obsidian rewrites links on rename — match
  that, fail loud if any reference can't be rewritten). Do **not** ship silent
  re-slug that orphans links.
- **CodeMirror bundle size / SSR.** Load the editor client-only (it already is —
  `'use client'`); dynamic-import if it bloats first paint.
- **Tag autocomplete completeness.** Must aggregate server-side (`/notes/tags`),
  not from the capped client list, or large vaults under-suggest and re-spawn
  duplicates — defeating the point.
- **Live preview** (Obsidian's inline-render) is a large CM-decorations effort;
  `Edit/Preview/Split` covers 90% of the value — keep live preview as stretch.

## References

- Obsidian organization (folders vs tags vs MOCs), the basis for the hybrid
  navigator: https://blog.shuvangkardas.com/obsidian-note-organization/ ·
  https://forum.obsidian.md/t/what-are-the-pros-and-cons-of-using-tags-instead-of-folders-for-the-purpose-of-categorizing-types-of-notes/27060 ·
  https://www.eleanorkonik.com/p/yet-another-hot-take-on-folders-versus-tags ·
  https://studio-obsidian.com/obsidian-folder-structure/
- Skills to use: `frontend-design` (build), `ui-ux-pro-max` (patterns),
  `webapp-testing`/`playwright-skill` (verify).
