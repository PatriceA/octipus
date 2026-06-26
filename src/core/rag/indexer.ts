import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';
import { CodeFileNotIndexableError, isCodeFile } from './code-detection';
import { getEmbeddingService } from './embeddings';

export interface IndexResult {
  filesIndexed: number;
  chunksStored: number;
  errors: string[];
}

/**
 * Optional sandbox guard. `indexFile`/`indexDirectory` read whatever absolute
 * path they're handed via `Bun.file(path).text()`, so a caller that accepts a
 * path from an untrusted request MUST pass `isAllowed` to confine reads to the
 * caller's workspace. For `indexDirectory` this is the only thing that closes
 * the symlink-leaf gap: the glob can surface a file *inside* the validated
 * directory that is itself a symlink to `/etc/passwd` or another tenant's
 * tree, and only a per-file realpath check (e.g. `WorkspaceFS.resolveOptional`)
 * catches it. Trusted in-process callers (e.g. the filesystem tool's
 * auto-index, which pre-validates) may omit it.
 */
export interface IndexGuard {
  /** Return false to skip a path that resolves outside the allowed sandbox. */
  isAllowed?: (absPath: string) => boolean;
}

export class FileIndexer {
  async indexFile(filePath: string, purpose: 'document' = 'document', guard?: IndexGuard): Promise<number> {
    if (guard?.isAllowed && !guard.isAllowed(filePath)) {
      throw new Error(`Path is outside the allowed workspace: ${filePath}`);
    }
    // Raw code files are never indexed — regardless of the requested `purpose`,
    // so a `**/*.ts` directory glob can't slip code in under 'document' either.
    if (isCodeFile(filePath)) {
      throw new CodeFileNotIndexableError(filePath);
    }
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = await file.text();
    if (!content.trim()) return 0;

    const service = getEmbeddingService();
    const _sourceId = generateId();

    // Delete existing embeddings for this file path
    await service.deleteBySource(purpose, filePath);

    return service.indexText(purpose, filePath, content, {
      filePath,
      language: this.detectLanguage(filePath),
    });
  }

  async indexDirectory(dirPath: string, patterns = ['**/*.md', '**/*.txt'], guard?: IndexGuard): Promise<IndexResult> {
    const result: IndexResult = { filesIndexed: 0, chunksStored: 0, errors: [] };

    // Use glob to find matching files. `followSymlinks: false` stops the scan
    // descending through symlinked directories; the per-file `isAllowed` check
    // below is the authoritative guard for symlinked leaf files (a `notes.md`
    // that is itself a link to `/etc/passwd`), which the directory-root
    // validation alone does not catch.
    for (const pattern of patterns) {
      const g = new Bun.Glob(pattern);
      for await (const path of g.scan({ cwd: dirPath, absolute: true, followSymlinks: false })) {
        if (guard?.isAllowed && !guard.isAllowed(path)) {
          result.errors.push(`${path}: skipped — resolves outside the allowed workspace`);
          coreLogger.warn({ path, dirPath }, 'Skipped indexing file that resolves outside the workspace');
          continue;
        }
        // Silently skip code files (e.g. a `**/*.ts` pattern) — not indexable by
        // design, and not an error worth surfacing per file.
        if (isCodeFile(path)) {
          coreLogger.debug({ path }, 'Skipped indexing raw code file (not stored in KB by design)');
          continue;
        }
        try {
          const chunks = await this.indexFile(path, 'document');
          result.filesIndexed++;
          result.chunksStored += chunks;
        } catch (err) {
          result.errors.push(`${path}: ${(err as Error).message}`);
          coreLogger.error({ err, path }, 'Failed to index file');
        }
      }
    }

    return result;
  }

  private detectLanguage(filePath: string): string | undefined {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      ts: 'typescript', js: 'javascript', py: 'python', rs: 'rust',
      go: 'go', java: 'java', md: 'markdown', txt: 'text',
    };
    return ext ? langMap[ext] : undefined;
  }
}

// Singleton
let instance: FileIndexer | null = null;

export function getFileIndexer(): FileIndexer {
  if (!instance) instance = new FileIndexer();
  return instance;
}
