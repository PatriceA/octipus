import { afterEach, expect, test, vi } from 'vitest';

const child = vi.hoisted(() => ({ spawn: vi.fn(() => ({ on: () => {}, unref: () => {} })) }));
vi.mock('node:child_process', () => ({ spawn: child.spawn }));
import { fileUrlFor } from '@/tui-kit/hyperlinks';
import { configureLinks, finishRows, linkPlain, openerFor, openUrl } from './links';
import { MessagesPane } from './components/messages-pane';

afterEach(() => configureLinks({ enabled: false, cwd: process.cwd() }));

test('off: text is left alone, but an unsafe link pi-tui wrote is still dropped', () => {
  expect(linkPlain('see https://x.example')).toBe('see https://x.example');
  expect(finishRows(['\x1b]8;;javascript:x\x1b\\a\x1b]8;;\x1b\\'])).toEqual(['a\x1b]8;;\x1b\\']);
});

test('on: replies and notices in the transcript are linked', () => {
  configureLinks({ enabled: true, cwd: '/repo' });
  const pane = new MessagesPane({ maxVisible: 20 });
  pane.push({ role: 'system', content: 'Wrote src/a.ts:3, see https://x.example/y', timestamp: new Date() });
  const rows = pane.render(80).join('\n');
  expect(rows).toContain('\x1b]8;;https://x.example/y\x1b\\');
  expect(rows).toMatch(/\x1b\]8;;file:\/\/[^\x1b]*\/repo\/src\/a\.ts\x1b\\/);
});

test('a clicked link opens only http and https, and never over SSH', () => {
  const reports: string[] = [];
  openUrl('javascript:alert(1)', message => reports.push(message), { command: 'true', args: [] });
  openUrl('https://x.example', message => reports.push(message), null);
  expect(reports).toEqual(['Not opened: only http and https links, and files on this machine, are followed.', expect.stringContaining('Over SSH')]);
  expect(openerFor('linux', { SSH_CONNECTION: '1 2 3 4' })).toBeNull();
  expect(openerFor('darwin', {})).toEqual({ command: 'open', args: [] });
  expect(openerFor('linux', {})).toEqual({ command: 'xdg-open', args: [] });
});

test('a clicked local file is never handed to the opener: its path is copied and the flash says so', async () => {
  const reports: string[] = [];
  const copied: string[] = [];
  const opener = { command: 'touch', args: [] as string[] };
  child.spawn.mockClear();
  // A model-written `notes.command:1` on macOS: `open` would run it.
  openUrl(fileUrlFor('notes.command:1', '/repo'), message => reports.push(message), opener, async text => { copied.push(text); return { ok: true, message: 'Copied' }; });
  await vi.waitFor(() => expect(reports).toHaveLength(1));
  expect(child.spawn).not.toHaveBeenCalled();
  expect(copied).toEqual(['/repo/notes.command']);
  expect(reports[0]).toBe('Copied the path (files are not opened from a click): /repo/notes.command');
});

test('a file link to another host is neither linked nor opened (a UNC share leaks NTLM credentials)', () => {
  const reports: string[] = [];
  child.spawn.mockClear();
  openUrl('file://attacker.example/share/x.exe', message => reports.push(message), { command: 'touch', args: [] });
  expect(child.spawn).not.toHaveBeenCalled();
  expect(reports).toEqual([expect.stringContaining('Not opened')]);
  expect(finishRows(['\x1b]8;;file://attacker.example/share\x1b\\x\x1b]8;;\x1b\\'])).toEqual(['x\x1b]8;;\x1b\\']);
});

test('a clicked web link still opens with the desktop opener', () => {
  child.spawn.mockClear();
  openUrl('https://x.example/docs', () => {}, { command: 'xdg-open', args: [] });
  expect(child.spawn).toHaveBeenCalledWith('xdg-open', ['https://x.example/docs'], { detached: true, stdio: 'ignore' });
});
