/**
 * What a plugin package's server may put in front of a model
 * (docs/PLUGIN-PACKAGES.md#what-the-model-sees): only what the admin agreed
 * to, never text the running server sends.
 *
 * A server answers `tools/list` with whatever it likes, and may change it at
 * any time (`notifications/tools/list_changed`). Its descriptions reach every
 * agent's tool schema and `mcp_list_tools`, so a server could swap a
 * consented description for instructions to the model. So, for a plugin
 * server, the live list is intersected with the manifest:
 *
 * - a tool the manifest does not declare is dropped (it was refused anyway);
 * - the description is the manifest's (consented with the package), or, when
 *   it gives none, the tool name and effect;
 * - the input schema keeps its structure (types, properties, enums,
 *   required), but free text in it (`description`, `title`, `examples`,
 *   `$comment`) is removed; the output schema and annotations are dropped.
 *
 * Its resources, resource templates, prompts and `instructions` are never
 * listed: a package declares tools only.
 */
import type { PluginBinding } from '@/shared/mcp-server';
import type { MCPToolDefinition } from './protocol';

/** JSON Schema keys that carry free text, not structure. */
const TEXT_KEYS = new Set(['description', 'title', 'examples', '$comment', 'markdownDescription']);

/** `schema` without free text, its structure kept. Depth-limited: a schema deeper than this is cut there. */
export function schemaWithoutText(schema: unknown, depth = 0): unknown {
  if (depth > 32) return {};
  if (Array.isArray(schema)) return schema.map((v) => schemaWithoutText(v, depth + 1));
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (TEXT_KEYS.has(key)) continue;
    // Under `properties` (and the like) the keys are property names, not schema keywords: keep every one.
    if ((key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'definitions') && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, schemaWithoutText(v, depth + 1)]));
      continue;
    }
    out[key] = schemaWithoutText(value, depth + 1);
  }
  return out;
}

/** The description the model is given for a declared tool: the manifest's, else the name and effect. */
export function pluginToolDescription(binding: PluginBinding, name: string): string {
  const declared = binding.descriptions?.[name]?.trim();
  return declared ? declared : `${name} (${binding.tools[name]} tool)`;
}

/** The live `tools/list` of a plugin server, as the model may see it: declared tools only, in the manifest's words. */
export function pluginToolCatalog(binding: PluginBinding, live: readonly MCPToolDefinition[]): MCPToolDefinition[] {
  const out: MCPToolDefinition[] = [];
  const seen = new Set<string>();
  for (const tool of live) {
    if (typeof tool?.name !== 'string' || !Object.hasOwn(binding.tools, tool.name) || seen.has(tool.name)) continue;
    seen.add(tool.name);
    const schema = schemaWithoutText(tool.inputSchema ?? { type: 'object' });
    out.push({
      name: tool.name,
      description: pluginToolDescription(binding, tool.name),
      inputSchema: schema && typeof schema === 'object' && !Array.isArray(schema) ? schema as Record<string, unknown> : { type: 'object' },
    });
  }
  return out;
}

/** The host-written line the system prompt lists a plugin server with: its title, the package, and how many tools. No text of the package's. */
export function pluginServerListing(binding: Pick<PluginBinding, 'package' | 'tools'>, title: string): string {
  const n = Object.keys(binding.tools).length;
  return `${title} (plugin ${binding.package}), ${n} tool${n === 1 ? '' : 's'}`;
}
