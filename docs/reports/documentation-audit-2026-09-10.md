# Documentation audit — 2026-09-10

## Scope and method

The repository began with 146 tracked Markdown files. This audit covered all
113 documentation files; the other 33 are runtime agent-role and delegation
prompts under `src/core/agent/` and were intentionally excluded. No tracked
`SKILL.md` files were present. The 113 include 112 handwritten documentation
files plus the generated architecture catalog, which was checked for freshness
but not manually edited. This audit added two documentation files, bringing the
checked result to 115. Vendored files were excluded. Three delegated reviews split the work into public and contributor
docs, current technical docs, and historical material. Claims
were checked against source, package scripts, generated inventory, CLI behavior,
or the recorded CI result where applicable. Historical plans and postmortems
were kept as historical records and labelled when their behavior or commands no
longer describe the current product.

This was a documentation audit, not a new runtime acceptance test or a live
provider evaluation. A statement that a code path exists does not establish its
quality under every model, provider, channel, or deployment.

## Public and contributor documentation

Covered the eight root Markdown files (`README.md`, `DESIGN.md`,
`CONTRIBUTING.md`, `AGENT.md`, `SECURITY.md`, `ROADMAP.md`, `CHANGELOG.md`, and
`CODE_OF_CONDUCT.md`), `docs/README.md`, `plugin-sdk/README.md`, all other
component README files outside `docs/`, and `scripts/*.md`.

Corrections included:

- Updated the README and roadmap after consolidation phases 1–4 landed on
  `main`, and removed already-shipped tool/channel discovery from the outlook.
- Checked release and inventory claims against source: tag `v0.2`, Node engine
  `>=24.9.0`, 16 role folders, 18 seeded expert definitions, 22 seeded skills,
  and 88 standalone MCP tools in 26 registration groups.
- Corrected manual-clone commands to use repository entry points, distinguished
  the standalone MCP tool count from built-in tool groups, and removed an
  inaccurate in-memory component from the embedded architecture summary.
- Reworded hard-budget, automatic-learning, and guaranteed-citation language to
  match what the implementation and current validation establish.
- Added the `mcp-server/README.md` that its package manifest expected, including
  build, stdio authentication, and the limits of the experimental HTTP path.
- Replaced a nonexistent security-report email reference and softened response
  targets; made conduct-reporting guidance private; replaced a stale closed
  list of direct database callers; and updated the audit allowlist guide from
  Bun to npm.
- Marked the old unattended auto-approval changelog entry as superseded by the
  current fail-closed behavior.

## Current technical documentation

Covered 43 direct `docs/*.md` files other than the index, five handwritten
architecture and guide documents, and the artifact toolbox design guide: 49
handwritten files in this technical scope. Corrections included:

- Reconciled roughly 50 obsolete API route entries with the generated catalog,
  documented cookie login versus mobile/API-token authentication, and narrowed
  `/v1` compatibility, model-name, streaming, and usage claims.
- Updated permission docs for fail-closed unattended `ASK`, scoped grants, and
  the canonical MCP identity; clarified that receipts record evidence rather
  than certify an outcome.
- Corrected web-port and embedded-storage configuration, actual swarm setting
  names, current `run_events` and restart behavior, scorer retries and `any_of`,
  and current Node CLI, TUI test, plugin-context, and channel-discovery paths.
- Repaired the master-key rotation procedure and documented its active-row and
  partial-error limits; fixed Compose environment interpolation and made Docker
  socket access explicitly opt-in.
- Removed unsupported browser-extension CAPTCHA/master-key statements, corrected
  OCR routing and fallback behavior, and removed an untraceable competitor
  matrix and unsupported OpenClaw superiority conclusions.
- Corrected the artifact design guide: the host uses local system font stacks,
  and its palette is web-derived rather than proven shared with TUI or mobile.

The review did not execute live vendor, voice-device, provider, recovery, or key
rotation procedures. Historical QA, multi-user, changelog, and external-product
inventory sections are identified as records where appropriate.

## Historical plans, reports, and archives

Covered all 52 tracked Markdown files under `.octipus/**`, `docs/plans/**`,
`docs/reports/**`, `docs/postmortems/**`, and `docs/superpowers/**`. Thirty-two
files received edits.

The consolidation plan and report now identify phases 1–4 as shipped on `main`
at `93296268`, with all eight workflows green, without implying a deployment or
release. Older archive designs, audits, QA notes, Bun-era plans, pre-rebuild
swarm/orchestrator material, voice follow-ups, a performance report, an incident
postmortem, and the obsolete Atlassian plan now carry historical boundaries and
current-source pointers. Dated facts were retained rather than rewritten as if
they happened under today's architecture.

Historical tasks were not reclassified one by one as current backlog. Their
banners require re-verification before implementation.

## Verification

Static checks covered all documentation files for local Markdown file links and
balanced fenced code blocks. The generated catalog matched source, including
295 HTTP table rows. `npm run typecheck` passed. `npm run lint` passed over 969
files with one informational warning that `biome.json` names schema 2.5.9 while
the installed CLI is 2.5.12. `git diff --check` passed.

The first sandboxed full-test run reported 15 environment-related failures:
nested Git and shell execution were denied, a localhost listener was denied,
and the source-scanning settings test could not spawn its search process. The
required unrestricted rerun passed: 452 test files passed, 13 were skipped;
5,342 tests passed and 166 were skipped.
