/**
 * Starting points for a plugin package (creator mode,
 * docs/PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent): each directory of
 * src/plugins/templates is a complete, valid package — a manifest and a
 * dependency-free MCP server in plain `.mjs` — that an agent reads with
 * `plugin_template`, writes into its workspace and edits.
 *
 * The production build copies the directory next to the bundle
 * (`dist/plugin-templates`, scripts/build.ts); from source it is read in place.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PLUGIN_MANIFEST_FILE } from '@/shared/plugin-package';

/** The most a template file may hold: they are small by design. */
const MAX_TEMPLATE_FILE_BYTES = 64 * 1024;
const TEMPLATE_NAME_RE = /^[a-z][a-z0-9-]{0,49}$/;

/** Where the templates are: beside the bundle when built, in the source tree otherwise. */
export function templatesRoot(): string {
  const here = import.meta.dirname;
  const candidates = [join(here, 'plugin-templates'), resolve(here, '..', '..', 'templates')];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[candidates.length - 1];
}

export interface PluginTemplateSummary {
  name: string;
  /** The template manifest's description: what it shows. */
  description: string;
  /** What it declares besides tools: commands, schedules, events, prompt, context. */
  contributes: string[];
}

export interface PluginTemplate extends PluginTemplateSummary {
  /** Every file, path relative to the package root → its text. */
  files: Record<string, string>;
}

async function readTemplateFiles(dir: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, await readTemplateFiles(dir, path));
    else if (entry.isFile()) {
      if ((await stat(join(dir, path))).size > MAX_TEMPLATE_FILE_BYTES) continue;
      out[path] = await readFile(join(dir, path), 'utf8');
    }
  }
  return out;
}

function summary(name: string, manifest: Record<string, unknown>): PluginTemplateSummary {
  const contributes = ['commands', 'schedules', 'events', 'prompt', 'context'].filter((key) => {
    const v = manifest[key];
    return Array.isArray(v) ? v.length > 0 : v !== undefined;
  });
  return { name, description: String(manifest.description ?? ''), contributes };
}

/** Every template, by name. */
export async function listTemplates(): Promise<PluginTemplateSummary[]> {
  const root = templatesRoot();
  const names = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && TEMPLATE_NAME_RE.test(e.name)).map((e) => e.name).sort();
  const out: PluginTemplateSummary[] = [];
  for (const name of names) {
    const manifest = JSON.parse(await readFile(join(root, name, PLUGIN_MANIFEST_FILE), 'utf8').catch(() => '{}')) as Record<string, unknown>;
    out.push(summary(name, manifest));
  }
  return out;
}

/** One template with its files, or null when there is none of that name. */
export async function readTemplate(name: string): Promise<PluginTemplate | null> {
  if (!TEMPLATE_NAME_RE.test(name)) return null;
  const dir = join(templatesRoot(), name);
  if (!existsSync(join(dir, PLUGIN_MANIFEST_FILE))) return null;
  const files = await readTemplateFiles(dir);
  return { ...summary(name, JSON.parse(files[PLUGIN_MANIFEST_FILE] ?? '{}') as Record<string, unknown>), files };
}
