# Temporary execution storage

Local host commands and CLI agent invocations receive private scratch storage
automatically. No setting or agent-written teardown is required. `TMPDIR`, `TMP`
and `TEMP` point to a fresh directory, so ordinary runtime APIs such as Node's
`os.tmpdir()` create test databases there instead of leaving them in shared
host `/tmp`. These environment variables are managed by Octipus at launch.

Scratch is removed after the command or CLI invocation exits, including errors,
timeouts and cancellation. Background jobs keep their scratch while running.
On POSIX systems, native descendants in the same process group also keep it
alive. Cleanup retries every minute after allocation, and checks abandoned
directories at startup. Ownership records and live processes are checked before
deletion; uncertain ownership or an unconfirmed launch is retained for inspection.
On Windows, liveness tracking covers the direct child process.

Only Octipus-created execution roots under the OS temporary directory's
`octipus-owned-temp-<user-id>` folder are eligible. Cleanup never sweeps other
temporary folders by filename or age, and never follows scratch symlinks into
project data. Existing sandbox runners retain their isolated scratch lifecycle.

Save deliverables, reusable environments and files needed by later commands in
the workspace, not temporary storage. CLI session reuse does not preserve scratch
from earlier invocations. Persistent services should use the background-job
tool and keep their durable data in a project directory.

This does not clean historical unowned `/tmp` files, hardcoded absolute paths,
programs that override the supplied temporary variables, remote SSH hosts,
container filesystems, or independently detached daemon process groups. Those
need their own application lifecycle cleanup. This controls lifetime rather
than the size of temporary data while an execution is still active.


Octipus's own Vitest suites also own scratch per test file. Each file cleans
its fixtures after teardown, while the session and other test files may keep
running. Only the migrated database template is shared until run teardown.
See [Testing](TESTING.md#temporary-fixture-lifetime).
