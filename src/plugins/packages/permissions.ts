/**
 * What a plugin package asks for, computed from its parsed manifest alone
 * (docs/PLUGIN-PACKAGES.md#packing-and-publishing): the summary
 * `octi plugin permissions` prints, a marketplace's CI diffs against the
 * published version, and an index lists beside each package. The host can
 * recompute it from a downloaded manifest and compare it with what a listing
 * claims, so a listing cannot understate what a package asks for.
 *
 * Every list is sorted (code-unit order), so the same manifest always gives
 * the same JSON, whatever order its author wrote things in.
 */
import { type PluginManifest, type PluginPermissionsSummary, type PluginToolEffect, pluginRuntime } from '@/shared/plugin-package';

/**
 * The package's `maxProtection`, or when it declares none: a package that
 * reaches the network leaves the house (1), and so does one that may have the
 * host fetch any URL it names (`web:read`: the URL itself can carry data out)
 * or run an agent that searches and fetches the web on a prompt it writes
 * (`agent:run`), and so does one with pages, which can navigate their frame
 * anywhere with what they were shown in the URL (docs/PLUGIN-PACKAGES.md#pages);
 * one that can do none of these keeps everything in (4).
 */
export function defaultMaxProtection(m: Pick<PluginManifest, 'maxProtection' | 'network' | 'host' | 'ui'>): 1 | 2 | 3 | 4 {
  if (m.maxProtection !== undefined) return m.maxProtection;
  const host = m.host ?? [];
  return (m.network ?? []).length > 0 || host.includes('web:read') || host.includes('agent:run') || (m.ui?.pages ?? []).length > 0 ? 1 : 4;
}

/** The permissions summary of a package (`octi plugin permissions --json`); the shape lives in src/shared so the web app reads the same type. */
export type PluginPermissions = PluginPermissionsSummary;

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values: readonly string[] | undefined) => [...(values ?? [])].sort(byCodeUnit);

/** The permissions summary of a parsed manifest (`parseManifest`, the parser install uses). */
export function computePermissions(manifest: PluginManifest): PluginPermissions {
  const tools = Object.entries(manifest.tools ?? {})
    .map(([name, decl]) => ({ name, effect: decl.effect }))
    .sort((a, b) => byCodeUnit(a.name, b.name));
  const effects: Record<PluginToolEffect, number> = { read: 0, write: 0, external: 0 };
  for (const tool of tools) effects[tool.effect] += 1;
  return {
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    runtime: pluginRuntime(manifest),
    host: sorted(manifest.host),
    network: sorted(manifest.network),
    tools,
    effects,
    contributions: {
      commands: sorted(manifest.commands?.map((c) => c.name)),
      schedules: sorted(manifest.schedules?.map((s) => s.id)),
      events: sorted(manifest.events?.map((e) => e.on)),
      prompt: manifest.prompt !== undefined,
      context: manifest.context !== undefined,
    },
    pages: manifest.ui?.pages.length ?? 0,
    trustedInput: manifest.model?.trustedInput === true,
    maxProtection: defaultMaxProtection(manifest),
  };
}
