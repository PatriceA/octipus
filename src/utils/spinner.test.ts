import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { KawaiiSpinner as Spinner } from './spinner';

class MockStream {
  writes: string[] = [];
  isTTY: boolean;
  constructor(isTTY: boolean) { this.isTTY = isTTY; }
  write(s: string) { this.writes.push(s); return true; }
}

describe('Spinner', () => {
  let origIsTTY: boolean | undefined;
  beforeEach(() => { origIsTTY = process.stdout.isTTY; });
  afterEach(() => { Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true }); });

  test('non-TTY emits static line, no ANSI escape', () => {
    const mock = new MockStream(false);
    const stream = mock as unknown as NodeJS.WriteStream;
    const s = new Spinner({ stream, style: 'classic' });
    s.start('loading');
    s.stop();
    const joined = mock.writes.join('');
    expect(joined).not.toContain('\u001b[');
    expect(joined).toContain('loading');
  });

  test('TTY emits animated frames with ANSI escapes', async () => {
    const mock = new MockStream(true);
    const stream = mock as unknown as NodeJS.WriteStream;
    const s = new Spinner({ stream, style: 'classic' });
    s.start('loading');
    await new Promise(r => setTimeout(r, 180));
    s.stop();
    const joined = mock.writes.join('');
    expect(joined).toContain('\u001b[');
  });

  test('succeed emits success marker', () => {
    const mock = new MockStream(false);
    const stream = mock as unknown as NodeJS.WriteStream;
    const s = new Spinner({ stream, style: 'classic' });
    s.start('task');
    s.succeed('done');
    const joined = mock.writes.join('');
    expect(joined.toLowerCase()).toContain('done');
  });

  test('fail emits failure marker', () => {
    const mock = new MockStream(false);
    const stream = mock as unknown as NodeJS.WriteStream;
    const s = new Spinner({ stream, style: 'classic' });
    s.start('task');
    s.fail('broken');
    const joined = mock.writes.join('');
    expect(joined.toLowerCase()).toContain('broken');
  });

  test('update changes label', async () => {
    const mock = new MockStream(true);
    const stream = mock as unknown as NodeJS.WriteStream;
    const s = new Spinner({ stream, style: 'classic' });
    s.start('first');
    s.update('second');
    await new Promise(r => setTimeout(r, 100));
    s.stop();
    const joined = mock.writes.join('');
    expect(joined).toContain('second');
  });

  test('kawaii style uses kawaii frames', async () => {
    const mock = new MockStream(true);
    const stream = mock as unknown as NodeJS.WriteStream;
    const s = new Spinner({ stream, style: 'kawaii' });
    s.start('kawaii task');
    await new Promise(r => setTimeout(r, 180));
    s.stop();
    const joined = mock.writes.join('');
    expect(joined).toContain('♡');
  });
});
