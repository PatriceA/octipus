import { expect, test } from 'vitest';
import { type ClipboardReadEnvironment, readClipboard } from './clipboard-read';

function environment(platform: NodeJS.Platform, env: Record<string, string>, answers: Record<string, string | number>) {
  const calls: string[] = [];
  const read: ClipboardReadEnvironment['read'] = async (command) => {
    calls.push(command);
    const answer = answers[command] ?? 'ENOENT';
    return typeof answer === 'string' && answer.startsWith('text:') ? { ok: true, text: answer.slice(5) } : { ok: false, status: answer };
  };
  return { environment: { platform, env, read }, calls };
}

test('reads with the platform tool, then the next one, then tmux', async () => {
  const mac = environment('darwin', {}, { pbpaste: 'text:from mac' });
  expect(await readClipboard(mac.environment)).toEqual({ text: 'from mac', message: 'Pasted from pbpaste.' });

  const x11 = environment('linux', { DISPLAY: ':0' }, { xclip: 1, xsel: 'text:from xsel' });
  expect((await readClipboard(x11.environment)).text).toBe('from xsel');
  expect(x11.calls).toEqual(['xclip', 'xsel']);

  const tmux = environment('linux', { TMUX: '/tmp/t' }, { tmux: 'text:buffer' });
  expect((await readClipboard(tmux.environment)).text).toBe('buffer');
});

test('over SSH no local tool is used, and with nothing to read the result says why', async () => {
  const ssh = environment('darwin', { SSH_TTY: '/dev/pts/1' }, { pbpaste: 'text:remote' });
  const result = await readClipboard(ssh.environment);
  expect(result.text).toBeNull();
  expect(ssh.calls).toEqual([]);
  expect(result.message).toBe('No clipboard tool can be used here.');

  const missing = environment('linux', { WAYLAND_DISPLAY: 'w' }, {});
  expect((await readClipboard(missing.environment)).message).toBe('The clipboard could not be read (wl-paste is not installed).');
});
