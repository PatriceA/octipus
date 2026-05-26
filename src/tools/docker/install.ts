/**
 * Installer for the `docker` capability — Docker is not auto-installable
 * because it needs system-level setup (kernel modules, user groups,
 * service management). The installer returns instructions instead.
 */

import { platform } from 'node:os';
import type { InstallerModule } from '@/capabilities/service';

const installer: InstallerModule = {
  kind: 'manual',
  install: async () => {
    const os = platform();
    const hint =
      os === 'darwin'
        ? 'macOS: install Docker Desktop from https://www.docker.com/products/docker-desktop'
        : os === 'win32'
          ? 'Windows: install Docker Desktop from https://www.docker.com/products/docker-desktop'
          : 'Linux: follow https://docs.docker.com/engine/install/ — then add your user to the `docker` group and re-login.';
    return {
      ok: false,
      detail: `Docker requires manual install. ${hint}`,
    };
  },
};

export default installer;
