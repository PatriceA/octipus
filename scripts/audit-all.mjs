#!/usr/bin/env node
// Audit all independently locked packages, including build/development dependencies.
// A finding passes only when scripts/audit-exceptions.json accepts it, and an
// exception past its review date fails the audit until it is looked at again.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditFindings } from './audit-exceptions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const exceptions = JSON.parse(readFileSync(resolve(here, 'audit-exceptions.json'), 'utf8'));
const today = new Date().toISOString().slice(0, 10);
let failed = false;
for (const folder of ['.', 'web', 'mcp-server']) {
  console.log(`\nDependency audit: ${folder}`);
  // Invoke npm's JS entry through Node: no shell quoting or Windows .cmd ambiguity.
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this command with npm run audit:all.');
  const result = spawnSync(process.execPath, [npmCli, 'audit', '--include=dev', '--audit-level=low', '--json'], {
    cwd: resolve(root, folder), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  // npm audit exits non-zero whenever it finds anything: the report decides, not the exit code.
  if (result.error || !report || report.error) {
    console.error(`  The audit could not complete: ${result.error?.message ?? report?.error?.summary ?? (result.stderr || 'no report').trim()}`);
    failed = true;
    continue;
  }
  const { open, accepted, expired } = auditFindings(report, exceptions, folder, today);
  for (const e of expired) {
    console.error(`  Exception ${e.advisory} (${e.package}) was due for review on ${e.reviewBy}: check whether it can go, then extend or remove it in scripts/audit-exceptions.json.`);
  }
  for (const v of open) {
    console.error(`  ${v.severity}: ${v.name}${v.advisories.length ? ` — ${v.advisories.join('; ')}` : ''}${v.dependsOn.length ? ` (depends on ${v.dependsOn.join(', ')})` : ''}`);
  }
  if (accepted.length) console.log(`  Accepted (scripts/audit-exceptions.json): ${accepted.join(', ')}`);
  if (open.length === 0 && expired.length === 0) console.log('  found 0 vulnerabilities outside the accepted exceptions');
  else failed = true;
}
if (failed) console.error('\nOne or more audits reported vulnerabilities or could not complete. Review each report above (`npm audit` in that folder has the details). No dependency versions were changed.');
process.exitCode = failed ? 1 : 0;
