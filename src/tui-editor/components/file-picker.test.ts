import { describe, expect, test } from 'vitest';
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

describe('FilePicker over a large index (docs/plans/tui-modernization.md §5.2)', () => {
  test('ranks the whole index: a file that sorts after the first thousand is found and comes first', () => {
    const files = Array.from({ length: 5000 }, (_, i) => `${ROOT}/aaa/${String(i).padStart(4, '0')}.ts`);
    files.push(`${ROOT}/zzz/components/header.ts`, `${ROOT}/zzz/had-er.txt`);
    const picker = new FilePicker({ root: ROOT, files, onPick: () => {}, onCancel: () => {} });
    for (const c of 'header') picker.handleInput(c);
    expect(picker.getShownLabels()[0]).toBe('zzz/components/header.ts');
  });

  test('fuzzy: letters in order, not a substring', () => {
    const { picker } = makePicker();
    for (const c of 'srchdr') picker.handleInput(c);
    expect(picker.getShownLabels()).toEqual(['src/components/header.ts']);
  });

  test('says how many matched when more than it shows', () => {
    const files = Array.from({ length: 800 }, (_, i) => `${ROOT}/f${i}.ts`);
    const picker = new FilePicker({ root: ROOT, files, onPick: () => {}, onCancel: () => {} });
    expect(picker.render(100).map(strip).join('\n')).toContain('500 of 800 shown');
  });

  test('indexes asynchronously, and Enter typed before the index arrives opens the best match', async () => {
    type Index = { files: string[]; source: 'walk'; truncated: boolean };
    let resolveIndex: (index: Index) => void = () => {};
    const index = new Promise<Index>((resolve) => { resolveIndex = resolve; });
    let picked: string | null = null;
    let updates = 0;
    const picker = new FilePicker({ root: ROOT, index, onPick: (p) => { picked = p; }, onCancel: () => {}, onUpdate: () => { updates++; } });
    expect(picker.render(80).map(strip).join('\n')).toContain('Indexing files');
    for (const c of 'readme') picker.handleInput(c);
    picker.handleInput('\r');
    resolveIndex({ files: FILES, source: 'walk', truncated: false });
    await index; await Promise.resolve();
    expect(updates).toBe(1);
    expect(picked).toBe(`${ROOT}/README.md`);
  });

  test('the filter takes a paste and non-ASCII names', () => {
    const files = [`${ROOT}/docs/café notes.md`, `${ROOT}/other.md`];
    const picker = new FilePicker({ root: ROOT, files, onPick: () => {}, onCancel: () => {} });
    picker.handleInput('\x1b[200~café\x1b[201~');
    expect(picker.getFilter()).toBe('café');
    expect(picker.getShownLabels()).toEqual(['docs/café notes.md']);
  });
});
