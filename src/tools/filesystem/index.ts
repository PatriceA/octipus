import { existsSync } from 'fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'path';
import { getConfig } from '@/config';
import type { AgentContext, ToolManifest } from '@/core/types';
import { WorkspaceFS, WorkspaceFsError } from '@/security/workspace-fs';
import { computeLineDiff } from '@/shared/diff';
import { WORK_STREAM_META_KEY } from '@/shared/work-stream';
import { withFileMutationQueue } from '@/utils/file-mutation-queue';
import { coreLogger } from '@/utils/logger';
import { safeRegExp } from '@/utils/sanitize';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * Cap on the file size we read back to build a work-stream diff. Past this we
 * skip the diff (the renderer falls back to a plain "file" result) rather than
 * pull a large file into memory on every write — Thread 1 scope guard.
 */
const DIFF_SOURCE_MAX_BYTES = 256 * 1024;

// Prose/doc extensions auto-indexed into RAG on write. Code and config are
// intentionally excluded — see autoIndexFile for the rationale.
const AUTO_INDEX_EXTENSIONS = new Set([
  '.md', '.txt', '.rst', '.csv', '.log',
]);

/**
 * Decide whether a written file should be auto-indexed and, if so, under
 * which RAG purpose. Pure (extension lookup only) so the doc-vs-code policy
 * is unit-testable without touching config, the indexer, or the filesystem.
 * Returns `'document'` for prose/doc formats, `null` for everything else
 * (code, config, binaries) — code is indexed on demand, never on write.
 */
export function autoIndexPurpose(filePath: string): 'document' | null {
  return AUTO_INDEX_EXTENSIONS.has(extname(filePath).toLowerCase()) ? 'document' : null;
}

/**
 * Project markers that signal "this directory is a real codebase the user
 * cares about" — writes targeting paths inside such a directory should land
 * on the actual file, not get redirected into the throwaway session folder.
 *
 * Heuristic only — projects without any of these markers (e.g. a plain notes
 * directory) still get the redirect; that's the safer default.
 */
const PROJECT_MARKERS = Object.freeze([
  '.git',
  'package.json',
  'pubspec.yaml',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
]);

/** Per-process cache of directory → project-root (or null). */
const projectRootCache = new Map<string, string | null>();

/**
 * Walk up from `absPath` looking for a project marker. Returns the directory
 * that contains a marker, or null if none was found before reaching the
 * workspace root. The walk stops at workspace root — we never claim
 * `workspace.rootPath` itself or any ancestor of it as a "project".
 */
function findProjectRoot(absPath: string, workspaceRoot: string): string | null {
  let dir = absPath;
  // If the input is a file path, start from its parent.
  try {
    if (existsSync(dir) && !existsSync(join(dir, '.'))) dir = dirname(dir);
  } catch { /* ignore */ }
  if (!dir.startsWith(workspaceRoot)) return null;

  while (dir.length > workspaceRoot.length && dir !== workspaceRoot) {
    const cached = projectRootCache.get(dir);
    if (cached !== undefined) return cached;

    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(dir, marker))) {
        projectRootCache.set(dir, dir);
        return dir;
      }
    }
    projectRootCache.set(dir, null);
    dir = dirname(dir);
  }
  return null;
}

/**
 * Get or create the session output directory for an agent.
 * Format: {workspace}/sessions/{YYYY-MM-DD}-{topic}/
 */
async function getSessionOutputDir(context: AgentContext | undefined, root: string): Promise<string | null> {
  try {
    const config = getConfig();
    if (!config.workspace.sessionFolders) {
      coreLogger.debug('Session folders disabled in config');
      return null;
    }
    if (!context?.sessionId) {
      coreLogger.debug('No sessionId in context, skipping session folder');
      return null;
    }

    const date = new Date().toISOString().slice(0, 10);
    const topic = (context.topic || context.role || 'general')
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 40);
    const shortId = context.sessionId.slice(0, 8);
    const dirName = `${date}-${topic}-${shortId}`;
    const sessionDir = join(root, 'sessions', dirName);

    if (!existsSync(sessionDir)) {
      await mkdir(sessionDir, { recursive: true });
      coreLogger.info({ sessionDir }, 'Created session output directory');
    }

    return sessionDir;
  } catch (err) {
    coreLogger.debug({ err }, 'Failed to get session output dir');
    return null;
  }
}

/**
 * Auto-index a written file into the RAG knowledge base (fire-and-forget).
 *
 * Prose/docs only (`purpose='document'`). Code is deliberately NOT
 * auto-indexed on write: agents read source directly (always fresher than a
 * stored chunk), grep/ripgrep beats vector search for exact symbols, and a
 * chunk for any file edited outside the agent (git pull, IDE, another dev)
 * silently goes stale. Code can still be indexed on demand via the knowledge
 * tool's `index_directory` / `index_file` — useful for repos the agent can't
 * read off the local filesystem.
 */
function autoIndexFile(filePath: string): void {
  try {
    const config = getConfig();
    if (!config.workspace.autoIndexFiles) return;

    const purpose = autoIndexPurpose(filePath);
    if (!purpose) return;

    // Fire-and-forget — don't block the write operation
    import('@/core/rag/indexer').then(({ getFileIndexer }) => {
      getFileIndexer().indexFile(filePath, purpose).then((chunks) => {
        coreLogger.debug({ filePath, chunks }, 'Auto-indexed file into knowledge base');
      }).catch((err) => {
        coreLogger.debug({ err, filePath }, 'Auto-index skipped (embedding service may be unavailable)');
      });
    }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in index'));
  } catch {
    // Silently skip if anything fails
  }
}

export class FilesystemTool extends BaseTool {
  readonly id = 'filesystem';
  readonly name = 'Filesystem';
  readonly version = '1.0.0';
  readonly description = 'Read and write files within the workspace';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'Read file contents from the workspace directory (text, code, config files)', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Write, create, copy, or move files within the workspace directory', defaultLevel: 'ASK' },
        { action: 'delete', description: 'Permanently delete files or directories from the workspace filesystem', defaultLevel: 'ASK', dangerous: true },
        { action: 'list', description: 'List and search file/directory names within the workspace', defaultLevel: 'ALLOW' },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read file contents',
          parameters: { path: { type: 'string', description: 'File path', required: true } },
          returns: 'File contents as string',
        },
        {
          name: 'write_file',
          description: 'Write content to a file',
          parameters: {
            path: { type: 'string', description: 'File path', required: true },
            content: { type: 'string', description: 'Content to write', required: true },
          },
          returns: 'Success status',
        },
        {
          name: 'list_directory',
          description: 'List directory contents',
          parameters: {
            path: { type: 'string', description: 'Directory path', required: false },
            recursive: { type: 'boolean', description: 'List recursively', required: false },
          },
          returns: 'Array of file/directory info',
        },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'read_file',
      'Read the contents of a file',
      createParameterSchema({
        path: { type: 'string', description: 'Relative or absolute path to the file', required: true },
        encoding: { type: 'string', description: 'File encoding', default: 'utf-8' },
      }),
      async (args, context) => {
        const fs = this.workspaceFor(context);
        const filePath = this.resolveAndValidate(this.requireString(args, 'path'), context, fs);

        const content = await readFile(filePath, { encoding: (args.encoding as BufferEncoding) || 'utf-8' });
        return { content, path: filePath, size: content.length };
      },
      { permissionAction: 'read' }
    );

    this.registerTool(
      'write_file',
      'Write content to a file, creating it if it does not exist. Relative paths are resolved to the session output directory (if enabled) or workspace root.',
      createParameterSchema({
        path: { type: 'string', description: 'Relative or absolute path to the file', required: true },
        content: { type: 'string', description: 'Content to write', required: true },
        createDirs: { type: 'boolean', description: 'Create parent directories if needed', default: true },
      }),
      async (args, context) => {
        const rawPath = this.requireString(args, 'path');
        this.requireString(args, 'content');
        const fs = this.workspaceFor(context);
        // `root` is the sandbox root — per-user under multiuser, flat
        // otherwise. All session-dir / project-marker arithmetic below must
        // anchor on this (not the flat `config.workspace.rootPath`), or it
        // produces paths the sandbox then rejects.
        const root = fs.root;
        let filePath: string;

        // Session-dir redirect only applies to agents with NO resolved project.
        // When the worker is operating on a real project (projectPath set by
        // the orchestrator), writes go to the real project — otherwise the
        // agent's output lands in a throwaway session folder and nothing ends
        // up in the repo.
        const projectPath = (context?.metadata as Record<string, unknown> | undefined)?.projectPath as string | undefined;
        const sessionDir = projectPath ? null : await getSessionOutputDir(context, root);
        if (sessionDir) {
          if (!rawPath.startsWith('/')) {
            // Relative path: by default resolve into session dir, BUT if the
            // path's first segment matches a real project under workspace
            // root (carries a project marker like `.git`/`package.json`),
            // resolve against workspace root instead. Pipeline subagents
            // routinely write `trivia_masters/server/src/foo.js` — without
            // this branch every relative write lands in the session folder
            // and the actual repo stays empty.
            const firstSegment = rawPath.split(/[/\\]/, 1)[0];
            const candidate = firstSegment ? resolve(root, firstSegment) : null;
            if (candidate && candidate.startsWith(root) && existsSync(candidate) && findProjectRoot(candidate, root)) {
              filePath = resolve(root, rawPath);
            } else {
              filePath = resolve(sessionDir, rawPath);
            }
          } else {
            // Absolute path within workspace root: redirect to the session
            // dir UNLESS the target lives inside a real project (marker dir
            // like `.git`, `package.json`, etc.). Pipeline stages targeting
            // an explicit repo had their writes silently sandboxed to
            // `sessions/.../<repo>/...` — files never landed in the repo.
            const resolved = resolve(rawPath);
            const insideWorkspace = resolved.startsWith(root);
            const inExcludedSubtree = resolved.includes('/sessions/')
              || resolved.includes('/extensions/')
              || resolved.includes('/.octipus/');
            const projectRoot = insideWorkspace && !inExcludedSubtree
              ? findProjectRoot(resolved, root)
              : null;

            if (insideWorkspace && !inExcludedSubtree && !projectRoot) {
              const relFromRoot = relative(root, resolved);
              filePath = resolve(sessionDir, relFromRoot);
            } else {
              filePath = resolved;
            }
          }
        } else if (projectPath && !rawPath.startsWith('/')) {
          // Project-scoped agent: relative paths resolve inside the project
          filePath = resolve(projectPath, rawPath);
        } else {
          filePath = rawPath.startsWith('/') ? resolve(rawPath) : resolve(root, rawPath);
        }
        // Final sandbox gate — same `fs` that computed `root`, so resolution
        // and validation can't disagree. Reassign to the canonical
        // (symlink-resolved) path so the write, prior-content read, mkdir,
        // auto-index, and reported `path` all operate on the same resolved
        // target the gate validated — consistent with `resolveAndValidate`
        // in every other tool here.
        filePath = this.resolveSafe(fs, filePath);

        return withFileMutationQueue(filePath, async () => {
          // Capture prior content (bounded) so the work stream can show a diff
          // of what changed. `null` ⇒ no diff (new file diffs against '' below;
          // too-large/unreadable skips the diff and falls back to a file result).
          let before: string | null = '';
          try {
            if (existsSync(filePath)) {
              const st = await stat(filePath);
              before = st.size <= DIFF_SOURCE_MAX_BYTES ? await readFile(filePath, 'utf-8') : null;
            }
          } catch {
            before = null; // unreadable prior content must never block the write
          }

          if (args.createDirs !== false) {
            const dir = dirname(filePath);
            if (!existsSync(dir)) {
              await mkdir(dir, { recursive: true });
            }
          }

          const content = args.content as string;
          await writeFile(filePath, content, 'utf-8');

          // Auto-index into RAG knowledge base
          autoIndexFile(filePath);

          const result: Record<string, unknown> = { success: true, path: filePath, bytesWritten: content.length };
          // UI-only diff for the work stream / file view — stripped before the
          // model sees the result (it already has the inputs it acted on).
          if (before !== null && content.length <= DIFF_SOURCE_MAX_BYTES) {
            const d = computeLineDiff(before, content);
            result[WORK_STREAM_META_KEY] = { diff: { patch: d.patch, added: d.added, removed: d.removed } };
          }
          return result;
        });
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'append_file',
      'Append content to a file',
      createParameterSchema({
        path: { type: 'string', description: 'Path to the file', required: true },
        content: { type: 'string', description: 'Content to append', required: true },
      }),
      async (args, context) => {
        this.requireString(args, 'content');
        const fs = this.workspaceFor(context);
        const filePath = this.resolveAndValidate(this.requireString(args, 'path'), context, fs);

        return withFileMutationQueue(filePath, async () => {
          const existing = existsSync(filePath) ? await readFile(filePath, 'utf-8') : '';
          const content = args.content as string;
          const next = existing + content;
          await writeFile(filePath, next, 'utf-8');

          // Auto-index into RAG
          autoIndexFile(filePath);

          const result: Record<string, unknown> = { success: true, path: filePath };
          // UI-only diff (see write_file) — stripped before the model sees it.
          if (existing.length + content.length <= DIFF_SOURCE_MAX_BYTES) {
            const d = computeLineDiff(existing, next);
            result[WORK_STREAM_META_KEY] = { diff: { patch: d.patch, added: d.added, removed: d.removed } };
          }
          return result;
        });
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'list_directory',
      'List contents of a directory',
      createParameterSchema({
        path: { type: 'string', description: 'Directory path', default: '.' },
        recursive: { type: 'boolean', description: 'List recursively', default: false },
        includeHidden: { type: 'boolean', description: 'Include hidden files', default: false },
      }),
      async (args, context) => {
        const fs = this.workspaceFor(context);
        const dirPath = this.resolveAndValidate((args.path as string) || '.', context, fs);

        const entries = await this.listDir(dirPath, args.recursive as boolean, args.includeHidden as boolean, fs.root);
        return { path: dirPath, entries };
      },
      { permissionAction: 'list' }
    );

    this.registerTool(
      'file_info',
      'Get information about a file or directory',
      createParameterSchema({
        path: { type: 'string', description: 'Path to the file or directory', required: true },
      }),
      async (args, context) => {
        const fs = this.workspaceFor(context);
        const filePath = this.resolveAndValidate(args.path as string, context, fs);

        const stats = await stat(filePath);
        return {
          path: filePath,
          name: basename(filePath),
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          created: stats.birthtime.toISOString(),
          modified: stats.mtime.toISOString(),
          permissions: stats.mode.toString(8).slice(-3),
        };
      },
      { permissionAction: 'read' }
    );

    this.registerTool(
      'create_directory',
      'Create a directory',
      createParameterSchema({
        path: { type: 'string', description: 'Directory path', required: true },
        recursive: { type: 'boolean', description: 'Create parent directories', default: true },
      }),
      async (args, context) => {
        const fs = this.workspaceFor(context);
        const dirPath = this.resolveAndValidate(args.path as string, context, fs);

        await mkdir(dirPath, { recursive: args.recursive !== false });
        return { success: true, path: dirPath };
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'delete_file',
      'Delete a file or directory',
      createParameterSchema({
        path: { type: 'string', description: 'Path to delete', required: true },
        recursive: { type: 'boolean', description: 'Delete directories recursively', default: false },
      }),
      async (args, context) => {
        const fs = this.workspaceFor(context);
        const filePath = this.resolveAndValidate(args.path as string, context, fs);

        return withFileMutationQueue(filePath, async () => {
          await rm(filePath, { recursive: args.recursive as boolean, force: false });
          return { success: true, path: filePath };
        });
      },
      { permissionAction: 'delete' }
    );

    this.registerTool(
      'copy_file',
      'Copy a file',
      createParameterSchema({
        source: { type: 'string', description: 'Source path', required: true },
        destination: { type: 'string', description: 'Destination path', required: true },
      }),
      async (args, context) => {
        const fs = this.workspaceFor(context);
        const srcPath = this.resolveAndValidate(args.source as string, context, fs);
        const destPath = this.resolveAndValidate(args.destination as string, context, fs);

        return withFileMutationQueue(destPath, async () => {
          await copyFile(srcPath, destPath);
          return { success: true, source: srcPath, destination: destPath };
        });
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'move_file',
      'Move or rename a file',
      createParameterSchema({
        source: { type: 'string', description: 'Source path', required: true },
        destination: { type: 'string', description: 'Destination path', required: true },
      }),
      async (args, context) => {
        const fs = this.workspaceFor(context);
        const srcPath = this.resolveAndValidate(args.source as string, context, fs);
        const destPath = this.resolveAndValidate(args.destination as string, context, fs);

        return withFileMutationQueue(destPath, async () => {
          await rename(srcPath, destPath);
          return { success: true, source: srcPath, destination: destPath };
        });
      },
      { permissionAction: 'write' }
    );

    this.registerTool(
      'search_files',
      'Search for files by name pattern',
      createParameterSchema({
        pattern: { type: 'string', description: 'Glob pattern or regex', required: true },
        path: { type: 'string', description: 'Directory to search in', default: '.' },
        maxResults: { type: 'number', description: 'Maximum results', default: 100 },
      }),
      async (args, context) => {
        const fs = this.workspaceFor(context);
        const dirPath = this.resolveAndValidate((args.path as string) || '.', context, fs);

        const pattern = safeRegExp(args.pattern as string);
        if (!pattern) {
          return { pattern: args.pattern, results: [], error: 'Invalid or too complex regex pattern' };
        }
        const results: string[] = [];

        const search = async (dir: string) => {
          if (results.length >= (args.maxResults as number || 100)) return;

          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= (args.maxResults as number || 100)) break;

            const fullPath = join(dir, entry.name);
            if (pattern.test(entry.name)) {
              results.push(relative(fs.root, fullPath));
            }
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              await search(fullPath);
            }
          }
        };

        await search(dirPath);
        return { pattern: args.pattern, results };
      },
      { permissionAction: 'list' }
    );
  }

  private requireString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Missing required parameter "${key}". The tool call arguments may have been truncated or malformed.`);
    }
    return value;
  }

  /**
   * Build the path sandbox for this call — the single source of truth for
   * BOTH resolution and validation.
   *
   * `WorkspaceFS.forAgent(context)` picks the layout by userId:
   *   - a real user → per-user nested root under
   *     `<workspace.rootPath>/users/{userId}/workspaces/default/files`.
   *   - system jobs (`userId === 'system'`/absent) → flat root at
   *     `config.workspace.rootPath`.
   *
   * `additionalPaths` and the legacy `/tmp/assistant-` prefix are allowed
   * extras; both modes block traversal, absolute-path escape, and symlink
   * escape. A devMode `projectPath` (absolute path to a real external
   * project the worker was pointed at) is added as an extra-allowed prefix
   * so project-scoped reads/writes pass the sandbox check.
   *
   * Previously resolution (`resolvePath`) anchored on the *flat*
   * `config.workspace.rootPath` while validation (`validatePath`) anchored
   * on the per-user `WorkspaceFS` root. With multiuser on those two roots
   * differ, so every relative-path call resolved to the flat root and then
   * failed validation against the nested root ("outside allowed workspace
   * directories"). Routing both through this one instance keeps them from
   * drifting again.
   */
  private workspaceFor(context?: AgentContext): WorkspaceFS {
    const projectPath = (context?.metadata as Record<string, unknown> | undefined)
      ?.projectPath as string | undefined;
    const fs = WorkspaceFS.forAgent(context, {
      extraAllowedPrefixes: projectPath ? [resolve(projectPath)] : [],
    });
    // Materialize the workspace root. In multiuser the per-user root
    // (`workspace/users/<uid>/workspaces/default/files`) is not seeded
    // anywhere — nothing calls ensureRoot at session setup — so read/list/
    // file_info on a fresh user hit ENOENT until the first write lazily
    // mkdirs it. Creating the caller's own root here is benign and
    // idempotent (existsSync-guarded) and makes reads return empty instead.
    fs.ensureRootSync();
    return fs;
  }

  /**
   * Validate an already-computed path against the workspace sandbox and
   * return the canonical (symlink-resolved) absolute path. Translates the
   * internal `WorkspaceFsError` into the user-facing message.
   */
  private resolveSafe(fs: WorkspaceFS, path: string): string {
    try {
      return fs.resolve(path);
    } catch (err) {
      if (err instanceof WorkspaceFsError) {
        throw new Error(`Path '${path}' is outside allowed workspace directories`);
      }
      throw err;
    }
  }

  /**
   * Resolve a user-supplied path and validate it against `fs` in one step.
   * Resolution rules (preserved from the former `resolvePath`):
   *   - absolute path → used as-is;
   *   - relative path + devMode `projectPath` → resolved under the project;
   *   - relative path otherwise → resolved under `fs.root`.
   * The result is then gated through `fs.resolve` so it can never land
   * outside the sandbox.
   */
  private resolveAndValidate(rawPath: string, context: AgentContext | undefined, fs: WorkspaceFS): string {
    let candidate: string;
    if (rawPath.startsWith('/')) {
      candidate = resolve(rawPath);
    } else {
      const projectPath = (context?.metadata as Record<string, unknown> | undefined)
        ?.projectPath as string | undefined;
      candidate = projectPath ? resolve(projectPath, rawPath) : resolve(fs.root, rawPath);
    }
    return this.resolveSafe(fs, candidate);
  }

  private async listDir(
    dir: string,
    recursive: boolean,
    includeHidden: boolean,
    root: string
  ): Promise<{ name: string; path: string; isDirectory: boolean; size?: number }[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: { name: string; path: string; isDirectory: boolean; size?: number }[] = [];

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);
      const relativePath = relative(root, fullPath);

      if (entry.isDirectory()) {
        results.push({ name: entry.name, path: relativePath, isDirectory: true });
        if (recursive) {
          const subEntries = await this.listDir(fullPath, true, includeHidden, root);
          results.push(...subEntries);
        }
      } else {
        const stats = await stat(fullPath);
        results.push({ name: entry.name, path: relativePath, isDirectory: false, size: stats.size });
      }
    }

    return results;
  }
}

export const filesystemTool = new FilesystemTool();
