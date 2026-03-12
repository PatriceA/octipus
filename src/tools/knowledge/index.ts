import { BaseTool, createParameterSchema } from '../base-tool';
import type { ToolManifest } from '@/core/types';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getFileIndexer } from '@/core/rag/indexer';

export class KnowledgeTool extends BaseTool {
  readonly id = 'knowledge';
  readonly name = 'Knowledge Base';
  readonly version = '1.0.0';
  readonly description = 'Search and manage the RAG knowledge base — index files and search stored knowledge.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'search', description: 'Search the RAG knowledge base for previously indexed documents and code snippets', defaultLevel: 'ALLOW' },
        { action: 'index', description: 'Index workspace files and directories into the RAG knowledge base for future retrieval', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'search_knowledge', description: 'Search the knowledge base for relevant information', parameters: { query: { type: 'string', description: 'Search query', required: true } }, returns: 'Matching knowledge entries with similarity scores' },
        { name: 'index_file', description: 'Index a file into the knowledge base', parameters: { path: { type: 'string', description: 'File path', required: true } }, returns: 'Number of chunks indexed' },
        { name: 'index_directory', description: 'Index all matching files in a directory', parameters: { path: { type: 'string', description: 'Directory path', required: true } }, returns: 'Index results with file and chunk counts' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'search_knowledge',
      'Search the knowledge base for information relevant to a query. Returns the most similar stored content.',
      createParameterSchema({
        query: { type: 'string', description: 'The search query', required: true },
        limit: { type: 'number', description: 'Max results to return (default: 5)', default: 5 },
        source_type: { type: 'string', description: 'Filter by source type: document, code, or all' },
      }),
      async (args) => {
        const service = getEmbeddingService();
        const results = await service.search(
          args.query as string,
          (args.limit as number) || 5,
          args.source_type as string | undefined,
        );

        if (results.length === 0) {
          return { results: [], message: 'No relevant knowledge found.' };
        }

        return {
          results: results.map(r => ({
            content: r.content,
            similarity: r.similarity.toFixed(3),
            sourceType: r.sourceType,
            filePath: r.metadata.filePath,
          })),
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'index_file',
      'Index a file into the knowledge base for future retrieval.',
      createParameterSchema({
        path: { type: 'string', description: 'Absolute path to the file to index', required: true },
        type: { type: 'string', description: 'Source type: document or code', default: 'document' },
      }),
      async (args) => {
        const indexer = getFileIndexer();
        const chunks = await indexer.indexFile(
          args.path as string,
          (args.type as 'document' | 'code') || 'document',
        );
        return { indexed: true, chunks, path: args.path };
      },
    );

    this.registerTool(
      'index_directory',
      'Index all matching files in a directory into the knowledge base.',
      createParameterSchema({
        path: { type: 'string', description: 'Directory path to index', required: true },
        patterns: { type: 'string', description: 'Comma-separated glob patterns (default: **/*.md,**/*.txt)', default: '**/*.md,**/*.txt' },
      }),
      async (args) => {
        const indexer = getFileIndexer();
        const patterns = ((args.patterns as string) || '**/*.md,**/*.txt').split(',').map(p => p.trim());
        const result = await indexer.indexDirectory(args.path as string, patterns);
        return result;
      },
    );
  }
}

export const knowledgeTool = new KnowledgeTool();
