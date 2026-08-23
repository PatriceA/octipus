/**
 * Installer for the `ollama` capability — Ollama runs as a system
 * service and its installer needs sudo on most platforms, so we never
 * auto-run it without explicit consent.
 *
 * Setting OCTIPUS_OLLAMA_AUTO_INSTALL=1 in the env opts in to running
 * `curl -fsSL https://ollama.com/install.sh | sh` on Linux. Otherwise
 * we return the install hint and let the user run it themselves.
 */

import { platform } from 'node:os';
import type { InstallerModule } from '@/capabilities/service';
import { spawnProcess } from '@/utils/proc';

const installer: InstallerModule = {
  kind: 'shell',
  install: async () => {
    const os = platform();
    const auto = process.env.OCTIPUS_OLLAMA_AUTO_INSTALL === '1';

    if (!auto || os !== 'linux') {
      const hint =
        os === 'darwin'
          ? 'macOS: brew install ollama  (or download from https://ollama.com/download)'
          : os === 'win32'
            ? 'Windows: install from https://ollama.com/download'
            : 'Linux: curl -fsSL https://ollama.com/install.sh | sh  (or set OCTIPUS_OLLAMA_AUTO_INSTALL=1 to let this command run it)';
      return { ok: false, detail: `Ollama install is manual by default. ${hint}` };
    }

    try {
      const proc = spawnProcess(['sh', '-c', 'curl -fsSL https://ollama.com/install.sh | sh'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exit !== 0) {
        return { ok: false, detail: `ollama install exited ${exit}: ${stderr.slice(-500)}`, output: stdout + stderr };
      }
      return { ok: true, detail: 'Ollama installed. Start it with `ollama serve` (or your distro service manager).', output: stdout };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

export default installer;
