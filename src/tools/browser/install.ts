/**
 * Installer for the `browser` capability — runs the Playwright
 * Chromium download. Reported through `octi capabilities install browser`
 * and the capability service's first-run flow.
 */

import type { InstallerModule } from '@/capabilities/service';
import { spawnProcess } from '@/utils/proc';

const installer: InstallerModule = {
  kind: 'bun-exec',
  install: async () => {
    try {
      const proc = spawnProcess(['npx', 'playwright', 'install', 'chromium'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exit !== 0) {
        return {
          ok: false,
          detail: `playwright install exited ${exit}: ${stderr.slice(-500)}`,
          output: stdout + stderr,
        };
      }
      return { ok: true, detail: 'Playwright Chromium installed.', output: stdout };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
  version: async () => {
    try {
      const proc = spawnProcess(['npx', 'playwright', '--version'], { stdout: 'pipe' });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      return out || null;
    } catch {
      return null;
    }
  },
};

export default installer;
