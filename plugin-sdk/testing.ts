/**
 * @octipus/plugin-sdk/testing — the plugin contract validation kit (WS3).
 *
 * `validatePlugin(dir)` runs the full pre-flight the host runs at load time:
 * manifest schema, apiVersion compatibility, module shape, an `initialize`
 * dry-run against a mock context, and a fixture dry-run of every declared tool.
 * Plugin authors import this in their own CI; the `octi plugin validate` CLI
 * and a repo CI job run it over `extensions/`.
 *
 * Portable (node fs + dynamic import) and zero-dependency.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkApiVersion,
  generateFixtureArgs,
  manifestTools,
  type PluginManifest,
  validateManifest,
} from './index';

export interface PluginValidationReport {
  ok: boolean;
  /** Fatal problems — the plugin would be refused by the host. */
  errors: string[];
  /** Non-fatal notes — legacy apiVersion, tools that threw on fixtures, etc. */
  warnings: string[];
  /** Human-readable "✓ …" lines for the checks that passed. */
  passed: string[];
}

/** A no-op logger + empty config, enough to dry-run a plugin's `initialize`. */
function mockContext(): unknown {
  const noop = () => {};
  return { logger: { info: noop, warn: noop, error: noop, debug: noop, child: () => mockContext() }, config: {} };
}

/**
 * Validate the plugin in `dir`. Never throws — returns a structured report.
 * `ok` is false only for fatal errors; tool dry-run failures are warnings
 * (a tool may legitimately reject synthetic fixtures).
 */
export async function validatePlugin(dir: string): Promise<PluginValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const passed: string[] = [];

  // 1. Manifest present + parseable.
  const manifestPath = join(dir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: [`no plugin.json in ${dir}`], warnings, passed };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`plugin.json is not valid JSON: ${(err as Error).message}`], warnings, passed };
  }

  // 2. Manifest schema.
  const result = validateManifest(raw);
  if (!result.ok) {
    return { ok: false, errors: result.errors, warnings, passed };
  }
  const manifest: PluginManifest = result.manifest;
  passed.push('manifest schema valid');

  // 3. apiVersion compatibility.
  const version = checkApiVersion(manifest.apiVersion);
  if (!version.ok) {
    errors.push(version.reason ?? 'apiVersion incompatible');
  } else if (version.legacy) {
    warnings.push(version.reason ?? 'legacy plugin (no apiVersion)');
  } else {
    passed.push(`apiVersion ${manifest.apiVersion} compatible`);
  }

  // 4. Entry module present + importable.
  const entryPath = join(dir, manifest.main);
  if (!existsSync(entryPath)) {
    errors.push(`entry file "${manifest.main}" not found`);
    return { ok: errors.length === 0, errors, warnings, passed };
  }
  let mod: Record<string, unknown>;
  try {
    const imported = (await import(pathToFileURL(entryPath).href)) as Record<string, unknown>;
    mod = (imported.default ?? imported) as Record<string, unknown>;
  } catch (err) {
    errors.push(`failed to import "${manifest.main}": ${(err as Error).message}`);
    return { ok: false, errors, warnings, passed };
  }

  // 5. Module shape.
  if (typeof mod?.name !== 'string') errors.push('module default export is missing a string "name"');
  const tools = mod?.tools as Record<string, unknown> | undefined;
  if (typeof tools !== 'object' || !tools) {
    errors.push('module default export is missing a "tools" object');
    return { ok: false, errors, warnings, passed };
  }
  passed.push('module shape valid');

  // 6. initialize dry-run (if declared).
  if (typeof mod.initialize === 'function') {
    try {
      await (mod.initialize as (ctx: unknown) => Promise<void>)(mockContext());
      passed.push('initialize() ran');
    } catch (err) {
      errors.push(`initialize() threw: ${(err as Error).message}`);
    }
  }

  // 7. Every declared tool exists + dry-runs against generated fixtures.
  for (const def of manifestTools(manifest)) {
    const impl = tools[def.name];
    if (typeof impl !== 'function') {
      errors.push(`declared tool "${def.name}" has no matching function in module.tools`);
      continue;
    }
    try {
      await (impl as (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>)(
        generateFixtureArgs(def.parameters),
        { config: {} },
      );
      passed.push(`tool "${def.name}" dry-run ok`);
    } catch (err) {
      warnings.push(`tool "${def.name}" threw on fixture input: ${(err as Error).message}`);
    }
  }

  // 8. Shutdown dry-run (best-effort).
  if (typeof mod.shutdown === 'function') {
    try {
      await (mod.shutdown as () => Promise<void>)();
      passed.push('shutdown() ran');
    } catch (err) {
      warnings.push(`shutdown() threw: ${(err as Error).message}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, passed };
}
