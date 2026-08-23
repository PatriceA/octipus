/**
 * Installer for the `mcp` capability — builds the bundled MCP server
 * so external agents (Claude Code, Codex, Gemini CLI, etc.) can call
 * Octipus tools over the MCP protocol.
 *
 * mcp-server uses npm + tsc (Node ≥ 18), not Bun — its dependencies
 * include modules that don't play well with Bun's resolver.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InstallerModule } from '@/capabilities/service';
import { fileAt } from '@/utils/fs-file';
import { spawnProcess } from '@/utils/proc';

const installer: InstallerModule = {
  kind: 'npm-build',
  install: async () => {
    const cwd = resolve(process.cwd(), 'mcp-server');
    if (!existsSync(cwd)) {
      return { ok: false, detail: `mcp-server directory not found at ${cwd}` };
    }

    const run = async (cmd: string[], step: string) => {
      const proc = spawnProcess(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exit !== 0) {
        throw new Error(`${step} exited ${exit}: ${stderr.slice(-500)}`);
      }
      return stdout;
    };

    try {
      const out1 = await run(['npm', 'install', '--silent'], 'npm install');
      const out2 = await run(['npm', 'run', 'build', '--silent'], 'npm run build');
      return { ok: true, detail: 'MCP server built (mcp-server/dist/index.js).', output: out1 + out2 };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
  version: async () => {
    try {
      const pkg = await fileAt(resolve(process.cwd(), 'mcp-server', 'package.json')).json<{ version?: string }>();
      return pkg?.version ? `mcp-server@${pkg.version}` : null;
    } catch {
      return null;
    }
  },
};

export default installer;
