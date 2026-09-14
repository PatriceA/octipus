import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { StdioTransport } from './stdio';

// ── Helpers ───────────────────────────────────────────────────

function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 1000,
  intervalMs = 5,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = fn();
      if (value !== undefined) return resolve(value);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('waitFor: timed out'));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

// Track transports across tests so we can always close them.
const openTransports: StdioTransport[] = [];

function makeTransport(command: string, args: string[] = []): StdioTransport {
  const t = new StdioTransport({ command, args });
  openTransports.push(t);
  return t;
}

afterEach(() => {
  while (openTransports.length) {
    openTransports.pop()!.close();
  }
});

// ── Basic behavior ────────────────────────────────────────────

describe('StdioTransport', () => {
  test('send throws before connect', () => {
    const t = new StdioTransport({ command: 'cat' });
    expect(() => t.send('hello')).toThrow(/not connected/);
  });

  test('onMessage receives each newline-delimited line', async () => {
    // `cat` echoes stdin back, so sending "foo\n" produces "foo\n"
    const t = makeTransport('cat');
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));
    await t.connect();

    t.send('hello');
    t.send('world');

    await waitFor(() => (messages.length >= 2 ? messages : undefined));
    expect(messages).toEqual(['hello', 'world']);
  });

  test('onMessage skips empty lines', async () => {
    const t = makeTransport('cat');
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));
    await t.connect();

    t.send(''); // produces just "\n"
    t.send('real');

    await waitFor(() => (messages.length >= 1 ? messages : undefined));
    expect(messages).toEqual(['real']);
  });

  test('onMessage buffers partial lines until newline arrives', async () => {
    // Use sh to emit a partial, then complete the line.
    const t = makeTransport('sh', [
      '-c',
      'printf "part1" && sleep 0.05 && printf "part2\\n"',
    ]);
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));
    await t.connect();

    await waitFor(() => (messages.length >= 1 ? messages : undefined));
    expect(messages).toEqual(['part1part2']);
  });

  test('onError receives stderr data', async () => {
    const t = makeTransport('sh', ['-c', 'echo "oh no" 1>&2']);
    const errors: Error[] = [];
    t.onError((e) => errors.push(e));
    await t.connect();

    await waitFor(() => (errors.length >= 1 ? errors : undefined));
    expect(errors[0].message.trim()).toBe('oh no');
  });

  test('onClose fires when child process exits', async () => {
    const t = makeTransport('true'); // exits immediately
    let closed = false;
    t.onClose(() => {
      closed = true;
    });
    await t.connect();
    await waitFor(() => (closed ? true : undefined));
    expect(closed).toBe(true);
  });

  test('onError fires when spawn fails (nonexistent command)', async () => {
    const t = makeTransport('this-command-does-not-exist-xyzzy');
    const errors: Error[] = [];
    t.onError((e) => errors.push(e));
    await t.connect();

    await waitFor(() => (errors.length >= 1 ? errors : undefined));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test('multiple message handlers all receive messages', async () => {
    const t = makeTransport('cat');
    const a: string[] = [];
    const b: string[] = [];
    t.onMessage((m) => a.push(m));
    t.onMessage((m) => b.push(m));
    await t.connect();
    t.send('ping');

    await waitFor(() => (a.length >= 1 && b.length >= 1 ? true : undefined));
    expect(a).toEqual(['ping']);
    expect(b).toEqual(['ping']);
  });

  test('close kills the process and prevents further sends', async () => {
    const t = new StdioTransport({ command: 'cat' });
    await t.connect();
    t.close();
    expect(() => t.send('after-close')).toThrow(/not connected/);
  });

  test('env option is passed to child process', async () => {
    const t = makeTransport('sh', ['-c', 'printf "%s\\n" "$STDIO_TEST_VAR"']);
    (t as any).options.env = { STDIO_TEST_VAR: 'hello-env' };
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));
    await t.connect();

    await waitFor(() => (messages.length >= 1 ? messages : undefined));
    expect(messages).toEqual(['hello-env']);
  });

  test('cwd option pins the MCP child to its configured project', async () => {
    // Asked of the runtime rather than of `pwd`: there is no `pwd` on Windows,
    // and Git Bash's answers in its own `/c/tmp` idiom — neither of which says
    // anything about whether the transport honoured `cwd`. A real directory,
    // realpath'd, because macOS resolves `/tmp` to `/private/tmp`.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stdio-cwd-')));
    const t = makeTransport(process.execPath, ['-e', 'process.stdout.write(process.cwd() + String.fromCharCode(10))']);
    (t as any).options.cwd = dir;
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));
    await t.connect();
    await waitFor(() => messages[0]);
    expect(messages[0]).toBe(dir);
  });

  test('sensitive parent secrets are not inherited by MCP children', async () => {
    const previous = process.env.MASTER_KEY;
    process.env.MASTER_KEY = 'must-not-leak';
    try {
      const t = makeTransport('sh', ['-c', 'printf "%s\\n" "${MASTER_KEY:-missing}"']);
      const messages: string[] = [];
      t.onMessage((m) => messages.push(m));
      await t.connect();
      await waitFor(() => messages[0]);
      expect(messages[0]).toBe('missing');
    } finally {
      if (previous === undefined) delete process.env.MASTER_KEY;
      else process.env.MASTER_KEY = previous;
    }
  });

  test('can treat routine stderr output as logs for noisy MCP servers', async () => {
    const t = makeTransport('sh', ['-c', 'echo ready >&2; cat']);
    (t as any).options.stderrAsError = false;
    const errors: Error[] = [];
    t.onError((error) => errors.push(error));
    await t.connect();
    await new Promise((done) => setTimeout(done, 30));
    expect(errors).toEqual([]);
  });
});
