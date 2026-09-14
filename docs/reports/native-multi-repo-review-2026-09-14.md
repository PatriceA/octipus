# Native multi-repository review — 2026-09-14

## Outcome

Octipus's built-in repository registry, declared dependency graph and symbol
navigation remain usable without CocoIndex Code or a configured embedding
provider. CocoIndex Code is an optional semantic-search connector, not a
replacement for this native functionality.

## Corrections

- Exposed `repo_registry` to General/root as a core tool, matching its suite
  instructions. Bounded the injected ambiguity summary and corrected snapshot
  and dependency-impact wording.
- Canonicalized discovery roots, deduplicated overlapping paths, constrained
  child symlinks, skipped generated directories and recognized Git worktrees.
- Improved manifest parsing, package aliases and Python normalization; added
  Dart/Flutter `pubspec.yaml`. Duplicate package providers no longer generate
  arbitrary edges. Repository-name collisions require an ID or absolute path.
- Made symbol enumeration respect Git ignores and filesystem boundaries;
  bounded reads and reported incomplete indexes. Corrected several declaration
  and export extraction cases. Empty diagnostic results survive persistence.
- Limited registry reads and repository knowledge searches to currently
  available repositories owned by the caller. Explicit unknown search filters
  fail clearly. Deleted/missing guides are removed on rescan; deregistration
  transactionally deletes associated embeddings before the registry row.
- Updated MULTI-REPO.md and RAG.md to explain capabilities and limits.

## Evidence

Independent agents reviewed repository discovery/manifests/graph, symbol
indexing, and the combined service/tool/API changes. Their actionable findings
were corrected and re-reviewed.

Regression coverage includes actual temporary repositories and PGlite:
scan/upsert, cross-repository dependencies, symbol lookup, rescans, ownership,
revoked paths, duplicate names/packages, guide cleanup, API responses, and
vector/keyword/hybrid visibility filtering. The symbol bundle check loads all
eight shipped grammar variants in Node. A read-only scan of the local repository
suite recognized mobile-octipus as a Dart product with 31 declared dependencies.

The routing evaluation was attempted in unit mode: six cases passed and six
specialist-routing cases were rejected by the harness because they require a
running-backend integration evaluation. This is not evidence of live model
selection or tool-use success. No live agent task was dispatched by this review.

## Deliberate limits

The graph contains direct manifest dependencies, not inferred API calls or a
complete impact analysis. Each repository stores one published package identity.
Symbols are snapshots; rescanning refreshes them. Native grammars cover
JavaScript/JSX, TypeScript/TSX, Python, Go, Rust and Java; Dart manifests are parsed,
but Dart symbols are not indexed. Git is needed for symbol file enumeration.
General file search/read/edit tools remain available for other languages.

This review tightened repository artifact search visibility. It did not redesign
access policy for all knowledge-base listing/read endpoints or other non-repository
content. Historical registry snapshots remain stored when paths disappear.

## Final validation

- Full suite: **5,783 passed, 168 skipped, 3 failed** (507 files).
- The three failures are existing TUI expectations in `chat.e2e.test.ts` and
  `selection.e2e.test.ts`: they expect mouse capture enabled at startup, while
  the current runtime intentionally leaves it disabled for native selection.
  Those unrelated files were not changed by this review.
- Final targeted API/registry/embedding visibility run: **22 passed**.
- TypeScript, lint, production build and architecture catalog generation passed.
- The full suite therefore is **not green**; live model tool use remains untested.
