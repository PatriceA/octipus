# Shared execution environments — implementation record

Baseline: `origin/main` pulled to `d4ec31ab` on 2026-11-08. Work branch:
`feat/execution-environments`.

## What main already provided

Main includes signed plugins, macOS process sandbox support, approved CLI/runtime
mounts, build caches, owner approval/recovery records and run permission profiles.
Those changes improve individual runners and security boundaries. It did not yet
provide one user-facing machine/account/access selection shared by project tools,
workers and verification gates. The implementation reuses those existing runners
and approval records rather than adding a parallel permission system.

## Delivered

- Central validated owner/workspace profiles with persistent revisions, project
  matching, session pinning, child/resume inheritance and revocation.
- Trusted OS account execution, mandatory isolated execution with a stable tool
  home, and SSH execution using the remote account. No silent sandbox fallback.
- Shared routing for shell, files, Git and GitHub CLI. Remote file browsing,
  versioned editing, Git Changes and pipeline snapshots measure the remote tree.
  Uploaded documents remain owner-local; project file attachments use their
  selected runtime's reader.
- Interactive/background approval choices without individual command lists.
  Explicit denials and shared/federated-space policy remain authoritative.
  Data-transfer consent is checked in command verification gates too.
- Settings and session UI, target labels on tools, account/runtime readiness,
  secret bindings, and explicit project remapping when changing machines.
- Per-environment prompt context is appended after the existing stable prefix,
  preserving install prompt caching and vendor CLI conversation fingerprints.
- Compatibility checks prevent native CLI models from escaping isolation or
  unexpectedly running on the wrong host. They currently require trusted host
  identity. Local worktrees are skipped when outside the selected folder grant.

## Validation and review

The affected security, shell, Git/GitHub, pipeline, scorer, filesystem, session and
settings suites passed (1,525 tests; 9 platform/integration skips in the broad run).
Focused remote-program tests compare snapshots with local snapshot behavior and
exercise Git diffs, versioned writes and symlink-alias locking without a remote
service. Production-artifact acceptance exercises real HTTP, storage, shell/file/
Git parity, automatic approval, explicit denial, active-worker revocation and
restart persistence. Browser tests cover setup, readiness, revocation, mapping,
project preservation and tool target labels. Backend/web type checks, lint and
catalog checks pass.

Independent backend/security and UI/API reviews found issues which were repaired
and rechecked. Real external SSH authentication and device/service acceptance are
not claimed by these fixture-based tests. The owner can test those from the new
readiness UI. Existing live pipelines/configuration are not changed by the code
implementation itself.

User guide: [Environments and access](../EXECUTION_ENVIRONMENTS.md).
