import { describe, expect, test } from 'vitest';
import { formatChangesMessage } from './changes-render';

describe('formatChangesMessage', () => {
  test('single-line status stays a plain system message', () => {
    const m = formatChangesMessage('Not a git repository — no changes to show.');
    expect(m.role).toBe('system');
    expect(m.content).toBe('Not a git repository — no changes to show.');
    expect(m.content).not.toContain('```');
  });

  test('a file list becomes a plain fenced assistant block (no diff lines)', () => {
    const body = 'Changes on main:\n  M  src/app.ts\n  ?? notes.txt\n\nRun /changes <path> to see a file’s diff.';
    const m = formatChangesMessage(body);
    expect(m.role).toBe('assistant');
    expect(m.content.startsWith('```\n')).toBe(true);
    expect(m.content.endsWith('\n```')).toBe(true);
    // No `diff` language tag — the list has no +/- lines.
    expect(m.content.startsWith('```diff')).toBe(false);
    expect(m.content).toContain('src/app.ts');
  });

  test('a unified diff becomes a ```diff fence', () => {
    const body = 'src/app.ts  (+1 −1)\n one\n-two\n+two and a half\n three';
    const m = formatChangesMessage(body);
    expect(m.role).toBe('assistant');
    expect(m.content.startsWith('```diff\n')).toBe(true);
    expect(m.content.endsWith('\n```')).toBe(true);
    expect(m.content).toContain('+two and a half');
  });

  test('a diff whose body contains ``` uses a longer outer fence (no break-out)', () => {
    // Diff of a markdown file: a patch line reintroduces a ``` fence.
    const body = 'README.md  (+1 −0)\n # Title\n+```js\n+code\n+```\n done';
    const m = formatChangesMessage(body);
    expect(m.role).toBe('assistant');
    // Inner run is 3 backticks, so the outer fence must be at least 4.
    expect(m.content.startsWith('````diff\n')).toBe(true);
    expect(m.content.endsWith('\n````')).toBe(true);
    // The embedded fence survives verbatim inside the block.
    expect(m.content).toContain('+```js');
  });

  test('trailing whitespace is trimmed before fencing', () => {
    const m = formatChangesMessage('line one\nline two\n\n  ');
    expect(m.content.endsWith('line two\n```')).toBe(true);
  });
});
