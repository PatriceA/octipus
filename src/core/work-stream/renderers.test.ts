import { describe, expect, it } from 'bun:test';
import { hasDedicatedRenderer, renderToolActivity } from './renderers';

describe('renderToolActivity — filesystem', () => {
  it('renders read_file with a path input and line-count title', () => {
    const start = renderToolActivity('filesystem__read_file', { path: '/work/poem.md' });
    expect(start.title).toBe('Read poem.md');
    expect(start.input).toEqual({ kind: 'path', value: '/work/poem.md' });
    expect(start.result).toBeUndefined();

    const done = renderToolActivity(
      'filesystem__read_file',
      { path: '/work/poem.md' },
      { content: 'line one\nline two\nline three', path: '/work/poem.md', size: 28 },
      true,
    );
    expect(done.title).toBe('Read poem.md (3 lines)');
    expect(done.result).toEqual({ kind: 'text', text: 'line one\nline two\nline three', truncated: false });
  });

  it('renders write_file as an edited file with byte count + file ref', () => {
    const done = renderToolActivity(
      'filesystem__write_file',
      { path: 'notes/poem.md', content: 'hello' },
      { success: true, path: '/work/notes/poem.md', bytesWritten: 5 },
      true,
    );
    expect(done.title).toBe('Wrote poem.md (5 bytes)');
    expect(done.result).toEqual({ kind: 'file', path: '/work/notes/poem.md', bytes: 5 });
  });

  it('renders write_file with a diff as an "Edited (+a −r)" diff preview', () => {
    const done = renderToolActivity(
      'filesystem__write_file',
      { path: 'notes/poem.md', content: 'roses are red\nviolets are green' },
      {
        success: true,
        path: '/work/notes/poem.md',
        bytesWritten: 31,
        __workStream: { diff: { patch: ' roses are red\n-violets are blue\n+violets are green', added: 1, removed: 1 } },
      },
      true,
    );
    expect(done.title).toBe('Edited poem.md (+1 −1)');
    expect(done.result?.kind).toBe('diff');
    if (done.result?.kind === 'diff') {
      expect(done.result.added).toBe(1);
      expect(done.result.removed).toBe(1);
      expect(done.result.patch).toContain('+violets are green');
    }
  });

  it('keeps the base verb when a write only adds lines (new file)', () => {
    const done = renderToolActivity(
      'filesystem__write_file',
      { path: 'new.md', content: 'a\nb' },
      { success: true, path: '/work/new.md', bytesWritten: 3, __workStream: { diff: { patch: '+a\n+b', added: 2, removed: 0 } } },
      true,
    );
    expect(done.title).toBe('Wrote new.md (+2 −0)');
    expect(done.result?.kind).toBe('diff');
  });

  it('renders list_directory as a capped item list', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, isDirectory: false }));
    entries.push({ name: 'src', isDirectory: true } as never);
    const done = renderToolActivity('filesystem__list_directory', { path: '.' }, { path: '/work', entries }, true);
    expect(done.result?.kind).toBe('list');
    if (done.result?.kind === 'list') {
      expect(done.result.total).toBe(31);
      expect(done.result.items.length).toBe(20);
      expect(done.result.items[0]).toBe('f0.txt');
    }
    expect(done.title).toBe('Listed . (31 items)');
  });
});

describe('renderToolActivity — shell', () => {
  it('renders a command with exit code and tail, ok=true on exit 0', () => {
    const done = renderToolActivity(
      'shell__run',
      { command: 'npm test' },
      { stdout: 'all good\n', stderr: '', exitCode: 0, outcome: 'success' },
      true,
    );
    expect(done.title).toBe('Ran npm test → exit 0');
    expect(done.result).toEqual({ kind: 'exit', code: 0, tail: 'all good', ok: true });
  });

  it('marks a non-zero exit as not ok and keeps the tail of the log', () => {
    const long = 'x'.repeat(5000);
    const done = renderToolActivity(
      'shell__run',
      { command: 'build' },
      { stdout: long, stderr: '', exitCode: 1, outcome: 'error' },
      true,
    );
    expect(done.result?.kind).toBe('exit');
    if (done.result?.kind === 'exit') {
      expect(done.result.ok).toBe(false);
      expect(done.result.code).toBe(1);
      // Tail is capped and ends with the *end* of the output.
      expect(done.result.tail.startsWith('…')).toBe(true);
      expect(done.result.tail.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe('renderToolActivity — web families', () => {
  it('renders a search by query family-match', () => {
    expect(hasDedicatedRenderer('web_search')).toBe(true);
    const done = renderToolActivity(
      'web_search',
      { query: 'octipus design' },
      { results: [{ title: 'A' }, { title: 'B' }] },
      true,
    );
    expect(done.title).toBe('Searched: octipus design');
    expect(done.input).toEqual({ kind: 'query', value: 'octipus design' });
    expect(done.result).toEqual({ kind: 'list', items: ['A', 'B'], total: 2 });
  });

  it('renders a fetch by url family-match', () => {
    const done = renderToolActivity('fetch_page', { url: 'https://example.com' }, { content: 'hi' }, true);
    expect(done.title).toBe('Fetched https://example.com');
    expect(done.input).toEqual({ kind: 'url', value: 'https://example.com' });
    expect(done.result).toEqual({ kind: 'text', text: 'hi', truncated: false });
  });
});

describe('renderToolActivity — generic fallback', () => {
  it('falls back to a generic title + capped json for unknown tools', () => {
    expect(hasDedicatedRenderer('mystery__do_thing')).toBe(false);
    const start = renderToolActivity('mystery__do_thing', { foo: 'bar', n: 1 });
    expect(start.title).toBe('Used do_thing');
    expect(start.input?.kind).toBe('json');
    expect(start.input?.value).toContain('foo');
  });

  it('never throws on malformed input and still yields a title', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = renderToolActivity('mystery__weird', circular, circular, true);
    expect(typeof out.title).toBe('string');
    expect(out.title.length).toBeGreaterThan(0);
  });

  it('caps very large text previews to the configured limit', () => {
    const huge = 'a'.repeat(50_000);
    const done = renderToolActivity('filesystem__read_file', { path: 'big.txt' }, { content: huge }, true);
    expect(done.result?.kind).toBe('text');
    if (done.result?.kind === 'text') {
      expect(done.result.truncated).toBe(true);
      expect(done.result.text.length).toBeLessThanOrEqual(2000);
    }
  });
});
