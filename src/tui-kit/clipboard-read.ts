/**
 * Read the user's clipboard, for pasting with a key rather than through the
 * terminal (whose own paste, Ctrl+Shift+V or Cmd+V, arrives as bracketed
 * paste and needs none of this).
 *
 * Tried in the order `clipboard.ts` copies: a native tool when the terminal
 * is local (`pbpaste`, PowerShell's `Get-Clipboard`, `wl-paste`, `xclip -o`,
 * `xsel -o`), then the tmux paste buffer. A terminal cannot be asked for its
 * clipboard (OSC 52 reads are refused almost everywhere), so with none of
 * these the result is `null` and says why, and the caller falls back to what
 * it copied itself.
 */
import { spawn } from 'node:child_process';

export interface ClipboardReadEnvironment {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Run a command and collect stdout; resolves to the text, or to the exit code / spawn error code when it failed. */
  read(command: string, args: string[]): Promise<{ ok: true; text: string } | { ok: false; status: number | string }>;
}

export interface ClipboardReadResult {
  text: string | null;
  /** Which tool gave the text, or why none did. */
  message: string;
}

function readCommand(command: string, args: string[]): Promise<{ ok: true; text: string } | { ok: false; status: number | string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: globalThis.Buffer[] = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, status: 'ETIMEDOUT' }); }, 3000);
    child.stdout.on('data', (chunk: globalThis.Buffer) => chunks.push(chunk));
    child.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ ok: false, status: error.code ?? error.message }); });
    child.once('close', code => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true, text: globalThis.Buffer.concat(chunks).toString('utf8') } : { ok: false, status: code ?? 'killed' });
    });
  });
}

export function defaultClipboardReadEnvironment(): ClipboardReadEnvironment {
  return { platform: process.platform, env: process.env, read: readCommand };
}

interface Candidate { name: string; command: string; args: string[] }

function candidates(platform: NodeJS.Platform, env: ClipboardReadEnvironment['env']): Candidate[] {
  const out: Candidate[] = [];
  // Over SSH a tool would read the remote machine's clipboard, not the user's.
  if (!env.SSH_CONNECTION && !env.SSH_TTY) {
    if (platform === 'darwin') out.push({ name: 'pbpaste', command: 'pbpaste', args: [] });
    else if (platform === 'win32' || env.WSL_DISTRO_NAME) out.push({ name: 'Get-Clipboard', command: 'powershell.exe', args: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'] });
    else {
      if (env.WAYLAND_DISPLAY) out.push({ name: 'wl-paste', command: 'wl-paste', args: ['--no-newline'] });
      if (env.DISPLAY) {
        out.push({ name: 'xclip', command: 'xclip', args: ['-selection', 'clipboard', '-o'] });
        out.push({ name: 'xsel', command: 'xsel', args: ['--clipboard', '--output'] });
      }
    }
  }
  if (env.TMUX) out.push({ name: 'tmux', command: 'tmux', args: ['save-buffer', '-'] });
  return out;
}

export async function readClipboard(environment: ClipboardReadEnvironment = defaultClipboardReadEnvironment()): Promise<ClipboardReadResult> {
  const failures: string[] = [];
  for (const candidate of candidates(environment.platform, environment.env)) {
    const result = await environment.read(candidate.command, candidate.args);
    if (result.ok) return { text: candidate.name === 'Get-Clipboard' ? result.text.replace(/\r?\n$/, '') : result.text, message: `Pasted from ${candidate.name}.` };
    failures.push(`${candidate.name} ${result.status === 'ENOENT' ? 'is not installed' : `failed (${result.status})`}`);
  }
  return { text: null, message: failures.length ? `The clipboard could not be read (${failures.join('; ')}).` : 'No clipboard tool can be used here.' };
}
