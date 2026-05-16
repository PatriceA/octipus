import { generateId } from '@/utils/crypto';
import { coreLogger } from '@/utils/logger';
import { getEmbeddingService } from './embeddings';

export interface IndexResult {
  filesIndexed: number;
  chunksStored: number;
  errors: string[];
}

export class FileIndexer {
  async indexFile(filePath: string, purpose: 'document' | 'code' = 'document'): Promise<number> {
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

  async indexDirectory(dirPath: string, patterns = ['**/*.md', '**/*.txt']): Promise<IndexResult> {
    const _glob = new Bun.Glob(patterns.join(','));
    const result: IndexResult = { filesIndexed: 0, chunksStored: 0, errors: [] };

    // Use glob to find matching files
    for (const pattern of patterns) {
      const g = new Bun.Glob(pattern);
      for await (const path of g.scan({ cwd: dirPath, absolute: true })) {
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
