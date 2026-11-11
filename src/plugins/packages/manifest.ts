/**
 * The plugin package manifest (`octipus-plugin.json`, docs/PLUGIN-PACKAGES.md):
 * parsed and checked here, with every problem reported at once, so a package
 * that does not fit the contract is refused at install rather than failing
 * when an agent first calls it.
 */
import { z } from 'zod';
import { fieldListSchema } from '@/core/records/fields';
import { SIGNATURE_FILE } from './integrity';
import { refineRuntime, runtimeFields } from './manifest-runtime';
import { contributionFields, contributionProblems } from './manifest-contributions';
import { MODEL_FIELDS, modelProblems } from './manifest-model';
import { STORE_FIELDS, storeProblems } from './manifest-store';
import { UI_HOST_FIELDS } from './manifest-ui-host';
import {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_TOOL_EFFECTS,
  type PluginManifest,
} from '@/shared/plugin-package';

const NAME_RE = /^[a-z][a-z0-9-]{1,49}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** An MCP tool name: what the bridge addresses as `<server>.<tool>`. */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * A host name, optionally with a leading `*.` for its subdomains and a
 * trailing `:port`. Without a port the egress proxy allows 443 and 80.
 */
const HOST_RE = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}(:([1-9]\d{0,4}))?$/i;
const hostPortOk = (h: string) => { const port = /:(\d+)$/.exec(h)?.[1]; return port === undefined || Number(port) <= 65535; };

/** Names a package may not use: they would read as the host's own MCP servers. */
const RESERVED_NAMES = new Set(['octipus', 'mcp', 'system', 'plugin']);

export const manifestSchema = z.object({
  name: z.string().regex(NAME_RE, 'name: lower-case letters, digits and -, starting with a letter (2-50)')
    .refine((n) => !RESERVED_NAMES.has(n), 'name: this name is reserved'),
  version: z.string().regex(SEMVER_RE, 'version: a semantic version such as 1.2.0'),
  apiVersion: z.string().regex(SEMVER_RE, 'apiVersion: a semantic version such as 1.0.0'),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000),
  publisher: z.string().trim().max(200).optional(),
  homepage: z.string().url().max(500).optional(),
  ...runtimeFields,
  server: z.object({
    command: z.string().trim().min(1).max(500),
    args: z.array(z.string().max(1000)).max(50).optional(),
    requestTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
  }).strict().optional(),
  tools: z.record(
    z.string().regex(TOOL_NAME_RE, 'tools: a tool name is letters, digits, _ and - (at most 64)'),
    z.object({
      effect: z.enum(PLUGIN_TOOL_EFFECTS),
      description: z.string().max(500).optional(),
    }).strict(),
  ).refine((tools) => Object.keys(tools).length > 0, 'tools: declare at least one tool')
    .refine((tools) => Object.keys(tools).length <= 200, 'tools: at most 200').optional(),
  network: z.array(z.string().regex(HOST_RE, 'network: host names such as api.example.com, *.example.com or api.example.com:8443')
    .refine(hostPortOk, 'network: a port is 1-65535')).max(50).optional(),
  maxProtection: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  settings: fieldListSchema.optional(),
  secrets: z.array(z.object({
    key: z.string().regex(ENV_KEY_RE, 'secrets: a key is an environment variable name such as API_TOKEN'),
    label: z.string().trim().min(1).max(100),
    help: z.string().max(500).optional(),
    required: z.boolean().optional(),
  }).strict()).max(20).optional(),
  ...contributionFields,
  ...UI_HOST_FIELDS,
  ...MODEL_FIELDS,
  ...STORE_FIELDS,
}).strict().superRefine((m, ctx) => {
  refineRuntime(m, ctx);
  // Pages call the plugin's own sandboxed tools, and the host API token rides
  // those tool calls: both need the package runtime.
  if (m.runtime === 'in-process' && (m.ui || m.host?.length)) {
    ctx.addIssue({ code: 'custom', message: 'ui and host apply to the package runtime only; an in-process plugin has no sandboxed tools to serve them' });
  }
  for (const message of contributionProblems(m)) ctx.addIssue({ code: 'custom', message });
  for (const message of modelProblems(m)) ctx.addIssue({ code: 'custom', message });
  for (const message of storeProblems(m)) ctx.addIssue({ code: 'custom', message });
  // The signature file is the one file the content hash leaves out: the server may not be started from it.
  const sigName = SIGNATURE_FILE.toLowerCase();
  if (m.server && [m.server.command, ...(m.server.args ?? [])].some((part) => part.toLowerCase().includes(sigName))) {
    ctx.addIssue({ code: 'custom', message: `server: the command and its args may not name ${SIGNATURE_FILE} (it is not covered by the content hash)` });
  }
  const keys = new Set<string>();
  for (const s of m.secrets ?? []) {
    if (keys.has(s.key)) ctx.addIssue({ code: 'custom', message: `secrets: "${s.key}" is declared twice` });
    keys.add(s.key);
  }
  for (const f of m.settings ?? []) {
    const env = settingEnvName(f.key);
    if (keys.has(env)) ctx.addIssue({ code: 'custom', message: `settings: "${f.key}" would collide with the secret ${env}` });
  }
});

export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'ManifestError';
  }
}

/** The environment variable a setting is handed to the package as. */
export function settingEnvName(key: string): string {
  return `OCTIPUS_SETTING_${key.toUpperCase()}`;
}

/**
 * Whether a package written against `apiVersion` runs on this host: the same
 * MAJOR, and a MINOR no newer than the host's (the rule of `@octipus/plugin-sdk`).
 */
export function apiVersionProblem(apiVersion: string): string | null {
  const [hostMajor, hostMinor] = PLUGIN_PACKAGE_API_VERSION.split('.').map(Number);
  const [major, minor] = apiVersion.split('.').map(Number);
  if (major !== hostMajor) return `apiVersion ${apiVersion} is not supported (this host reads ${hostMajor}.x)`;
  if (minor > hostMinor) return `apiVersion ${apiVersion} is newer than this host (${PLUGIN_PACKAGE_API_VERSION}); update Octipus`;
  return null;
}

/** Parse a manifest, or throw `ManifestError` listing every problem. */
export function parseManifest(value: unknown): PluginManifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    throw new ManifestError(result.error.issues.map((i) => (i.path.length && !i.message.includes(':') ? `${i.path.join('.')}: ${i.message}` : i.message)));
  }
  const apiProblem = apiVersionProblem(result.data.apiVersion);
  if (apiProblem) throw new ManifestError([apiProblem]);
  return result.data;
}
