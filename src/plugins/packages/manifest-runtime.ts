/**
 * The runtime part of the plugin manifest (docs/PLUGIN-PACKAGES.md#runtimes):
 * `runtime` and, for an `in-process` plugin, its `entry` module. Merged into
 * the manifest schema of ./manifest.ts.
 *
 * - `package` (the default): an MCP server in the sandbox. `server` and
 *   `tools` are required; `entry` is refused.
 * - `in-process`: a trusted extension loaded into the server process
 *   (docs/PLUGINS.md#from-an-extension-octihook-trusted-extensions-only). `entry` is required. `server` and
 *   `tools` are refused (nothing is started, and its tools are registered
 *   with `octi.registerTool`, each with its effect), and so are the fields
 *   whose guarantees only a sandbox gives: `network` (it has the server's
 *   network) and `maxProtection` (it can read whatever the server can).
 *   `settings` and `secrets` are refused too: nothing hands them to an
 *   in-process module yet. Its name has no `-`, since its tools are named
 *   `ext_<name>__<id>`.
 */
import { z } from 'zod';
import { PLUGIN_RUNTIMES } from '@/shared/plugin-package';

/** A relative path of plain segments, ending in a module extension the server can import. */
const ENTRY_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/){0,10}[A-Za-z0-9_][A-Za-z0-9._-]*\.(?:ts|js|mjs)$/;

export const runtimeFields = {
  runtime: z.enum(PLUGIN_RUNTIMES).optional(),
  entry: z.string().max(300)
    .regex(ENTRY_RE, 'entry: a relative path inside the package to a .ts, .js or .mjs module, such as index.ts or dist/plugin.mjs')
    .refine((e) => !e.split('/').some((seg) => seg === '.' || seg === '..'), 'entry: no . or .. segments')
    .optional(),
};

interface RuntimeShape {
  name: string;
  runtime?: (typeof PLUGIN_RUNTIMES)[number];
  entry?: string;
  server?: unknown;
  tools?: unknown;
  network?: unknown;
  maxProtection?: unknown;
  settings?: unknown;
  secrets?: unknown;
}

/** The checks that depend on the runtime, as zod issues. */
export function refineRuntime(m: RuntimeShape, ctx: z.RefinementCtx): void {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if ((m.runtime ?? 'package') === 'package') {
    if (m.server === undefined) issue('server: required (how the host starts the package\'s MCP server)');
    if (m.tools === undefined) issue('tools: required (declare at least one tool)');
    if (m.entry !== undefined) issue('entry: only for runtime "in-process"');
    return;
  }
  if (m.entry === undefined) issue('entry: required for runtime "in-process" (the module exporting the extension factory)');
  if (m.name.includes('-')) issue('name: an in-process plugin\'s name is lower-case letters and digits (its tools are named ext_<name>__<id>)');
  if (m.server !== undefined) issue('server: an in-process plugin starts no server; remove server');
  if (m.tools !== undefined) issue('tools: an in-process plugin registers its tools with octi.registerTool (each with its effect); remove tools');
  if (m.network !== undefined) issue('network: an in-process plugin has the server\'s network, so declared hosts would limit nothing; remove network');
  if (m.maxProtection !== undefined) issue('maxProtection: an in-process plugin can read whatever the server can; remove maxProtection');
  if (m.settings !== undefined) issue('settings: not supported for runtime "in-process"');
  if (m.secrets !== undefined) issue('secrets: not supported for runtime "in-process" (a provider takes the name of a system vault secret instead)');
}
