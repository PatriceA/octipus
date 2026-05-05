import { describe, expect, test } from 'bun:test';
import { FilePicker } from './file-picker';

const ROOT = '/tmp/example-project';
const FILES = [
  `${ROOT}/src/index.ts`,
  `${ROOT}/src/app.ts`,
  `${ROOT}/src/components/header.ts`,
  `${ROOT}/README.md`,
];

function makePicker() {
  let picked: string | null = null;
  let cancelled = false;
  const picker = new FilePicker({
    root: ROOT,
    files: FILES,
    onPick:   (p) => { picked = p; },
    onCancel: ()  => { cancelled = true; },
  });
  return { picker, get picked() { return picked; }, get cancelled() { return cancelled; } };
}

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m/g, ''); }

describe('FilePicker', () => {
  test('renders relative paths against the root', () => {
    const { picker } = makePicker();
    const text = picker.render(120).map(strip).join('\n');
    expect(text).toContain('src/index.ts');
    expect(text).toContain('README.md');
    expect(text).not.toContain(ROOT);
  });

  test('Escape cancels', () => {
    const ctx = makePicker();
    ctx.picker.handleInput('\x1b');
    expect(ctx.cancelled).toBe(true);
  });

  test('Enter picks the highlighted entry', () => {
    const ctx = makePicker();
    ctx.picker.handleInput('\r');
    expect(ctx.picked).toBe(FILES[0]);
  });

  test('printable chars extend the filter', () => {
    const ctx = makePicker();
    for (const c of 'header') ctx.picker.handleInput(c);
    expect(ctx.picker.getFilter()).toBe('header');
  });

  test('Backspace on empty filter cancels', () => {
    const ctx = makePicker();
    ctx.picker.handleInput('\x7f');
    expect(ctx.cancelled).toBe(true);
  });

  test('renders inside a bordered box bounded by viewport width', () => {
    const ctx = makePicker();
    const lines = ctx.picker.render(60).map(strip);
    expect(lines[0].startsWith('┌')).toBe(true);
    expect(lines[lines.length - 1].startsWith('└')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
  });
});
