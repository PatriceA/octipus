#!/usr/bin/env tsx
/**
 * `octi plugin <subcommand>` (WS3).
 *
 *   octi plugin validate <dir>   Validate a plugin against the contract.
 *
 * Delegated from bin/octi.ts. Uses the published validation kit so authors and
 * the host run identical checks.
 */
import { resolve } from 'node:path';
import { validatePlugin } from '@octipus/plugin-sdk/testing';

const HELP = `octi plugin — plugin tooling

Usage:
  octi plugin validate <dir>    Validate a plugin directory against the contract
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

async function main(): Promise<void> {
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
