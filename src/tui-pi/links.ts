/**
 * Where the transcript links URLs and `path:line` references (OSC 8), and
 * how a clicked link is opened.
 *
 * `configureLinks` is set once by the chat (whether the terminal shows
 * links, and the project directory that relative paths are read from).
 * Everything rendered goes through `linkPlain` (plain text, before
 * wrapping) or `finishRows` (rows pi-tui's Markdown styled), and the latter
 * always drops a link whose URL is not `http`, `https` or `file`.
 *
 * On the alternate screen with app mouse the app receives the click, not the
 * terminal, so `openUrl` opens the link with the desktop's opener — never
 * over SSH, where it would open on the remote machine.
 */
import { spawn } from 'node:child_process';
import { linkify, linkifyStyled, safeUrl, sanitizeHyperlinks } from '@/tui-kit/hyperlinks';

let config = { enabled: false, cwd: process.cwd() };

export function configureLinks(next: { enabled: boolean; cwd: string }): void { config = { ...next }; }
export function linksEnabled(): boolean { return config.enabled; }

/** Plain text, before it is wrapped: its URLs and `path:line` references linked. */
export function linkPlain(text: string): string {
  return config.enabled ? linkify(text, config.cwd) : text;
}

/** Rows Markdown rendered: unsafe links dropped, `path:line` references linked. */
export function finishRows(rows: readonly string[]): string[] {
  return rows.map(row => {
    const safe = sanitizeHyperlinks(row);
    return config.enabled ? linkifyStyled(safe, config.cwd) : safe;
  });
}

/** The command that opens a URL on this machine, or null where there is none to use. */
export function openerFor(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | null {
  if (env.SSH_CONNECTION || env.SSH_TTY) return null;
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') return { command: 'explorer.exe', args: [] };
  if (env.WSL_DISTRO_NAME) return { command: 'wslview', args: [] };
  return { command: 'xdg-open', args: [] };
}

/** Open a clicked link; `report` says why not, or that the opener failed. */
export function openUrl(url: string, report: (message: string) => void, opener = openerFor()): void {
  const href = safeUrl(url);
  if (!href) { report('Not opened: only http, https and file links are opened.'); return; }
  if (!opener) { report('Over SSH links are not opened here: Shift+click (Option+click) lets your terminal open it.'); return; }
  const child = spawn(opener.command, [...opener.args, href], { detached: true, stdio: 'ignore' });
  child.on('error', error => report(`Could not open the link with ${opener.command}: ${error.message}`));
  child.unref();
}
