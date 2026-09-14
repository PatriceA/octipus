import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MCPServer } from '@/core/types';
import type { MCPServerConnection } from '@/mcp/bridge';
import {
  CocoIndexService,
  ProcessRunError,
  runProcess,
  type CocoIndexServiceDependencies,
  type ProcessOptions,
} from './cocoindex';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: {
  servers?: MCPServer[];
  connectError?: Error;
  delayedAdd?: ReturnType<typeof deferred<void>>;
  delayedRemove?: ReturnType<typeof deferred<void>>;
  delayedIndex?: ReturnType<typeof deferred<void>>;
  firstProbe?: ReturnType<typeof deferred<boolean>>;
  oldModel?: string;
  indexError?: Error;
  deps?: Partial<CocoIndexServiceDependencies>;
} = {}) {
  let servers = [...(options.servers ?? [])];
  let connection: MCPServerConnection | undefined;
  let localExtra = true;
  const writes = new Map<string, string>();
  const calls: Array<{ command: string; args: readonly string[]; options?: ProcessOptions }> = [];
  const run = vi.fn(async (command: string, args: readonly string[], processOptions?: ProcessOptions) => {
    calls.push({ command, args, options: processOptions });
    if (command === '/venv/python' && !localExtra) throw new ProcessRunError('missing module', 1);
    if (args[0] === 'index' && options.delayedIndex) await options.delayedIndex.promise;
    if (args[0] === 'index' && options.indexError) throw options.indexError;
    if (command === 'uv' && args[0] === 'tool' && args[1] === 'install') localExtra = true;
    if (command === 'uv' && args.join(' ') === 'tool dir --bin') return { stdout: '/home/test/.local/bin\n', stderr: '' };
    return { stdout: '', stderr: '' };
  });
  const bridge = {
    getServerConfigs: () => [...servers],
    getConnection: () => connection,
    disconnect: vi.fn(async () => { connection = undefined; }),
    addServer: vi.fn(async (server: MCPServer) => {
      if (options.delayedAdd) await options.delayedAdd.promise;
      servers = [...servers.filter((item) => item.id !== server.id), server];
    }),
    removeServer: vi.fn(async (id: string) => {
      if (options.delayedRemove) await options.delayedRemove.promise;
      const found = servers.some((server) => server.id === id);
      servers = servers.filter((server) => server.id !== id);
      return found;
    }),
    connect: vi.fn(async (server: MCPServer) => {
      if (options.connectError) throw options.connectError;
      connection = {
        id: server.id,
        server,
        status: 'connected',
        tools: [{ name: 'search', description: 'search', inputSchema: {} }],
      } as MCPServerConnection;
      return connection;
    }),
  };
  const deps: CocoIndexServiceDependencies = {
    bridge,
    run,
    homeDir: '/home/test',
    writeFile: vi.fn(async (path, data) => { writes.set(path, String(data)); }),
    restrictFile: vi.fn(() => {}),
    readText: vi.fn(async (path) => {
      if (path.endsWith('octipus-connector.json') && options.oldModel) {
        return JSON.stringify({ embeddingModel: options.oldModel });
      }
      if (path.endsWith('/ccc')) return '#!/venv/python\n';
      throw new Error('missing');
    }),
    canExecute: vi.fn(async (path) => {
      if (options.firstProbe) {
        const probe = options.firstProbe;
        options.firstProbe = undefined;
        return probe.promise;
      }
      return path.endsWith('/ccc');
    }),
  };
  const merged = { ...deps, ...options.deps };
  return {
    service: new CocoIndexService(merged), deps: merged, bridge, run, calls, writes,
    setLocalExtra(value: boolean) { localExtra = value; },
    getServers: () => servers,
  };
}

// Posix-shaped FIXTURES, not posix-only logic: every expectation here is
// written as `/home/test/...` and `/workspace/repo`, which `join` turns into
// backslash paths on Windows. What the managed install does differently there
// is covered by its own suite at the bottom of the file.
describe.skipIf(process.platform === 'win32')('CocoIndexService', () => {
  test('builds an isolated local index before exposing the MCP server', async () => {
    const f = fixture();
    await f.service.install('/workspace/repo', 'Snowflake/snowflake-arctic-embed-xs');
    await f.service.waitForIdle();

    const status = await f.service.getStatus();
    expect(status).toMatchObject({ configured: true, installed: true, status: 'connected' });
    const server = f.getServers()[0];
    expect(server).toMatchObject({
      id: 'cocoindex-code', cwd: '/workspace/repo', args: ['mcp'],
      requestTimeoutMs: 1_800_000, stderrAsError: false,
    });
    expect(server.env?.COCOINDEX_CODE_DIR).toBe('/home/test/.octipus/cocoindex-code');
    expect(server.env?.COCOINDEX_CODE_HOST_CWD).toBe('');
    expect(server.env?.COCOINDEX_CODE_HOST_PATH_MAPPING).toBe('');
    expect(server.env?.COCOINDEX_CODE_DAEMON_SUPERVISED).toBe('');
    expect(server.env?.COCOINDEX_CODE_DB_PATH_MAPPING).toMatch(/^\/workspace\/repo=\/home\/test\/\.octipus\/cocoindex-code\/indexes\//);
    expect(f.calls.some((call) => call.args.join(' ') === 'init --force')).toBe(true);
    expect(f.calls.some((call) => call.args[0] === 'index')).toBe(true);
    expect([...f.writes.entries()]).toEqual(expect.arrayContaining([
      [expect.stringContaining('global_settings.yml'), expect.stringContaining('provider: sentence-transformers')],
      [expect.stringContaining('octipus-connector.json'), expect.stringContaining('snowflake-arctic-embed-xs')],
    ]));
  });

  test('upgrades a slim ccc installation to include local embeddings', async () => {
    const f = fixture();
    f.setLocalExtra(false);
    await f.service.install('/workspace/repo');
    await f.service.waitForIdle();
    expect(f.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'uv', args: ['tool', 'install', '--upgrade', 'cocoindex-code[full]'] }),
    ]));
    expect((await f.service.getStatus()).status).toBe('connected');
  });

  test('retains actionable setup errors across status polling', async () => {
    const f = fixture({ connectError: new Error('MCP handshake failed') });
    await f.service.install('/workspace/repo');
    await f.service.waitForIdle();
    expect(await f.service.getStatus()).toMatchObject({
      status: 'error', error: expect.stringContaining('MCP handshake failed'), configured: true,
    });
    expect((await f.service.getStatus()).error).toContain('MCP handshake failed');
  });

  test('does not overwrite an unmanaged server with the reserved ID', async () => {
    const f = fixture({ servers: [{
      id: 'cocoindex-code', name: 'Mine', command: 'mine', isEnabled: true,
    }] });
    await expect(f.service.install('/workspace/repo')).rejects.toThrow('unmanaged MCP server');
    expect(f.bridge.addServer).not.toHaveBeenCalled();
  });

  test('remove during a pending add cannot resurrect the connector', async () => {
    const delayedAdd = deferred<void>();
    const f = fixture({ delayedAdd });
    await f.service.install('/workspace/repo');
    while (!f.bridge.addServer.mock.calls.length) await new Promise((done) => setTimeout(done, 0));
    const removing = f.service.remove();
    delayedAdd.resolve();
    await removing;
    expect(f.getServers()).toEqual([]);
    expect(f.bridge.connect).not.toHaveBeenCalled();
  });

  test('changing models resets only the mapped managed index', async () => {
    const f = fixture({ oldModel: 'old/model' });
    await f.service.install('/workspace/repo', 'new/model');
    await f.service.waitForIdle();
    const reset = f.calls.find((call) => call.args.join(' ') === 'reset --force');
    expect(reset?.options?.env?.COCOINDEX_CODE_DB_PATH_MAPPING).toContain('/workspace/repo=');
    expect(f.calls.some((call) => call.args.join(' ') === 'daemon stop')).toBe(true);
  });

  test('a new install cannot race an in-progress removal', async () => {
    const delayedRemove = deferred<void>();
    const managed: MCPServer = {
      id: 'cocoindex-code', name: 'CocoIndex Code', command: '/home/test/.local/bin/ccc',
      cwd: '/workspace/old', isEnabled: true,
      env: { OCTIPUS_MANAGED_CONNECTOR: 'cocoindex-code' },
    };
    const f = fixture({ servers: [managed], delayedRemove });
    const removing = f.service.remove();
    while (!f.bridge.removeServer.mock.calls.length) await new Promise((done) => setTimeout(done, 0));
    await expect(f.service.install('/workspace/new')).rejects.toThrow('removal is still in progress');
    delayedRemove.resolve();
    await removing;
    expect(f.getServers()).toEqual([]);
  });

  test('an in-flight status probe cannot overwrite newer install progress', async () => {
    const firstProbe = deferred<boolean>();
    const delayedIndex = deferred<void>();
    const f = fixture({ firstProbe, delayedIndex });
    const status = f.service.getStatus();
    await new Promise((done) => setTimeout(done, 0));
    await f.service.install('/workspace/repo');
    firstProbe.resolve(true);
    expect((await status).status).not.toBe('not_installed');
    delayedIndex.resolve();
    await f.service.waitForIdle();
  });

  test('failed indexing explicitly stops the separately daemonized worker', async () => {
    const f = fixture({ indexError: new Error('index failed') });
    await f.service.install('/workspace/repo');
    await f.service.waitForIdle();
    expect((await f.service.getStatus()).error).toContain('index failed');
    expect(f.calls.filter((call) => call.args.join(' ') === 'daemon stop')).toHaveLength(2);
  });
});

/**
 * The managed install used to refuse Windows outright. What actually stood in
 * the way was two POSIX assumptions, not the toolchain: upstream ships a
 * `win_amd64` wheel and `uv tool install cocoindex-code[full]` produces a
 * working `ccc.exe`.
 */
describe.skipIf(process.platform !== 'win32')('CocoIndexService on Windows', () => {
  const TOOLS_DIR = 'C:\\uv\\tools';
  const VENV_PYTHON = join(TOOLS_DIR, 'cocoindex-code', 'Scripts', 'python.exe');
  const CCC = 'C:\\bin\\ccc.exe';

  function windowsFixture(localExtraPresent: boolean) {
    const f = fixture({
      deps: {
        homeDir: 'C:\\Users\\test',
        run: vi.fn(async (command: string, args: readonly string[]) => {
          calls.push({ command, args: [...args] });
          if (command === VENV_PYTHON && !localExtraPresent) throw new ProcessRunError('missing module', 1);
          if (command === 'uv' && args.join(' ') === 'tool dir') return { stdout: `${TOOLS_DIR}\r\n`, stderr: '' };
          if (command === 'uv' && args.join(' ') === 'tool dir --bin') return { stdout: 'C:\\bin\r\n', stderr: '' };
          if (command === 'uv' && args[1] === 'install') localExtraPresent = true;
          return { stdout: '', stderr: '' };
        }),
        // `ccc.exe` is a PE binary: reading it must never be how the
        // interpreter is found on this platform.
        readText: vi.fn(async () => { throw new Error('binary'); }),
        canExecute: vi.fn(async (path: string) => path === CCC || path === VENV_PYTHON),
      },
    });
    return f;
  }
  let calls: Array<{ command: string; args: string[] }> = [];
  beforeEach(() => { calls = []; });

  test('resolves the interpreter from uv’s tool venv rather than a shebang', async () => {
    const f = windowsFixture(true);
    await f.service.install('C:\\src\\project');
    await f.service.waitForIdle();

    // The probe ran, and it ran against uv's venv interpreter. Reading a
    // shebang out of `ccc.exe` — which the fixture makes throw, as the real
    // binary would produce nothing useful — is what used to happen instead,
    // and it reported "no local embeddings" unconditionally.
    const probe = calls.find((call) => call.args[0] === '-c' && call.args[1]?.includes('sentence_transformers'));
    expect(probe?.command).toBe(VENV_PYTHON);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'uv', args: ['tool', 'dir'] }),
    ]));
    expect((await f.service.getStatus()).status).toBe('connected');
  });

  test('installs the local-embedding extra when the venv does not have it', async () => {
    const f = windowsFixture(false);
    await f.service.install('C:\\src\\project');
    await f.service.waitForIdle();
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'uv', args: ['tool', 'install', '--upgrade', 'cocoindex-code[full]'] }),
    ]));
    expect((await f.service.getStatus()).status).toBe('connected');
  });
});

test.skipIf(process.platform === 'win32')('runProcess cancellation kills descendants before it settles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octipus-coco-process-'));
  const marker = join(dir, 'orphaned');
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'x'), 250)`;
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}, process.argv[1]], {stdio:'ignore'}); setTimeout(() => {}, 10000)`;
  const abort = new AbortController();
  const running = runProcess(process.execPath, ['-e', parentCode, marker], {
    signal: abort.signal,
    timeoutMs: 5_000,
  });
  setTimeout(() => abort.abort(), 30);
  await expect(running).rejects.toMatchObject({ code: 'ABORT_ERR' });
  await new Promise((done) => setTimeout(done, 350));
  await expect(readFile(marker)).rejects.toThrow();
  await rm(dir, { recursive: true, force: true });
});
