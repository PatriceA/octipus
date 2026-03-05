import { readFile, writeFile, readdir, stat, mkdir, rm, copyFile, rename } from 'fs/promises';
import { join, resolve, dirname, relative, basename } from 'path';
import { existsSync } from 'fs';
import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest, AgentContext } from '@/core/types';
import { getConfig } from '@/config';

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
        { action: 'read', description: 'Read files', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Write/create files', defaultLevel: 'ASK' },
        { action: 'delete', description: 'Delete files', defaultLevel: 'ASK', dangerous: true },
        { action: 'list', description: 'List directory contents', defaultLevel: 'ALLOW' },
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
      async (args) => {
        const filePath = this.resolvePath(args.path as string);
        this.validatePath(filePath);

        const content = await readFile(filePath, { encoding: (args.encoding as BufferEncoding) || 'utf-8' });
        return { content, path: filePath, size: content.length };
      },
      { permissionAction: 'read' }
    );

    this.registerTool(
      'write_file',
      'Write content to a file, creating it if it does not exist',
      createParameterSchema({
        path: { type: 'string', description: 'Relative or absolute path to the file', required: true },
        content: { type: 'string', description: 'Content to write', required: true },
        createDirs: { type: 'boolean', description: 'Create parent directories if needed', default: true },
      }),
      async (args) => {
        const filePath = this.resolvePath(args.path as string);
        this.validatePath(filePath);

        if (args.createDirs !== false) {
          const dir = dirname(filePath);
          if (!existsSync(dir)) {
            await mkdir(dir, { recursive: true });
          }
        }

        await writeFile(filePath, args.content as string, 'utf-8');
        return { success: true, path: filePath, bytesWritten: (args.content as string).length };
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
      async (args) => {
        const filePath = this.resolvePath(args.path as string);
        this.validatePath(filePath);

        const existing = existsSync(filePath) ? await readFile(filePath, 'utf-8') : '';
        await writeFile(filePath, existing + args.content, 'utf-8');

        return { success: true, path: filePath };
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
      async (args) => {
        const dirPath = this.resolvePath((args.path as string) || '.');
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
      async (args) => {
        const filePath = this.resolvePath(args.path as string);
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
      async (args) => {
        const dirPath = this.resolvePath(args.path as string);
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
      async (args) => {
        const filePath = this.resolvePath(args.path as string);
        this.validatePath(filePath);

        await rm(filePath, { recursive: args.recursive as boolean, force: false });
        return { success: true, path: filePath };
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
      async (args) => {
        const srcPath = this.resolvePath(args.source as string);
        const destPath = this.resolvePath(args.destination as string);
        this.validatePath(srcPath);
        this.validatePath(destPath);

        await copyFile(srcPath, destPath);
        return { success: true, source: srcPath, destination: destPath };
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
      async (args) => {
        const srcPath = this.resolvePath(args.source as string);
        const destPath = this.resolvePath(args.destination as string);
        this.validatePath(srcPath);
        this.validatePath(destPath);

        await rename(srcPath, destPath);
        return { success: true, source: srcPath, destination: destPath };
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
      async (args) => {
        const dirPath = this.resolvePath((args.path as string) || '.');
        this.validatePath(dirPath);

        const pattern = new RegExp(args.pattern as string);
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

  private resolvePath(path: string): string {
    if (path.startsWith('/')) {
      return resolve(path);
    }
    const { root } = getWorkspacePaths();
    return resolve(root, path);
  }

  private validatePath(path: string): void {
    const resolved = resolve(path);
    const { root, additional } = getWorkspacePaths();
    const allPaths = [root, ...additional];

    const allowed = allPaths.some(p => resolved.startsWith(p)) || resolved.startsWith('/tmp');
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
