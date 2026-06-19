# W8 — Capability Model: one provider contract, connectors-as-primary

**Status:** Design memo (W8 design-gate). Approve before any `refactor/capability-model` code.
**Created:** 2026-06-19
**Source:** `.octipus/plans/goose-inspired-enhancements.md` §W8. Facts verified against the
tree at the file:line citations below.
**Decision (2026-06-19, baked in plan):** connectors/MCP are the **primary** extension
model (Goose-style); built-in tools are reserved for **core** only. GitHub stays a
built-in core tool (move its auth to a per-user vault token later); the unused
`extensions/github` plugin is deleted (done — PR #133).

---

## 1. The problem — five paths, three gating behaviours

Octipus has **five** ways to add an agent capability, each with its own loader, and
**three** different role-gating behaviours. That sprawl is why capabilities feel
"hardwired in several places."

| Path | Loader entry | Role gating today |
|------|--------------|-------------------|
| Built-in tools | `src/tools/discovery.ts` (`discoverTools()`), registered `src/tools/index.ts:41` | `toolId` in role `toolIds` (code config) |
| Plugins | `src/plugins/loader.ts:14` (scans `extensions/<name>`) | `plugin-<name>` in `toolIds` (code config) |
| MCP | `src/mcp/bridge.ts:34` (config file or DB) | all-or-nothing — single `'mcp'` entry in `toolIds` → lazy meta-tools (`roles.ts:129-138`) |
| Connectors | `src/connectors/registry.ts:18` (per-user OAuth) | **bypass roles entirely** — pushed after gating (`worker-spawner.ts:278-282`), OAuth-presence gated |
| Extensions | `src/extensions/loader.ts:35` (`~/.octipus/extensions`, `.octipus/extensions`) | not tools — gateway commands, no role gating |

**Tool resolution for a spawned worker** (the hot path):
`spawnWorker()` (`worker-spawner.ts:276`) → `getToolsForRole(role)` (`roles.ts:113-141`):
1. `config.toolIds` → filter against the capability snapshot (uninstalled tools dropped + warn, `roles.ts:118-127`).
2. Split: builtin ids (`!== 'mcp'`) → `registry.getToolHandlersForTools()`; if `'mcp'` present → append lazy MCP meta-tools.
3. **Then** in `spawnWorker`, connector tool handlers are pushed on top, per `userId`, **outside** `getToolsForRole` — bypassing role gating (`worker-spawner.ts:278-282`).

---

## 2. Correction to the plan's premise (verified)

The plan says DB `roles.toolIds` "exists but is unused." **Not quite** — important for W7:

- `src/db/schema/roles.ts:6` — `toolIds: jsonb('tool_ids').$type<string[]>()` exists.
- `src/db/seed-roles.ts:11-22` — **the file registry is canonical**; DB rows exist so users
  can tweak prompts/tool allowlists at runtime; new code-level tool ids are **merged** into
  the DB row (preserving user edits).
- `src/db/seed-roles.ts:84-103` — `loadRolesFromDb()` runs after seed and **overwrites the
  in-memory `ROLE_CONFIGS`** with DB values.

So a DB→runtime path *already exists at boot*. What's missing is **(a)** a write API
(`PATCH /roles/:id` — none today, only `GET /tools/role-map`, `tools.ts:111`), **(b)** a
single documented read point with explicit "DB overrides, code is the default" semantics
(today it's a boot-time overwrite of a mutable global, not a per-read fallback), and
**(c)** cache invalidation on write (roles cached at `roles/index.ts:22`; only
`reloadRoles()` clears it). W7 builds on this, it doesn't start from zero.

---

## 3. The contract — one "capability provider"

Every path should implement one contract so "add a capability and assign its roles"
becomes a single DB-backed operation regardless of where the capability lives.

```ts
interface CapabilityProvider {
  readonly id: string;                 // stable, role-bindable id (e.g. 'fs', 'plugin-x',
                                       // 'mcp:<server>', 'connector_atlassian')
  readonly kind: 'builtin' | 'plugin' | 'mcp' | 'connector';
  register(): Promise<void> | void;    // make the provider known (idempotent)
  declareTools(ctx: { userId?: string }): Promise<ToolHandler[]>; // its tool handlers
  isAvailable(ctx: { userId?: string }): Promise<boolean>;        // installed/authed?
  // enable/disable + role-binding are NOT per-provider methods — they are the SAME
  // DB-backed operation for every provider (roles.toolIds ∋ provider.id). See W7.
}
```

Key shift: **role binding is uniform.** A role's `toolIds` may contain a builtin id, a
`plugin-*` id, an `mcp:<server>` id, or a `connector_*` id — all resolved through the
**one** read point in `getToolsForRole`. Connectors **stop bypassing** role gating
(`worker-spawner.ts:278` path is folded into the gated resolution); availability
(`isAvailable`, e.g. OAuth presence) becomes an additional filter, not a separate code path.

---

## 4. Decision matrix — which path for a new capability

| Use… | When |
|------|------|
| **Connector** (preferred) | Third-party SaaS behind OAuth (Atlassian, Google, M365…). Isolated, per-user, never touches core. **Default choice for new integrations.** |
| **MCP** (preferred) | External tool server speaking MCP, shareable across agents; or a community/official server. Isolated from core. |
| **Plugin** | Self-hosted custom tools that need host runtime but not core changes; user-installable under `extensions/`. |
| **Built-in tool** | **Core only** — fs, shell, git, the dev workflow (incl. `src/tools/github`). Touches core code; reserve for capabilities the platform itself depends on. |
| **Extension** | Gateway commands / host-side behaviour that are not agent tools. Not a tool path — don't use it to add agent capabilities. |

**Deprecate the overlap:** "extensions-as-commands" vs "plugins-as-tools" is a real
fork — extensions stay for non-tool gateway behaviour; new *tools* go via
connector/MCP/plugin, never via extensions. New core capabilities are the only ones that
become built-in tools.

---

## 5. Capability-awareness (the Jira correction)

A *not-connected* capability must **prompt the user to connect**, never silently fail.
Example: no Atlassian OAuth ⇒ no Jira tools ⇒ when the user asks for Jira, the agent
should surface "connect Atlassian to enable this" rather than dead-ending. This is the
modular model working as intended: capabilities appear when their provider is
added/authed (`isAvailable`), isolated from core. (Fail-loud, per DESIGN.md house rule.)

---

## 6. Migration path (staged — do NOT big-bang)

1. **Done (PR #133):** delete unused `extensions/github`.
2. **W7 — `feat/role-tool-binding-ui`:** make DB `roles.toolIds` the runtime override with
   a **single read point** in `getToolsForRole` (DB value if present, else code config),
   add `PATCH /roles/:id` (admin-gated), make `/tools` UI toggles write through, invalidate
   the role cache on write, and **bring connectors + MCP under the same binding** (assign
   `connector_*` / `mcp:<server>` ids to roles; connectors stop bypassing gating). This
   delivers the contract's "uniform role binding" half first — highest user value.
3. **Later — `refactor/capability-model` (staged, behind this memo):** introduce the
   `CapabilityProvider` interface and adapt each loader to it, one path per PR, keeping
   `getToolsForRole` as the single resolution point. No behaviour change per PR — pure
   convergence.
4. **Follow-up (filed, not now):** `src/tools/github` auths via host keychain
   (`gh auth status`, `tools/github/index.ts:42`) — multiuser problem; move to per-user
   vault token (the pattern the deleted plugin already had). Relates to
   `feedback_secrets_in_vault_not_env`.

---

## 7. Anti-patterns (DESIGN.md house rules in force)

- Don't fork a second tool-resolution path — **one** read point (`getToolsForRole`).
- Don't lose the code-config default — DB `toolIds` null/absent ⇒ fall back to code config.
- Don't big-bang the convergence — stage behind this memo, one path per PR, no behaviour
  change per step.
- Fail loud — surface "capability not connected", never silently drop a requested tool
  without a logged reason + user-facing hint.
- No model-id literals anywhere this touches (it doesn't, but keep it in mind for W9/W10).

---

## 8. Open questions for sign-off

1. Id scheme for MCP: `mcp:<server>` (per-server) vs finer-grained `mcp:<server>:<tool>`?
   Recommend per-server now (matches today's all-or-nothing granularity), per-tool later.
2. Should connector availability (`isAvailable=false`) **hide** the tool from the role or
   **show it as connect-to-enable**? Recommend: keep it bindable in config, filter at
   spawn, and let the awareness layer (§5) surface the connect prompt on demand.
3. Admin gating for `PATCH /roles/:id` — reuse existing admin/permission check; confirm
   which guard.
