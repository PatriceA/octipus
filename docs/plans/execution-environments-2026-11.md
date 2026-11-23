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

## Egress policy and per-worker isolation (2026-11-23)

### What existed before this change

Checked against the code, not the roadmap entry ("shell/code tools run in the
same process", "no declarative allow/deny"), which was partly stale:

- Shell commands do **not** run in the server process. Each one is its own
  child process in its own process group (`detached`, killed as a tree on
  deadline or cancel), and under `security.shellSandbox` `auto`/`required` its
  own bwrap or firejail instance (new pid, ipc, uts and network namespaces,
  read-only OS, a per-spawn `/tmp`, the workspace writable) or sandbox-exec
  profile on macOS. The isolated execution environment requires that sandbox.
- `codemode` scripts run in QuickJS/WebAssembly on a worker thread with no
  network or filesystem; they reach only tools, through the normal pipeline.
- A per-host egress proxy existed, but only for plugin package servers (their
  manifest `network` list), not for shell commands: `network: true` gave a
  sandboxed command the whole host network.
- Web fetches were SSRF-guarded (private/metadata addresses, every redirect
  hop, IP pinning) but nothing let an operator say which public hosts a tool
  may reach.

### Delivered

`security.egressPolicy` and one engine (src/security/egress-policy.ts): rules
by host, address range, port and scheme, globally, per tool and per role,
deny wins, evaluated on canonical host names and on the pinned addresses.
Used by `fetchGuarded`, the browser/websearch page tools, the plugin package
proxy and a new per-command shell proxy that replaces direct network for a
sandboxed command; where no sandbox confines the shell it is advisory and
`GET /api/settings/egress` says so (`requireEnforcement` refuses instead).
Refusals are logged and audited. Reference: [EGRESS-POLICY.md](../EGRESS-POLICY.md).

### Per-worker isolation: what remains

The plan above names no concrete per-worker step, and the roadmap item
("WASI / lightweight VM isolation per worker, mounted as a provider behind the
waterfall") is a multi-week change. It was not started half-way. What it
needs, in order:

1. **Resource limits per command.** Nothing bounds a sandboxed command's
   memory, CPU or process count today (only its wall-clock deadline). Add
   them at the sandbox boundary: `prlimit`-style rlimits (`RLIMIT_AS`,
   `RLIMIT_NPROC`, `RLIMIT_CPU`) applied by the launcher inside the sandbox,
   and, where a delegated cgroup v2 subtree exists (systemd user slice),
   `memory.max` / `pids.max` per command. Needs: a config shape per execution
   environment, detection of cgroup delegation, and an e2e test like
   shell-sandbox.linux.e2e.test.ts that proves a fork bomb and a memory hog
   are stopped.
2. **One sandbox identity per worker, not per command.** Each command is a
   fresh sandbox; a worker's commands share only the workspace and (spaces)
   the run's tool home. A per-worker scratch home and a per-worker egress
   proxy (one proxy for the worker's lifetime instead of one per command)
   would let audit rows and limits be attributed per worker and keep state
   between a worker's commands without touching the workspace. Needs a
   lifecycle hook at worker start/stop (src/core/agent-worker.ts) and cleanup
   on crash.
3. **In-process tools.** Web fetch, the shared headless Chromium, file tools
   and MCP clients still run inside the server process. The browser could run
   in its own sandboxed process with its network through the same egress
   proxy (which would also close the "sub-resources are not judged" gap in
   EGRESS-POLICY.md); file tools are already confined by `WorkspaceFS`.
4. **A VM/WASI execution provider** behind the dispatch waterfall, as the
   roadmap describes, for hosts where bwrap is unavailable (default Docker
   seccomp, Windows). This is the multi-week part: a provider interface, an
   image, workspace sync and the same e2e matrix.
