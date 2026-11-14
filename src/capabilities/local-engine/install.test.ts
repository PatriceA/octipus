/**
 * The local embedding engine end to end against fakes: a fake GitHub release
 * and Hugging Face file (fetch), and a fake `llama-server` (a Node script that
 * answers /health and /v1/embeddings). Covers the install job, verification,
 * the supervisor, the provider, binding only an unbound lane, and removal.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const MODEL_BYTES = Buffer.from('GGUF-fake-model-bytes'.repeat(100));
const MODEL_SHA = createHash('sha256').update(MODEL_BYTES).digest('hex');

vi.mock('./manifest.json', () => ({
  default: {
    engine: {
      name: 'llama.cpp', repo: 'ggml-org/llama.cpp', tag: 'b1', binary: 'llama-server',
      gpu: { vulkan: { 'win32-x64': { pattern: '^llama-b1-bin-win-vulkan-x64\\.zip$', sha256: null } } },
      assets: {
        'linux-x64': { pattern: '^llama-b1-bin-ubuntu-x64\\.tar\\.gz$', sha256: null },
        'linux-arm64': { pattern: '^llama-b1-bin-ubuntu-arm64\\.tar\\.gz$', sha256: null },
        'darwin-arm64': { pattern: '^llama-b1-bin-macos-arm64\\.tar\\.gz$', sha256: null },
        'darwin-x64': { pattern: '^llama-b1-bin-macos-x64\\.tar\\.gz$', sha256: null },
        'win32-x64': { pattern: '^nope$', sha256: null },
        'win32-arm64': { pattern: '^nope$', sha256: null },
      },
    },
    defaultModel: 'tiny',
    models: [{
      id: 'tiny', label: 'Tiny', repo: 'test/tiny-GGUF', revision: 'a'.repeat(40), file: 'tiny.gguf',
      sha256: MODEL_SHA, size: MODEL_BYTES.length, dims: 8, pooling: 'mean', contextLength: 512,
      prefixes: { query: 'q: ', document: 'd: ' }, license: 'test',
    }, {
      id: 'tiny2', label: 'Tiny 2', repo: 'test/tiny-GGUF', revision: 'a'.repeat(40), file: 'tiny2.gguf',
      sha256: MODEL_SHA, size: MODEL_BYTES.length, dims: 8, pooling: 'mean', contextLength: 512,
      prefixes: { query: 'q: ', document: 'd: ' }, license: 'test',
    }],
  },
}));

interface Row { name: string; provider: string; modelId: string; metadata?: Record<string, unknown>; topicRoles?: Record<string, string> }
const rows = new Map<string, Row>();
vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getModel: async (name: string) => rows.get(name) ?? null,
    registerModel: async (row: Row) => { rows.set(row.name, { ...row }); },
    updateModel: async (name: string, patch: Partial<Row>) => { rows.set(name, { ...rows.get(name)!, ...patch }); },
    getModelForTopic: async (lane: string) => [...rows.values()].find((r) => r.topicRoles?.[lane] === 'primary') ?? null,
    getAllModelsIncludeDisabled: async () => [...rows.values()],
    deleteModel: async (name: string) => { rows.delete(name); },
  }),
}));
vi.mock('@/models/providers/instrumented', () => ({ recordProviderUsage: async () => {} }));

const FAKE_SERVER = `#!/usr/bin/env node
const http = require('node:http');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.error('version: 1 (fake)'); process.exit(0); }
if (args.includes('--api-key')) { console.error('the key must not be on the command line'); process.exit(2); }
const port = Number(args[args.indexOf('--port') + 1]);
const offset = args[args.indexOf('-m') + 1].endsWith('tiny2.gguf') ? 100 : 0;
const key = process.env.LLAMA_API_KEY;
http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(401); return res.end(); }
  if (req.url === '/health') { res.writeHead(200); return res.end('{"status":"ok"}'); }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const input = JSON.parse(body).input;
    const data = input.map((t, i) => ({ index: i, embedding: Array.from({ length: 8 }, (_, j) => offset + t.length + j) })).reverse();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data, usage: { prompt_tokens: 3 } }));
  });
}).listen(port, '127.0.0.1');
`;

const supported = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'].includes(`${process.platform}-${process.arch}`);
const arch = `${process.platform === 'darwin' ? 'macos' : 'ubuntu'}-${process.arch}`;
/** A binary that cannot load its libraries (it prints "version", but fails). */
const BROKEN_SERVER = `#!/bin/sh
echo "llama-server: /lib/x86_64-linux-gnu/libc.so.6: version \\\`GLIBC_2.38' not found" >&2
exit 1
`;
let root = '';
let archive = Buffer.alloc(0);
let archiveSha = '';
let goodArchive = Buffer.alloc(0);
let brokenArchive = Buffer.alloc(0);
let modelBody = MODEL_BYTES;
let assetFetches = 0;
let modelFetches = 0;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'octipus-le-'));
  const build = join(root, 'release', 'build', 'bin');
  await mkdir(build, { recursive: true });
  await writeFile(join(build, 'llama-server'), FAKE_SERVER);
  await chmod(join(build, 'llama-server'), 0o755);
  // Releases ship versioned libraries behind relative symlinks.
  await writeFile(join(build, 'libggml.so.0.1'), 'lib');
  await symlink('libggml.so.0.1', join(build, 'libggml.so.0'));
  const tarPath = join(root, `llama-b1-bin-${arch}.tar.gz`);
  execFileSync('tar', ['-czf', tarPath, '-C', join(root, 'release'), 'build']);
  goodArchive = await readFile(tarPath);
  const brokenBuild = join(root, 'broken', 'build', 'bin');
  await mkdir(brokenBuild, { recursive: true });
  await writeFile(join(brokenBuild, 'llama-server'), BROKEN_SERVER);
  await chmod(join(brokenBuild, 'llama-server'), 0o755);
  const brokenTar = join(root, 'broken.tar.gz');
  execFileSync('tar', ['-czf', brokenTar, '-C', join(root, 'broken'), 'build']);
  brokenArchive = await readFile(brokenTar);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

beforeEach(() => {
  process.env.OCTIPUS_MODELS_DIR = join(root, 'models');
  rows.clear();
  modelBody = MODEL_BYTES;
  archive = goodArchive;
  archiveSha = createHash('sha256').update(archive).digest('hex');
  modelFetches = 0;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b1')) {
      return Response.json({ assets: [{ name: `llama-b1-bin-${arch}.tar.gz`, browser_download_url: 'https://github.com/ggml-org/llama.cpp/releases/download/b1/asset.tar.gz', digest: `sha256:${archiveSha}`, size: archive.length }] });
    }
    if (url === 'https://github.com/ggml-org/llama.cpp/releases/download/b1/asset.tar.gz') { assetFetches++; return new Response(new Uint8Array(archive)); }
    if (url.startsWith(`https://huggingface.co/test/tiny-GGUF/resolve/${'a'.repeat(40)}/`)) { modelFetches++; return new Response(new Uint8Array(modelBody)); }
    return realFetch(input, init);
  });
});
afterEach(async () => {
  const { stopLocalEngine, resetLocalEngineForTest } = await import('./engine-process');
  await stopLocalEngine();
  resetLocalEngineForTest();
  const { removeLocalEngine } = await import('./install');
  await removeLocalEngine();
  vi.unstubAllGlobals();
  delete process.env.OCTIPUS_MODELS_DIR;
});

describe('release archives', () => {
  test('a zip entry that escapes the target folder is refused', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('build/bin/llama-server.exe', 'x');
    zip.file('../escaped.txt', 'x');
    const dir = await mkdtemp(join(tmpdir(), 'octipus-zip-'));
    const file = join(dir, 'a.zip');
    await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const { extractArchive } = await import('./install');
    await expect(extractArchive(file, join(dir, 'x'))).rejects.toThrow(/Unsafe path/);
    expect(existsSync(join(dir, 'escaped.txt'))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test('a zip release is extracted', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('build/bin/llama-server.exe', 'binary');
    const dir = await mkdtemp(join(tmpdir(), 'octipus-zip-'));
    const file = join(dir, 'a.zip');
    await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const { extractArchive } = await import('./install');
    await extractArchive(file, join(dir, 'x'));
    expect(await readFile(join(dir, 'x', 'build', 'bin', 'llama-server.exe'), 'utf8')).toBe('binary');
    await rm(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!supported)('local embedding engine', () => {
  test('installs, probes, registers and binds an unbound embedding lane', async () => {
    const { startLocalEngineInstall, waitForLocalEngineInstall } = await import('./install');
    const stages: string[] = [];
    startLocalEngineInstall('admin', undefined, (j) => { if (stages.at(-1) !== j.stage) stages.push(j.stage); });
    const job = await waitForLocalEngineInstall();
    expect(job?.error).toBeUndefined();
    expect(job).toMatchObject({ stage: 'done', bound: true, modelName: 'local tiny' });
    expect(stages).toEqual(expect.arrayContaining(['engine', 'model', 'probe', 'register', 'done']));
    const row = rows.get('local tiny')!;
    expect(row).toMatchObject({ provider: 'local-engine', modelId: 'tiny', topicRoles: { embedding: 'primary' } });
    expect(row.metadata).toMatchObject({ embedPrefixes: { query: 'q: ', document: 'd: ' }, dims: 8 });
    expect(existsSync(join(root, 'models', 'embeddings', 'tiny', 'tiny.gguf'))).toBe(true);
    // The library symlink is still relative and resolves inside the engine folder.
    const engine = join(root, 'models', 'engines', 'llama.cpp', 'b1');
    const [dir] = (await import('node:fs')).readdirSync(engine);
    expect(await readlink(join(engine, dir!, 'libggml.so.0'))).toBe('libggml.so.0.1');
    expect(existsSync(join(engine, dir!, 'libggml.so.0'))).toBe(true);
  });

  test('a binary that does not run is refused, even when its error mentions a version', async () => {
    archive = brokenArchive;
    archiveSha = createHash('sha256').update(archive).digest('hex');
    const { startLocalEngineInstall, waitForLocalEngineInstall } = await import('./install');
    startLocalEngineInstall('admin');
    const job = await waitForLocalEngineInstall();
    expect(job?.stage).toBe('error');
    expect(job?.error).toMatch(/does not run on this machine/);
    expect(existsSync(join(root, 'models', 'engines', 'llama.cpp', 'active.json'))).toBe(false);
    const { engineBinaryPath } = await import('./engine-process');
    expect(engineBinaryPath()).toBeNull();
  });

  test('removing or installing something else while an install runs is refused', async () => {
    const { LocalEngineBusyError, removeLocalEngine, startLocalEngineInstall, waitForLocalEngineInstall } = await import('./install');
    const first = startLocalEngineInstall('admin');
    expect(startLocalEngineInstall('admin')).toBe(first);
    expect(() => startLocalEngineInstall('admin', 'tiny2')).toThrow(LocalEngineBusyError);
    await expect(removeLocalEngine()).rejects.toThrow(LocalEngineBusyError);
    expect((await waitForLocalEngineInstall())?.stage).toBe('done');
  });

  test('callers for two models each get an engine serving their own model', async () => {
    const { startLocalEngineInstall, waitForLocalEngineInstall } = await import('./install');
    startLocalEngineInstall('admin');
    await waitForLocalEngineInstall();
    startLocalEngineInstall('admin', 'tiny2');
    await waitForLocalEngineInstall();
    const { LocalEngineProvider } = await import('@/models/providers/local-engine-provider');
    const provider = new LocalEngineProvider();
    const [a, b] = await Promise.all([provider.embed(['x'], 'tiny'), provider.embed(['x'], 'tiny2')]);
    expect(a[0]?.[0]).toBe(1);
    expect(b[0]?.[0]).toBe(101);
    const { localEngineStatus } = await import('./engine-process');
    // Switching models is a stop, not a crash.
    expect(localEngineStatus().recentCrashes).toBe(0);
  });

  test('an embedding model already bound is never replaced', async () => {
    rows.set('openai text-embedding-3-small', { name: 'openai text-embedding-3-small', provider: 'openai', modelId: 'text-embedding-3-small', topicRoles: { embedding: 'primary' } });
    const { startLocalEngineInstall, waitForLocalEngineInstall } = await import('./install');
    startLocalEngineInstall('admin');
    const job = await waitForLocalEngineInstall();
    expect(job).toMatchObject({ stage: 'done', bound: false });
    expect(job?.note).toMatch(/stays in use/);
    expect(rows.get('openai text-embedding-3-small')?.topicRoles).toEqual({ embedding: 'primary' });
    expect(rows.get('local tiny')?.topicRoles).toBeUndefined();
  });

  test('a model that does not match its checksum is refused', async () => {
    modelBody = Buffer.from('tampered'.repeat(100));
    const { startLocalEngineInstall, waitForLocalEngineInstall } = await import('./install');
    startLocalEngineInstall('admin');
    const job = await waitForLocalEngineInstall();
    expect(job?.stage).toBe('error');
    expect(job?.error).toMatch(/Checksum mismatch|larger than the pinned/);
    expect(rows.size).toBe(0);
  });

  test('the provider embeds through the supervised engine, in input order', async () => {
    const { startLocalEngineInstall, waitForLocalEngineInstall } = await import('./install');
    startLocalEngineInstall('admin');
    await waitForLocalEngineInstall();
    const { LocalEngineProvider } = await import('@/models/providers/local-engine-provider');
    const vectors = await new LocalEngineProvider().embed(['a', 'bbb'], 'tiny');
    expect(vectors.map((v) => v[0])).toEqual([1, 3]);
    const { localEngineStatus, stopLocalEngine } = await import('./engine-process');
    expect(localEngineStatus()).toMatchObject({ running: true, model: 'tiny' });
    await stopLocalEngine();
    expect(localEngineStatus().running).toBe(false);
    // Started again on demand.
    expect((await new LocalEngineProvider().embed(['cc'], 'tiny'))[0]?.[0]).toBe(2);
  });

  test('removal stops the engine, deletes its rows and files', async () => {
    const { startLocalEngineInstall, waitForLocalEngineInstall, removeLocalEngine } = await import('./install');
    startLocalEngineInstall('admin');
    await waitForLocalEngineInstall();
    const out = await removeLocalEngine();
    expect(out.removedRows).toEqual(['local tiny']);
    expect(rows.size).toBe(0);
    expect(existsSync(join(root, 'models', 'embeddings', 'tiny'))).toBe(false);
    expect(existsSync(join(root, 'models', 'engines', 'llama.cpp'))).toBe(false);
  });

  test('an older engine build serves until the new tag has passed its probe, then is removed', async () => {
    const { startLocalEngineInstall, waitForLocalEngineInstall, upgradeLocalEngineIfNeeded } = await import('./install');
    startLocalEngineInstall('admin');
    await waitForLocalEngineInstall();
    const engines = join(root, 'models', 'engines', 'llama.cpp');
    // Pretend the install was made with an older tag.
    const { rename } = await import('node:fs/promises');
    await rename(join(engines, 'b1'), join(engines, 'b0'));
    await writeFile(join(engines, 'active.json'), JSON.stringify({ tag: 'b0', variant: 'cpu' }));
    const { engineBinaryPath } = await import('./engine-process');
    expect(engineBinaryPath()).toContain(join('b0', ''));
    assetFetches = 0;
    expect(await upgradeLocalEngineIfNeeded()).toBe(true);
    expect(assetFetches).toBe(1);
    expect(JSON.parse(await readFile(join(engines, 'active.json'), 'utf8'))).toEqual({ tag: 'b1', variant: 'cpu' });
    expect(existsSync(join(engines, 'b0'))).toBe(false);
    expect(engineBinaryPath()).toContain(join('b1', ''));
    expect(await upgradeLocalEngineIfNeeded()).toBe(false);
  });

  test('a verified install is not downloaded again', async () => {
    const { startLocalEngineInstall, waitForLocalEngineInstall } = await import('./install');
    startLocalEngineInstall('admin');
    await waitForLocalEngineInstall();
    assetFetches = 0;
    modelFetches = 0;
    startLocalEngineInstall('admin');
    expect((await waitForLocalEngineInstall())?.stage).toBe('done');
    expect(assetFetches).toBe(0);
    expect(modelFetches).toBe(0);
  });

  test('a GPU build is refused where none is built', async () => {
    const { startLocalEngineInstall } = await import('./install');
    expect(() => startLocalEngineInstall('admin', undefined, undefined, { gpu: 'vulkan' })).toThrow(/no vulkan build/);
  });

  test('the engine is not started for a model that is not installed', async () => {
    const { ensureLocalEngine } = await import('./engine-process');
    await expect(ensureLocalEngine('tiny')).rejects.toThrow(/not installed/);
  });
});
