/**
 * @octipus/plugin-sdk — the versioned plugin contract (WS3).
 *
 * The single source of truth for the `plugin.json` manifest shape, the host
 * API-version compatibility rule, and manifest validation. The Octipus host
 * imports this (via a tsconfig path alias — no install) so the loader and the
 * `octi plugin validate` CLI enforce exactly what plugin authors build against.
 *
 * Zero runtime dependencies — safe to publish and import in an author's CI.
 */

/** The contract version this host implements. Bump the MAJOR on a breaking change. */
export const PLUGIN_API_VERSION = '1.0.0';

export interface PluginToolParam {
  /** JSON-schema-ish type: string | number | boolean | object | array. */
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface PluginToolDef {
  name: string;
  description: string;
  parameters: Record<string, PluginToolParam>;
}

export interface PluginCommandDef {
  name: string;
  description: string;
}

/**
 * Declared capabilities. `tools` here is canonical when present; the top-level
 * `manifest.tools` is kept for backward-compat and used when `capabilities` is
 * absent. `commands`/`events` subsume what the host-extension format offered.
 */
export interface PluginCapabilities {
  tools?: PluginToolDef[];
  commands?: PluginCommandDef[];
  events?: string[];
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  main: string;
  /**
   * Contract version the plugin targets (semver). Absent ⇒ a legacy plugin
   * from before versioning — loaded with a deprecation warning, not refused.
   */
  apiVersion?: string;
  capabilities?: PluginCapabilities;
  /** Legacy top-level tool list. Kept; mirrors `capabilities.tools`. */
  tools: PluginToolDef[];
  /** Secret-key → vault-secret-name map the host resolves per calling user. */
  secrets?: Record<string, string>;
}

/** The effective tool list: `capabilities.tools` wins, else the top-level `tools`. */
export function manifestTools(manifest: PluginManifest): PluginToolDef[] {
  return manifest.capabilities?.tools ?? manifest.tools ?? [];
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export interface ApiVersionCheck {
  ok: boolean;
  /** Present on failure (reason to refuse) or as a note (legacy warning). */
  reason?: string;
  /** True when the plugin declared no apiVersion (legacy) — load but warn. */
  legacy?: boolean;
}

/**
 * Decide whether a plugin's declared `apiVersion` is compatible with this host.
 *   - undefined      → legacy: allowed, with a deprecation warning.
 *   - malformed      → refused.
 *   - major mismatch → refused (breaking contract change).
 *   - newer minor    → refused (needs a newer host).
 *   - otherwise      → allowed.
 */
export function checkApiVersion(apiVersion: string | undefined): ApiVersionCheck {
  if (apiVersion === undefined) {
    return { ok: true, legacy: true, reason: `no "apiVersion" declared — assuming legacy; declare "${PLUGIN_API_VERSION}"` };
  }
  const p = parseSemver(apiVersion);
  const host = parseSemver(PLUGIN_API_VERSION) as Semver;
  if (!p) return { ok: false, reason: `invalid apiVersion "${apiVersion}" (expected semver like ${PLUGIN_API_VERSION})` };
  if (p.major !== host.major) {
    return { ok: false, reason: `apiVersion ${apiVersion} is incompatible with host ${PLUGIN_API_VERSION} (major mismatch)` };
  }
  if (p.minor > host.minor) {
    return { ok: false, reason: `apiVersion ${apiVersion} needs a newer host (this host implements ${PLUGIN_API_VERSION})` };
  }
  return { ok: true };
}

export type ManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

function validateToolDefs(tools: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(tools)) {
    errors.push(`${label} must be an array`);
    return;
  }
  for (const tool of tools) {
    if (typeof tool !== 'object' || !tool) {
      errors.push(`${label}: each tool must be an object`);
      continue;
    }
    const t = tool as Record<string, unknown>;
    if (typeof t.name !== 'string' || !t.name) errors.push(`${label}: a tool is missing "name"`);
    if (typeof t.description !== 'string') errors.push(`${label}: tool "${t.name ?? '?'}" missing "description"`);
    if (typeof t.parameters !== 'object' || !t.parameters) {
      errors.push(`${label}: tool "${t.name ?? '?'}" missing "parameters"`);
    }
  }
}

/**
 * Structurally validate a parsed `plugin.json`. Non-throwing: returns every
 * error found so a validator can report them all at once. Does NOT check
 * apiVersion compatibility — call `checkApiVersion` separately.
 */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['plugin.json is not an object'] };
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) errors.push('missing or empty "name"');
  if (typeof obj.version !== 'string' || !obj.version) errors.push('missing or empty "version"');
  if (typeof obj.description !== 'string') errors.push('missing "description"');
  if (typeof obj.main !== 'string' || !obj.main) errors.push('missing or empty "main"');

  // Tools: capabilities.tools wins if present, else the top-level tools.
  const caps = obj.capabilities as Record<string, unknown> | undefined;
  if (caps !== undefined && (typeof caps !== 'object' || Array.isArray(caps))) {
    errors.push('"capabilities" must be an object');
  } else if (caps?.tools !== undefined) {
    validateToolDefs(caps.tools, 'capabilities.tools', errors);
  } else {
    validateToolDefs(obj.tools, '"tools"', errors);
  }

  if (obj.apiVersion !== undefined && typeof obj.apiVersion !== 'string') {
    errors.push('"apiVersion" must be a string');
  }

  if (obj.secrets !== undefined) {
    if (typeof obj.secrets !== 'object' || obj.secrets === null || Array.isArray(obj.secrets)) {
      errors.push('"secrets" must be an object');
    } else {
      for (const [key, secretName] of Object.entries(obj.secrets)) {
        if (typeof secretName !== 'string' || !secretName) {
          errors.push(`secret "${key}" must map to a non-empty secret name`);
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: obj as unknown as PluginManifest };
}

/** A deterministic fixture value for a declared parameter (used in tool dry-runs). */
export function fixtureForParam(param: PluginToolParam): unknown {
  if (param.default !== undefined) return param.default;
  switch (param.type) {
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'test';
  }
}

/** Build a full fixture argument object for a tool from its parameter schema. */
export function generateFixtureArgs(params: Record<string, PluginToolParam>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(params ?? {})) {
    out[key] = fixtureForParam(def);
  }
  return out;
}
