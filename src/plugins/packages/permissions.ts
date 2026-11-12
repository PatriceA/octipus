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
import { join } from 'node:path';
import { type PluginManifest, type PluginPermissionsSummary, type PluginToolEffect, pluginRuntime, pluginStoreQuota } from '@/shared/plugin-package';
import { fileSha256, uiTreeHash } from './integrity';
import { uiDirOf } from './manifest-ui-host';

/**
 * The level a package may see, from its manifest alone: its `maxProtection`,
 * or when it declares none: a package that reaches the network leaves the
 * house (1), and so does one that may have the host fetch any URL it names
 * (`web:read`: the URL itself can carry data out) or run an agent that
 * searches and fetches the web on a prompt it writes (`agent:run`), or send
 * mail to any address (`mail:send`); one that can do none of these keeps
 * everything in (4).
 *
 * A package with pages is 1 whatever it declares: a page can navigate its
 * frame to any website with what it was shown in the URL
 * (docs/PLUGIN-PACKAGES.md#pages), an egress nothing declares or enforces.
 * The permissions summary (`computePermissions`), so the CLI and an index,
 * carry this clamped value.
 */
export function defaultMaxProtection(m: Pick<PluginManifest, 'maxProtection' | 'network' | 'host' | 'ui'>): 1 | 2 | 3 | 4 {
  if ((m.ui?.pages ?? []).length > 0) return 1;
  if (m.maxProtection !== undefined) return m.maxProtection;
  const host = m.host ?? [];
  return (m.network ?? []).length > 0 || host.includes('web:read') || host.includes('agent:run') || host.includes('mail:send') ? 1 : 4;
}

/** The permissions summary of a package (`octi plugin permissions --json`); the shape lives in src/shared so the web app reads the same type. */
export type PluginPermissions = PluginPermissionsSummary;

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (values: readonly string[] | undefined) => [...(values ?? [])].sort(byCodeUnit);

/**
 * Hashes of files the summary pins beyond the manifest: the prompt file's
 * bytes and the page directory's tree (./integrity.ts). Only where a package
 * directory is at hand (`packagePermissions`); without them both read null.
 */
export interface PermissionFileHashes {
  promptSha256: string | null;
  uiSha256: string | null;
}

const rolesOf = (roles: readonly string[] | undefined) => (roles === undefined ? {} : { roles: sorted(roles) });

/**
 * The permissions summary of a parsed manifest (`parseManifest`, the parser
 * install uses). `files` carries the hashes of the prompt file and the page
 * directory; without it they are null (a manifest alone). The host always
 * computes it with them (`packagePermissions`), so a listing must list them.
 */
export function computePermissions(manifest: PluginManifest, files: PermissionFileHashes = { promptSha256: null, uiSha256: null }): PluginPermissions {
  const tools = Object.entries(manifest.tools ?? {})
    .map(([name, decl]) => ({ name, effect: decl.effect }))
    .sort((a, b) => byCodeUnit(a.name, b.name));
  const effects: Record<PluginToolEffect, number> = { read: 0, write: 0, external: 0 };
  for (const tool of tools) effects[tool.effect] += 1;
  const pages = (manifest.ui?.pages ?? [])
    .map((p) => ({ path: p.path, title: p.title, entry: p.entry }))
    .sort((a, b) => byCodeUnit(a.path, b.path));
  return {
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    runtime: pluginRuntime(manifest),
    host: sorted(manifest.host),
    network: sorted(manifest.network),
    secrets: sorted((manifest.secrets ?? []).map((s) => s.key)),
    settings: sorted((manifest.settings ?? []).map((f) => f.key)),
    store: manifest.store ? { quotaBytes: pluginStoreQuota(manifest) as number } : null,
    tools,
    effects,
    contributions: {
      commands: (manifest.commands ?? [])
        .map((c) => ({ name: c.name, tool: c.tool, ...(c.input !== undefined ? { input: c.input } : {}) }))
        .sort((a, b) => byCodeUnit(a.name, b.name)),
      schedules: (manifest.schedules ?? [])
        .map((x) => ({ id: x.id, cron: x.cron, tool: x.tool, ...(x.input !== undefined ? { input: x.input } : {}) }))
        .sort((a, b) => byCodeUnit(a.id, b.id)),
      events: (manifest.events ?? []).map((e) => ({ on: e.on, tool: e.tool }))
        .sort((a, b) => byCodeUnit(a.on, b.on) || byCodeUnit(a.tool, b.tool)),
      prompt: manifest.prompt ? { file: manifest.prompt.file, sha256: files.promptSha256, ...rolesOf(manifest.prompt.roles) } : null,
      context: manifest.context ? { tool: manifest.context.tool, ...rolesOf(manifest.context.roles) } : null,
    },
    pages,
    ui: pages.length > 0 ? { dir: uiDirOf(manifest.ui), sha256: files.uiSha256 } : null,
    dashboards: (manifest.dashboards ?? [])
      .map((d) => ({
        id: d.id,
        title: d.title,
        // In their declared order: the order they are drawn in.
        widgets: d.widgets.map((w) => ({ id: w.id, type: w.type, title: w.title, tool: w.tool, ...(w.input !== undefined ? { input: w.input } : {}) })),
      }))
      .sort((a, b) => byCodeUnit(a.id, b.id)),
    trustedInput: manifest.model?.trustedInput === true,
    maxProtection: defaultMaxProtection(manifest),
  };
}

/**
 * The permissions summary of the package in `dir` (its source, a staged copy
 * or its installed directory): `computePermissions` with the prompt file's
 * sha256 and the page directory's tree hash read from it.
 */
export async function packagePermissions(manifest: PluginManifest, dir: string): Promise<PluginPermissions> {
  const promptSha256 = manifest.prompt ? await fileSha256(join(dir, ...manifest.prompt.file.split('/'))) : null;
  const uiSha256 = (manifest.ui?.pages ?? []).length > 0 ? await uiTreeHash(join(dir, ...uiDirOf(manifest.ui).split('/'))) : null;
  return computePermissions(manifest, { promptSha256, uiSha256 });
}
