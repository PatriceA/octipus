/**
 * The CLI suites spawn vendor CLIs with Octipus's tool bridge, which resolves
 * `mcp-server/dist/index.js` (`resolveCliMcpEntry`). CI builds it as a step of
 * its own; a clean checkout did not, and `npm test` then failed 156 tests with
 * "CLI tool bridge is not built" — one missing build reported as six failing
 * suites.
 *
 * So the run builds it first when it can (the bridge's dependencies are
 * installed), and otherwise says once, up front, what to run. Nothing happens
 * when the bridge is already built.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function ensureCliBridgeBuilt(root = resolve(import.meta.dirname, '../..')): 'present' | 'built' | 'missing' {
  const bridge = join(root, 'mcp-server');
  if (existsSync(join(bridge, 'dist', 'index.js'))) return 'present';
  if (!existsSync(join(bridge, 'node_modules'))) {
    console.warn('[test setup] mcp-server/dist is missing and mcp-server has no node_modules: the CLI suites will fail. Run: npm ci --prefix mcp-server && npm run build --prefix mcp-server');
    return 'missing';
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build'], { cwd: bridge, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`[test setup] building mcp-server failed (exit ${result.status}); the CLI suites need mcp-server/dist`);
  return 'built';
}

export default function setup(): void {
  ensureCliBridgeBuilt();
}
