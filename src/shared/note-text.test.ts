import { describe, expect, test } from 'vitest';
import { bodyPreview, noteTitleFrom, taskLineAt, TITLE_MAX, toggleSeenTask, toggleTaskAt } from './note-text';

describe('noteTitleFrom', () => {
  test('takes the first line with text, read as plain text', () => {
    expect(noteTitleFrom('Shopping list\nmilk')).toBe('Shopping list');
    expect(noteTitleFrom('\n\n  # 2026-11-23\n\n## Notes')).toBe('2026-11-23');
    expect(noteTitleFrom('- [ ] **Call** the [[dentists/anna|dentist]]')).toBe('Call the dentist');
    expect(noteTitleFrom('> a [link](https://example.com) and `code` and *soft*')).toBe('a link and code and soft');
    expect(noteTitleFrom('1. [[Plan]]')).toBe('Plan');
  });

  test('skips a properties block and is empty for a note with no text', () => {
    expect(noteTitleFrom('---\ntags: [a]\n---\nReal title')).toBe('Real title');
    expect(noteTitleFrom('')).toBe('');
    expect(noteTitleFrom('#  \n -  \n')).toBe('');
  });

  test('keeps a tag and cuts a long line', () => {
    expect(noteTitleFrom('#idea for later')).toBe('#idea for later');
    const long = noteTitleFrom('word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('toggleTaskAt', () => {
  const body = '# Day\n- [ ] milk\n  - [x] eggs\n1. [ ] call\n> - [ ] quoted\nplain [ ] text';

  test('flips the task on the line holding the offset', () => {
    expect(toggleTaskAt(body, body.indexOf('milk'))).toBe(body.replace('- [ ] milk', '- [x] milk'));
    expect(toggleTaskAt(body, body.indexOf('  - [x]'))).toBe(body.replace('[x] eggs', '[ ] eggs'));
    expect(toggleTaskAt(body, body.indexOf('call'))).toBe(body.replace('1. [ ] call', '1. [x] call'));
    expect(toggleTaskAt(body, body.indexOf('quoted'))).toBe(body.replace('> - [ ] quoted', '> - [x] quoted'));
  });

  test('sets the state when asked, and leaves other lines alone', () => {
    expect(toggleTaskAt(body, body.indexOf('eggs'), true)).toBe(body);
    expect(toggleTaskAt('- [X] Done', 0, false)).toBe('- [ ] Done');
    expect(toggleTaskAt(body, body.indexOf('plain'))).toBeNull();
    expect(toggleTaskAt(body, 0)).toBeNull();
    expect(toggleTaskAt(body, body.length + 1)).toBeNull();
    // The last line, with no newline after it.
    expect(toggleTaskAt('a\n- [ ] end', 9)).toBe('a\n- [x] end');
  });
});

describe('a task whose box is on the next line', () => {
  test('is ticked from its item line, as the reading view draws it', () => {
    expect(toggleTaskAt('-\n  [ ] x', 0)).toBe('-\n  [x] x');
    expect(toggleTaskAt('> -\n> [x] quoted', 0)).toBe('> -\n> [ ] quoted');
    expect(toggleTaskAt('-\n\n  [ ] x', 0)).toBeNull();
  });
});

describe('toggleSeenTask', () => {
  const seen = 'intro\n- [ ] milk\n- [ ] eggs';
  const eggs = seen.indexOf('- [ ] eggs');
  const line = taskLineAt(seen, eggs) as string;

  test('ticks the task at the offset while that line is unchanged', () => {
    expect(toggleSeenTask(seen, eggs, line)).toBe('intro\n- [ ] milk\n- [x] eggs');
  });

  test('finds the task when the text moved under it, and refuses when it is gone or ambiguous', () => {
    // Someone added a line above meanwhile (a live note).
    const moved = 'intro\nnew line\n- [ ] milk\n- [ ] eggs';
    expect(toggleSeenTask(moved, eggs, line)).toBe('intro\nnew line\n- [ ] milk\n- [x] eggs');
    // Already ticked by someone else: still the same task, set to the state asked for.
    expect(toggleSeenTask('intro\n- [ ] milk\n- [x] eggs', eggs, line, true)).toBe('intro\n- [ ] milk\n- [x] eggs');
    expect(toggleSeenTask('intro\n- [ ] milk', eggs, line)).toBeNull();
    expect(toggleSeenTask('a line longer than the offset\n- [ ] eggs\n- [ ] eggs', eggs, line)).toBeNull();
  });
});

describe('bodyPreview', () => {
  test('reads only what a row can show, and drops a cut title line', () => {
    const big = `${'Long title '.repeat(20)}\n${'- [ ] item **x** with [[link]]\n'.repeat(20000)}`;
    const t0 = performance.now();
    const preview = bodyPreview(big, noteTitleFrom(big));
    expect(performance.now() - t0).toBeLessThan(20);
    expect(preview.startsWith('item x with link · item x')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(140);
  });

  test('drops the title line and joins the rest as plain text', () => {
    expect(bodyPreview('# Shopping\n\n- [ ] milk\n- eggs', 'Shopping')).toBe('milk · eggs');
    expect(bodyPreview('Plant tomatoes in May.', 'Garden plan')).toBe('Plant tomatoes in May.');
    expect(bodyPreview(undefined, 'x')).toBe('');
    expect(bodyPreview('t\n' + 'a'.repeat(300), 't', 20)).toHaveLength(20);
  });
});
