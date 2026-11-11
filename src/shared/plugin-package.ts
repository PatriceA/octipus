/**
 * Plugin packages (docs/PLUGIN-PACKAGES.md): the shapes the server and the web
 * share. Dependency-free so `web/` imports it as is; the manifest is parsed
 * and checked in src/plugins/packages/manifest.ts.
 */
import type { PluginDeclarationItem, PluginGuidanceWarning } from './plugin-declarations';
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
  /** Pages shown in the web app (see "Pages and host API" below). */
  ui?: PluginUiDecl;
  /** Host API scopes the package asks for (see "Pages and host API" below). */
  host?: PluginHostScope[];
  /**
   * What the package says about the prompts of its `model:complete` calls
   * (see "Model calls on CLI lanes" below). Absent: untrusted.
   */
  model?: PluginModelDecl;
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
  /** What it adds besides tools (docs/PLUGIN-PACKAGES.md#contributions). */
  contributions: PluginContributionsView;

  /**
   * The host API scopes an admin approved (docs/PLUGIN-PACKAGES.md#host-api);
   * null before any approval. A scope the manifest declares and this list
   * lacks is not granted, and enabling asks for it again.
   */
  approvedHostScopes: PluginHostApproval[] | null;
  /**
   * The manifest's `model.trustedInput` and whether an admin approved it
   * (`model:cli-tools` in `approveHostScopes`); null when the manifest does
   * not declare it (see "Model calls on CLI lanes" below).
   */
  modelCliTools: PluginModelCliToolsView | null;
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

/**
 * What an installed package adds to the host, and whether each part is bound
 * now. Nothing binds until an admin approves `hash` (`approveContributions`).
 */
export interface PluginContributionsView {
  /** The contributions hash now (`sha256:<hex>`): what `approveContributions` takes. Null when it adds nothing (or cannot be read). */
  hash: string | null;
  /** The hash an admin approved, or null. */
  approvedHash: string | null;
  /** Whether `approvedHash` is `hash`: only then is anything bound. */
  approved: boolean;
  commands: Array<{ name: string; tool: string; effect: PluginToolEffect | null; description: string; bound: boolean }>;
  schedules: Array<{ id: string; cron: string; tool: string; effect: PluginToolEffect | null; bound: boolean; lastRun: PluginContributionRun | null }>;
  events: Array<{ on: PluginEventType; tool: string; effect: PluginToolEffect | null; bound: boolean; lastRun: PluginContributionRun | null }>;
  /** `text`: the whole prompt file, for review (null when it cannot be read). */
  prompt: { file: string; roles: string[] | null; text: string | null; bound: boolean; chars: number | null } | null;
  context: { tool: string; effect: PluginToolEffect | null; roles: string[] | null; bound: boolean; lastRun: PluginContributionRun | null } | null;
  /** Why a declared contribution is not bound right now (not approved, a name taken since install, content not approved). */
  problems: string[];
}
// ── end contributions ───────────────────────────────────────────────────────

// ── Pages and host API (docs/PLUGIN-PACKAGES.md#pages, #host-api) ─────────

/**
 * What a package may do through the host API, as the user who triggered the
 * call. A small explicit set: each scope maps to one narrow endpoint group of
 * `/api/plugin-host/*`. Write scopes (`notes:write`, `tasks:write`,
 * `documents:write`, `notify`) are handed only to calls of a tool whose
 * declared effect is `write` or `external`: a `read` tool reads.
 *
 * `web:read` has the host fetch one public web page (through its SSRF guard)
 * and hand back its readable text; `model:complete` runs one text completion
 * on the calling user's `everyday` model. Neither changes data, so a `read`
 * tool gets them; `web:read` lets a package name any URL, so it counts as
 * network for the package's default `maxProtection` (docs/PLUGIN-PACKAGES.md#host-api).
 *
 * `agent:run` starts a background agent run of the host's (as the user, with
 * a prompt and a role) and reads its status and result by its id: the run
 * outlives the call's token, the package only ever holds the run id. A `read`
 * tool gets it to read a run; starting one needs a `write` or `external` tool
 * (`PLUGIN_HOST_START_SCOPES`). Its agent can search and fetch the web with the
 * user's tools, so it counts as network too.
 */
export const PLUGIN_HOST_SCOPES = [
  'notes:read', 'notes:write', 'tasks:read', 'tasks:write', 'documents:read', 'documents:write', 'notify', 'web:read', 'model:complete',
  'agent:run',
] as const;
export type PluginHostScope = (typeof PLUGIN_HOST_SCOPES)[number];

/** The scopes that change data or reach the user: only for `write`/`external` tools. */
export const PLUGIN_HOST_WRITE_SCOPES: readonly PluginHostScope[] = ['notes:write', 'tasks:write', 'documents:write', 'notify'];

/**
 * Scopes a `read` tool holds to read with, whose starting endpoint still needs
 * a `write` or `external` tool: `agent:run` (a read tool polls a run, a write
 * tool starts one).
 */
export const PLUGIN_HOST_START_SCOPES: readonly PluginHostScope[] = ['agent:run'];

/** One page a package adds to the web app. */
export interface PluginUiPage {
  /** The page's path under `/plugins/<name>/`, e.g. `dashboard` (lower-case, `a-z0-9-`, `/`-separated). */
  path: string;
  /** Sidebar label and page title. */
  title: string;
  /** A lucide icon name (e.g. `chart-bar`); a default icon when missing or unknown. */
  icon?: string;
  /** The static HTML file, relative to `ui.dir`. */
  entry: string;
}

export interface PluginUiDecl {
  /** The directory (relative to the package root) whose files are served; default `ui`. */
  dir?: string;
  pages: PluginUiPage[];
}

/** A page of an enabled package, as the sidebar lists it (`GET /api/plugin-ui`). */
export interface PluginPageLink {
  plugin: string;
  /** The package's title. */
  pluginTitle: string;
  path: string;
  title: string;
  icon: string | null;
  /** The entry file's URL, served by `/api/plugin-ui/<name>/…`. */
  src: string;
}

/** What `_meta["octipus/host"]` of a `tools/call` carries to a package that declares `host`. */
export interface PluginHostCallMeta {
  /** Where the host API is reached, through the package's egress proxy: `http://octipus-host.internal`. */
  url: string;
  /** The bearer token for this one call. */
  token: string;
  /** ISO time the token expires (the call's timeout). */
  expiresAt: string;
  /** What the token may do: the declared, approved scopes the user holds, for this tool's effect. */
  scopes: PluginHostScope[];
}

/** The `_meta` key a tool call carries the host API token under. */
export const PLUGIN_HOST_META_KEY = 'octipus/host';

/** The name a package reaches the host API by, through its egress proxy only (never resolved by DNS). */
export const PLUGIN_HOST_ALIAS = 'octipus-host.internal';

// ── end pages and host API ─────────────────────────────────────────────

// ── Model calls on CLI lanes (docs/PLUGIN-PACKAGES.md#model-calls-on-cli-lanes) ──
// A plugin's `model:complete` call is refused (409 cli_model) when the user's
// `everyday` lane is bound to a CLI model: a vendor CLI is an agent harness
// with its own tools (shell, files), run as the Octipus server user, and a
// plugin's prompt may carry outside data written to steer it. A package whose
// prompts carry none can say so (`model.trustedInput`, with a reason), and
// only an admin's explicit approval of `model:cli-tools` lets its calls run
// on such a lane. An upgrade clears the approval, like every host scope.

/** The most characters `model.reason` may have. */
export const MAX_MODEL_TRUST_REASON_CHARS = 300;

/** What `model` in the manifest declares. */
export interface PluginModelDecl {
  /**
   * The package's prompts to `model:complete` are built only from its own
   * constants or from sources the admin trusts, never from outside data
   * (web pages, mail, user files, other people's words). Default false.
   * Needs `model:complete`, refuses `web:read` and runtime `in-process`.
   */
  trustedInput?: boolean;
  /** Why the prompts carry no outside data; required with `trustedInput`, shown to the admin. */
  reason?: string;
}

/**
 * The approval item of `model.trustedInput`, sent in `approveHostScopes`
 * next to the host scopes. Not a scope a manifest declares in `host`, and
 * never handed to a package's token.
 */
export const PLUGIN_MODEL_CLI_TOOLS_APPROVAL = 'model:cli-tools';
export type PluginHostApproval = PluginHostScope | typeof PLUGIN_MODEL_CLI_TOOLS_APPROVAL;

/** The warning the admin approves `model:cli-tools` under. */
export const MODEL_CLI_TOOLS_WARNING = 'Its model calls may run on CLI agents with their own tools (shell, files) as the Octipus server user; '
  + 'only approve if its prompts never carry outside data.';

export interface PluginModelCliToolsView {
  /** The manifest's `model.reason`. */
  reason: string;
  /** Whether an admin approved `model:cli-tools` for this version. */
  approved: boolean;
  /** Approved, and `model:complete` is approved too: its calls may run on a CLI lane. */
  active: boolean;
  /** The package's other sources of data the admin must trust: `network` hosts and `*:read` host scopes; null when none. */
  sourcesWarning: string | null;
}

/** Whether a manifest declares `model.trustedInput`. */
export function declaresTrustedModelInput(m: Pick<PluginManifest, 'model'>): boolean {
  return m.model?.trustedInput === true;
}

/**
 * The sources a package with `model.trustedInput` can still build prompts
 * from, which only the admin can judge: its `network` hosts and its `*:read`
 * host scopes (`web:read` is refused outright). Null when it has none.
 */
export function modelCliToolsSourcesWarning(m: Pick<PluginManifest, 'network' | 'host'>): string | null {
  const hosts = m.network ?? [];
  const reads = (m.host ?? []).filter((s) => s.endsWith(':read'));
  if (hosts.length === 0 && reads.length === 0) return null;
  const parts = [
    ...(hosts.length > 0 ? [`the network hosts ${hosts.join(', ')}`] : []),
    ...(reads.length > 0 ? [`the host scopes ${reads.join(', ')}`] : []),
  ];
  return `It also reads from ${parts.join(' and ')}: approve only if you trust what they return, since it can reach its prompts.`;
}
// ── end model calls on CLI lanes ────────────────────────────────────────────

/**
 * A first-party plugin shipped with Octipus (`plugins/<name>` in the install),
 * as `GET /api/plugin-packages/bundled` lists it (docs/PLUGIN-PACKAGES.md#bundled-plugins).
 */
export interface BundledPluginView {
  name: string;
  version: string;
  title: string;
  description: string;
  /** Host API scopes it asks for (approved when enabling). */
  host: PluginHostScope[];
  /** Hosts it reaches itself. */
  network: string[];
  /** The installed version of this bundle, or null. */
  installed: string | null;
  /** Another package (not this bundle) holds the name: it cannot be installed until that one is removed. */
  taken?: boolean;
  /** Its manifest does not parse: why (it cannot be installed). */
  problem?: string;
}


// ── Creator mode (docs/PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent) ───
// An agent may write a `package` plugin in its workspace and install it with
// `plugin_dev__plugin_install` (src/tools/plugin-dev): always disabled, for an
// admin to review and enable. The install's audit row records who asked.

/** The agent that wrote and installed a package's current version. */
export interface PluginAgentAuthorship {
  /** The user whose agent installed it (an admin, who approved the call). */
  userId: string;
  /** The chat session the agent ran in, when it ran in one. */
  sessionId: string | null;
  agentId: string | null;
  /** When it was installed. */
  at: string;
}

export interface PluginPackageView {
  /**
   * Set when the current version was installed by an agent (creator mode),
   * read from its `installed`/`upgraded` audit row; null when a person
   * installed it.
   */
  authoredBy: PluginAgentAuthorship | null;
}
// ── end creator mode ────────────────────────────────────────────────────────

// ── Marketplace, provenance, revocation, updates and usage ──────────────────
// (docs/PLUGIN-PACKAGES.md#marketplace). The fields below merge into the
// interfaces above.

/**
 * Where an installed version came from (`plugin_packages.origin`):
 * - `marketplace`: the built-in Octipus marketplace;
 * - `registry:<name>`: a registry of `plugins.registries`;
 * - `url`, `directory`, `bundled`, `agent`: a direct install by an admin, a
 *   plugin shipped with Octipus, or creator mode.
 */
export interface PluginOrigin {
  source: 'marketplace' | `registry:${string}` | 'url' | 'directory' | 'bundled' | 'agent';
  /** The registry's name (the marketplace's is "Octipus"), for a registry install. */
  registry?: string;
  /** The tarball URL, for a URL or registry install. */
  url?: string;
  /** The version the listing offered (equal to the installed version). */
  listingVersion?: string;
  /** The `generatedAt` of the signed index it was installed from. */
  indexGeneratedAt?: string | null;
}

/** Why an installed package (or its signing key) is revoked, as the package view shows it. */
export interface PluginRevocationView {
  kind: 'package' | 'key';
  /** The revoked key id, for a key revocation. */
  keyId: string | null;
  reason: string;
  /** Where the revocation came from: `marketplace` (its signed index) or `config` (plugins.revokedKeys / a revoked trusted publisher). */
  source: 'marketplace' | 'config';
  /** When this host first saw it (marketplace revocations only). */
  since: string | null;
}

export interface PluginPackageView {
  /** Where the installed version came from; null when installed before provenance was recorded. */
  origin: PluginOrigin | null;
  /** Set when this version, or the key that signed it, is revoked: it does not start, and enabling is refused. */
  revocation: PluginRevocationView | null;
  /** What it declares it will do, item by item (`declarationItems`), for the admin to read and agree to. */
  declarations: PluginDeclarationItem[];
}

/**
 * What a package asks for, computed from its manifest alone
 * (`computePermissions`, `octi plugin permissions --json`); an index v2 entry
 * carries it, and the host recomputes it at install.
 */
export interface PluginPermissionsSummary {
  name: string;
  version: string;
  apiVersion: string;
  runtime: PluginRuntime;
  host: string[];
  network: string[];
  /** The names (keys) of the secrets it asks for, sorted; never their labels or values. */
  secrets: string[];
  /** The names (keys) of its settings, sorted. */
  settings: string[];
  tools: Array<{ name: string; effect: PluginToolEffect }>;
  effects: Record<PluginToolEffect, number>;
  /**
   * What it adds besides tools, with what each part is bound to, so a schedule
   * switched to another tool, a new cron, new prompt text or another context
   * tool is a change of its own (docs/PLUGIN-PACKAGES.md#packing-and-publishing).
   */
  contributions: PluginPermissionsContributions;
  /** Its pages, sorted by path. */
  pages: Array<{ path: string; title: string; entry: string }>;
  /** The directory its pages are served from and the hash of that tree (`uiTreeHash`); null without pages. */
  ui: { dir: string; sha256: string | null } | null;
  trustedInput: boolean;
  maxProtection: 1 | 2 | 3 | 4;
}

/**
 * `PluginPermissionsSummary.contributions`. Lists are sorted (commands by
 * name, schedules by id, events by `on` then tool); `roles` is sorted and
 * left out when the manifest names none (every role). `prompt.sha256` is the
 * hex sha256 of the prompt file's bytes, null only where no package directory
 * was at hand (a manifest alone).
 */
export interface PluginPermissionsContributions {
  /** `input` only when the manifest gives the command one. */
  commands: Array<{ name: string; tool: string; input?: Record<string, unknown> }>;
  schedules: Array<{ id: string; cron: string; tool: string; input?: Record<string, unknown> }>;
  events: Array<{ on: string; tool: string }>;
  prompt: { file: string; sha256: string | null; roles?: string[] } | null;
  context: { tool: string; roles?: string[] } | null;
}

/** One change between two permission summaries (`PluginUpdateView.diff`). */
export interface PluginPermissionChange {
  kind: 'runtime' | 'apiVersion' | 'host' | 'network' | 'secrets' | 'settings' | 'tool' | 'contribution' | 'pages' | 'trustedInput' | 'maxProtection';
  change: 'added' | 'removed' | 'wider' | 'narrower' | 'changed';
  /** In words, e.g. "host API scope notes:write". */
  text: string;
  /** Whether it asks for more than before. */
  widens: boolean;
}

export interface PluginPermissionDiff {
  /** Whether anything asks for more than before. */
  widened: boolean;
  changes: PluginPermissionChange[];
}

/** Whether a listed version can run here. */
export interface PluginCompatibility {
  ok: boolean;
  /** Why not, in words; null when it can. */
  reason: string | null;
}

/** One version of a plugin in the marketplace (or a registry). */
export interface MarketplaceVersionView {
  version: string;
  publishedAt: string | null;
  /** The tarball's sha256 (`sha256:<hex>`). */
  sha256: string;
  contentHash: string | null;
  apiVersion: string | null;
  minOctipus: string | null;
  compatibility: PluginCompatibility;
  /** The reason, when this version is revoked. */
  revoked: string | null;
}

/** One plugin as the in-app Marketplace page shows it (`GET /api/plugin-packages/marketplace`). */
export interface MarketplacePluginView {
  /** `marketplace`, or a registry's name. */
  registry: string;
  name: string;
  title: string;
  /** The listing's one-line summary (may be empty). */
  summary: string;
  description: string;
  category: string | null;
  tags: string[];
  author: { name: string; url: string | null } | null;
  homepage: string | null;
  license: string | null;
  publisher: string | null;
  /** The icon through the host's asset proxy (`/api/plugin-packages/marketplace/asset?…`), or null. */
  icon: string | null;
  /** Screenshots through the host's asset proxy. */
  screenshots: string[];
  /** README.md as raw Markdown text (render sanitized, without raw HTML or remote images), or null. */
  readme: string | null;
  /** CHANGELOG.md as raw Markdown text, or null. */
  changelog: string | null;
  /** The newest version that can be installed here (compatible, not revoked), or null. */
  latest: string | null;
  /** Every listed version, newest first. */
  versions: MarketplaceVersionView[];
  /** The permissions of `latest` (else of the newest version), as the index lists them; checked again at install. */
  permissions: PluginPermissionsSummary | null;
  /** `permissions` in words, e.g. "Reads your tasks", "No network access". */
  askSummary: string[];
  /** `permissions` item by item (`declarationItems`; no secrets or page titles: the listing does not carry the manifest). */
  declarations: PluginDeclarationItem[];
  /** Guidance for the admin (an egress scope beside a read scope, deprecation, a source change); never a refusal. */
  warnings: PluginGuidanceWarning[];
  /** Whether `latest` can be installed here. */
  compatibility: PluginCompatibility;
  installedVersion: string | null;
  /** Where the installed version came from, when installed. */
  installedOrigin: PluginOrigin | null;
  /** A newer installable version than the installed one, from the same source. */
  updateAvailable: string | null;
  /** Set when the installed version is revoked (or every listed version is). */
  revoked: string | null;
  deprecated: string | null;
  /** Downloads as the marketplace's unsigned stats.json reports them; display only, never part of trust. Null when unknown. */
  downloads: number | null;
}

export interface MarketplaceListing {
  /**
   * `ready`: listed; `off`: plugins.marketplace is false; `unconfigured`: this
   * build has no marketplace keys yet (`message` says so); `error`: the index
   * could not be read or verified (`message` says why).
   */
  state: 'ready' | 'off' | 'unconfigured' | 'error';
  message: string | null;
  /** The index's `generatedAt`, when listed. */
  generatedAt: string | null;
  plugins: MarketplacePluginView[];
  /** Categories present in `plugins`, sorted. */
  categories: string[];
  /**
   * Registries (from plugins.registries, or the marketplace) that could not be
   * read, and why; and listed versions refused because they replace a
   * published version ("replaced: refused"), the rest of that index kept.
   */
  errors: Array<{ registry: string; error: string }>;
  /** The marketplace's index or keys.json last accepted more than 7 days ago (a banner; the admins are notified once). */
  stale: MarketplaceStaleFile[];
}

/** A marketplace file whose last accepted version is old: revocations published since may not have reached this host. */
export interface MarketplaceStaleFile {
  file: 'index' | 'keys.json';
  generatedAt: string;
  message: string;
}

/** A newer version of an installed package from the same source (`GET /api/plugin-packages/updates`). */
export interface PluginUpdateView {
  name: string;
  installed: string;
  latest: string;
  /** `marketplace` or the registry's name. */
  registry: string;
  /** Installed permissions (recomputed from the installed manifest) → the new entry's; null when the listing states none (an index v1 registry). */
  diff: PluginPermissionDiff | null;
  /** Guidance: what widens, what the new version adds that needs saying. */
  warnings: PluginGuidanceWarning[];
}

/** Tokens, spend and calls of one plugin package (`GET /api/plugin-packages/:name/usage`). */
export interface PluginUsageView {
  name: string;
  days: number;
  since: string;
  /** `all` for the admin view (every user), `me` for the caller's own. */
  scope: 'all' | 'me';
  /** `model:complete` calls: cost rows tagged `plugin:<name>`. */
  modelCalls: number;
  /** Background runs (`agent:run`) started. */
  runs: number;
  inputTokens: number;
  outputTokens: number;
  /** Spend in the cost log's currency (USD), model calls and runs together. */
  cost: number;
  /** Per user (admin view only; ids, no content). */
  byUser?: Array<{ userId: string; modelCalls: number; runs: number; tokens: number; cost: number }>;
}

/** `GET /api/plugin-packages/sandbox`: the sandbox plugin package servers get on this host (src/plugins/packages/sandbox-policy.ts). */
export interface PluginSandboxStatus {
  /** `plugins.sandbox`. */
  setting: 'required' | 'off';
  /** The working runner, or null. */
  runner: 'bwrap' | 'firejail' | 'sandbox-exec' | 'appcontainer' | null;
  /** Why no runner works here, with how to get one; null when one does. */
  unavailable: string | null;
  platform: string;
  /** One line: "active runner bwrap" or "unavailable: …". */
  summary: string;
}
