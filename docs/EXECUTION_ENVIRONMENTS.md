# Environments and access

Open **Settings → Environments & Access**. An environment chooses where project
commands run, which account supplies CLI authentication, which folders file tools
can reach, and how approval works. It applies to a session, its workers, pipeline
verification commands and Companion background work. It is stored in Octipus
settings; editing a hidden configuration file is unnecessary.

Existing installations keep their previous behavior until the owner explicitly
adds/selects an environment. Nothing is automatically granted by this update. Existing environments retain tool-specific authority until their owner changes it.

## Workstation automation and multi-machine projects

Use **Set up workstation automation** for work that should have the same access as
your workstation account. This grants commands and filesystem access as a whole,
including installed `gh`, `oc`, `tea`, Git helpers, existing CLI configuration,
SSH agents and SSH host aliases. New commands on PATH need no registration.
Additional program folders can be added once; they apply to shell, native CLI
agents and verification. Readiness shows a searchable inventory from the actual
runtime. Discovery is advisory, not another list of approved binaries.

Account authority includes the OS account's files outside starting folders,
administrative/destructive operations and normal Compose lifecycle management
with existing projects, inline builds and env files. Project folders choose the
starting location and automatic environment matching; they do not limit this
broad grant. OS authentication and permissions remain real requirements.

One workstation environment can build locally, deploy via SSH to several machines,
and verify remote services. Do not switch the entire session to each deployment
host. Choose a remote environment only when the project's commands/files should
actually live on that host. A browser on your laptop does not make an Octipus
server elsewhere your laptop account.

The preset enables automatic interactive/background operations, network/private
data transfer and **routine pipeline sign-offs and recovery**. These are live,
revocable environment grants, not lists of individual commands. Recovery still
checks previous effects before replay; a grant is not evidence an action failed.
Explicit user pauses, budgets, acceptance criteria, deliberate Deny rules and
shared/federated boundaries remain effective. Default tool restrictions can be
replaced by account authority; deliberately saved Deny rules cannot. Missing SSH
keys, unauthenticated kubeconfig or a stopped service are runtime problems rather
than requests for repeated approval.

For existing projects, edit their currently selected environment to use full
account access and automatic work, or select the new environment in each project
chat. A new preset does not rebind sessions. Identical folder matches need an
explicit selection. Saving changes to a used profile stops affected active agents;
resume them after saving. Disabling a profile revokes its authority.

In isolated mode, **Use installed workstation programs as a group** exposes program
folders read-only without inheriting private configuration. Complex toolchains may
still need their runtime dependencies or explicit credentials; test readiness in
that environment. Trusted workstation mode avoids these isolation differences.

## Choose where work runs

| Environment | Tools and account | Isolation |
|---|---|---|
| This computer | The machine running the Octipus server, using its OS account. Opt into its existing CLI logins to use normal `gh`, `oc`, SSH and Git configuration. | Opt-in full account access, or tool restrictions with approved file folders. Host processes are not sandboxed. |
| Isolated workspace | Installed/approved runtimes, selected folders, a separate persistent tool home and explicitly connected credentials. | Requires the supported process sandbox. Missing isolation fails instead of falling back to the host. |
| Remote machine | SSH account on the chosen server, with that server's installed tools and CLI logins. Commands, filesystem and Git target that machine. | Trusted remote account authority. Node.js is required remotely. SSH uses the server account's keys/agent and existing known-host trust. |

The host/remote network checkbox is consent policy, not network confinement. Only
isolated mode enforces network isolation. OS permissions still apply. Host service
access exposes Docker and USB/ADB; Docker's socket carries the daemon account's
power. In trusted host mode that explicit grant also permits lifecycle management
of existing host containers through dedicated Docker tools. Unsupported Compose
features can be handled through an authorized shell in the same environment.
A deliberate saved permission denial cannot be bypassed by changing tools.

CLI-backed models have native vendor tools, so they currently require **This
computer with host account access**. API/local models can use all three environment
types. Octipus rejects an incompatible model/environment pair before starting it.

## Configure once, then reuse

1. Add an environment, give it a recognizable name and select project folders.
   Subfolders are included. The most specific matching project folder wins; an
   ambiguous match asks for explicit selection instead of guessing a machine.
2. Choose interactive/background approval. Set it as the account default if
   appropriate. A session also has a **Runs on** selector showing the account and
   machine. Switching preserves a compatible project folder. When the folder cannot
   exist in the new environment, choose its path on the selected machine.
3. Use **Test readiness**. It checks the actual runtime, configured credentials,
   folder writes and optional GitHub CLI authentication. The optional runtime
   command can check `oc whoami`, `adb devices -l` or another installed CLI.
   A successful API connection does not prove CLI authentication.
4. Disable access to revoke it. Bound workers stop when a profile changes and
   new calls re-read its policy. A removed/disabled pinned profile produces an
   error rather than quietly using another runtime.

A containerized/service installation sees its own account and mounted folders,
not automatically the desktop browser user's files or credentials. Readiness
reports the actual account. SSH trust, OS access and missing executables must be
configured in that runtime; Octipus does not copy private keys from chat.

## Approvals without command lists

Interactive and background policies are separate:

- **Ask** uses the owner's existing approval inbox. Background work can raise a
  durable owner request instead of failing because nobody is attached to its run.
- **Automatic** approves available tool operations in this environment across
  turns, including commands first encountered later in a pipeline. It grants
  side effects; it does not require a list of individual command strings.
- **Read only** blocks background changes.

Stored explicit **DENY**, shared-space membership/role rules and remote-member
boundaries remain authoritative. Automatically sending private/credential-tainted
data also requires the environment's network and data-transfer consent. Historical
refusals describe an earlier attempt, not the newly saved policy.

## Credentials

Trusted host mode can use ordinary OS account CLI logins. API integrations remain
separate connections; a GitHub API token is not automatically a `gh`/Git login.
For other runtimes, select encrypted secrets and the variable names their CLI
expects in **Connected credentials**. Values are injected only when executing and
masked in returned output/errors. In Secrets, **Allow runtime** adds the execution
environment consumer to a restricted secret without removing other restrictions.
Per-agent restricted credentials cannot be reused as a general environment binding.

A managed tool home persists across turns. CLI configuration created there is
reused; Git can use credential helpers configured there (for example `gh auth
setup-git`). Network access, account authorization and a reachable service are
separate prerequisites. Readiness deliberately does not label them all "permission
denied" or claim that another machine's login is available.

## Remote limitations

Remote commands, basic file operations, file viewing/editing and Git use the SSH
account. Uploaded chat attachments remain in the owner's Octipus storage; an
upload is not an implicit remote transfer. Local API integrations keep their
configured service target. Snapshots used by pipeline and child acceptance are measured on the remote host.
Vendor-native CLI workers and local worktree isolation are not supported remotely;
choose an API/local model, or use a trusted host environment with authorized SSH
commands for deployments driven by a vendor CLI.

In restricted mode, optional local worktree isolation is skipped when its internal
worktree directory is outside the selected environment’s approved folders. The worker, registered
tools and verification commands then stay together in the approved project.
