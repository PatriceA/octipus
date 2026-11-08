#!/usr/bin/env tsx
/**
 * `octi plugin <subcommand>` (WS3).
 *
 *   octi plugin validate <dir>   Validate a plugin against the contract.
 *   octi plugin convert <dir>    Convert a legacy plugin into a plugin package.
 *
 * Delegated from bin/octi.ts. Uses the published validation kit so authors and
 * the host run identical checks.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validatePlugin } from '@octipus/plugin-sdk/testing';
import { ConvertError, convertLegacyPlugin } from '@/plugins/convert';
import { PLUGIN_TOOL_EFFECTS, type PluginToolEffect } from '@/shared/plugin-package';

const HELP = `octi plugin — plugin tooling

Usage:
  octi plugin validate <dir>    Validate a plugin directory against the contract
  octi plugin convert <legacy-dir> [--out <dir>] [--effect <tool>=<read|write|external>]... [--network <host>]...
                                Convert a legacy plugin (plugin.json) into a plugin
                                package (octipus-plugin.json + MCP server). Every tool
                                is "external" (always ask) unless --effect lowers it.
`;

async function runValidate(dir: string): Promise<never> {
  const abs = resolve(dir);
  const report = await validatePlugin(abs);

  for (const p of report.passed) process.stdout.write(`  ✓ ${p}\n`);
  for (const w of report.warnings) process.stdout.write(`  ⚠ ${w}\n`);
  for (const e of report.errors) process.stderr.write(`  ✗ ${e}\n`);

  if (report.ok) {
    process.stdout.write(`\n✅ ${abs} is a valid plugin${report.warnings.length ? ' (with warnings)' : ''}.\n`);
    process.exit(0);
  }
  process.stderr.write(`\n❌ ${abs} failed validation (${report.errors.length} error(s)).\n`);
  process.exit(1);
}

async function runConvert(argv: string[]): Promise<never> {
  let parsed: ReturnType<typeof parseConvertArgs>;
  try {
    parsed = parseConvertArgs(argv);
  } catch (err) {
    process.stderr.write(`octi plugin convert: ${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  try {
    const result = await convertLegacyPlugin(parsed.dir, { outDir: parsed.out, effects: parsed.effects, network: parsed.network });
    for (const w of result.warnings) process.stdout.write(`  ⚠ ${w}\n`);
    const m = result.manifest;
    process.stdout.write(`\n✅ Wrote the plugin package "${m.name}" ${m.version} to ${result.outDir}\n`);
    for (const [tool, decl] of Object.entries(m.tools)) process.stdout.write(`  ${tool}: ${decl.effect}\n`);
    process.stdout.write(`  network: ${m.network?.length ? m.network.join(', ') : 'none'}; maxProtection: ${m.maxProtection}\n`);
    process.stdout.write('\nReview the effects (lower one with --effect <tool>=read once you have read its handler),\n'
      + `then install it: POST /api/plugin-packages { "path": "${result.outDir}" }\n`);
    process.exit(0);
  } catch (err) {
    if (!(err instanceof ConvertError)) throw err;
    for (const p of err.problems) process.stderr.write(`  ✗ ${p}\n`);
    process.stderr.write(`\n❌ ${resolve(parsed.dir)} cannot be converted (${err.problems.length} problem(s)).\n`);
    process.exit(1);
  }
}

function parseConvertArgs(argv: string[]): { dir: string; out?: string; effects: Record<string, PluginToolEffect>; network: string[] } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      effect: { type: 'string', multiple: true },
      network: { type: 'string', multiple: true },
    },
  });
  if (positionals.length !== 1) throw new Error(positionals.length ? 'expected one <legacy-dir>' : 'missing <legacy-dir>');
  const effects: Record<string, PluginToolEffect> = {};
  for (const spec of values.effect ?? []) {
    const [tool, effect] = spec.split('=');
    if (!tool || !PLUGIN_TOOL_EFFECTS.includes(effect as PluginToolEffect)) {
      throw new Error(`--effect "${spec}": expected <tool>=${PLUGIN_TOOL_EFFECTS.join('|')}`);
    }
    effects[tool] = effect as PluginToolEffect;
  }
  return { dir: positionals[0], out: values.out, effects, network: values.network ?? [] };
}

async function main(): Promise<void> {
  // The launchers start this from the project directory; paths on the command
  // line (and the default --out) are the user's, relative to where they ran it.
  if (process.env.OCTI_USER_CWD) process.chdir(process.env.OCTI_USER_CWD);
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'validate': {
      const dir = rest[0];
      if (!dir) {
        process.stderr.write('octi plugin validate: missing <dir>\n');
        process.exit(2);
      }
      await runValidate(dir);
      break;
    }
    case 'convert':
      await runConvert(rest);
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      process.exit(0);
      break;
    default:
      process.stderr.write(`octi plugin: unknown subcommand "${sub}"\n\n${HELP}`);
      process.exit(1);
  }
}

await main();
