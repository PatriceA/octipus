import { readFile, writeFile, readdir, stat, mkdir, rm, copyFile, rename } from 'fs/promises';
import { join, resolve, dirname, relative, basename, extname } from 'path';
import { existsSync, realpathSync } from 'fs';
import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest, AgentContext } from '@/core/types';
import { getConfig } from '@/config';
import { safeRegExp } from '@/utils/sanitize';
import { coreLogger } from '@/utils/logger';
import { withFileMutationQueue } from '@/utils/file-mutation-queue';

function getWorkspacePaths(): { root: string; additional: string[] } {
  try {
    const config = getConfig();
    return {
      root: resolve(config.workspace.rootPath),
      additional: config.workspace.additionalPaths.map(p => resolve(p)),
    };
  } catch {
    // Config may not be loaded yet during early initialization
    return {
      root: resolve(process.env.WORKSPACE_PATH || process.cwd()),
      additional: process.env.WORKSPACE_ADDITIONAL_PATHS?.split(',').filter(Boolean).map(p => resolve(p)) || [],
    };
  }
}

// File extensions eligible for RAG auto-indexing
const INDEXABLE_EXTENSIONS = new Set([
  '.md', '.txt', '.rst', '.csv', '.json', '.yaml', '.yml',
  '.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java',
  '.sh', '.bash', '.zsh', '.sql', '.html', '.css', '.xml',
  '.toml', '.ini', '.cfg', '.conf', '.env.example', '.log',
]);

/**
 * Get or create the session output directory for an agent.
 * Format: {workspace}/sessions/{YYYY-MM-DD}-{topic}/
 */
async function getSessionOutputDir(context?: AgentContext): Promise<string | null> {
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

    const { root } = getWorkspacePaths();
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
 */
function autoIndexFile(filePath: string): void {
  try {
    const config = getConfig();
    if (!config.workspace.autoIndexFiles) return;

    const ext = extname(filePath).toLowerCase();
    if (!INDEXABLE_EXTENSIONS.has(ext)) return;

    // Fire-and-forget — don't block the write operation
    import('@/core/rag/indexer').then(({ getFileIndexer }) => {
      const sourceType = ['.md', '.txt', '.rst', '.csv', '.log'].includes(ext) ? 'document' : 'code';
      getFileIndexer().indexFile(filePath, sourceType).then((chunks) => {
        coreLogger.debug({ filePath, chunks }, 'Auto-indexed file into knowledge base');
      }).catch((err) => {
        coreLogger.debug({ err, filePath }, 'Auto-index skipped (embedding service may be unavailable)');
      });
    }).catch(() => {});
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
        const filePath = this.resolvePath(this.requireString(args, 'path'), context);
        this.validatePath(filePath);

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
        let filePath: string;

        // Session-dir redirect only applies to agents with NO resolved project.
        // When the worker is operating on a real project (projectPath set by
        // the orchestrator), writes go to the real project — otherwise the
        // agent's output lands in a throwaway session folder and nothing ends
        // up in the repo.
        const projectPath = (context?.metadata as Record<string, unknown> | undefined)?.projectPath as string | undefined;
        const sessionDir = projectPath ? null : await getSessionOutputDir(context);
        if (sessionDir) {
          if (!rawPath.startsWith('/')) {
            // Relative path → resolve into session dir
            filePath = resolve(sessionDir, rawPath);
          } else {
            // Absolute path within workspace root → redirect to session dir
            const { root } = getWorkspacePaths();
            const resolved = resolve(rawPath);
            if (resolved.startsWith(root) && !resolved.includes('/sessions/') && !resolved.includes('/extensions/') && !resolved.includes('/.assistant/')) {
              const relFromRoot = relative(root, resolved);
              filePath = resolve(sessionDir, relFromRoot);
            } else {
              filePath = this.resolvePath(rawPath, context);
            }
          }
        } else if (projectPath && !rawPath.startsWith('/')) {
          // Project-scoped agent: relative paths resolve inside the project
          filePath = resolve(projectPath, rawPath);
        } else {
          filePath = this.resolvePath(rawPath, context);
        }
        this.validatePath(filePath);

        return withFileMutationQueue(filePath, async () => {
          if (args.createDirs !== false) {
            const dir = dirname(filePath);
            if (!existsSync(dir)) {
              await mkdir(dir, { recursive: true });
            }
          }

          await writeFile(filePath, args.content as string, 'utf-8');

          // Auto-index into RAG knowledge base
          autoIndexFile(filePath);

          return { success: true, path: filePath, bytesWritten: (args.content as string).length };
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
        const filePath = this.resolvePath(this.requireString(args, 'path'), context);
        this.requireString(args, 'content');
        this.validatePath(filePath);

        return withFileMutationQueue(filePath, async () => {
          const existing = existsSync(filePath) ? await readFile(filePath, 'utf-8') : '';
          await writeFile(filePath, existing + args.content, 'utf-8');

          // Auto-index into RAG
          autoIndexFile(filePath);

          return { success: true, path: filePath };
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
        const dirPath = this.resolvePath((args.path as string) || '.', context);
        this.validatePath(dirPath);

        const entries = await this.listDir(dirPath, args.recursive as boolean, args.includeHidden as boolean);
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
        const filePath = this.resolvePath(args.path as string, context);
        this.validatePath(filePath);

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
        const dirPath = this.resolvePath(args.path as string, context);
        this.validatePath(dirPath);

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
        const filePath = this.resolvePath(args.path as string, context);
        this.validatePath(filePath);

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
        const srcPath = this.resolvePath(args.source as string, context);
        const destPath = this.resolvePath(args.destination as string, context);
        this.validatePath(srcPath);
        this.validatePath(destPath);

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
        const srcPath = this.resolvePath(args.source as string, context);
        const destPath = this.resolvePath(args.destination as string, context);
        this.validatePath(srcPath);
        this.validatePath(destPath);

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
        const dirPath = this.resolvePath((args.path as string) || '.', context);
        this.validatePath(dirPath);

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
              results.push(relative(getWorkspacePaths().root, fullPath));
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

  private resolvePath(path: string, context?: import('@/core/types').AgentContext): string {
    if (path.startsWith('/')) {
      return resolve(path);
    }
    // Use project-specific path from agent context when available
    const projectPath = (context?.metadata as Record<string, unknown>)?.projectPath as string | undefined;
    if (projectPath) {
      return resolve(projectPath, path);
    }
    const { root } = getWorkspacePaths();
    return resolve(root, path);
  }

  private validatePath(path: string): void {
    const resolved = resolve(path);
    const { root, additional } = getWorkspacePaths();
    const allPaths = [root, ...additional];

    // Resolve symlinks to prevent symlink bypass attacks
    let realPath: string;
    try {
      realPath = realpathSync(resolved);
    } catch {
      // File may not exist yet (e.g. write operations) — check parent directory
      const parent = dirname(resolved);
      try {
        realPath = join(realpathSync(parent), basename(resolved));
      } catch {
        realPath = resolved;
      }
    }

    const allowed = allPaths.some(p => realPath.startsWith(p)) || realPath.startsWith('/tmp/assistant-');
    if (!allowed) {
      throw new Error(`Path '${path}' is outside allowed workspace directories`);
    }
  }

  private async listDir(
    dir: string,
    recursive: boolean,
    includeHidden: boolean
  ): Promise<{ name: string; path: string; isDirectory: boolean; size?: number }[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: { name: string; path: string; isDirectory: boolean; size?: number }[] = [];

    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);
      const relativePath = relative(getWorkspacePaths().root, fullPath);

      if (entry.isDirectory()) {
        results.push({ name: entry.name, path: relativePath, isDirectory: true });
        if (recursive) {
          const subEntries = await this.listDir(fullPath, true, includeHidden);
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
