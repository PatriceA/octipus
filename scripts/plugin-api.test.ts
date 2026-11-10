/**
 * `octi plugin list` / `octi plugin approve` (scripts/plugin-api.ts) against
 * a fake backend: the token rides as a bearer, approve sends the hash it was
 * given or the one confirmed at a terminal, and refuses to guess otherwise.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { describe, expect, test } from 'vitest';
import { MAX_PLUGIN_SECRET_LENGTH, type PluginPackageView } from '@/shared/plugin-package';
import {
  approveCommand,
  approveContributionsCommand,
  approveInProcessCommand,
  backendBase,
  type HiddenInput,
  listCommand,
  parseSettingPairs,
  type PluginApiIo,
  readAllText,
  readHiddenLine,
  secretCommand,
  secretCommandFromArgs,
  setCommand,
  uninstallCommand,
} from './plugin-api';

const RECORDED = `sha256:${'a'.repeat(64)}`;
const ACTUAL = `sha256:${'b'.repeat(64)}`;

function view(over: Partial<PluginPackageView> = {}): PluginPackageView {
  return {
    name: 'finapi', version: '1.0.0', manifest: {} as PluginPackageView['manifest'], enabled: true, settings: {}, secretsSet: [],
    problem: 'Modified since it was approved (hash mismatch); approve its content to run it',
    network: { state: 'refused', detail: 'Not started' }, connected: false,
    contentHash: RECORDED, actualHash: ACTUAL, signedBy: null,
    signature: { status: 'invalid', keyId: null, publisher: null, detail: 'does not match' },
    runtime: 'package', inProcess: null,
    contributions: { hash: null, approvedHash: null, approved: false, commands: [], schedules: [], events: [], prompt: null, context: null, problems: [] },
    approvedHostScopes: null, installedBy: null, installedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  };
}

interface Harness {
  io: PluginApiIo;
  out: string[];
  err: string[];
  requests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }>;
  asked: string[];
}

function harness(opts: {
  packages?: PluginPackageView[];
  patch?: (body: { approveContent?: string; settings?: Record<string, unknown> }) => [number, unknown];
  respond?: (method: string, body: unknown) => [number, unknown] | undefined;
  interactive?: boolean;
  answer?: string;
  token?: string;
  secret?: string | Error;
} = {}): Harness {
  const h: Harness = { out: [], err: [], requests: [], asked: [], io: undefined as unknown as PluginApiIo };
  h.io = {
    env: { API_PORT: '4999', ...(opts.token ? { OCTIPUS_API_TOKEN: opts.token } : {}) },
    interactive: opts.interactive ?? false,
    out: (t) => h.out.push(t),
    err: (t) => h.err.push(t),
    ask: async (q) => { h.asked.push(q); return opts.answer ?? ''; },
    readSecret: async (q) => {
      h.asked.push(q);
      if (opts.secret instanceof Error) throw opts.secret;
      return opts.secret ?? '';
    },
    fetch: (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      h.requests.push({ method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body });
      const custom = opts.respond?.(init.method ?? 'GET', body);
      if (custom) return new Response(JSON.stringify(custom[1]), { status: custom[0] });
      if (init.method === 'PATCH') {
        const [status, data] = opts.patch?.(body) ?? [200, view({ contentHash: body.approveContent, actualHash: null, problem: null })];
        return new Response(JSON.stringify(data), { status });
      }
      return new Response(JSON.stringify(opts.packages ?? [view()]));
    }) as typeof fetch,
  };
  return h;
}

describe('octi plugin list', () => {
  test('lists every package with its state, signature, network and both hashes, sending the API token', async () => {
    const h = harness({ token: 'tok-123' });
    expect(await listCommand(h.io)).toBe(0);
    expect(h.requests).toEqual([{ method: 'GET', url: 'http://localhost:4999/api/plugin-packages/', headers: { authorization: 'Bearer tok-123' }, body: undefined }]);
    const text = h.out.join('');
    expect(text).toContain('finapi 1.0.0  problem: Modified since it was approved');
    expect(text).toContain('network: refused');
    expect(text).toContain(`content:   ${RECORDED}`);
    expect(text).toContain(`octi plugin approve finapi --hash ${ACTUAL}`);
  });

  test('a refused token or an unreachable backend says what to do', async () => {
    const h = harness();
    h.io.fetch = (async () => new Response('{"error":"Admin access required"}', { status: 403 })) as typeof fetch;
    expect(await listCommand(h.io)).toBe(1);
    expect(h.err.join('')).toMatch(/OCTIPUS_API_TOKEN/);
    h.io.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    expect(await listCommand(h.io)).toBe(1);
    expect(h.err.join('')).toMatch(/backend unreachable at http:\/\/localhost:4999.*octi start/);
  });

  test('the base URL follows API_PORT, as the other backend commands', () => {
    expect(backendBase({})).toBe('http://localhost:3005');
    expect(backendBase({ API_PORT: '8080' })).toBe('http://localhost:8080');
  });

  test('an API_PORT that is not a port is refused before any request (the token stays home)', async () => {
    for (const port of ['1@evil.example', '80/x', '0', '65536', '123456', ' 80', 'abc']) {
      expect(() => backendBase({ API_PORT: port }), port).toThrow(/API_PORT must be a port number/);
      const h = harness({ token: 'secret' });
      h.io.env.API_PORT = port;
      expect(await listCommand(h.io), port).toBe(2);
      expect(await approveCommand(h.io, 'finapi', ACTUAL), port).toBe(2);
      expect(h.requests, port).toEqual([]);
    }
  });
});

describe('octi plugin approve', () => {
  test('with --hash: sends exactly that hash', async () => {
    const h = harness();
    expect(await approveCommand(h.io, 'finapi', ACTUAL)).toBe(0);
    expect(h.requests).toEqual([expect.objectContaining({ method: 'PATCH', url: 'http://localhost:4999/api/plugin-packages/finapi', body: { approveContent: ACTUAL } })]);
    expect(h.out.join('')).toContain(`Approved finapi: content ${ACTUAL}`);
  });

  test('a 409 (the files changed since) is shown with the actual hash, and fails', async () => {
    const h = harness({ patch: () => [409, { error: `The files of finapi hash to sha256:${'c'.repeat(64)}, not to the reviewed ${ACTUAL}`, problems: ['approveContent: reviewed …'] }] });
    expect(await approveCommand(h.io, 'finapi', ACTUAL)).toBe(1);
    expect(h.err.join('')).toContain(`hash to sha256:${'c'.repeat(64)}`);
    const withHash = harness({ patch: () => [409, { error: 'changed', actualHash: `sha256:${'c'.repeat(64)}` }] });
    expect(await approveCommand(withHash.io, 'finapi', ACTUAL)).toBe(1);
    expect(withHash.err.join('')).toContain(`--hash sha256:${'c'.repeat(64)}`);
  });

  test('without --hash at a terminal: shows the actual hash, asks, and approves that one on yes', async () => {
    const h = harness({ interactive: true, answer: 'y' });
    expect(await approveCommand(h.io, 'finapi', undefined)).toBe(0);
    expect(h.asked).toEqual([expect.stringContaining(ACTUAL)]);
    expect(h.requests.map((r) => [r.method, r.body])).toEqual([['GET', undefined], ['PATCH', { approveContent: ACTUAL }]]);
  });

  test('without --hash: no answer approves nothing; not at a terminal it refuses and prints the command', async () => {
    const no = harness({ interactive: true, answer: '' });
    expect(await approveCommand(no.io, 'finapi', undefined)).toBe(1);
    expect(no.requests.map((r) => r.method)).toEqual(['GET']);

    const batch = harness({ interactive: false });
    expect(await approveCommand(batch.io, 'finapi', undefined)).toBe(2);
    expect(batch.asked).toEqual([]);
    expect(batch.requests.map((r) => r.method)).toEqual(['GET']);
    expect(batch.err.join('')).toContain(`octi plugin approve finapi --hash ${ACTUAL}`);
  });

  test('nothing to approve, an unknown package, and a malformed --hash', async () => {
    const clean = harness({ packages: [view({ actualHash: null, problem: null })], interactive: true });
    expect(await approveCommand(clean.io, 'finapi', undefined)).toBe(0);
    expect(clean.out.join('')).toContain('no content waiting for approval');
    expect(clean.asked).toEqual([]);
    expect(await approveCommand(harness().io, 'datev', undefined)).toBe(1);
    const bad = harness();
    expect(await approveCommand(bad.io, 'finapi', 'abc')).toBe(2);
    expect(bad.requests).toEqual([]);
  });
});

describe('octi plugin approve-in-process', () => {
  const inProcessView = (over: Partial<PluginPackageView> = {}) => view({
    name: 'auditlog', runtime: 'in-process', problem: null, actualHash: null, enabled: false,
    inProcess: { approved: false, approvedHash: null, approvedBy: null, approvedAt: null, loaded: false },
    ...over,
  });
  const approvedView = (body: { approveInProcess?: string }): [number, unknown] => [200, inProcessView({
    inProcess: { approved: true, approvedHash: body.approveInProcess ?? null, approvedBy: 'u', approvedAt: '2026-11-10T00:00:00Z', loaded: false },
  })];

  test('list shows the runtime and the missing approval with the command to give it', async () => {
    const h = harness({ packages: [inProcessView()] });
    expect(await listCommand(h.io)).toBe(0);
    const text = h.out.join('');
    expect(text).toContain('runtime:   in-process');
    expect(text).toContain(`octi plugin approve-in-process auditlog --hash ${RECORDED}`);
  });

  test('with --hash: sends exactly that hash as approveInProcess', async () => {
    const h = harness({ respond: (method, body) => (method === 'PATCH' ? approvedView(body as { approveInProcess?: string }) : undefined) });
    expect(await approveInProcessCommand(h.io, 'auditlog', RECORDED)).toBe(0);
    expect(h.requests).toEqual([expect.objectContaining({ method: 'PATCH', url: 'http://localhost:4999/api/plugin-packages/auditlog', body: { approveInProcess: RECORDED } })]);
    expect(h.out.join('')).toContain(`Approved auditlog to run in the server process, for ${RECORDED}. Enable it to load it.`);
  });

  test('without --hash: asks at a terminal for the approved content hash; refuses to guess elsewhere', async () => {
    const yes = harness({ packages: [inProcessView()], interactive: true, answer: 'y', respond: (method, body) => (method === 'PATCH' ? approvedView(body as { approveInProcess?: string }) : undefined) });
    expect(await approveInProcessCommand(yes.io, 'auditlog', undefined)).toBe(0);
    expect(yes.asked[0]).toContain(RECORDED);
    expect(yes.asked[0]).toContain('full authority');
    expect(yes.requests.at(-1)?.body).toEqual({ approveInProcess: RECORDED });

    const no = harness({ packages: [inProcessView()], interactive: true, answer: 'n' });
    expect(await approveInProcessCommand(no.io, 'auditlog', undefined)).toBe(1);
    expect(no.requests.filter((r) => r.method === 'PATCH')).toEqual([]);

    const away = harness({ packages: [inProcessView()] });
    expect(await approveInProcessCommand(away.io, 'auditlog', undefined)).toBe(2);
    expect(away.err.join('')).toContain(`octi plugin approve-in-process auditlog --hash ${RECORDED}`);
  });

  test('a package, changed content or a bad hash are refused before anything is sent', async () => {
    const pkgHarness = harness({ packages: [view({ name: 'finapi', runtime: 'package' })] });
    expect(await approveInProcessCommand(pkgHarness.io, 'finapi', undefined)).toBe(1);
    expect(pkgHarness.err.join('')).toMatch(/sandboxed package/);

    const changed = harness({ packages: [inProcessView({ actualHash: ACTUAL })] });
    expect(await approveInProcessCommand(changed.io, 'auditlog', undefined)).toBe(1);
    expect(changed.err.join('')).toContain('octi plugin approve auditlog first');

    const bad = harness();
    expect(await approveInProcessCommand(bad.io, 'auditlog', 'sha256:nope')).toBe(2);
    expect(bad.requests).toEqual([]);
  });
});

describe('octi plugin uninstall', () => {
  test('with --yes: sends DELETE without asking', async () => {
    const h = harness({ token: 'tok', respond: (m) => (m === 'DELETE' ? [200, { uninstalled: true }] : undefined) });
    expect(await uninstallCommand(h.io, 'finapi', true)).toBe(0);
    expect(h.requests).toEqual([{ method: 'DELETE', url: 'http://localhost:4999/api/plugin-packages/finapi', headers: { authorization: 'Bearer tok' }, body: undefined }]);
    expect(h.asked).toEqual([]);
    expect(h.out.join('')).toContain('Uninstalled finapi.');
  });

  test('at a terminal it asks, and only yes deletes; elsewhere it refuses without --yes', async () => {
    const yes = harness({ interactive: true, answer: 'yes', respond: (m) => (m === 'DELETE' ? [200, { uninstalled: true }] : undefined) });
    expect(await uninstallCommand(yes.io, 'finapi', false)).toBe(0);
    expect(yes.asked).toEqual([expect.stringContaining('Uninstall finapi?')]);
    expect(yes.requests.map((r) => r.method)).toEqual(['DELETE']);

    const no = harness({ interactive: true, answer: 'n' });
    expect(await uninstallCommand(no.io, 'finapi', false)).toBe(1);
    expect(no.requests).toEqual([]);

    const batch = harness({ interactive: false });
    expect(await uninstallCommand(batch.io, 'finapi', false)).toBe(2);
    expect(batch.requests).toEqual([]);
    expect(batch.asked).toEqual([]);
    expect(batch.err.join('')).toContain('octi plugin uninstall finapi --yes');
  });

  test('an unknown package (404) fails with the backend message; a malformed name is not sent', async () => {
    const h = harness({ respond: () => [404, { error: 'No plugin package named datev' }] });
    expect(await uninstallCommand(h.io, 'datev', true)).toBe(1);
    expect(h.err.join('')).toContain('No plugin package named datev');
    const bad = harness();
    expect(await uninstallCommand(bad.io, '../users', true)).toBe(2);
    expect(bad.requests).toEqual([]);
  });
});

describe('octi plugin set', () => {
  test('sends key=value pairs as settings (key= clears), and shows what is saved', async () => {
    const h = harness({ patch: () => [200, view({ actualHash: null, problem: null, settings: { region: 'eu', limit: 5 } })] });
    expect(await setCommand(h.io, 'finapi', ['region=eu', 'limit=5', 'note=', 'url=https://x.example/?a=b'])).toBe(0);
    expect(h.requests).toEqual([expect.objectContaining({ method: 'PATCH', url: 'http://localhost:4999/api/plugin-packages/finapi', body: { settings: { region: 'eu', limit: '5', note: null, url: 'https://x.example/?a=b' } } })]);
    expect(h.out.join('')).toContain('Saved the settings of finapi: region=eu limit=5.');
  });

  test('a refusal shows every problem; malformed pairs are not sent', async () => {
    const h = harness({ patch: () => [400, { error: 'The settings do not fit the package', problems: ['Limit: must be a number', 'Unknown field "nope"'] }] });
    expect(await setCommand(h.io, 'finapi', ['limit=x', 'nope=1'])).toBe(1);
    expect(h.err.join('')).toMatch(/do not fit[\s\S]*Limit: must be a number[\s\S]*Unknown field "nope"/);
    for (const pairs of [[], ['region'], ['=eu'], ['Region=eu'], ['a=1', 'a=2']]) {
      const bad = harness();
      expect(await setCommand(bad.io, 'finapi', pairs), JSON.stringify(pairs)).toBe(2);
      expect(bad.requests).toEqual([]);
    }
    expect(parseSettingPairs(['a=x=y'])).toEqual({ a: 'x=y' });
    // Only exactly `key=` clears; spaces alone are refused, not read as a clear.
    expect(parseSettingPairs(['a=', 'b= x '])).toEqual({ a: null, b: ' x ' });
    expect(() => parseSettingPairs(['a=   '])).toThrow(/only spaces.*`a=` to clear/);
    const spaces = harness();
    expect(await setCommand(spaces.io, 'finapi', ['region=  '])).toBe(2);
    expect(spaces.requests).toEqual([]);
  });
});

describe('octi plugin secret', () => {
  test('reads the value from the prompt or stdin (one trailing newline dropped) and PUTs it; it is never printed', async () => {
    const h = harness({ secret: 's3cr3t value\n', respond: (m) => (m === 'PUT' ? [200, { saved: true }] : undefined) });
    expect(await secretCommand(h.io, 'finapi', 'FINAPI_TOKEN', false)).toBe(0);
    expect(h.requests).toEqual([expect.objectContaining({ method: 'PUT', url: 'http://localhost:4999/api/plugin-packages/finapi/secrets/FINAPI_TOKEN', body: { value: 's3cr3t value' } })]);
    expect(h.asked).toEqual([expect.stringContaining('not shown')]);
    expect([...h.out, ...h.err].join('')).not.toContain('s3cr3t');
    expect(h.out.join('')).toContain('Saved FINAPI_TOKEN of finapi.');
  });

  test('--clear sends null without reading; an empty value is refused', async () => {
    const clear = harness({ respond: (m) => (m === 'PUT' ? [200, { saved: true }] : undefined) });
    expect(await secretCommand(clear.io, 'finapi', 'FINAPI_TOKEN', true)).toBe(0);
    expect(clear.requests.map((r) => r.body)).toEqual([{ value: null }]);
    expect(clear.asked).toEqual([]);

    const empty = harness({ secret: '\n' });
    expect(await secretCommand(empty.io, 'finapi', 'FINAPI_TOKEN', false)).toBe(2);
    expect(empty.requests).toEqual([]);
    expect(empty.err.join('')).toContain('--clear');

    const cancelled = harness({ secret: new Error('cancelled') });
    expect(await secretCommand(cancelled.io, 'finapi', 'FINAPI_TOKEN', false)).toBe(1);
    expect(cancelled.requests).toEqual([]);
  });

  test('a refusal (undeclared key, required while enabled) is shown; a malformed key is not sent', async () => {
    const h = harness({ secret: 'x', respond: () => [400, { error: 'finapi declares no secret NOPE' }] });
    expect(await secretCommand(h.io, 'finapi', 'NOPE', false)).toBe(1);
    expect(h.err.join('')).toContain('declares no secret NOPE');
    const bad = harness({ secret: 'x' });
    expect(await secretCommand(bad.io, 'finapi', 'a/b', false)).toBe(2);
    expect(bad.requests).toEqual([]);
  });
});

describe('octi plugin secret: arguments, the hidden prompt, stdin and the length limit', () => {
  test('a value typed on the command line is refused without being echoed', async () => {
    for (const argv of [['finapi', 'KEY', '-s3cret'], ['finapi', 'KEY', '--s3cret=x'], ['finapi', 'KEY', 's3cret'], ['finapi', 'KEY', '--', '-s3cret'], ['finapi']]) {
      const h = harness({ secret: 'never read' });
      expect(await secretCommandFromArgs(h.io, argv), argv.join(' ')).toBe(2);
      const text = [...h.out, ...h.err].join('');
      expect(text, argv.join(' ')).toContain('never from the command line');
      expect(text, argv.join(' ')).not.toContain('3cret');
      expect(h.requests).toEqual([]);
      expect(h.asked).toEqual([]);
    }
    const ok = harness({ secret: 'v', respond: (m) => (m === 'PUT' ? [200, { saved: true }] : undefined) });
    expect(await secretCommandFromArgs(ok.io, ['finapi', 'KEY'])).toBe(0);
    expect(ok.requests.map((r) => r.body)).toEqual([{ value: 'v' }]);
    const clear = harness({ respond: (m) => (m === 'PUT' ? [200, { saved: true }] : undefined) });
    expect(await secretCommandFromArgs(clear.io, ['finapi', 'KEY', '--clear'])).toBe(0);
    expect(clear.requests.map((r) => r.body)).toEqual([{ value: null }]);
  });

  test('a value longer than the route accepts is refused with the limit, before any request', async () => {
    const h = harness({ secret: `${'x'.repeat(MAX_PLUGIN_SECRET_LENGTH + 1)}\n` });
    expect(await secretCommand(h.io, 'finapi', 'KEY', false)).toBe(2);
    expect(h.err.join('')).toContain(`${MAX_PLUGIN_SECRET_LENGTH + 1} characters; a plugin secret holds at most ${MAX_PLUGIN_SECRET_LENGTH}`);
    expect(h.requests).toEqual([]);
    const max = harness({ secret: 'x'.repeat(MAX_PLUGIN_SECRET_LENGTH), respond: (m) => (m === 'PUT' ? [200, { saved: true }] : undefined) });
    expect(await secretCommand(max.io, 'finapi', 'KEY', false)).toBe(0);
  });

  test('stdin is read whole as UTF-8, and refused once it is longer than a secret can be', async () => {
    const euro = Buffer.from('p€ss\n');
    // A character split across chunks stays whole.
    expect(await readAllText(Readable.from([euro.subarray(0, 2), euro.subarray(2)]))).toBe('p€ss\n');
    await expect(readAllText(Readable.from([Buffer.alloc(43, 'x')]), 10)).rejects.toThrow(/longer than 10 characters/);
  });

  /** A fake raw-mode terminal: records the mode calls; `type` sends chunks as the terminal would. */
  function fakeTty(): HiddenInput & { type: (chunk: string | Buffer) => void; calls: string[] } {
    const emitter = new EventEmitter();
    let encoding: BufferEncoding | null = null;
    let decoder: StringDecoder | undefined;
    const calls: string[] = [];
    return {
      calls,
      setRawMode: (raw: boolean) => { calls.push(`raw:${raw}`); },
      setEncoding: (e: BufferEncoding) => { encoding = e; calls.push(`encoding:${e}`); },
      resume: () => { calls.push('resume'); },
      pause: () => { calls.push('pause'); },
      on: (event, listener) => emitter.on(event, listener),
      off: (event, listener) => emitter.off(event, listener),
      // With an encoding set, a stream decodes with a StringDecoder, holding back a partial character.
      type: (chunk) => {
        if (typeof chunk === 'string' || encoding === null) {
          emitter.emit('data', chunk);
          return;
        }
        decoder ??= new StringDecoder(encoding);
        const text = decoder.write(chunk);
        if (text) emitter.emit('data', text);
      },
    };
  }

  test('the hidden prompt sets UTF-8 and raw mode, never echoes, and drops escape sequences and control characters', async () => {
    const tty = fakeTty();
    const written: string[] = [];
    const line = readHiddenLine(tty, (t) => written.push(t), 'Value: ');
    tty.type('ab');
    tty.type('\u001b[D\u001b[1;5C'); // arrow keys
    tty.type('\u001b[200~c\u001b[201~'); // a bracketed paste keeps its text, not its markers
    tty.type('\u0001\u0007\t\u0015'); // Ctrl-A, bell, tab, Ctrl-U
    tty.type('\u001bx'); // Alt+x
    tty.type('dX\u007f'); // Backspace removes X
    const euro = Buffer.from('€');
    tty.type(euro.subarray(0, 1));
    tty.type(euro.subarray(1));
    tty.type('\u001bOP'); // F1
    tty.type('\r');
    expect(await line).toBe('abcd€');
    expect(written).toEqual(['Value: ', '\n']);
    expect(tty.calls).toEqual(['encoding:utf8', 'raw:true', 'resume', 'raw:false', 'pause']);
  });

  test('Enter right after a lone Esc still ends the line; Ctrl-C cancels; Ctrl-D ends', async () => {
    const esc = fakeTty();
    const a = readHiddenLine(esc, () => {}, '');
    esc.type('k\u001b\r');
    expect(await a).toBe('k');
    const cancel = fakeTty();
    const b = readHiddenLine(cancel, () => {}, '');
    cancel.type('abc\u0003');
    await expect(b).rejects.toThrow('cancelled');
    const eof = fakeTty();
    const c = readHiddenLine(eof, () => {}, '');
    eof.type('xy\u0004');
    expect(await c).toBe('xy');
  });

  test('the hidden prompt keeps at most one character over the limit, so a long value is refused', async () => {
    const tty = fakeTty();
    const line = readHiddenLine(tty, () => {}, '', 3);
    tty.type('abcdefg\r');
    expect(await line).toBe('abcd');
  });
});

describe('octi plugin approve-contributions', () => {
  const CONTRIB = `sha256:${'c'.repeat(64)}`;
  const contributed = (over: Partial<PluginPackageView['contributions']> = {}) => view({
    name: 'greeter', problem: null, actualHash: null, enabled: false,
    contributions: {
      hash: CONTRIB, approvedHash: null, approved: false,
      commands: [{ name: 'greet', tool: 'hello', effect: 'read', description: 'Say hello', bound: false }],
      schedules: [{ id: 'tick', cron: '0 * * * *', tool: 'record', effect: 'write', bound: false, lastRun: null }],
      events: [{ on: 'chat.response', tool: 'hello', effect: 'read', bound: false, lastRun: null }],
      prompt: { file: 'prompt.md', roles: null, text: 'Always greet loudly.\nSecond line.', bound: false, chars: null },
      context: { tool: 'ctx', effect: 'read', roles: null, bound: false, lastRun: null },
      problems: [],
      ...over,
    },
  });

  test('without --hash: shows everything it adds, the whole prompt text, and asks at a terminal; refuses elsewhere', async () => {
    const yes = harness({ packages: [contributed()], interactive: true, answer: 'y', respond: (method) => (method === 'PATCH' ? [200, contributed({ approvedHash: CONTRIB, approved: true })] : undefined) });
    expect(await approveContributionsCommand(yes.io, 'greeter', undefined)).toBe(0);
    const shown = yes.out.join('');
    expect(shown).toContain('/greet → hello (read)');
    expect(shown).toContain('"0 * * * *" (UTC) → record (write), as the installing admin');
    expect(shown).toContain('chat.response → hello (read)');
    expect(shown).toContain('every turn of EVERY user');
    expect(shown).toContain('    | Always greet loudly.\n    | Second line.');
    expect(yes.requests.at(-1)?.body).toEqual({ approveContributions: CONTRIB });

    const away = harness({ packages: [contributed()] });
    expect(await approveContributionsCommand(away.io, 'greeter', undefined)).toBe(2);
    expect(away.err.join('')).toContain(`octi plugin approve-contributions greeter --hash ${CONTRIB}`);
    expect(away.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
  });

  test('with --hash: sends it; a refusal names the hash to review', async () => {
    const ok = harness({ respond: (method) => (method === 'PATCH' ? [200, contributed({ approvedHash: CONTRIB, approved: true })] : undefined) });
    expect(await approveContributionsCommand(ok.io, 'greeter', CONTRIB)).toBe(0);
    expect(ok.requests).toEqual([expect.objectContaining({ method: 'PATCH', body: { approveContributions: CONTRIB } })]);
    const refused = harness({ respond: (method) => (method === 'PATCH' ? [409, { error: 'changed', contributionsHash: CONTRIB }] : undefined) });
    expect(await approveContributionsCommand(refused.io, 'greeter', `sha256:${'d'.repeat(64)}`)).toBe(1);
    expect(refused.err.join('')).toContain(`--hash ${CONTRIB}`);
    expect(await approveContributionsCommand(harness().io, 'greeter', 'sha256:nope')).toBe(2);
  });
});
