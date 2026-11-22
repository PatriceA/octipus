/**
 * Copy text to the user's clipboard, by the most reliable way available here.
 *
 *   1. A native tool, when the terminal is local: `pbcopy`, `clip.exe`,
 *      `wl-copy`, `xclip`, `xsel`. Their exit status says whether it worked.
 *   2. The tmux paste buffer, inside tmux (`load-buffer -w` also hands it to
 *      the outer terminal's clipboard when tmux's `set-clipboard` allows).
 *   3. OSC 52, a request written to the terminal. Terminals may refuse it and
 *      never say so, so the result says "requested", not "copied".
 *
 * The result always names the way that was used, or says plainly that none
 * worked and why; callers show that message instead of claiming success.
 */
import { spawn } from 'node:child_process';

export type ClipboardMethod = 'pbcopy' | 'clip.exe' | 'wl-copy' | 'xclip' | 'xsel' | 'tmux' | 'osc52';

export interface ClipboardResult {
  /** False when nothing took the text. OSC 52 counts as true: it was sent, not confirmed. */
  ok: boolean;
  method?: ClipboardMethod;
  /** One sentence for the user: what was used, or why nothing was. */
  message: string;
}

export interface ClipboardEnvironment {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Run a command with `input` on stdin; resolves to its exit code, or the spawn error's code (`ENOENT`). */
  run(command: string, args: string[], input: string): Promise<number | string>;
  /** Write an escape sequence to the terminal (the OSC 52 fallback). */
  writeTerminal(data: string): void;
}

/** Terminals cap OSC 52 payloads; xterm's default is about 100 kB of base64. */
export const OSC52_MAX_BYTES = 75_000;

function runCommand(command: string, args: string[], input: string): Promise<number | string> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('ETIMEDOUT'); }, 3000);
    child.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code ?? error.message); });
    child.once('exit', code => { clearTimeout(timer); resolve(code ?? 'killed'); });
    child.stdin.once('error', () => { /* the exit status reports the failure */ });
    child.stdin.end(input);
  });
}

export function defaultClipboardEnvironment(writeTerminal: (data: string) => void): ClipboardEnvironment {
  return { platform: process.platform, env: process.env, run: runCommand, writeTerminal };
}

interface Candidate { method: ClipboardMethod; command: string; args: string[] }

/** Native tools worth trying on this machine, in order; none over SSH, where they would copy on the remote host. */
function nativeCandidates(platform: NodeJS.Platform, env: ClipboardEnvironment['env']): Candidate[] {
  if (env.SSH_CONNECTION || env.SSH_TTY) return [];
  if (platform === 'darwin') return [{ method: 'pbcopy', command: 'pbcopy', args: [] }];
  if (platform === 'win32' || env.WSL_DISTRO_NAME) return [{ method: 'clip.exe', command: 'clip.exe', args: [] }];
  const found: Candidate[] = [];
  if (env.WAYLAND_DISPLAY) found.push({ method: 'wl-copy', command: 'wl-copy', args: [] });
  if (env.DISPLAY) {
    found.push({ method: 'xclip', command: 'xclip', args: ['-selection', 'clipboard'] });
    found.push({ method: 'xsel', command: 'xsel', args: ['--clipboard', '--input'] });
  }
  return found;
}

export async function copyToClipboard(text: string, environment: ClipboardEnvironment): Promise<ClipboardResult> {
  const { platform, env, run } = environment;
  const failures: string[] = [];
  for (const candidate of nativeCandidates(platform, env)) {
    const status = await run(candidate.command, candidate.args, text);
    if (status === 0) return { ok: true, method: candidate.method, message: `Copied with ${candidate.method}.` };
    failures.push(`${candidate.method} ${status === 'ENOENT' ? 'is not installed' : `failed (${status})`}`);
  }
  if (env.TMUX) {
    const status = await run('tmux', ['load-buffer', '-w', '-'], text);
    if (status === 0) return { ok: true, method: 'tmux', message: 'Copied to the tmux buffer (paste with prefix ]); tmux passes it on to your terminal if set-clipboard allows.' };
    failures.push(`tmux load-buffer failed (${status})`);
  }
  const tried = failures.length ? ` (${failures.join('; ')})` : '';
  if (Buffer.byteLength(text, 'utf8') > OSC52_MAX_BYTES) {
    return { ok: false, message: `Not copied: no clipboard tool worked${tried}, and the text is over the ${OSC52_MAX_BYTES / 1000} kB a terminal clipboard request allows.` };
  }
  environment.writeTerminal(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  return { ok: true, method: 'osc52', message: `Sent to your terminal as an OSC 52 clipboard request${tried}; if paste is empty, your terminal refused it.` };
}
