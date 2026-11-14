/**
 * The supervisor of the local embedding engine (`llama-server`): started
 * lazily on the first embedding, bound to 127.0.0.1 on a free port with a
 * fresh API key per start, passed in the environment (owner-readable only,
 * never on the command line), restarted on demand after a crash (not after
 * three in five minutes), stopped when idle (`localEngine.idleStopMinutes`,
 * default 30; 0 = never) and on shutdown. Never started for a model or a
 * build that is not installed.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { createServer } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { getConfig } from '@/config';
import { type ChildProcessHandle, spawnProcess } from '@/utils/proc';
import { logger } from '@/utils/logger';
import { LOCAL_ENGINE_MANIFEST, type LocalEmbeddingModel, localEmbeddingModel, platformKey } from './manifest';
import { activeEngine, engineDir, modelFilePath } from './paths';

const log = logger.child({ component: 'local-engine' });
const EXE = process.platform === 'win32' ? '.exe' : '';
const START_TIMEOUT_MS = 90_000;
const CRASH_WINDOW_MS = 5 * 60_000;
const MAX_CRASHES = 3;

interface Running {
  proc: ChildProcessHandle;
  port: number;
  apiKey: string;
  model: LocalEmbeddingModel;
  startedAt: number;
  /** Stopped on purpose: its exit is not a crash. */
  stopping: boolean;
}

let running: Running | null = null;
let starting: { modelId: string; promise: Promise<Running> } | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let crashes: number[] = [];
let exitHookInstalled = false;

/**
 * The engine binary in use: the build recorded as active, which is written
 * only after a build passed its probe (an older tag keeps serving until a
 * newer one has). Null when no build was ever activated.
 */
export function engineBinaryPath(): string | null {
  const key = platformKey();
  const active = activeEngine();
  if (!key || !active) return null;
  return join(engineDir(key, active.tag, active.variant), `${LOCAL_ENGINE_MANIFEST.engine.binary}${EXE}`);
}

/** The environment the engine runs with (the probe uses the same one). */
export function engineEnv(bin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = dirname(bin);
  const libVar = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : process.platform === 'win32' ? 'PATH' : 'LD_LIBRARY_PATH';
  return { ...process.env, [libVar]: [dir, process.env[libVar]].filter(Boolean).join(delimiter), ...extra };
}

export function isModelInstalled(model: LocalEmbeddingModel): boolean {
  const bin = engineBinaryPath();
  return !!bin && existsSync(bin) && existsSync(modelFilePath(model));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function idleStopMs(): number {
  try {
    const minutes = getConfig().localEngine?.idleStopMinutes ?? 30;
    return minutes > 0 ? minutes * 60_000 : 0;
  } catch {
    return 30 * 60_000;
  }
}

function armIdleStop(): void {
  if (idleTimer) clearTimeout(idleTimer);
  const ms = idleStopMs();
  if (!ms) return;
  idleTimer = setTimeout(() => { log.info('Local embedding engine idle: stopping'); void stopLocalEngine(); }, ms);
  idleTimer.unref?.();
}

/** Log the engine's output at debug; keep the last lines to explain a failed start. */
async function drainLines(stream: ReadableStream<Uint8Array> | null, tail: string[]): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      if (line) {
        log.debug({ engine: 'llama-server' }, line.slice(0, 500));
        tail.push(line.slice(0, 300));
        if (tail.length > 8) tail.shift();
      }
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  }
}

async function waitHealthy(port: number, apiKey: string, proc: ChildProcessHandle, tail: string[]): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  const why = () => (tail.length ? `: ${tail.slice(-3).join(' | ')}` : '');
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`llama-server exited (code ${proc.exitCode}) while starting${why()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server did not become healthy in time${why()}`);
}

async function start(model: LocalEmbeddingModel): Promise<Running> {
  const bin = engineBinaryPath();
  if (!bin || !existsSync(bin)) throw new Error('The local embedding engine is not installed. Run `octi capabilities install local-embedding` or use the Topics page.');
  const gguf = modelFilePath(model);
  if (!existsSync(gguf)) throw new Error(`The local embedding model ${model.id} is not installed.`);
  const recent = crashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS);
  crashes = recent;
  if (recent.length >= MAX_CRASHES) throw new Error(`The local embedding engine crashed ${recent.length} times in 5 minutes; not restarting. See the logs.`);
  const port = await freePort();
  const apiKey = randomBytes(24).toString('hex');
  const threads = Math.max(1, Math.floor(cpus().length / 2));
  const proc = spawnProcess({
    command: bin,
    // The key goes in the environment (LLAMA_API_KEY): a command line is readable by every local user.
    args: ['-m', gguf, '--embedding', '--pooling', model.pooling, '--host', '127.0.0.1', '--port', String(port),
      '-c', String(model.contextLength), '-b', '2048', '-ub', '2048', '--parallel', '2', '-t', String(threads), '--no-slots'],
    stdout: 'pipe',
    stderr: 'pipe',
    env: engineEnv(bin, { LLAMA_API_KEY: apiKey }),
  });
  const tail: string[] = [];
  void drainLines(proc.stdout, tail);
  void drainLines(proc.stderr, tail);
  const self: Running = { proc, port, apiKey, model, startedAt: Date.now(), stopping: false };
  // Never outlive the backend, whatever way it exits.
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => { try { running?.proc.kill('SIGKILL'); } catch { /* gone */ } });
  }
  void proc.exited.then((code) => {
    if (running === self) running = null;
    if (!self.stopping && code !== 0) {
      crashes.push(Date.now());
      log.warn({ code, model: model.id, output: tail.slice(-3) }, 'Local embedding engine exited; it restarts on the next embedding');
    }
  });
  try {
    await waitHealthy(port, apiKey, proc, tail);
  } catch (err) {
    self.stopping = true;
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
    throw err;
  }
  log.info({ model: model.id, port }, 'Local embedding engine started');
  return self;
}

/**
 * The running engine for `modelId`, started if needed. Concurrent callers for
 * the same model share one start; a caller for another model waits for it,
 * then switches, and never receives an engine serving a different model.
 */
export async function ensureLocalEngine(modelId: string): Promise<{ port: number; apiKey: string; model: LocalEmbeddingModel }> {
  const model = localEmbeddingModel(modelId);
  if (!model) throw new Error(`Unknown local embedding model "${modelId}"`);
  for (let i = 0; i < 4; i++) {
    if (running?.model.id === model.id) {
      armIdleStop();
      return { port: running.port, apiKey: running.apiKey, model: running.model };
    }
    if (starting) {
      if (starting.modelId === model.id) {
        await starting.promise;
        continue;
      }
      await starting.promise.catch(() => {});
      continue;
    }
    if (running) await stopLocalEngine();
    const promise = start(model);
    const entry = { modelId: model.id, promise };
    starting = entry;
    try {
      running = await promise;
    } finally {
      if (starting === entry) starting = null;
    }
  }
  if (running?.model.id === model.id) return { port: running.port, apiKey: running.apiKey, model: running.model };
  throw new Error(`The local embedding engine is busy switching models; try ${model.id} again.`);
}

export async function stopLocalEngine(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const current = running;
  running = null;
  if (!current) return;
  current.stopping = true;
  try { current.proc.kill('SIGTERM'); } catch { /* gone */ }
  const timeout = setTimeout(() => { try { current.proc.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
  timeout.unref?.();
  await current.proc.exited.catch(() => {});
  clearTimeout(timeout);
}

export function localEngineStatus(): { running: boolean; model?: string; port?: number; startedAt?: number; recentCrashes: number } {
  return {
    running: !!running,
    ...(running ? { model: running.model.id, port: running.port, startedAt: running.startedAt } : {}),
    recentCrashes: crashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS).length,
  };
}

/** For tests. */
export function resetLocalEngineForTest(): void { running = null; starting = null; crashes = []; }
