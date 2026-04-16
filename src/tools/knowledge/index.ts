import { BaseTool, createParameterSchema, type ToolAvailability } from '../base-tool';
import type { ToolManifest } from '@/core/types';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getFileIndexer } from '@/core/rag/indexer';

export class KnowledgeTool extends BaseTool {
  readonly id = 'knowledge';
  readonly name = 'Knowledge Base';
  readonly version = '1.2.0';
  readonly description = 'Search and manage the RAG knowledge base — hybrid search (semantic + keyword), index files, and read stored knowledge.';

  override async checkAvailability(): Promise<ToolAvailability> {
    try {
      const { getModelRegistry } = await import('@/models/model-registry');
      const registry = getModelRegistry();
      const embeddingModel = await registry.getModelForTopic('embedding');
      const hasEmbedding = embeddingModel?.topics?.includes('embedding') ||
        (embeddingModel?.topicRoles && 'embedding' in embeddingModel.topicRoles);
      if (!hasEmbedding) {
        return { available: true, degraded: true, reason: 'No embedding model configured — indexing and semantic search disabled' };
      }
      return { available: true };
    } catch {
      return { available: true, degraded: true, reason: 'No embedding model configured' };
    }
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'search', description: 'Search the knowledge base using hybrid (semantic + keyword) search', defaultLevel: 'ALLOW' },
        { action: 'index', description: 'Index workspace files and directories into the knowledge base', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'search_knowledge', description: 'Search the knowledge base for relevant information using hybrid search', parameters: { query: { type: 'string', description: 'Search query', required: true } }, returns: 'Matching knowledge entries with similarity scores' },
        { name: 'read_knowledge', description: 'Read the full content of a knowledge entry by ID', parameters: { id: { type: 'string', description: 'Entry ID from search results', required: true } }, returns: 'Full content of the knowledge entry' },
        { name: 'index_file', description: 'Index a file into the knowledge base', parameters: { path: { type: 'string', description: 'File path', required: true } }, returns: 'Number of chunks indexed' },
        { name: 'index_directory', description: 'Index all matching files in a directory', parameters: { path: { type: 'string', description: 'Directory path', required: true } }, returns: 'Index results with file and chunk counts' },
        { name: 'cleanup_knowledge', description: 'Remove orphaned, stale, short, and duplicate entries from the knowledge base', parameters: { dry_run: { type: 'boolean', description: 'Preview only' } }, returns: 'Cleanup summary with counts' },
        { name: 'knowledge_stats', description: 'Get detailed knowledge base statistics', parameters: {}, returns: 'Stats including counts, age distribution, and coverage' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'knowledge_stats',
      'Get detailed knowledge base statistics including entry counts by source type, age distribution, content metrics, and abstract coverage.',
      createParameterSchema({}),
      async () => {
        const service = getEmbeddingService();
        const stats = await service.getStats();
        return {
          ...stats,
          summary: `${stats.total} entries across ${Object.keys(stats.bySourceType).length} source types. Avg content length: ${stats.avgContentLength} chars. Abstract coverage: ${stats.abstractCoverage.withAbstract}/${stats.total}.`,
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'search_knowledge',
      'Search the knowledge base using hybrid search (combines semantic similarity with keyword matching). Returns abstracts — use read_knowledge to get full content.',
      createParameterSchema({
        query: { type: 'string', description: 'The search query', required: true },
        limit: { type: 'number', description: 'Max results to return (default: 5)', default: 5 },
        source_type: { type: 'string', description: 'Filter by source type: document, code, agent_output, or all' },
        mode: { type: 'string', description: 'Search mode: hybrid (default), semantic (vector only), or keyword (full-text only)' },
      }),
      async (args) => {
        const service = getEmbeddingService();
        const limit = (args.limit as number) || 5;
        const sourceType = args.source_type as string | undefined;
        const mode = (args.mode as string) || 'hybrid';

        let results;
        switch (mode) {
          case 'semantic':
            results = await service.search(args.query as string, limit, sourceType);
            break;
          case 'keyword':
            results = await service.ftsSearch(args.query as string, limit, sourceType);
            break;
          default:
            results = await service.hybridSearch(args.query as string, limit, sourceType);
        }

        if (results.length === 0) {
          return { results: [], message: 'No relevant knowledge found.' };
        }

        return {
          results: results.map(r => ({
            id: r.id,
            abstract: r.abstract || r.content.slice(0, 200),
            similarity: r.similarity.toFixed(3),
            sourceType: r.sourceType,
            filePath: r.metadata.filePath,
          })),
          hint: 'Use read_knowledge with an entry ID to get the full content.',
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'read_knowledge',
      'Read the full content of a knowledge entry by its ID (returned from search_knowledge).',
      createParameterSchema({
        id: { type: 'string', description: 'The knowledge entry ID from search results', required: true },
      }),
      async (args) => {
        const service = getEmbeddingService();
        const entry = await service.readById(args.id as string);

        if (!entry) {
          return { error: 'Knowledge entry not found.' };
        }

        return {
          id: entry.id,
          content: entry.content,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          filePath: entry.metadata.filePath,
          language: entry.metadata.language,
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
      { permissionAction: 'index' },
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
      { permissionAction: 'index' },
    );

    this.registerTool(
      'cleanup_knowledge',
      'Clean up the knowledge base by removing orphaned document embeddings, stale agent outputs (older than N days), very short entries, and duplicates. Returns counts of removed entries. Use dry_run=true to preview without deleting.',
      createParameterSchema({
        max_age_days: { type: 'number', description: 'Max age in days for agent outputs (default: 30)', default: 30 },
        min_content_length: { type: 'number', description: 'Minimum content length to keep (default: 50)', default: 50 },
        dry_run: { type: 'boolean', description: 'Preview only, do not delete (default: false)', default: false },
      }),
      async (args) => {
        const service = getEmbeddingService();
        const result = await service.cleanup({
          maxAgeDays: (args.max_age_days as number) || 30,
          minContentLength: (args.min_content_length as number) || 50,
          dryRun: (args.dry_run as boolean) ?? false,
        });
        return {
          ...result,
          message: result.total === 0
            ? 'Knowledge base is clean — nothing to remove.'
            : `${args.dry_run ? 'Would remove' : 'Removed'} ${result.total} entries: ${result.orphanedDocuments} orphaned, ${result.staleAgentOutputs} stale, ${result.shortEntries} short, ${result.duplicates} duplicates.`,
        };
      },
      { permissionAction: 'index' },
    );
  }
}

export const knowledgeTool = new KnowledgeTool();
