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
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnProcess } from '@/utils/proc';
import { logger } from '@/utils/logger';
import { downloadVerified, sha256File } from './download';
import { engineEnv, stopLocalEngine, useLocalEngine } from './engine-process';
import { engineAsset, type EngineVariant, LOCAL_ENGINE_MANIFEST, type LocalEmbeddingModel, localEmbeddingModel, modelUrl, type PlatformKey, platformKey } from './manifest';
import { activeEngine, engineDir, enginesRoot, modelDir, modelFilePath } from './paths';

const log = logger.child({ component: 'local-engine-install' });
export const LOCAL_ENGINE_PROVIDER = 'local-engine';

export type LocalEngineStage = 'engine' | 'model' | 'probe' | 'register' | 'done' | 'error';

export interface LocalEngineJob {
  id: string;
  ownerId: string;
  modelId: string;
  variant: EngineVariant;
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

async function releaseAsset(key: PlatformKey, variant: EngineVariant): Promise<{ url: string; name: string; sha256: string; size?: number }> {
  const { repo, tag } = LOCAL_ENGINE_MANIFEST.engine;
  const pinned = engineAsset(key, variant);
  if (!pinned) throw new Error(`llama.cpp has no ${variant} build for ${key}.`);
  const want = new RegExp(pinned.pattern);
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'octipus-local-engine' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Could not read the llama.cpp ${tag} release (HTTP ${res.status}). Check the network, or copy models/engines from another install.`);
  const release = (await res.json()) as { assets?: ReleaseAsset[] };
  const asset = (release.assets ?? []).find((a) => want.test(a.name));
  if (!asset) throw new Error(`The llama.cpp ${tag} release has no build for ${key}.`);
  const fromApi = asset.digest?.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : null;
  const sha256 = pinned.sha256 ?? fromApi;
  if (!sha256) throw new Error(`No checksum is known for ${asset.name}; refusing to install an unverified binary.`);
  if (pinned.sha256 && fromApi && pinned.sha256 !== fromApi) throw new Error(`The pinned checksum of ${asset.name} does not match the release's.`);
  // The download URL is built here, never taken from the API answer: only the
  // release's own location (GitHub then redirects to its file storage), for a
  // plain file name that matched the pinned pattern.
  if (!/^[A-Za-z0-9._-]+$/.test(asset.name)) throw new Error(`Unexpected asset name in the llama.cpp ${tag} release: ${asset.name}`);
  const url = `https://github.com/${LOCAL_ENGINE_MANIFEST.engine.repo}/releases/download/${encodeURIComponent(LOCAL_ENGINE_MANIFEST.engine.tag)}/${encodeURIComponent(asset.name)}`;
  return { url, name: asset.name, sha256, size: asset.size };
}

async function run(command: string, args: string[], timeoutMs = 60_000, env?: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  const proc = spawnProcess({ command, args, stdout: 'pipe', stderr: 'pipe', ...(env ? { env } : {}) });
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

/** Extract a release archive (zip entries may not leave `into`). Exported for tests. */
export async function extractArchive(archive: string, into: string): Promise<void> {
  await mkdir(into, { recursive: true });
  if (archive.endsWith('.zip')) {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await readFile(archive));
    for (const entry of Object.values(zip.files)) {
      // JSZip rewrites "../" away; the name as stored is what is checked (a release never has one).
      const stored = (entry as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
      const target = join(into, entry.name);
      // Zip-slip: every entry stays inside the target directory.
      if (stored.split(/[\\/]/).includes('..') || isAbsolute(stored) || (!target.startsWith(`${into}/`) && !target.startsWith(`${into}\\`))) {
        throw new Error(`Unsafe path in the release archive: ${stored}`);
      }
      if (entry.dir) { await mkdir(target, { recursive: true }); continue; }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await entry.async('nodebuffer'));
    }
    return;
  }
  const { code, output } = await run('tar', ['-xzf', archive, '-C', into, '--no-same-owner'], 300_000);
  if (code !== 0) throw new Error(`Could not extract ${archive}: ${output.trim().slice(-300)}`);
}

/**
 * Record the build in use (after its probe passed). The running engine is
 * stopped first when the build changes (it restarts on the new one; Windows
 * cannot delete a running binary), then older tags are removed, best effort:
 * what cannot be removed now is removed next time.
 */
async function activate(variant: EngineVariant): Promise<boolean> {
  const { tag } = LOCAL_ENGINE_MANIFEST.engine;
  const before = activeEngine();
  const changed = before?.tag !== tag || before?.variant !== variant;
  if (changed) await stopLocalEngine();
  await mkdir(enginesRoot(), { recursive: true });
  await writeFile(join(enginesRoot(), 'active.json'), `${JSON.stringify({ tag, variant })}\n`);
  for (const entry of await readdir(enginesRoot(), { withFileTypes: true }).catch(() => [])) {
    // Older tags, and staging folders an interrupted install left behind.
    if (!entry.isDirectory() || !(/^b\d+$/.test(entry.name) || entry.name.startsWith('.staging-')) || entry.name === tag) continue;
    await rm(join(enginesRoot(), entry.name), { recursive: true, force: true }).catch((err: unknown) => log.warn({ err, dir: entry.name }, 'Could not remove an older engine build yet'));
  }
  return changed;
}

/**
 * The engine binary for this platform and variant at the manifest's tag,
 * downloaded beside any older build, verified, probed, then made active.
 */
async function installEngine(key: PlatformKey, variant: EngineVariant, progress: (percent: number, text: string) => void): Promise<{ bin: string; changed: boolean }> {
  const exe = `${LOCAL_ENGINE_MANIFEST.engine.binary}${process.platform === 'win32' ? '.exe' : ''}`;
  const dir = engineDir(key, LOCAL_ENGINE_MANIFEST.engine.tag, variant);
  const bin = join(dir, exe);
  if (await probeEngine(bin)) return { bin, changed: await activate(variant) };
  const asset = await releaseAsset(key, variant);
  // Staged beside its destination (same file system): the extracted folder is
  // renamed into place, so the release's relative library symlinks stay intact.
  await mkdir(enginesRoot(), { recursive: true });
  const work = await mkdtemp(join(enginesRoot(), '.staging-'));
  try {
    // A fixed local name: nothing from the API answer becomes a path.
    const archive = join(work, asset.name.endsWith('.zip') ? 'engine.zip' : 'engine.tar.gz');
    await downloadVerified(asset.url, archive, asset.sha256, {
      size: asset.size,
      onProgress: (done, total) => progress(total ? Math.round((done / total) * 100) : 0, `Downloading the engine (${Math.round(done / 1e6)} MB)`),
    });
    progress(100, 'Extracting the engine');
    const unpacked = join(work, 'x');
    await extractArchive(archive, unpacked);
    const from = await findBinaryDir(unpacked, exe);
    if (!from) throw new Error(`${asset.name} has no ${exe}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await rename(from, dir).catch(() => cp(from, dir, { recursive: true, verbatimSymlinks: true }));
    if (process.platform !== 'win32') {
      for (const name of await readdir(dir)) {
        if (name === exe || name.startsWith('llama-') || name.endsWith('.so') || name.endsWith('.dylib')) await chmod(join(dir, name), 0o755).catch(() => {});
      }
    }
    if (process.platform === 'darwin') await run('xattr', ['-dr', 'com.apple.quarantine', dir]).catch(() => undefined);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  if (!(await probeEngine(bin))) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`The downloaded llama-server${variant === 'cpu' ? '' : ` (${variant})`} does not run on this machine (\`--version\` failed).`);
  }
  return { bin, changed: await activate(variant) };
}

/**
 * Does the binary run? `--version` must exit 0 and print llama.cpp's
 * `version: <build>` line, with the same library path the engine starts
 * with (a loader error such as "GLIBC_2.38 not found" is a failure).
 */
export async function probeEngine(bin: string): Promise<boolean> {
  if (!(await stat(bin).catch(() => null))?.isFile()) return false;
  try {
    const { code, output } = await run(bin, ['--version'], 30_000, engineEnv(bin));
    return code === 0 && /^version: \d+/m.test(output);
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
  const json = await useLocalEngine(model.id, async ({ port, apiKey }) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ input: [`${model.prefixes.document}hello world`], model: model.id }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`The engine did not embed the probe text (HTTP ${res.status}).`);
    return (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  });
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
  // Any row holding the lane, enabled or not (a disabled primary comes back when re-enabled).
  const holder = (await registry.getAllModelsIncludeDisabled()).find((r) => boundTo(r, 'embedding'));
  if (holder) return { name, bound: holder.name === name };
  const row = await registry.getModel(name);
  await registry.updateModel(name, { topicRoles: { ...(row?.topicRoles ?? {}), embedding: 'primary' } });
  return { name, bound: true };
}

/** Another install, update or removal is running (the API answers 409). */
export class LocalEngineBusyError extends Error {
  constructor(message = 'The local embedding engine is being installed or updated; try again when it finishes.') { super(message); }
}

/** Run the install; one at a time (the same request again joins the running one). */
export function startLocalEngineInstall(ownerId: string, modelId?: string, onUpdate?: (job: LocalEngineJob) => void, opts: { gpu?: EngineVariant } = {}): LocalEngineJob {
  const model = localEmbeddingModel(modelId);
  if (!model) throw new Error(`Unknown local embedding model "${modelId}". Known: ${LOCAL_ENGINE_MANIFEST.models.map((m) => m.id).join(', ')}`);
  const key = platformKey();
  // A GPU build is opt-in; without one asked for, the build already in use stays.
  const variant: EngineVariant = opts.gpu ?? activeEngine()?.variant ?? 'cpu';
  if (running) {
    if (current && current.modelId === model.id && current.variant === variant) return current;
    throw new LocalEngineBusyError(current ? `An install of ${current.modelId} is running; try again when it finishes.` : undefined);
  }
  if (key && !engineAsset(key, variant)) throw new Error(`llama.cpp has no ${variant} build for ${key}.`);
  const job: LocalEngineJob = { id: randomUUID(), ownerId, modelId: model.id, variant, stage: 'engine', percent: 0, statusText: 'Starting', startedAt: Date.now() };
  current = job;
  const update = (patch: Partial<LocalEngineJob>) => { Object.assign(job, patch); onUpdate?.({ ...job }); };
  running = (async () => {
    try {
      if (!key) throw new Error(`No llama.cpp build exists for ${process.platform}-${process.arch}.`);
      // A running engine on another build is stopped when the new one is activated.
      await installEngine(key, variant, (percent, statusText) => update({ stage: 'engine', percent, statusText }));
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

/**
 * Download and verify the engine and the model files only: no database, no
 * engine start (the Docker build bakes them with this; the install API then
 * finds them verified and only probes and registers).
 */
export async function fetchLocalEngineFiles(modelId?: string, progress: (text: string) => void = () => {}): Promise<LocalEmbeddingModel> {
  const model = localEmbeddingModel(modelId);
  if (!model) throw new Error(`Unknown local embedding model "${modelId}". Known: ${LOCAL_ENGINE_MANIFEST.models.map((m) => m.id).join(', ')}`);
  const key = platformKey();
  if (!key) throw new Error(`No llama.cpp build exists for ${process.platform}-${process.arch}.`);
  let last = '';
  const report = (_p: number, text: string) => { if (text !== last) { last = text; progress(text); } };
  await installEngine(key, activeEngine()?.variant ?? 'cpu', report);
  await installModel(model, report);
  return model;
}

/**
 * After an update brought a new engine tag: download it beside the build in
 * use, switch once its probe passes, and restart the engine on it. Vectors
 * are unaffected (the model file does not change). Runs at boot, only when a
 * local model is the bound embedding model; the old build serves meanwhile.
 */
export async function upgradeLocalEngineIfNeeded(): Promise<boolean> {
  const active = activeEngine();
  const key = platformKey();
  if (!key || !active || active.tag === LOCAL_ENGINE_MANIFEST.engine.tag || running) return false;
  // Holds the same lock as an install (an install asked for meanwhile gets 409), and shows as a job.
  const model = localEmbeddingModel() as LocalEmbeddingModel;
  const record: LocalEngineJob = {
    id: randomUUID(), ownerId: 'system', modelId: model.id, variant: active.variant, stage: 'engine', percent: 0,
    statusText: `Updating the engine to llama.cpp ${LOCAL_ENGINE_MANIFEST.engine.tag}`, startedAt: Date.now(),
  };
  current = record;
  const job = (async () => {
    try {
      await installEngine(key, active.variant, (percent, statusText) => Object.assign(record, { percent, statusText }));
      Object.assign(record, { stage: 'done', percent: 100, statusText: `Engine updated to llama.cpp ${LOCAL_ENGINE_MANIFEST.engine.tag}.`, finishedAt: Date.now() });
      log.info({ from: active.tag, to: LOCAL_ENGINE_MANIFEST.engine.tag }, 'Local embedding engine updated');
    } catch (err) {
      Object.assign(record, { stage: 'error', error: (err as Error).message, statusText: 'Engine update failed; the installed build stays in use', finishedAt: Date.now() });
      throw err;
    }
    return record;
  })();
  running = job;
  try {
    await job;
  } finally {
    if (running === job) running = null;
  }
  return true;
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
  if (running) throw new LocalEngineBusyError('The local embedding engine is being installed or updated; remove it when that finishes.');
  await stopLocalEngine();
  const { getModelRegistry } = await import('@/models/model-registry');
  const registry = getModelRegistry();
  const removedRows: string[] = [];
  for (const row of await registry.getAllModelsIncludeDisabled()) {
    if (row.provider !== LOCAL_ENGINE_PROVIDER) continue;
    await registry.deleteModel(row.name);
    removedRows.push(row.name);
  }
  await rm(enginesRoot(), { recursive: true, force: true });
  for (const m of LOCAL_ENGINE_MANIFEST.models) await rm(modelDir(m), { recursive: true, force: true });
  current = null;
  return { removedRows };
}
