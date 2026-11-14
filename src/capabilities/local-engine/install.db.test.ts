/**
 * Installing the local embedding engine never replaces an embedding model
 * already in use (docs/RAG.md → Local embeddings → Binding), against the real
 * model registry on embedded PGlite. The release, the model file and
 * `llama-server` are fakes; everything from the install job down to the rows
 * and the lane binding is real.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const MODEL_BYTES = Buffer.from('GGUF-fake-model-bytes'.repeat(100));
const MODEL_SHA = createHash('sha256').update(MODEL_BYTES).digest('hex');

vi.mock('./manifest.json', () => ({
  default: {
    engine: {
      name: 'llama.cpp', repo: 'ggml-org/llama.cpp', tag: 'b1', binary: 'llama-server',
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
    }],
  },
}));

const FAKE_SERVER = `#!/usr/bin/env node
const http = require('node:http');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.error('version: 1 (fake)'); process.exit(0); }
const port = Number(args[args.indexOf('--port') + 1]);
const key = process.env.LLAMA_API_KEY;
http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + key) { res.writeHead(401); return res.end(); }
  if (req.url === '/health') { res.writeHead(200); return res.end('{"status":"ok"}'); }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const data = JSON.parse(body).input.map((t, i) => ({ index: i, embedding: Array.from({ length: 8 }, (_, j) => t.length + j) }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });
}).listen(port, '127.0.0.1');
`;

const supported = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'].includes(`${process.platform}-${process.arch}`);
const arch = `${process.platform === 'darwin' ? 'macos' : 'ubuntu'}-${process.arch}`;
const EXISTING = 'openai text-embedding-3-small';
let root = '';
let archive = Buffer.alloc(0);
const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-local-engine-db-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  root = await mkdtemp(join(tmpdir(), 'octipus-le-db-'));
  const build = join(root, 'release', 'build', 'bin');
  await mkdir(build, { recursive: true });
  await writeFile(join(build, 'llama-server'), FAKE_SERVER);
  await chmod(join(build, 'llama-server'), 0o755);
  const tarPath = join(root, 'release.tar.gz');
  execFileSync('tar', ['-czf', tarPath, '-C', join(root, 'release'), 'build']);
  archive = await readFile(tarPath);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  process.env.OCTIPUS_MODELS_DIR = join(root, 'models');
  const sha = createHash('sha256').update(archive).digest('hex');
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/b1')) {
      return Response.json({ assets: [{ name: `llama-b1-bin-${arch}.tar.gz`, browser_download_url: '', digest: `sha256:${sha}`, size: archive.length }] });
    }
    if (url === `https://github.com/ggml-org/llama.cpp/releases/download/b1/llama-b1-bin-${arch}.tar.gz`) return new Response(new Uint8Array(archive));
    if (url.startsWith('https://huggingface.co/test/tiny-GGUF/resolve/')) return new Response(new Uint8Array(MODEL_BYTES));
    return realFetch(input, init);
  });
  const { getModelRegistry } = await import('@/models/model-registry');
  const registry = getModelRegistry();
  for (const row of await registry.getAllModelsIncludeDisabled()) await registry.deleteModel(row.name);
});

afterEach(async () => {
  const { removeLocalEngine } = await import('./install');
  await removeLocalEngine();
  const { resetLocalEngineForTest } = await import('./engine-process');
  resetLocalEngineForTest();
  vi.unstubAllGlobals();
  delete process.env.OCTIPUS_MODELS_DIR;
});

async function install() {
  const { startLocalEngineInstall, waitForLocalEngineInstall } = await import('./install');
  startLocalEngineInstall('admin');
  const job = await waitForLocalEngineInstall();
  expect(job?.error).toBeUndefined();
  return job;
}

describe.skipIf(!supported)('local embedding install and the embedding lane (database)', () => {
  test('an embedding model already bound stays bound; the local model is added unbound', async () => {
    const { getModelRegistry } = await import('@/models/model-registry');
    const registry = getModelRegistry();
    await registry.registerModel({ name: EXISTING, provider: 'openai', modelId: 'text-embedding-3-small', topicRoles: { embedding: 'primary' } });

    const job = await install();
    expect(job).toMatchObject({ stage: 'done', bound: false });
    expect(job?.note).toMatch(/stays in use/);
    expect((await registry.getModelForTopic('embedding'))?.name).toBe(EXISTING);
    expect((await registry.getModel(EXISTING))?.topicRoles).toEqual({ embedding: 'primary' });
    const local = await registry.getModel('local tiny');
    expect(local).toMatchObject({ provider: 'local-engine', modelId: 'tiny' });
    expect(local?.topicRoles ?? {}).not.toHaveProperty('embedding');
  });

  test('a disabled embedding primary is respected too: re-enabling it finds the lane as it was', async () => {
    const { getModelRegistry } = await import('@/models/model-registry');
    const registry = getModelRegistry();
    await registry.registerModel({ name: EXISTING, provider: 'openai', modelId: 'text-embedding-3-small', topicRoles: { embedding: 'primary' } });
    await registry.updateModel(EXISTING, { isEnabled: false });

    const job = await install();
    expect(job).toMatchObject({ stage: 'done', bound: false });
    expect((await registry.getModel('local tiny'))?.topicRoles ?? {}).not.toHaveProperty('embedding');
    await registry.updateModel(EXISTING, { isEnabled: true });
    expect((await registry.getModelForTopic('embedding'))?.name).toBe(EXISTING);
  });

  test('an unbound lane gets the local model as its primary', async () => {
    const job = await install();
    expect(job).toMatchObject({ stage: 'done', bound: true, modelName: 'local tiny' });
    const { getModelRegistry } = await import('@/models/model-registry');
    expect((await getModelRegistry().getModelForTopic('embedding'))?.name).toBe('local tiny');
  });

  test('removing it unbinds the lane (search then reports no embedding model)', async () => {
    await install();
    const { removeLocalEngine } = await import('./install');
    expect((await removeLocalEngine()).removedRows).toEqual(['local tiny']);
    const { getModelRegistry } = await import('@/models/model-registry');
    expect(await getModelRegistry().getModelForTopic('embedding')).toBeNull();
  });
});
