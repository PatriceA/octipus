import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import * as yaml from 'js-yaml';
import { getConfig } from '@/config';
import type { MCPServer } from '@/core/types';
import { getMCPBridge, type MCPServerConnection } from '@/mcp/bridge';
import { WorkspaceFS } from '@/security/workspace-fs';
import { buildChildEnv } from '@/security/child-env';
import {
  COCOINDEX_CONNECTOR_ID,
  COCOINDEX_DEFAULT_EMBEDDING_MODEL,
  type CocoIndexStatus,
} from '@/shared/cocoindex';
import { restrictToOwner } from '@/utils/file-acl';
import { killProcessTree } from '@/utils/proc';
import { writeFileAt } from '@/utils/fs-file';
import { coreLogger } from '@/utils/logger';

/** The launcher's filename. One constant, because a site that spelled it
 * `'ccc'` on Windows silently never matched. */
const CCC_EXECUTABLE = process.platform === 'win32' ? 'ccc.exe' : 'ccc';

const MANAGED_MARKER = 'cocoindex-code';
const INSTALL_PACKAGE = 'cocoindex-code[full]';
const COMMAND_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const INDEX_TIMEOUT_MS = 2 * 60 * 60_000;
const FIRST_INDEX_TIMEOUT_MS = 30 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const liveProcessGroups = new Set<number>();
let processReaperInstalled = false;

function trackProcessGroup(pid: number | undefined): () => void {
  if (pid === undefined) return () => {};
  liveProcessGroups.add(pid);
  if (!processReaperInstalled) {
    processReaperInstalled = true;
    process.once('exit', () => {
      for (const group of liveProcessGroups) killProcessTree(group);
      liveProcessGroups.clear();
    });
  }
  return () => liveProcessGroups.delete(pid);
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessOptions,
) => Promise<ProcessResult>;

export class ProcessRunError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
  ) {
    super(message);
    this.name = 'ProcessRunError';
  }
}

export const runProcess: ProcessRunner = (command, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new ProcessRunError(`${command} was cancelled`, 'ABORT_ERR'));
      return;
    }
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: buildChildEnv(options.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminalError: ProcessRunError | null = null;
    const untrack = trackProcessGroup(child.pid);
    const append = (current: string, chunk: Buffer): string =>
      (current + chunk.toString()).slice(-MAX_OUTPUT_BYTES);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });

    // `ccc` starts a daemon of its own, so the direct child is not the whole
    // job: a kill that reaches only it leaves the worker running and holding
    // the pipes. `killProcessTree` is the POSIX group signal, or `taskkill /T`.
    const killTree = (): void => killProcessTree(child.pid, child);
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (settled) return;
      terminalError = new ProcessRunError(`${command} timed out after ${timeoutMs}ms`, 'ETIMEDOUT');
      killTree();
    }, timeoutMs);
    const onAbort = (): void => {
      if (settled) return;
      terminalError = new ProcessRunError(`${command} was cancelled`, 'ABORT_ERR');
      killTree();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      untrack();
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new ProcessRunError(error.message, error.code));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      untrack();
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      if (terminalError) {
        reject(terminalError);
        return;
      }
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? 'unknown'}`;
      reject(new ProcessRunError(`${command} failed: ${detail}`, code ?? undefined));
    });
  });

interface CocoIndexBridge {
  getServerConfigs(): MCPServer[];
  getConnection(serverId: string): MCPServerConnection | undefined;
  addServer(server: MCPServer): Promise<void>;
  removeServer(serverId: string): Promise<boolean>;
  disconnect(serverId: string): Promise<void>;
  connect(server: MCPServer): Promise<MCPServerConnection>;
}

export interface CocoIndexServiceDependencies {
  bridge: CocoIndexBridge;
  run: ProcessRunner;
  homeDir: string;
  writeFile: typeof writeFileAt;
  /** Owner-only permissions for a file just written. Platform-aware. */
  restrictFile: (path: string) => void;
  readText: (path: string) => Promise<string>;
  canExecute: (path: string) => Promise<boolean>;
}

function defaultDependencies(): CocoIndexServiceDependencies {
  return {
    bridge: getMCPBridge(),
    run: runProcess,
    homeDir: homedir(),
    writeFile: writeFileAt,
    restrictFile: restrictToOwner,
    readText: (path) => readFile(path, 'utf8'),
    canExecute: async (path) => {
      try { await access(path, fsConstants.X_OK); return true; }
      catch { return false; }
    },
  };
}

function isManaged(server: MCPServer | undefined): boolean {
  return server?.env?.OCTIPUS_MANAGED_CONNECTOR === MANAGED_MARKER;
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 1_000);
}

function isMissingCommand(error: unknown): boolean {
  return error instanceof ProcessRunError && error.code === 'ENOENT';
}

function assertEmbeddingModel(model: string): string {
  const normalized = model.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)) {
    throw new Error('Embedding model must be a Hugging Face model ID such as org/model-name');
  }
  if (normalized.length > 200) throw new Error('Embedding model must be 200 characters or fewer');
  return normalized;
}

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/** Resolve an admin-selected folder and constrain it to configured filesystem roots. */
export async function resolveCocoIndexWorkspacePath(input: string, userId: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Workspace path is required');
  if (trimmed.includes('\0')) throw new Error('Workspace path contains a null byte');

  const config = getConfig();
  const lexical = isAbsolute(trimmed) ? resolve(trimmed) : resolve(config.workspace.rootPath, trimmed);
  let candidate: string;
  try {
    candidate = await realpath(lexical);
    if (!(await stat(candidate)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Workspace path does not exist or is not a directory: ${lexical}`);
  }

  const userRoot = WorkspaceFS.forAgent({ userId }).root;
  const roots = [config.workspace.rootPath, userRoot, ...config.workspace.additionalPaths];
  const realRoots = await Promise.all(roots.map(async (root) => {
    try { return await realpath(resolve(root)); }
    catch { return resolve(root); }
  }));
  if (!realRoots.some((root) => isUnder(candidate, root))) {
    throw new Error('Workspace path must be under a configured workspace root');
  }
  return candidate;
}

export class CocoIndexService {
  private state: CocoIndexStatus;
  private installedCommand: string | null | undefined;
  private job: Promise<void> | null = null;
  private removeJob: Promise<CocoIndexStatus> | null = null;
  private generation = 0;
  private activeAbort: AbortController | null = null;
  private setupError: string | null = null;
  private installerCommandCandidate: string | null = null;

  constructor(private readonly deps: CocoIndexServiceDependencies = defaultDependencies()) {
    this.state = this.baseStatus();
  }

  private managedServer(): MCPServer | undefined {
    return this.deps.bridge.getServerConfigs().find(
      (server) => server.id === COCOINDEX_CONNECTOR_ID && isManaged(server),
    );
  }

  private configDir(): string {
    return join(this.deps.homeDir, '.octipus', 'cocoindex-code');
  }

  private managedEnvironment(workspacePath: string): Record<string, string> {
    const configDir = this.configDir();
    const indexDir = join(
      configDir,
      'indexes',
      createHash('sha256').update(workspacePath).digest('hex').slice(0, 24),
    );
    return {
      COCOINDEX_CODE_DIR: configDir,
      COCOINDEX_CODE_DB_PATH_MAPPING: `${workspacePath}=${indexDir}`,
      // These upstream controls override cwd/path discovery or daemon startup.
      // Empty values pin the managed connector to the explicit settings above.
      COCOINDEX_CODE_HOST_CWD: '',
      COCOINDEX_CODE_HOST_PATH_MAPPING: '',
      COCOINDEX_CODE_DAEMON_SUPERVISED: '',
    };
  }

  private async stopManagedDaemon(
    command: string | null | undefined,
    workspacePath: string,
  ): Promise<void> {
    if (!command) return;
    await this.deps.run(command, ['daemon', 'stop'], {
      cwd: workspacePath,
      env: this.managedEnvironment(workspacePath),
      timeoutMs: COMMAND_TIMEOUT_MS,
    }).catch(() => {});
  }

  private modelFrom(server?: MCPServer): string {
    return server?.env?.OCTIPUS_COCOINDEX_EMBEDDING_MODEL
      || COCOINDEX_DEFAULT_EMBEDDING_MODEL;
  }

  private baseStatus(): CocoIndexStatus {
    const server = this.managedServer();
    const connection = server
      ? this.deps.bridge.getConnection(COCOINDEX_CONNECTOR_ID)
      : undefined;
    const configured = !!server;
    return {
      id: COCOINDEX_CONNECTOR_ID,
      installed: configured,
      configured,
      workspacePath: server?.cwd ?? null,
      status: connection?.status === 'connected'
        ? 'connected'
        : configured ? (connection?.status ?? 'disconnected') : 'not_installed',
      ...(connection?.error ? { error: connection.error } : {}),
      embedding: {
        provider: 'sentence-transformers',
        model: this.modelFrom(server),
        local: true,
      },
    };
  }

  async getStatus(): Promise<CocoIndexStatus> {
    if (this.job) return structuredClone(this.state);
    const generation = this.generation;
    const current = this.baseStatus();
    if (this.installedCommand === undefined) {
      const discovered = await this.findInstalledCommand(current.configured
        ? this.managedServer()?.command
        : undefined);
      if (this.job || this.removeJob || generation !== this.generation) {
        return structuredClone(this.state);
      }
      this.installedCommand = discovered;
    }
    current.installed = this.installedCommand !== null;
    if (!current.installed && !current.configured) current.status = 'not_installed';
    else if (!current.installed && current.configured) {
      current.status = 'error';
      current.error = 'CocoIndex Code is configured but the ccc executable is unavailable';
    }
    if (this.setupError) {
      current.status = 'error';
      current.error = this.setupError;
    }
    this.state = current;
    return structuredClone(current);
  }

  async install(workspacePath: string, embeddingModel?: string): Promise<CocoIndexStatus> {
    if (this.removeJob) throw new Error('CocoIndex Code connector removal is still in progress');
    if (this.job) return structuredClone(this.state);
    const conflicting = this.deps.bridge.getServerConfigs().find(
      (server) => server.id === COCOINDEX_CONNECTOR_ID && !isManaged(server),
    );
    if (conflicting) {
      throw new Error(
        `An unmanaged MCP server already uses the ID ${COCOINDEX_CONNECTOR_ID}; rename or remove it first`,
      );
    }
    const model = assertEmbeddingModel(embeddingModel ?? COCOINDEX_DEFAULT_EMBEDDING_MODEL);
    const generation = ++this.generation;
    const abort = new AbortController();
    this.activeAbort = abort;
    this.setupError = null;
    this.state = {
      ...this.baseStatus(),
      status: 'installing',
      error: undefined,
      progress: { phase: 'install', message: 'Checking CocoIndex Code installation' },
      workspacePath,
      embedding: { provider: 'sentence-transformers', model, local: true },
    };
    this.job = this.runInstall(generation, workspacePath, model, abort.signal)
      .catch(async (error) => {
        // The CLI starts its indexing daemon in a separate OS session. A
        // process-group kill cannot reach it, so explicitly stop the isolated
        // daemon before a failed or cancelled setup is considered settled.
        await this.stopManagedDaemon(this.installedCommand, workspacePath);
        if (generation !== this.generation) return;
        this.state.status = 'error';
        this.setupError = cleanError(error);
        this.state.error = this.setupError;
        this.state.progress = undefined;
        coreLogger.error({ err: error }, 'CocoIndex Code connector setup failed');
      })
      .finally(() => {
        if (generation === this.generation) {
          this.job = null;
          this.activeAbort = null;
        }
      });
    return structuredClone(this.state);
  }

  private async runInstall(
    generation: number,
    workspacePath: string,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    let command = await this.findInstalledCommand(this.managedServer()?.command);
    if (!command || !(await this.hasLocalEmbeddingSupport(command, signal))) {
      this.state.progress = { phase: 'install', message: 'Installing CocoIndex Code and local embeddings' };
      await this.installPackage(signal);
      command = await this.findInstalledCommand();
      if (!command) throw new Error('Installation finished but the ccc executable could not be found');
      if (!(await this.hasLocalEmbeddingSupport(command, signal))) {
        throw new Error('CocoIndex Code was installed without the sentence-transformers local embedding backend');
      }
    }
    this.installedCommand = command;
    this.state.installed = true;
    if (generation !== this.generation) return;

    this.state.status = 'configuring';
    this.state.progress = { phase: 'initialize', message: 'Initializing the selected workspace' };
    const configDir = this.configDir();
    const indexDir = join(
      configDir,
      'indexes',
      createHash('sha256').update(workspacePath).digest('hex').slice(0, 24),
    );
    if (workspacePath.includes(',') || workspacePath.includes('=')) {
      throw new Error('CocoIndex Code workspace paths cannot contain commas or equals signs');
    }
    const metadataPath = join(indexDir, 'octipus-connector.json');
    let previousIndexModel: string | null = null;
    try {
      const metadata = JSON.parse(await this.deps.readText(metadataPath)) as { embeddingModel?: unknown };
      if (typeof metadata.embeddingModel === 'string') previousIndexModel = metadata.embeddingModel;
    } catch {
      // A fresh managed index has no metadata yet.
    }
    const globalSettings = yaml.dump({
      embedding: { provider: 'sentence-transformers', model },
    }, { noRefs: true, lineWidth: -1 });
    const settingsPath = join(configDir, 'global_settings.yml');
    await this.deps.writeFile(settingsPath, globalSettings);
    this.deps.restrictFile(settingsPath);
    const env = this.managedEnvironment(workspacePath);
    await this.deps.run(command, ['init', '--force'], {
      cwd: workspacePath,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      signal,
    });
    // The daemon caches the global embedding configuration. It belongs to the
    // isolated COCOINDEX_CODE_DIR, so stop it on every reconfiguration before
    // validating/building with the newly selected model and workspace.
    await this.deps.run(command, ['daemon', 'stop'], {
      cwd: workspacePath,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      signal,
    });
    if (previousIndexModel !== null && previousIndexModel !== model) {
      await this.deps.run(command, ['reset', '--force'], {
        cwd: workspacePath,
        env,
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
      });
    }
    this.state.progress = {
      phase: 'initialize',
      message: 'Downloading the local model and building the initial code index',
    };
    await this.deps.run(command, ['index'], {
      cwd: workspacePath,
      env,
      timeoutMs: INDEX_TIMEOUT_MS,
      signal,
    });
    await this.deps.writeFile(metadataPath, JSON.stringify({
      workspacePath,
      embeddingProvider: 'sentence-transformers',
      embeddingModel: model,
    }, null, 2));
    this.deps.restrictFile(metadataPath);
    if (generation !== this.generation) return;

    this.state.status = 'connecting';
    this.state.progress = { phase: 'connect', message: 'Connecting the CocoIndex Code MCP server' };
    const server: MCPServer = {
      id: COCOINDEX_CONNECTOR_ID,
      name: 'CocoIndex Code',
      command,
      args: ['mcp'],
      cwd: workspacePath,
      env: {
        ...env,
        OCTIPUS_MANAGED_CONNECTOR: MANAGED_MARKER,
        OCTIPUS_COCOINDEX_EMBEDDING_MODEL: model,
      },
      isEnabled: true,
      transport: 'stdio',
      requestTimeoutMs: FIRST_INDEX_TIMEOUT_MS,
      stderrAsError: false,
    };
    await this.deps.bridge.disconnect(COCOINDEX_CONNECTOR_ID);
    if (generation !== this.generation) return;
    await this.deps.bridge.addServer(server);
    if (generation !== this.generation) {
      await this.deps.bridge.removeServer(COCOINDEX_CONNECTOR_ID);
      return;
    }
    const connection = await this.deps.bridge.connect(server);
    if (generation !== this.generation) {
      await this.deps.bridge.disconnect(COCOINDEX_CONNECTOR_ID);
      if (this.managedServer()) await this.deps.bridge.removeServer(COCOINDEX_CONNECTOR_ID);
      return;
    }
    if (connection.status !== 'connected') {
      throw new Error(connection.error || 'CocoIndex Code MCP server did not connect');
    }
    if (!connection.tools.some((tool) => tool.name === 'search')) {
      await this.deps.bridge.disconnect(COCOINDEX_CONNECTOR_ID);
      throw new Error('CocoIndex Code connected without its required search tool');
    }
    this.state = {
      id: COCOINDEX_CONNECTOR_ID,
      installed: true,
      configured: true,
      workspacePath,
      status: 'connected',
      embedding: { provider: 'sentence-transformers', model, local: true },
    };
  }

  private async findInstalledCommand(preferred?: string): Promise<string | null> {
    const pathCandidates = (process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, CCC_EXECUTABLE));
    const candidates = [...new Set([
      preferred,
      this.installerCommandCandidate,
      process.env.UV_TOOL_BIN_DIR
        ? join(process.env.UV_TOOL_BIN_DIR, CCC_EXECUTABLE) : undefined,
      process.env.PIPX_BIN_DIR
        ? join(process.env.PIPX_BIN_DIR, CCC_EXECUTABLE) : undefined,
      // uv's default bin directory on every platform, Windows included —
      // which is where a Windows `uv tool install` actually lands. Written
      // without the extension, this candidate could never match there.
      join(this.deps.homeDir, '.local', 'bin', CCC_EXECUTABLE),
      ...pathCandidates,
    ].filter((value): value is string => !!value))];
    for (const command of candidates) {
      if (!(await this.deps.canExecute(command))) continue;
      try {
        await this.deps.run(command, ['version'], { timeoutMs: COMMAND_TIMEOUT_MS });
        return command;
      } catch {
        // Try the next known executable location.
      }
    }
    return null;
  }

  private async hasLocalEmbeddingSupport(command: string, signal: AbortSignal): Promise<boolean> {
    try {
      const python = await this.interpreterFor(command, signal);
      if (!python) return false;
      await this.deps.run(python, [
        '-c',
        'import importlib.util,sys;sys.exit(0 if importlib.util.find_spec("sentence_transformers") else 1)',
      ], {
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The interpreter `ccc` runs on, so the sentence-transformers extra can be
   * probed rather than guessed.
   *
   * On POSIX the launcher is a script and its shebang names the interpreter
   * outright. On Windows `ccc.exe` is a PE binary — uv ships a compiled
   * launcher, not a script — so there is no shebang to read. The tool's own
   * virtualenv is where the interpreter actually lives:
   * `<uv tool dir>/cocoindex-code/Scripts/python.exe`. Without this the probe
   * answered "no local embeddings" for every Windows install and re-downloaded
   * the multi-gigabyte extra on each one.
   */
  private async interpreterFor(command: string, signal: AbortSignal): Promise<string | null> {
    if (process.platform !== 'win32') {
      const firstLine = (await this.deps.readText(command)).split(/\r?\n/, 1)[0] ?? '';
      const match = firstLine.match(/^#!\s*(\/\S+)/);
      if (!match || match[1].endsWith('/env')) return null;
      return match[1];
    }
    // Both installers, because `installPackage` falls back to pipx when uv is
    // missing: asking uv alone on a pipx host answers "no local embeddings"
    // before AND after the install, and the run then fails claiming the extra
    // was not installed — on a machine where it was.
    for (const venvRoot of await this.toolVenvRoots(signal)) {
      const python = join(venvRoot, 'cocoindex-code', 'Scripts', 'python.exe');
      if (await this.deps.canExecute(python)) return python;
    }
    // A `ccc.exe` that came from neither — a hand-built venv, a vendored copy —
    // sits next to its own interpreter: uv and pipx both put the launcher in a
    // bin directory beside `Scripts`, and a venv keeps them in one place.
    const sibling = join(dirname(command), 'python.exe');
    return (await this.deps.canExecute(sibling)) ? sibling : null;
  }

  /** Where uv and pipx keep their per-tool virtualenvs, whichever are present. */
  private async toolVenvRoots(signal: AbortSignal): Promise<string[]> {
    const roots: string[] = [];
    const ask = async (command: string, args: string[]): Promise<void> => {
      try {
        const result = await this.deps.run(command, args, { timeoutMs: COMMAND_TIMEOUT_MS, signal });
        const line = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
        if (line) roots.push(line);
      } catch {
        // That installer is not on this host. The other one may be.
      }
    };
    await ask('uv', ['tool', 'dir']);
    await ask('pipx', ['environment', '--value', 'PIPX_LOCAL_VENVS']);
    return roots;
  }

  private async installPackage(signal: AbortSignal): Promise<void> {
    try {
      await this.deps.run('uv', ['--version'], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
      await this.deps.run('uv', ['tool', 'install', '--upgrade', INSTALL_PACKAGE], {
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal,
      });
      try {
        const result = await this.deps.run('uv', ['tool', 'dir', '--bin'], {
          timeoutMs: COMMAND_TIMEOUT_MS,
          signal,
        });
        const binDir = result.stdout.trim().split(/\r?\n/).at(-1)?.trim();
        if (binDir) {
          this.installerCommandCandidate = join(
            binDir,
            CCC_EXECUTABLE,
          );
        }
      } catch {
        // Standard uv installs use ~/.local/bin, already among the candidates.
      }
      return;
    } catch (error) {
      if (!isMissingCommand(error)) throw error;
    }
    try {
      await this.deps.run('pipx', ['--version'], { timeoutMs: COMMAND_TIMEOUT_MS, signal });
      await this.deps.run('pipx', ['install', '--force', INSTALL_PACKAGE], {
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (!isMissingCommand(error)) throw error;
      throw new Error(
        'CocoIndex Code requires Python 3.11+ and either uv or pipx. Install uv or pipx, then try again.',
      );
    }
  }

  async remove(): Promise<CocoIndexStatus> {
    if (this.removeJob) return structuredClone(await this.removeJob);
    this.removeJob = this.runRemove();
    try { return structuredClone(await this.removeJob); }
    finally { this.removeJob = null; }
  }

  private async runRemove(): Promise<CocoIndexStatus> {
    const pending = this.job;
    const workspacePath = this.state.workspacePath;
    const command = this.installedCommand;
    this.activeAbort?.abort();
    ++this.generation;
    this.activeAbort = null;
    this.setupError = null;
    await pending;
    this.job = null;
    if (workspacePath) await this.stopManagedDaemon(command, workspacePath);
    const managed = this.managedServer();
    if (managed) await this.deps.bridge.removeServer(COCOINDEX_CONNECTOR_ID);
    this.state = {
      id: COCOINDEX_CONNECTOR_ID,
      installed: this.installedCommand !== null && this.installedCommand !== undefined,
      configured: false,
      workspacePath: null,
      status: this.installedCommand ? 'disconnected' : 'not_installed',
      embedding: {
        provider: 'sentence-transformers',
        model: COCOINDEX_DEFAULT_EMBEDDING_MODEL,
        local: true,
      },
    };
    return structuredClone(this.state);
  }

  /** Test/support hook: resolves when the current background setup has settled. */
  async waitForIdle(): Promise<void> {
    await this.job;
  }
}

let serviceInstance: CocoIndexService | null = null;

export function getCocoIndexService(): CocoIndexService {
  if (!serviceInstance) serviceInstance = new CocoIndexService();
  return serviceInstance;
}

export function redactCocoIndexStatus(status: CocoIndexStatus): CocoIndexStatus {
  const { error: _error, progress: _progress, ...publicStatus } = status;
  return { ...publicStatus, workspacePath: null };
}
