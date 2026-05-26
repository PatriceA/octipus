/**
 * Installer for the `browser-ext` capability — copies the unpacked
 * extension from the repo into `~/.octipus/browser-extension/` so the
 * user can load it as an unpacked Chrome extension. The bridge that
 * the agent uses to talk to the extension is a separate runtime
 * check (handled by the tool's own availability probe).
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InstallerModule } from '@/capabilities/service';

const installer: InstallerModule = {
  kind: 'copy',
  install: async () => {
    const src = resolve(process.cwd(), 'browser-extension');
    if (!existsSync(src)) {
      return { ok: false, detail: `Source not found: ${src}` };
    }
    const dest = join(homedir(), '.octipus', 'browser-extension');
    try {
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true });
      return {
        ok: true,
        detail: `Extension copied to ${dest}. Load it from chrome://extensions (Developer Mode → Load unpacked).`,
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

export default installer;
