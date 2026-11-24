import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An installed headless Chromium shell for tests that need a real browser:
 * the newest `chromium_headless_shell-*` under PLAYWRIGHT_BROWSERS_PATH or
 * /opt/pw-browsers, or '' when there is none. Tests pass it as
 * `executablePath`, so a Playwright upgrade whose own browser build is not
 * downloaded yet does not turn them red, and skip when it is ''.
 */
export function installedChromium(): string {
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter((r): r is string => !!r)) {
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names.filter((n) => n.startsWith('chromium_headless_shell-')).sort().reverse()) {
      const candidate = join(root, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}
