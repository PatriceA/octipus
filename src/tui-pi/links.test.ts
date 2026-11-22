import { afterEach, expect, test } from 'vitest';
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

test('a clicked link opens only http, https and file, and never over SSH', () => {
  const reports: string[] = [];
  openUrl('javascript:alert(1)', message => reports.push(message), { command: 'true', args: [] });
  openUrl('https://x.example', message => reports.push(message), null);
  expect(reports).toEqual(['Not opened: only http, https and file links are opened.', expect.stringContaining('Over SSH')]);
  expect(openerFor('linux', { SSH_CONNECTION: '1 2 3 4' })).toBeNull();
  expect(openerFor('darwin', {})).toEqual({ command: 'open', args: [] });
  expect(openerFor('linux', {})).toEqual({ command: 'xdg-open', args: [] });
});
