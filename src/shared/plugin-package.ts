/**
 * Plugin packages (docs/PLUGIN-PACKAGES.md): the shapes the server and the web
 * share. Dependency-free so `web/` imports it as is; the manifest is parsed
 * and checked in src/plugins/packages/manifest.ts.
 */
import type { FieldDef } from './record-fields';

/** The manifest file at a package's root. */
export const PLUGIN_MANIFEST_FILE = 'octipus-plugin.json';

/** The longest value a plugin package secret holds (`PUT /api/plugin-packages/:name/secrets/:key`). */
export const MAX_PLUGIN_SECRET_LENGTH = 10_000;

/** The manifest contract this host reads (`apiVersion`, same MAJOR, MINOR not newer). */
export const PLUGIN_PACKAGE_API_VERSION = '1.0.0';

/**
 * What a tool does, as its package declares it. The host decides the
 * permission from it, and the declaration can only make a tool stricter:
 *
 * - `read`: reads only. Default ALLOW.
 * - `write`: changes data in the system it connects to. Default ASK.
 * - `external`: an effect outside the organisation — a payment, a message to
 *   a person, a post. Always ASK: a permission rule cannot lower it, and an
 *   unattended run is refused.
 *
 * A tool the package does not declare is hidden and refused.
 */
export const PLUGIN_TOOL_EFFECTS = ['read', 'write', 'external'] as const;
export type PluginToolEffect = (typeof PLUGIN_TOOL_EFFECTS)[number];

export interface PluginToolDecl {
  effect: PluginToolEffect;
  /** One line shown at install time. */
  description?: string;
}

/** A credential the package needs, stored in the vault and handed to it as an environment variable of the same name. */
export interface PluginSecretDecl {
  /** The environment variable name, e.g. `FINAPI_CLIENT_SECRET`. */
  key: string;
  label: string;
  help?: string;
  required?: boolean;
}

export interface PluginManifest extends PluginManifestContributions {
  /** Lower-case package name, e.g. `finapi`. */
  name: string;
  version: string;
  apiVersion: string;
  /** Shown in the plugin list. */
  title: string;
  description: string;
  publisher?: string;
  homepage?: string;
  /**
   * How the host starts the package: a local MCP server over stdio, in the
   * package directory. Required for runtime `package`; absent for `in-process`.
   */
  server?: {
    command: string;
    args?: string[];
    /** Per-request timeout for slow tools, in milliseconds. */
    requestTimeoutMs?: number;
  };
  /**
   * Every tool the package offers and what it does. Required for runtime
   * `package`; absent for `in-process` (its tools are registered with
   * `octi.registerTool`, each with its own effect).
   */
  tools?: Record<string, PluginToolDecl>;
  /** Hosts the package talks to. Shown at install; the sandbox gets network only when there is at least one. */
  network?: string[];
  /**
   * The highest protection level (1-4, docs/plans/business-os.md C6) of data
   * the package may see. Recorded now; enforced by the privacy gateway.
   */
  maxProtection?: 1 | 2 | 3 | 4;
  /** Non-secret settings, handed to the package as `OCTIPUS_SETTING_<KEY>`. */
  settings?: FieldDef[];
  secrets?: PluginSecretDecl[];
}

/** An installed package as the API returns it. */
/**
 * How a package's network is held on this host (docs/PLUGIN-PACKAGES.md#network):
 *
 * - `offline` — it declares no host and the sandbox gives it no network;
 * - `restricted` — it declares hosts and reaches only those, through the
 *   egress proxy, with direct network off in the sandbox;
 * - `not_enforced` — no sandbox wraps it on this platform (sandbox off, no
 *   bwrap/firejail on Linux, no sandbox-exec on macOS, Windows): the
 *   declared hosts are advice, and a package with hosts is only pointed at
 *   the proxy;
 * - `refused` — `security.shellSandbox` is `required` and no runner can
 *   enforce it here, so the server is not started at all.
 */
export interface PluginNetworkStatus {
  state: 'offline' | 'restricted' | 'not_enforced' | 'refused';
  /** A sentence for the operator. */
  detail: string;
}

/** The signature state of a package's approved content (docs/PLUGIN-PACKAGES.md#signed-packages). */
export interface PluginSignatureStatus {
  status: 'valid' | 'unsigned' | 'unknown_key' | 'revoked' | 'expired' | 'invalid' | 'changed';
  keyId: string | null;
  /** The publisher named in plugins.trustedPublishers, when the key is listed there. */
  publisher: string | null;
  /** A sentence for the operator. */
  detail: string;
}

/** A package one of `plugins.registries` lists (`GET /api/plugin-packages/registry`). */
export interface PluginRegistryEntry {
  /** The registry's `name` in the config. */
  registry: string;
  name: string;
  version: string;
  description: string | null;
  /** The https tarball (.tar.gz). */
  url: string;
  /** The sha256 of the tarball, `sha256:<hex>`, checked before it is unpacked. */
  sha256: string;
  /** The version installed here, or null. */
  installedVersion: string | null;
}

export interface PluginRegistryListing {
  packages: PluginRegistryEntry[];
  /** Registries that could not be read, and why; their packages are missing from the list. */
  errors: Array<{ registry: string; error: string }>;
}

export interface PluginPackageView {
  name: string;
  version: string;
  manifest: PluginManifest;
  enabled: boolean;
  settings: Record<string, string | number | boolean>;
  /** Which declared secrets have a value in the vault (never the values). */
  secretsSet: string[];
  /** Why the package is not running, when it should be. */
  problem: string | null;
  /** Whether its network is actually limited on this host, and how. */
  network: PluginNetworkStatus;
  /** Whether its MCP server is connected right now. */
  connected: boolean;
  /**
   * The hash its files were approved with (`sha256:<hex>`, docs/PLUGIN-PACKAGES.md#content-pinning);
   * null until the first start of a package installed before pinning.
   */
  contentHash: string | null;
  /**
   * What its files hash to now, when they do not match `contentHash` (the
   * problem is the hash mismatch): the hash to review and approve with
   * `approveContent`. Null otherwise.
   */
  actualHash: string | null;
  /**
   * The trusted publisher (`plugins.trustedPublishers`) whose valid signature
   * covers `contentHash` (docs/PLUGIN-PACKAGES.md#signed-packages), recomputed
   * for each view against the keys trusted now and the approved signature
   * file; null for unsigned content, an untrusted or removed key, a changed
   * signature file, or content approved without a signature.
   */
  signedBy: string | null;
  /**
   * The signature over `contentHash` now, in words and by state (null before
   * the first start of a package installed before pinning): `valid`,
   * `unsigned`, `unknown_key`, `revoked` or `expired` (a key withdrawn in
   * `plugins.trustedPublishers` / `plugins.revokedKeys`), `invalid`, or
   * `changed` (not the signature file approved with the content).
   */
  signature: PluginSignatureStatus | null;
  installedBy: string | null;
  installedAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Runtimes (docs/PLUGIN-PACKAGES.md#runtimes, docs/plans/plugins-everything.md
// phase 1): a package runs as a sandboxed MCP server (`package`, the default)
// or as a trusted extension loaded into the server process (`in-process`).
// The fields below merge into the interfaces above.
// ---------------------------------------------------------------------------

/** How a plugin runs. */
export const PLUGIN_RUNTIMES = ['package', 'in-process'] as const;
export type PluginRuntime = (typeof PLUGIN_RUNTIMES)[number];

export interface PluginManifest {
  /** How the plugin runs; `package` when absent. */
  runtime?: PluginRuntime;
  /**
   * For `in-process`: the module (`.ts`, `.js` or `.mjs`, relative to the
   * package root) whose default export is the extension factory
   * (`(octi) => void | Promise<void>`, docs/PLUGINS.md#from-an-extension-octihook-trusted-extensions-only).
   */
  entry?: string;
}

/**
 * The extra approval an `in-process` plugin needs before it may be enabled:
 * running in the server process, recorded with the content hash it covers.
 * Approving other content (an upgrade, a content approval of new bytes)
 * clears it.
 */
export interface PluginInProcessStatus {
  /** Whether the approval covers the approved content now (`approvedHash === contentHash`). */
  approved: boolean;
  /** The content hash approved to run in the server process, or null. */
  approvedHash: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Whether its module is loaded in this server process now. */
  loaded: boolean;
}

export interface PluginPackageView {
  /** `manifest.runtime`, defaulted. */
  runtime: PluginRuntime;
  /** For an `in-process` plugin, its in-process approval and whether it is loaded; null for `package`. */
  inProcess: PluginInProcessStatus | null;
}

/** The runtime a manifest declares, defaulted. */
export function pluginRuntime(m: { runtime?: PluginRuntime }): PluginRuntime {
  return m.runtime ?? 'package';
}
// --- end runtimes ----------------------------------------------------------

// ── Contributions: commands, schedules, events, prompt, context ─────────────
// (docs/PLUGIN-PACKAGES.md#contributions; checked in
// src/plugins/packages/manifest-contributions.ts, bound in
// src/plugins/packages/contributions/). Each one names one of the package's
// own declared tools and runs through the same authorization as an agent call.

/**
 * The gateway events a package may subscribe to (`events[].on`). Each reaches
 * the tool as ids only (never message text, file contents or secrets):
 *
 * - `chat.response` — a root turn answered: `{ type, at, userId, sessionId }`;
 * - `document.completed` — an uploaded document was processed: `{ type, at, userId, documentId }`;
 * - `document.failed` — processing an uploaded document failed: `{ type, at, userId, documentId }`.
 */
export const PLUGIN_EVENT_TYPES = ['chat.response', 'document.completed', 'document.failed'] as const;
export type PluginEventType = (typeof PLUGIN_EVENT_TYPES)[number];

/** `/name args` calls `tool` as the user who typed it, without a model turn. */
export interface PluginCommandDecl {
  /** The command without the slash; also reachable as `/<package>:<name>`. */
  name: string;
  tool: string;
  description: string;
  /**
   * The tool's arguments. A string value `"$args"` is replaced by the text
   * after the command. Default `{ "text": "$args" }`.
   */
  input?: Record<string, unknown>;
}

/** The cron runner calls `tool` with `input` (UTC, five fields). */
export interface PluginScheduleDecl {
  id: string;
  cron: string;
  tool: string;
  input?: Record<string, unknown>;
}

export interface PluginEventDecl {
  on: PluginEventType;
  tool: string;
}

/** Static markdown from the package, added to the system prompt of `roles` (all when omitted). */
export interface PluginPromptDecl {
  /** A `.md` file in the package, relative to its root. */
  file: string;
  roles?: string[];
}

/** A `read` tool called at the start of every turn of `roles` (all when omitted); its text rides the turn. */
export interface PluginContextDecl {
  tool: string;
  roles?: string[];
}

export interface PluginManifestContributions {
  commands?: PluginCommandDecl[];
  schedules?: PluginScheduleDecl[];
  events?: PluginEventDecl[];
  prompt?: PluginPromptDecl;
  context?: PluginContextDecl;
}

/** The last run of a schedule, event or context contribution (on the plugin's row). */
export interface PluginContributionRun {
  at: string;
  ok: boolean;
  /** Why it failed, or what was skipped (rate limit). */
  error: string | null;
}

/** What an installed package adds to the host, and whether each part is bound now. */
export interface PluginContributionsView {
  commands: Array<{ name: string; tool: string; description: string; bound: boolean }>;
  schedules: Array<{ id: string; cron: string; tool: string; bound: boolean; lastRun: PluginContributionRun | null }>;
  events: Array<{ on: PluginEventType; tool: string; bound: boolean; lastRun: PluginContributionRun | null }>;
  prompt: { file: string; roles: string[] | null; bound: boolean; chars: number | null } | null;
  context: { tool: string; roles: string[] | null; bound: boolean; lastRun: PluginContributionRun | null } | null;
  /** Why a declared contribution is not bound right now (a name taken since install, content not approved). */
  problems: string[];
}
// ── end contributions ───────────────────────────────────────────────────────
