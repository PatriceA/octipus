/**
 * The legacy-plugin converter (docs/PLUGINS.md#converting-to-a-plugin-package):
 * convert the legacy fixture (tests/fixtures/legacy-plugin), check the manifest against the package
 * contract, then start the generated MCP server as a real subprocess and
 * compare its answers with the legacy handlers'. Refusals are checked on
 * synthetic plugins.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, describe, expect, test, vi } from 'vitest';
import exampleModule from '../../tests/fixtures/legacy-plugin/index';
import { ConvertError, convertLegacyPlugin, renderServer, toJsonSchema } from './convert';
import { parseManifest } from './packages/manifest';

const EXAMPLE = resolve(__dirname, '..', '..', 'tests', 'fixtures', 'legacy-plugin');

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** A minimal MCP client over the generated server's stdio. */
function startServer(dir: string) {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const stderr: string[] = [];
  child.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  const notifications: Array<Record<string, unknown>> = [];
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const msg = JSON.parse(line) as Record<string, unknown>;
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    } else {
      notifications.push(msg);
    }
  });
  let next = 1;
  const request = (method: string, params?: unknown) => new Promise<Record<string, unknown>>((res, rej) => {
    const id = next++;
    const timer = setTimeout(() => rej(new Error(`no answer to ${method}; stderr: ${stderr.join('')}`)), 10_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      res(msg);
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { child, request, notifications, stderr };
}

function writePlugin(manifest: Record<string, unknown>, files: Record<string, string>): string {
  const dir = tmp('octipus-legacy-');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ version: '1.0.0', description: 'probe', apiVersion: '1.0.0', main: 'index.mjs', ...manifest }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

async function refusal(dir: string, opts: Parameters<typeof convertLegacyPlugin>[1] = {}): Promise<string[]> {
  try {
    await convertLegacyPlugin(dir, { outDir: join(tmp('octipus-out-'), 'pkg'), checkHandlers: true, ...opts });
  } catch (err) {
    if (err instanceof ConvertError) return err.problems;
    throw err;
  }
  throw new Error('expected a ConvertError');
}

const tool = (name: string) => ({ name, description: `${name} tool`, parameters: { x: { type: 'string', description: 'x', required: true } } });

describe('convertLegacyPlugin: the legacy fixture', () => {
  let outDir: string;

  test('writes a package whose manifest fits the package contract', async () => {
    outDir = join(tmp('octipus-convert-'), 'example-package');
    const result = await convertLegacyPlugin(EXAMPLE, { outDir });

    const written = JSON.parse(readFileSync(join(outDir, 'octipus-plugin.json'), 'utf8'));
    const manifest = parseManifest(written);
    expect(manifest).toEqual(result.manifest);
    expect(manifest.name).toBe('example-plugin');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.server).toEqual({ command: 'node', args: ['server.mjs'] });
    // The most conservative effect for every tool, no network, the ceiling for that case.
    expect(manifest.tools).toEqual({
      greet: { effect: 'external', description: 'Returns a greeting message for the given name' },
      calculate: { effect: 'external', description: 'Performs basic arithmetic on two numbers' },
    });
    expect(manifest.network).toEqual([]);
    expect(manifest.maxProtection).toBe(4);
    expect(existsSync(join(outDir, 'legacy', 'index.ts'))).toBe(true);
    expect(existsSync(join(outDir, 'legacy', 'plugin.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')).type).toBe('module');
  });

  test('the generated server answers initialize, tools/list and tools/call like the legacy handler', async () => {
    const server = startServer(outDir);

    const init = await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.result).toMatchObject({ protocolVersion: '2024-11-05', serverInfo: { name: 'example-plugin', version: '1.0.0' } });

    const list = await server.request('tools/list');
    const tools = (list.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['greet', 'calculate']);
    expect(tools[1].inputSchema).toEqual({
      type: 'object',
      properties: {
        operation: { type: 'string', description: 'The operation to perform: add, subtract, multiply, divide' },
        a: { type: 'number', description: 'First operand' },
        b: { type: 'number', description: 'Second operand' },
      },
      required: ['operation', 'a', 'b'],
    });

    const args = { operation: 'multiply', a: 6, b: 7 };
    const call = await server.request('tools/call', { name: 'calculate', arguments: args });
    const content = (call.result as { content: Array<{ type: string; text: string }> }).content;
    expect(JSON.parse(content[0].text)).toEqual(await exampleModule.tools.calculate(args));

    const greet = await server.request('tools/call', { name: 'greet', arguments: { name: 'Ada' } });
    expect(JSON.parse((greet.result as { content: Array<{ text: string }> }).content[0].text)).toEqual(await exampleModule.tools.greet({ name: 'Ada' }));

    const unknown = await server.request('tools/call', { name: 'nope', arguments: {} });
    expect(unknown.error).toMatchObject({ code: -32602 });

    // initialize's logger.info went out as an MCP log message, never on stderr
    // (the host reads stderr as a transport error).
    expect(server.notifications).toContainEqual(expect.objectContaining({ method: 'notifications/message', params: expect.objectContaining({ data: 'Example plugin initialized' }) }));
    expect(server.stderr.join('')).toBe('');

    server.child.stdin?.end();
    await new Promise((res) => server.child.once('exit', res));
  });

  test('effects can be lowered per tool, and the output must be empty', async () => {
    const out = join(tmp('octipus-convert-'), 'pkg');
    const result = await convertLegacyPlugin(EXAMPLE, { outDir: out, effects: { greet: 'read' } });
    expect(result.manifest.tools?.greet.effect).toBe('read');
    expect(result.manifest.tools?.calculate.effect).toBe('external');
    await expect(convertLegacyPlugin(EXAMPLE, { outDir: out })).rejects.toThrow(/exists and is not empty/);
  });
});

describe('convertLegacyPlugin: refusals', () => {
  test('host internals, hooks and the vault', async () => {
    const dir = writePlugin({ name: 'needs-host', tools: [tool('t')] }, {
      'index.mjs': `import { getAgentHooks } from '@/core/agent/hooks';
import { getVault } from '@/security/vault';
import { helper } from '../outside.mjs';
getAgentHooks().register('before-agent-start', () => {});
export default { name: 'needs-host', tools: { t: async () => getVault() } };`,
    });
    const problems = await refusal(dir);
    expect(problems.some((p) => p.includes('host internals ("@/core/agent/hooks")'))).toBe(true);
    expect(problems.some((p) => p.includes('host internals ("@/security/vault")'))).toBe(true);
    expect(problems.some((p) => p.includes('root agent hook'))).toBe(true);
    expect(problems.some((p) => p.includes('reads the vault'))).toBe(true);
    expect(problems.some((p) => p.includes('outside the plugin directory'))).toBe(true);
  });

  test('declared vault secrets', async () => {
    const dir = writePlugin({ name: 'has-secrets', tools: [tool('t')], secrets: { TOKEN: 'my-token' } }, {
      'index.mjs': `export default { name: 'has-secrets', tools: { t: async (_a, ctx) => ctx.config.TOKEN } };`,
    });
    expect((await refusal(dir)).some((p) => p.includes('declares secrets (TOKEN)'))).toBe(true);
  });

  test('network use without hosts; with hosts it converts at the lowest ceiling', async () => {
    const files = { 'index.mjs': `export default { name: 'net', tools: { t: async () => (await fetch('https://api.example.com')).status } };` };
    const dir = writePlugin({ name: 'net', tools: [tool('t')] }, files);
    expect((await refusal(dir)).some((p) => p.includes('uses the network') && p.includes('--network'))).toBe(true);

    const result = await convertLegacyPlugin(dir, { outDir: join(tmp('octipus-out-'), 'pkg'), network: ['api.example.com'] });
    expect(result.manifest.network).toEqual(['api.example.com']);
    expect(result.manifest.maxProtection).toBe(1);
  });

  test('names, parameter types, missing handlers and extension-less imports', async () => {
    const dir = writePlugin({
      name: 'Bad_Name',
      tools: [tool('ok'), { name: 'odd', description: 'd', parameters: { v: { type: 'any', description: 'v' } } }],
    }, {
      'index.mjs': `import './lib';\nexport default { name: 'x', tools: { ok: async () => 1 } };`,
      'lib.mjs': '',
    });
    const problems = await refusal(dir);
    expect(problems.some((p) => p.includes('"any"'))).toBe(true);
    expect(problems.some((p) => p.includes('without a file extension'))).toBe(true);

    const fixed = writePlugin({ name: 'Bad_Name', tools: [tool('ok'), tool('missing')] }, {
      'index.mjs': `export default { name: 'x', tools: { ok: async () => 1 } };`,
    });
    const more = await refusal(fixed);
    expect(more).toContain('tool "missing" has no handler in index.mjs');
    expect(more.some((p) => p.startsWith('generated octipus-plugin.json: name:'))).toBe(true);
  });

  test('a missing plugin.json', async () => {
    expect(await refusal(tmp('octipus-empty-'))).toEqual([expect.stringMatching(/^no plugin\.json in /)]);
  });
});

describe('convertLegacyPlugin: running nothing it has not been asked to', () => {
  test('the handlers are not imported unless asked: the plugin\'s top-level code does not run', async () => {
    const marker = join(tmp('octipus-marker-'), 'ran');
    const dir = writePlugin({ name: 'quiet', tools: [tool('ok')] }, {
      'index.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport default { name: 'quiet', tools: { ok: async () => 1 } };`,
    });
    const result = await convertLegacyPlugin(dir, { outDir: join(tmp('octipus-out-'), 'pkg') });
    expect(existsSync(marker)).toBe(false);
    expect(result.warnings.some((w) => w.includes('--check-handlers'))).toBe(true);

    await convertLegacyPlugin(dir, { outDir: join(tmp('octipus-out-'), 'pkg'), checkHandlers: true });
    expect(existsSync(marker)).toBe(true);
  });

  test('a link under node_modules is refused; node_modules/.bin shims are left out', async () => {
    const dir = writePlugin({ name: 'linked', tools: [tool('ok')] }, {
      'index.mjs': `export default { name: 'linked', tools: { ok: async () => 1 } };`,
      'node_modules/dep/index.js': 'module.exports = 1;',
    });
    mkdirSync(join(dir, 'node_modules', '.bin'));
    symlinkSync('../dep/index.js', join(dir, 'node_modules', '.bin', 'dep'));
    const outDir = join(tmp('octipus-out-'), 'pkg');
    await convertLegacyPlugin(dir, { outDir });
    expect(existsSync(join(outDir, 'legacy', 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(outDir, 'legacy', 'node_modules', '.bin'))).toBe(false);

    symlinkSync('dep', join(dir, 'node_modules', 'alias'));
    const problems = await refusal(dir);
    expect(problems.some((p) => p.includes(join('node_modules', 'alias')) && p.includes('symbolic link'))).toBe(true);
  });

  test('an entry path with "#" still loads, and a newline cannot leave the header comment', async () => {
    const dir = writePlugin({ name: 'hashy', tools: [tool('ok')], main: 'lib#1/index.mjs', version: '1.0.0' }, {
      'lib#1/index.mjs': `export default { name: 'hashy', tools: { ok: async () => 'fine' } };`,
    });
    const outDir = join(tmp('octipus-out-'), 'pkg');
    await convertLegacyPlugin(dir, { outDir });
    const server = startServer(outDir);
    await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const call = await server.request('tools/call', { name: 'ok', arguments: { x: 'y' } });
    expect((call.result as { content: Array<{ text: string }> }).content[0].text).toBe('fine');
    server.child.stdin?.end();
    await new Promise((res) => server.child.once('exit', res));

    const header = renderServer({ name: 'n', version: '1', entry: './legacy/a\nprocess.exit(1)//.mjs', tools: [] }).split('\n').slice(0, 4);
    expect(header.every((line) => line.startsWith('//'))).toBe(true);
  });
});

describe('toJsonSchema', () => {
  test('flat legacy parameters become a JSON Schema object', () => {
    expect(toJsonSchema({
      q: { type: 'string', description: 'query', required: true },
      limit: { type: 'integer', description: 'max', default: 10 },
    }, 't')).toEqual({
      type: 'object',
      properties: { q: { type: 'string', description: 'query' }, limit: { type: 'integer', description: 'max', default: 10 } },
      required: ['q'],
    });
    expect(toJsonSchema({}, 't')).toEqual({ type: 'object', properties: {} });
  });
});

describe('legacy loader deprecation', () => {
  test('warns once per plugin, naming the convert command', async () => {
    vi.resetModules();
    const warn = vi.fn();
    vi.doMock('@/utils/logger', async (original) => {
      const actual = await original<typeof import('@/utils/logger')>();
      const child = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() };
      return { ...actual, createChildLogger: () => child };
    });
    const root = tmp('octipus-deprecation-');
    const pluginDir = join(root, 'legacy-plugins', 'old-one');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'old-one', version: '1.0.0', description: 'd', apiVersion: '1.0.0', main: 'index.mjs', tools: [tool('t')] }));
    writeFileSync(join(pluginDir, 'index.mjs'), `export default { name: 'old-one', tools: { t: async () => 1 } };`);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const loader = await import('./loader');
      const loaded = await loader.loadPlugins({ dir: join(root, 'legacy-plugins'), cwd: root });
      expect(loaded.map((p) => p.manifest.name)).toEqual(['old-one']);
      await loader.reloadPlugin('old-one');
      const deprecations = warn.mock.calls.filter((c) => String(c[1]).includes('deprecated'));
      expect(deprecations).toHaveLength(1);
      expect(deprecations[0][1]).toContain(`octi plugin convert ${pluginDir}`);
    } finally {
      cwd.mockRestore();
      vi.doUnmock('@/utils/logger');
    }
  });
});
