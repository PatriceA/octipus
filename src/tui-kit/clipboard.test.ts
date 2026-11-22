import { expect, test, vi } from 'vitest';
import { type ClipboardEnvironment, copyToClipboard, OSC52_MAX_BYTES } from './clipboard';

function environment(platform: NodeJS.Platform, env: Record<string, string>, results: Record<string, number | string> = {}) {
  const calls: string[] = [];
  const writes: string[] = [];
  const target: ClipboardEnvironment = {
    platform, env,
    run: vi.fn(async (command: string, args: string[]) => { calls.push([command, ...args].join(' ')); return results[command] ?? 'ENOENT'; }),
    writeTerminal: data => { writes.push(data); },
  };
  return { target, calls, writes };
}

test.each([
  ['darwin', {}, 'pbcopy', 'pbcopy'],
  ['win32', {}, 'clip.exe', 'clip.exe'],
  ['linux', { WSL_DISTRO_NAME: 'Ubuntu' }, 'clip.exe', 'clip.exe'],
  ['linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 'wl-copy', 'wl-copy'],
  ['linux', { DISPLAY: ':0' }, 'xclip', 'xclip -selection clipboard'],
] as const)('%s %j uses %s when it succeeds', async (platform, env, method, call) => {
  const e = environment(platform, env, { [method]: 0 });
  const result = await copyToClipboard('text', e.target);
  expect(result).toMatchObject({ ok: true, method });
  expect(result.message).toContain(method);
  expect(e.calls).toEqual([call]);
  expect(e.writes).toEqual([]);
});

test('a tool that is missing or fails moves on to the next, and the message says what was tried', async () => {
  const e = environment('linux', { DISPLAY: ':0' }, { xclip: 1, xsel: 'ENOENT' });
  const result = await copyToClipboard('text', e.target);
  expect(e.calls).toEqual(['xclip -selection clipboard', 'xsel --clipboard --input']);
  expect(result.method).toBe('osc52');
  expect(result.message).toContain('xclip failed (1)');
  expect(result.message).toContain('xsel is not installed');
});

test('over SSH no local tool is used: it would copy on the remote machine', async () => {
  const e = environment('darwin', { SSH_CONNECTION: '1 2 3 4' }, { pbcopy: 0 });
  const result = await copyToClipboard('text', e.target);
  expect(e.calls).toEqual([]);
  expect(result.method).toBe('osc52');
});

test('inside tmux the paste buffer comes before OSC 52', async () => {
  const e = environment('linux', { TMUX: '/tmp/tmux-0/default,1,0' }, { tmux: 0 });
  const result = await copyToClipboard('text', e.target);
  expect(e.calls).toEqual(['tmux load-buffer -w -']);
  expect(result).toMatchObject({ ok: true, method: 'tmux' });
});

test('OSC 52 is the last resort, sent and described as unconfirmed', async () => {
  const e = environment('linux', {});
  const result = await copyToClipboard('héllo 🐙', e.target);
  expect(e.writes).toEqual([`\x1b]52;c;${Buffer.from('héllo 🐙').toString('base64')}\x07`]);
  expect(result).toMatchObject({ ok: true, method: 'osc52' });
  expect(result.message).toContain('refused');
});

test('when nothing can take the text it says so and claims nothing', async () => {
  const e = environment('linux', {});
  const result = await copyToClipboard('x'.repeat(OSC52_MAX_BYTES + 1), e.target);
  expect(result.ok).toBe(false);
  expect(result.method).toBeUndefined();
  expect(result.message).toMatch(/^Not copied/);
  expect(e.writes).toEqual([]);
});
