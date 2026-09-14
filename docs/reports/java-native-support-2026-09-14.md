# Java native repository support — 2026-09-14

Java now has all three native navigation layers: repository discovery,
manifest-derived package/dependency matching, and definition lookup. These
features work without CocoIndex Code.

## Added

- Maven `pom.xml` parsing with structural XML validation, `groupId:artifactId`
  identities, declared parent group fallback and bounded local properties.
  Only direct project dependencies produce edges; dependency management,
  build-plugin and profile declarations are not treated as active application
  dependencies.
- Static `build.gradle` / `build.gradle.kts` parsing with local settings and
  properties. Unsupported expressions remain outside the inferred graph.
- Repository-map commands for Maven/Gradle, wrapper preference, Java source/test
  entry directories and visible static-analysis notes.
- More complete Java symbols: compact record constructors, annotation elements,
  enum members and nested types, and accurate interface visibility.
- A direct declaration of the already installed XML parser dependency; no new
  parser version or build-tool execution was introduced.

## Boundaries

This is static repository analysis, not a Maven or Gradle evaluator. It does not
resolve complete module graphs, execute convention plugins, load external parent
POMs, activate profiles, or synthesize compiler-generated Java members. Agents can
inspect files or run build tools through normal tools when needed; a suitable JDK
and project build environment are still required for compilation and tests.

See [Multi-repo workspaces](../MULTI-REPO.md#java-repositories) for supported formats
and [language coverage](../MULTI-REPO.md#language-coverage).

## Validation

- Final full suite: **5,816 passed, 168 skipped, zero failures** (495 passing
  files; 14 skipped). This includes the corrected TUI tests and final Java code.

- Focused native repository/parser/symbol tests passed; additional parser
  hardening regressions passed before the final full-suite run.
- TypeScript, lint, production build and catalog generation passed.
- Early parser failures were corrected and re-reviewed. The three TUI failures
  were outdated startup expectations: native selection is intentionally enabled
  by leaving mouse capture off. Updated tests cover explicit capture toggling,
  wheel/keyboard history, clipboard contents, resize and draft preservation in
  chat/editor. All five targeted real-terminal tests passed; runtime unchanged.
- Independent review covered scanner wiring, Java symbols, parser correctness
  and bounded performance, plus the TUI test changes. No remaining blockers.

No live agent task or actual Maven/Gradle build was run; fixtures verify static
analysis and persistence without executing repository build scripts.
