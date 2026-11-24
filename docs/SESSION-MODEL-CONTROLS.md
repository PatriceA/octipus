# Session model controls

In a session, open **Activity & settings → connection & model**. Running agents
show their own underlying model and CLI adapter separately. When no run is active,
the latest run is shown. An old record containing only `cli/codex` is an adapter
identity, not a model: the panel says the CLI default was not reported instead of
inventing a model. New Codex runs can read model/effort from the linked session log;
Claude-compatible CLIs report their model in initialization and assistant events.

Expand **Models for this session**:

1. Find the topic and registered CLI configuration (for example Build / Codex).
2. Choose **All agents on this topic** or a role such as Coding, Review or QA.
3. Choose/enter a CLI model identifier and, where supported, reasoning effort.
   Available catalogs come from the CLI's existing discovery mechanism; Codex
   uses its account model cache. There is no hardcoded model catalog.
4. Save. Reset to defaults removes that scope's override.

A role-specific effort inherits a topic-wide model choice. Blank fields inherit
the configured default. Role scope covers subsequent runs of that role, not just
one old agent ID. The session's latest 100 runs identify custom roles and explicit
pipeline configurations as well as normal topic bindings.

## When it takes effect

Saving never stops or changes an executing subprocess. The next CLI launch reads
the saved settings, including a subsequent pipeline stage, child or continuation.
Model or effort changes invalidate the existing vendor-session fingerprint: the
new launch gets a fresh CLI context and the applicable saved Octipus conversation
or stage brief. Hidden vendor history, reasoning and cache cannot be transferred.
Work already committed and saved pipeline progress are not discarded. Saving does
not itself resume a pipeline.

Other sessions and global topic/model configuration are unchanged. Overrides
persist in session settings across reloads, restarts and conversation clearing.
Concurrent stale edits are rejected; refresh before saving them again.

## Capabilities and permissions

- These controls change the underlying model within its existing CLI/account.
  They do not replace global provider routing or edit `/model` root selection.
- Codex, Claude-compatible adapters, Muse and Antigravity translate reasoning
  effort to their typed CLI controls. Availability still depends on the installed
  CLI, selected model and account. Unsupported CLI effort options are not offered.
- Mistral Vibe's current managed adapter does not support a per-run model switch;
  use its runtime profile. Its model field is not offered as a working override.
- Live catalog discovery for a personal CLI row is unavailable here; enter its
  model identifier. Octipus never borrows install credentials for that lookup.
- Companion's fixed supervisor/maintenance model remains in Companion settings.
- Personal session ownership and Chat API scope are required to save. Shared-room
  model controls are not exposed through this personal inspector. Existing model,
  account, content-protection, tool-permission and spending checks still apply.
  These settings grant no tools, credentials or permission to run commands.

The [Context inspector](CONTEXT-INSPECTOR.md) separately shows what each agent
read. A full run's token spend is not the current context size.

### Picking a CLI model

The session editor and Models page share a catalog dropdown. Choose a named
model or keep **Use configured default**, which shows the inherited model.
Existing saved IDs remain visible if the vendor catalog no longer lists them.
**Enter a custom model ID…** opens a separate field only when needed. A failed
session catalog request offers **Retry catalog** and does not erase your choice.
