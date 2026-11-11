# Windows native plugin sandbox

`octipus-sandbox.exe` is the native boundary for package plugins on Windows
10/11. It is independent of agent shell environments. In Administration →
Plugin packages the active runner is shown as `appcontainer`.

## Install and build

The PowerShell installer downloads the helper and SHA-256 checksum for an
exact release tag. It never mixes a source checkout with the latest release's
helper. Source checkouts require Rust (`rustup`, MSVC host toolchain) and Visual
Studio C++ Build Tools, then:

```powershell
npm run build:sandbox:windows
```

The result is `native/bin/octipus-sandbox.exe`. The backend only detects this
application-owned location; it never searches PATH for its security boundary.
Restart Octipus after installing a helper (detection is cached). No elevation,
Windows service, WSL or Docker is needed at runtime. Build on the native Windows
architecture; release assets currently target x64.

## What is enforced

- A less-privileged AppContainer (LPAC) has no networking capabilities, no host
  process handles and no broad ALL APPLICATION PACKAGES file entitlement.
  The non-network `registryRead` capability allows Windows' socket library to
  initialize its OS protocol catalog; it grants no internet or LAN access.
- The package tree is readable/executable. Only the dedicated package data and
  per-launch scratch trees and Windows-managed private profile are writable. Host home, credentials and unrelated
  project folders are not granted. Junctions/reparse points are refused.
- A private copy of the runtime executable runs in scratch. The installed Node
  under Program Files is not modified. Node is supported; other native runtimes
  must carry their dependencies themselves. `.bat`/`.cmd` shims are refused.
- A job limits committed memory to 2 GiB and active processes to 32. The child
  starts suspended, joins the job, then runs. Closing/killing the helper closes
  the non-inherited job handle and terminates every descendant.
- For declared network/host scopes, a SID-protected local named pipe carries
  traffic to Octipus's existing per-package proxy. The Node bridge runs inside
  the AppContainer. It does not add an internet capability or a host loopback
  exemption; arbitrary localhost services remain inaccessible. The existing
  proxy still enforces declared hosts, private-address rejection and host API
  stamping. A Node preload adapts connections aimed at HTTP(S)_PROXY to the
  pipe without opening a TCP listener. It is a compatibility adapter; removing
  it cannot grant network access. Native runtimes may use OCTIPUS_EGRESS_PIPE
  directly; automatic HTTP proxy adaptation currently supports Node only.
  Missing isolation means refusal, never a sandboxed status badge.

## Persistent folder permissions

Provisioning changes ACLs only on the dedicated package/data trees and private
runtime scratch. Data trees are intentionally low integrity so an AppContainer
can write there. These are persistent plugin storage permissions, not temporary
host permissions that depend on a destructor restoring them after a crash.
Do not use a general workspace or home directory as plugin data.

Provisioning is serialized with a user/SYSTEM-only named mutex. Profile identity
includes the entire persistent resource set, runtime bytes and an authority
fingerprint of the supplied child environment (including secrets) and declared
egress/host API configuration. A changed authority uses a different SID; only
launches with identical authority share an identity and the same data. Secrets
are hashed for identity, never placed in profile names or launch records.
Profiles/ACEs remain provisioned after stop; disabling a plugin stops its job and
prevents launch. Old provisioned identities do not execute and have no process
remaining after job termination. Uninstall removes package/data files as usual;
Windows profile records are small and remain until the OS account is removed.

The host/server OS account is trusted, as on other platforms. Administrators can
change ACLs or disable isolation; the helper does not defend against the host
administrator. Kernel/AppContainer isolation is required; no alternate Windows
shell sandbox is implied.

## Tests and release artifacts

`Windows plugin sandbox` CI builds the helper, tests its protocol/argument
quoting, and executes real AppContainer filesystem and network probes, concurrent
launches, forced termination and restart. A descendant is either denied by
AppContainer or must die with the job. The
release workflow gates the Windows binary on the same real isolation tests,
then attaches the binary and checksum to the matching GitHub Release. Linux
cross-target checking verifies the Windows API bindings compile but is not a
substitute for that Windows execution lane.

```powershell
cargo test --locked --manifest-path native/windows-sandbox/Cargo.toml
npx vitest run --project unit src/security/windows-plugin-sandbox.test.ts src/security/shell-sandbox.windows.e2e.test.ts
```
