/**
 * Install the optional local embedding engine (docs/RAG.md → Local
 * embeddings): only when someone says yes, never in the background on its own.
 *
 *   1. the llama.cpp release asset for this platform: SHA-256 from the
 *      manifest, else GitHub's release API (`assets[].digest`); a download
 *      that does not match is refused;
 *   2. extracted, `chmod +x`, quarantine cleared on macOS, and PROBED by
 *      running `llama-server --version` (a file that exists proves nothing);
 *   3. the GGUF model at its pinned revision, SHA-256 verified;
 *   4. started, and a probe text embedded: the vector's dimension must match
 *      the manifest;
 *   5. the model row created and bound to the embedding lane ONLY when the
 *      lane is unbound — an existing embedding model is never replaced
 *      (existing vectors would need a rebuild; docs/RAG.md).
 *
 * Idempotent (verified files are kept); concurrent calls share one job.
 */
import { randomUUID } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnProcess } from '@/utils/proc';
import { logger } from '@/utils/logger';
import { downloadVerified, sha256File } from './download';
import { engineBinaryPath, ensureLocalEngine, stopLocalEngine } from './engine-process';
import { LOCAL_ENGINE_MANIFEST, type LocalEmbeddingModel, localEmbeddingModel, modelUrl, type PlatformKey, platformKey } from './manifest';
import { engineDir, modelDir, modelFilePath } from './paths';

const log = logger.child({ component: 'local-engine-install' });
export const LOCAL_ENGINE_PROVIDER = 'local-engine';

export type LocalEngineStage = 'engine' | 'model' | 'probe' | 'register' | 'done' | 'error';

export interface LocalEngineJob {
  id: string;
  ownerId: string;
  modelId: string;
  stage: LocalEngineStage;
  /** Download progress of the current stage, 0–100. */
  percent: number;
  statusText: string;
  modelName?: string;
  /** Bound to the embedding lane by this install (false: another model stays in use). */
  bound?: boolean;
  note?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

let current: LocalEngineJob | null = null;
let running: Promise<LocalEngineJob> | null = null;

export function rowName(model: LocalEmbeddingModel): string {
  return `local ${model.id}`;
}

export function localEngineJob(): LocalEngineJob | null {
  return current;
}

interface ReleaseAsset { name: string; browser_download_url: string; digest?: string | null; size?: number }

async function releaseAsset(key: PlatformKey): Promise<{ url: string; name: string; sha256: string; size?: number }> {
  const { repo, tag, assets } = LOCAL_ENGINE_MANIFEST.engine;
  const want = new RegExp(assets[key].pattern);
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'octipus-local-engine' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Could not read the llama.cpp ${tag} release (HTTP ${res.status}). Check the network, or copy models/engines from another install.`);
  const release = (await res.json()) as { assets?: ReleaseAsset[] };
  const asset = (release.assets ?? []).find((a) => want.test(a.name));
  if (!asset) throw new Error(`The llama.cpp ${tag} release has no build for ${key}.`);
  const fromApi = asset.digest?.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : null;
  const sha256 = assets[key].sha256 ?? fromApi;
  if (!sha256) throw new Error(`No checksum is known for ${asset.name}; refusing to install an unverified binary.`);
  if (assets[key].sha256 && fromApi && assets[key].sha256 !== fromApi) throw new Error(`The pinned checksum of ${asset.name} does not match the release's.`);
  return { url: asset.browser_download_url, name: asset.name, sha256, size: asset.size };
}

async function run(command: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; output: string }> {
  const proc = spawnProcess({ command, args, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  timer.unref?.();
  const [out, err, code] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : '',
    proc.stderr ? new Response(proc.stderr).text() : '',
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, output: `${out}\n${err}` };
}

/** Find the directory holding `name` inside an extracted release. */
async function findBinaryDir(root: string, name: string, depth = 4): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (entries.some((e) => e.isFile() && e.name === name)) return root;
  if (depth === 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = await findBinaryDir(join(root, e.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

async function extract(archive: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true });
  if (archive.endsWith('.zip')) {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await readFile(archive));
    for (const entry of Object.values(zip.files)) {
      const target = join(into, entry.name);
      // Zip-slip: every entry stays inside the target directory.
      if (!target.startsWith(`${into}/`) && !target.startsWith(`${into}\\`)) throw new Error(`Unsafe path in the release archive: ${entry.name}`);
      if (entry.dir) { await mkdir(target, { recursive: true }); continue; }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await entry.async('nodebuffer'));
    }
    return;
  }
  const { code, output } = await run('tar', ['-xzf', archive, '-C', into, '--no-same-owner'], 300_000);
  if (code !== 0) throw new Error(`Could not extract ${archive}: ${output.trim().slice(-300)}`);
}

/** The engine binary for this platform, downloaded, verified and probed. */
async function installEngine(key: PlatformKey, progress: (percent: number, text: string) => void): Promise<string> {
  const bin = engineBinaryPath() as string;
  if (await probeEngine(bin)) return bin;
  const asset = await releaseAsset(key);
  const work = await mkdtemp(join(tmpdir(), 'octipus-llama-'));
  try {
    const archive = join(work, asset.name);
    await downloadVerified(asset.url, archive, asset.sha256, {
      size: asset.size,
      onProgress: (done, total) => progress(total ? Math.round((done / total) * 100) : 0, `Downloading the engine (${Math.round(done / 1e6)} MB)`),
    });
    progress(100, 'Extracting the engine');
    const unpacked = join(work, 'x');
    await extract(archive, unpacked);
    const exe = `${LOCAL_ENGINE_MANIFEST.engine.binary}${process.platform === 'win32' ? '.exe' : ''}`;
    const from = await findBinaryDir(unpacked, exe);
    if (!from) throw new Error(`${asset.name} has no ${exe}`);
    const dir = engineDir(key);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await cp(from, dir, { recursive: true });
    if (process.platform !== 'win32') {
      for (const name of await readdir(dir)) {
        if (name === exe || name.startsWith('llama-') || name.endsWith('.so') || name.endsWith('.dylib')) await chmod(join(dir, name), 0o755).catch(() => {});
      }
    }
    if (process.platform === 'darwin') await run('xattr', ['-dr', 'com.apple.quarantine', dir]).catch(() => undefined);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  if (!(await probeEngine(bin))) throw new Error('The downloaded llama-server does not run on this machine (`--version` failed).');
  return bin;
}

/** Does the binary run? (`--version` exits 0, or prints a version.) */
export async function probeEngine(bin: string): Promise<boolean> {
  if (!(await stat(bin).catch(() => null))?.isFile()) return false;
  try {
    const { code, output } = await run(bin, ['--version'], 30_000);
    return code === 0 || /version/i.test(output);
  } catch {
    return false;
  }
}

/** The GGUF at its pinned revision; a verified file is kept (a marker spares hashing it again). */
async function installModel(model: LocalEmbeddingModel, progress: (percent: number, text: string) => void): Promise<void> {
  const file = modelFilePath(model);
  const marker = join(modelDir(model), '.verified');
  const info = await stat(file).catch(() => null);
  if (info?.size === model.size && (await readFile(marker, 'utf8').catch(() => '')).trim() === model.sha256) return;
  if (info?.size === model.size && (await sha256File(file)) === model.sha256) {
    await writeFile(marker, model.sha256);
    return;
  }
  await downloadVerified(modelUrl(model), file, model.sha256, {
    size: model.size,
    onProgress: (done) => progress(Math.round((done / model.size) * 100), `Downloading ${model.label} (${Math.round(done / 1e6)} of ${Math.round(model.size / 1e6)} MB)`),
  });
  await writeFile(marker, model.sha256);
}

/** Embed a probe text through the running engine; the dimension must match the manifest. */
async function probeEmbedding(model: LocalEmbeddingModel): Promise<void> {
  const { port, apiKey } = await ensureLocalEngine(model.id);
  const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: [`${model.prefixes.document}hello world`], model: model.id }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`The engine did not embed the probe text (HTTP ${res.status}).`);
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const dims = json.data?.[0]?.embedding?.length ?? 0;
  if (dims !== model.dims) throw new Error(`The engine returned ${dims}-dimensional vectors; ${model.id} should give ${model.dims}.`);
}

/** The model row; bound to the embedding lane only when nothing is bound there. */
async function registerRow(model: LocalEmbeddingModel): Promise<{ name: string; bound: boolean }> {
  const { getModelRegistry } = await import('@/models/model-registry');
  const { boundTo } = await import('@/models/media-resolver');
  const registry = getModelRegistry();
  const name = rowName(model);
  const metadata = {
    embedPrefixes: { query: model.prefixes.query, document: model.prefixes.document },
    dims: model.dims,
    engine: { name: LOCAL_ENGINE_MANIFEST.engine.name, tag: LOCAL_ENGINE_MANIFEST.engine.tag, modelSha256: model.sha256 },
    capabilitiesDetectedAt: new Date().toISOString(),
  };
  const existing = await registry.getModel(name);
  if (existing) await registry.updateModel(name, { metadata: { ...(existing.metadata ?? {}), ...metadata } as never });
  else {
    await registry.registerModel({
      name, provider: LOCAL_ENGINE_PROVIDER, modelId: model.id, supportsTools: false, supportsStreaming: false, supportsVision: false,
      metadata: metadata as never,
    } as never);
  }
  const bound = await registry.getModelForTopic('embedding');
  if (bound && boundTo(bound, 'embedding')) return { name, bound: bound.name === name };
  const row = await registry.getModel(name);
  await registry.updateModel(name, { topicRoles: { ...(row?.topicRoles ?? {}), embedding: 'primary' } });
  return { name, bound: true };
}

/** Run the install; one at a time (a second call joins the running one). */
export function startLocalEngineInstall(ownerId: string, modelId?: string, onUpdate?: (job: LocalEngineJob) => void): LocalEngineJob {
  const model = localEmbeddingModel(modelId);
  if (!model) throw new Error(`Unknown local embedding model "${modelId}". Known: ${LOCAL_ENGINE_MANIFEST.models.map((m) => m.id).join(', ')}`);
  if (running && current) return current;
  const key = platformKey();
  const job: LocalEngineJob = { id: randomUUID(), ownerId, modelId: model.id, stage: 'engine', percent: 0, statusText: 'Starting', startedAt: Date.now() };
  current = job;
  const update = (patch: Partial<LocalEngineJob>) => { Object.assign(job, patch); onUpdate?.({ ...job }); };
  running = (async () => {
    try {
      if (!key) throw new Error(`No llama.cpp build exists for ${process.platform}-${process.arch}.`);
      await installEngine(key, (percent, statusText) => update({ stage: 'engine', percent, statusText }));
      await installModel(model, (percent, statusText) => update({ stage: 'model', percent, statusText }));
      update({ stage: 'probe', percent: 100, statusText: 'Starting the engine and embedding a probe' });
      await probeEmbedding(model);
      update({ stage: 'register', statusText: 'Registering the model' });
      const { name, bound } = await registerRow(model);
      update({
        stage: 'done', percent: 100, modelName: name, bound, finishedAt: Date.now(),
        statusText: bound ? `Installed; ${name} is the embedding model.` : 'Installed.',
        ...(bound ? {} : { note: 'Your current embedding model stays in use. To switch, bind this one on the Topics page and rebuild the vectors (docs/RAG.md → Vector indexing).' }),
      });
      log.info({ model: model.id, bound }, 'Local embedding engine installed');
    } catch (err) {
      update({ stage: 'error', error: (err as Error).message, statusText: 'Install failed', finishedAt: Date.now() });
      log.error({ err, model: model.id }, 'Local embedding engine install failed');
    } finally {
      running = null;
    }
    return job;
  })();
  return job;
}

/** Wait for the running install (tests, the CLI path through the API polls instead). */
export async function waitForLocalEngineInstall(): Promise<LocalEngineJob | null> {
  return running ? running : current;
}

/**
 * Remove the engine and the model files. A bound row is unbound and removed:
 * RAG then reports that no embedding model is configured (fail loud).
 */
export async function removeLocalEngine(): Promise<{ removedRows: string[] }> {
  await stopLocalEngine();
  const { getModelRegistry } = await import('@/models/model-registry');
  const registry = getModelRegistry();
  const removedRows: string[] = [];
  for (const row of await registry.getAllModelsIncludeDisabled()) {
    if (row.provider !== LOCAL_ENGINE_PROVIDER) continue;
    await registry.deleteModel(row.name);
    removedRows.push(row.name);
  }
  const { modelsRoot } = await import('./paths');
  await rm(join(modelsRoot(), 'engines', 'llama.cpp'), { recursive: true, force: true });
  for (const m of LOCAL_ENGINE_MANIFEST.models) await rm(modelDir(m), { recursive: true, force: true });
  current = null;
  return { removedRows };
}
