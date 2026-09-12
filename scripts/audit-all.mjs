#!/usr/bin/env node
// Audit all independently locked packages, including build/development dependencies.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
for (const folder of ['.', 'web', 'mcp-server']) {
  console.log(`\nDependency audit: ${folder}`);
  // Invoke npm's JS entry through Node: no shell quoting or Windows .cmd ambiguity.
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this command with npm run audit:all.');
  const result = spawnSync(process.execPath, [npmCli, 'audit'], {
    cwd: resolve(root, folder), stdio: 'inherit',
  });
  if (result.error || result.status !== 0) failed = true;
}
if (failed) console.error('\nOne or more audits reported vulnerabilities or could not complete. Review each report above. No dependency versions were changed.');
process.exitCode = failed ? 1 : 0;
