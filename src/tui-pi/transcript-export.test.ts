import { expect, test } from 'vitest';
import { defaultExportName, EXIT_SUMMARY_LINES, exitSummary, transcriptMarkdown, transcriptPlainText } from './transcript-export';

const at = new Date('2026-11-22T10:30:00Z');
const id = '0f3b2a1c-1111-4111-8111-111111111111';
const entries = [
  { role: 'system' as const, content: 'Welcome', timestamp: at },
  { role: 'user' as const, content: 'first', timestamp: at },
  { role: 'assistant' as const, content: 'one', timestamp: at },
  { role: 'user' as const, content: 'second?', timestamp: at },
  { role: 'system' as const, content: '→ shell', timestamp: at },
  { role: 'assistant' as const, content: 'two\x1b[2J', timestamp: at },
  { role: 'user' as const, content: '/quit', timestamp: at },
];

test('the exit summary is the last thing asked and its reply, then the resume command; no escape sequence reaches the shell', () => {
  const text = exitSummary(entries, id);
  expect(text).toBe(`You:\nsecond?\n\nOctipus:\ntwo\n\nResume this conversation: octi tui --session ${id}`);
});

test('nothing sent: nothing to resume', () => {
  expect(exitSummary([], null)).toBe('');
  expect(exitSummary(entries, null)).not.toContain('octi tui');
});

test('a long reply is clipped with a count of what was left out', () => {
  const long = Array.from({ length: EXIT_SUMMARY_LINES + 5 }, (_, n) => `line ${n}`).join('\n');
  const text = exitSummary([{ role: 'user', content: 'q', timestamp: at }, { role: 'assistant', content: long, timestamp: at }], id);
  expect(text).toContain(`line ${EXIT_SUMMARY_LINES - 1}\n… 5 more lines`);
  expect(text).not.toContain(`line ${EXIT_SUMMARY_LINES}\n`);
});

test('Markdown keeps text as received, headed per message; notices are quoted', () => {
  const markdown = transcriptMarkdown(entries, id, at);
  expect(markdown.startsWith(`# Octipus session ${id}\n`)).toBe(true);
  expect(markdown).toContain('## You · 2026-11-22 10:30\n\nsecond?');
  expect(markdown).toContain('## Notice · 2026-11-22 10:30\n\n> → shell');
  expect(markdown).toContain('two\x1b[2J');
  expect(defaultExportName(id, at)).toBe('octipus-0f3b2a1c-20261122-103000.md');
});

test('the scrollback dump is printable text', () => {
  expect(transcriptPlainText(entries)).not.toContain('\x1b');
  expect(transcriptPlainText(entries)).toContain('Octipus:\ntwo\n');
});
