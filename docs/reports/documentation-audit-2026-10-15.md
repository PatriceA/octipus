# Documentation audit — 2026-10-15

## Scope and evidence

Three smaller-model reviewers checked setup/provider, execution/architecture,
and feature documentation against the current working tree. The review covered
commands and defaults, role/model resolution, tool registration, recovery,
permissions, channels, voice, artifacts, MCP, profiles, and contributor setup.
It was a source-based review, not a live-provider feature certification.
Historical comparisons, release notes, proposals, and postmortems remain records
of their original context. Existing in-progress code and documentation changes
were preserved.

Corrections include removed Expert commands and model preferences, lane/role
resolution, explicit CLI backup behavior, Node 24.19.0 requirements, build steps,
static MCP registration, API port aliases, Docker environment files, voice
engines/signature handling, MCP transports, profile endpoints, artifact vault
resolution, and the three Vitest projects.

## Website alignment

The website source is `/home/patrice/docker-services/octipus-website`.
`scripts/website-docs-map.json` maps 62 canonical reference pages to website URLs.
`sync-website-docs.mjs` publishes Markdown, converts relative links, replaces
old MDX copies, and supports a non-mutating `--check`. Existing website routes
remain available. Missing guides now cover spaces, tasks, work plans, artifacts,
inline UI, budgets, recovery, and other features.

Website-only quick-start, runtime, root-agent, pipeline, security, tools, and
web UI pages were reviewed separately. They still require manual maintenance.
The landing-page identity/design was left for the subsequent brainstorming.
The website directory is not a Git checkout; a pre-edit source/config snapshot
was saved at `/tmp/octipus-doc-audit/`. That temporary copy is not a durable backup.

## Validation

- TypeScript, lint, architecture catalog, and whitespace checks passed.
- Two publisher tests passed, covering link conversion, code fences, stale MDX
  removal, and non-mutating drift detection.
- Shared-page sync check: 62 pages, zero drift.
- Website build: 72 pages; internal documentation route/anchor check found no
  broken links. Mapped source pages also have no missing relative file links.
- Browser checks covered documentation, routing, artifacts, API reference,
  spaces, work plans, and mobile navigation.
- Website container was updated independently of other services; public
  `/docs/features/work-plans/` returned HTTP 200.

Full backend suite: **8,438 passed, 214 skipped**, exit code 0 (469 seconds).
Skipped cases are not verified; external integration and live-provider checks
were not run as part of this documentation pass.
