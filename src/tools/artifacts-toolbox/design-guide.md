# Designing an artifact

Read this before writing `html_template` or `css` by hand. It does not apply to
toolbox-only artifacts (sources + widgets, no template) — those render through
the default grid and already look consistent.

## First decide what kind of page this is

- **Dashboard / feed / table** — scanned, not read. Use the toolbox flow
  (`sources` + `add_artifact_widget`); do not hand-author HTML. Surface the
  summary before the detail, and encode state in form as well as number: a pill,
  a chip, a coloured stripe, so what needs attention reads at a glance.
- **Report / memo / one-pager** — read top to bottom. Hand-authored HTML is
  right here. One column, generous spacing, real typographic hierarchy.
- **Poster / card / invite** — a single composition. Commit to one look.

Match the effort to the job. A status page does not need a hero.

## Palette

Octipus's own vocabulary, shared with the web app, the TUI and the mobile
client. Use it unless the user asks for something else — an artifact that looks
like the product it came from reads as intentional.

| Role | Hex | Use for |
| --- | --- | --- |
| canvas | `#0E0E0E` | page background |
| surface | `#151515` | cards, panels |
| surface-high | `#1C1C1C` | inputs, nested surfaces |
| hairline | `#33343B` | every border — one weight, 1px |
| text | `#FFFFFF` | body |
| text-dim | `#8A8A8A` | labels, captions, secondary |
| primary | `#8CACFF` | links, accents, the one emphatic colour |
| success | `#8CE8B0` | healthy / passed |
| warning | `#FFD37A` | degraded / needs attention |
| error | `#FF716C` | failed / critical |

Semantic colours (success / warning / error) are separate from the accent and do
not count as a second accent. Spend boldness in one place and keep the rest
quiet.

## Type

`JetBrains Mono` for everything — it is the product's voice, and the font is
already loaded on the artifact host. Set a scale and stay on it: one display
size, one heading, one body, one caption. Give headings
`text-wrap: balance`, keep running text near 65–75 characters wide, and letter-space
uppercase labels slightly (`0.08em`). Use `font-variant-numeric: tabular-nums`
anywhere digits line up in a column.

## Layout

- Lay out sibling groups with flex or grid and `gap` — not per-element margins,
  which collapse and double in ways that are hard to see.
- Wide content (tables, code, diagrams) goes in its own
  `overflow-x: auto` container so the page body never scrolls sideways.
- Relative units and `max-width: 100%` on media. Assume the page will be opened
  on a phone.
- Give the page a real `max-width` (roughly `60rem` for a report) and centre it.
  Full-bleed text at 1920px is unreadable.

## Rules the host enforces

- **Self-contained.** No CDN scripts, no external stylesheets, no remote images.
  Inline the CSS and JS; embed images as `data:` URIs. Interactive pages are
  fine — inline `<script>` and `onclick` handlers are compiled into a CSP-pinned
  bundle. A `<script src>` pointing anywhere else is dropped.
- **Structure means something.** Numbered markers, eyebrows and dividers should
  encode something true — a real sequence, a real severity order. Numbering a
  list that has no order is decoration.
- **Write from the reader's side.** Name things the way a person would say them,
  not the way the system stores them. Active voice. Specific beats clever.

## What to avoid

Generic AI-page defaults: warm cream with a serif display and a terracotta
accent; a purple-to-blue gradient hero; emoji as section markers; everything
centred; a giant hero on a page that is really a document. If the user pinned a
direction, follow it exactly — their words win over everything here.
