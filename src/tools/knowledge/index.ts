import { getKnowledgeGraph, entityRefFromSourceId, type EntityRef, type TraversalDirection } from '@/core/knowledge/graph';
import { slugify } from '@/core/knowledge/wikilink';
import { type EmbeddingPurpose, getEmbeddingService } from '@/core/rag/embeddings';
import { getFileIndexer } from '@/core/rag/indexer';
import type { AgentContext, ToolManifest } from '@/core/types';
import { getKnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { WorkspaceFS, WorkspaceFsError } from '@/security/workspace-fs';
import { BaseTool, createParameterSchema, type ToolAvailability } from '../base-tool';

/**
 * Sandbox for the indexing tools. Like the filesystem tool's `workspaceFor`,
 * it pins reads to the caller's workspace root (per-user under multiuser; flat
 * otherwise) plus `additionalPaths` and a devMode `projectPath`. Without this
 * the index tools fed `Bun.file(path).text()` any absolute path the agent
 * named — arbitrary host-file read into the KB.
 */
function workspaceFor(context?: AgentContext): WorkspaceFS {
  const projectPath = (context?.metadata as Record<string, unknown> | undefined)
    ?.projectPath as string | undefined;
  const fs = WorkspaceFS.forAgent(context, {
    extraAllowedPrefixes: projectPath ? [projectPath] : [],
  });
  // Materialize the per-user workspace root (see the filesystem tool's
  // workspaceFor) so index_directory on a fresh multiuser workspace doesn't
  // ENOENT before the root has been written to.
  fs.ensureRootSync();
  return fs;
}

function resolveInWorkspace(fs: WorkspaceFS, path: string): string {
  try {
    return fs.resolve(path);
  } catch (err) {
    if (err instanceof WorkspaceFsError) {
      throw new Error(`Path '${path}' is outside allowed workspace directories`);
    }
    throw err;
  }
}

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
    } catch (err) {
      const { toolLogger } = await import('@/utils/logger');
      toolLogger.warn({ err, toolId: this.id }, 'KnowledgeTool availability check failed — treating embedding features as degraded');
      return { available: true, degraded: true, reason: 'Embedding model availability could not be determined' };
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
        { action: 'link', description: 'Create explicit edges between knowledge entities', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'search_knowledge', description: 'Search the knowledge base for relevant information using hybrid search', parameters: { query: { type: 'string', description: 'Search query', required: true } }, returns: 'Matching knowledge entries with similarity scores' },
        { name: 'read_knowledge', description: 'Read the full content of a knowledge entry by ID', parameters: { id: { type: 'string', description: 'Entry ID from search results', required: true } }, returns: 'Full content of the knowledge entry' },
        { name: 'index_file', description: 'Index a file into the knowledge base', parameters: { path: { type: 'string', description: 'File path', required: true } }, returns: 'Number of chunks indexed' },
        { name: 'index_directory', description: 'Index all matching files in a directory', parameters: { path: { type: 'string', description: 'Directory path', required: true } }, returns: 'Index results with file and chunk counts' },
        { name: 'cleanup_knowledge', description: 'Remove orphaned, stale, short, and duplicate entries from the knowledge base', parameters: { dry_run: { type: 'boolean', description: 'Preview only' } }, returns: 'Cleanup summary with counts' },
        { name: 'knowledge_stats', description: 'Get detailed knowledge base statistics', parameters: {}, returns: 'Stats including counts, age distribution, and coverage' },
        { name: 'link_knowledge', description: 'Create an explicit directed edge between two knowledge entities', parameters: { from_type: { type: 'string', description: 'Source entity type', required: true }, from_id: { type: 'string', description: 'Source entity id', required: true } }, returns: 'The created edge id and whether it resolved' },
        { name: 'get_backlinks', description: 'List edges pointing at an entity (or sharing a tag/ref)', parameters: { ref: { type: 'string', description: 'Slug or tag to look up' } }, returns: 'Inbound edges' },
        { name: 'traverse_knowledge', description: 'Bounded BFS over authored edges from an entry entity', parameters: { entry_type: { type: 'string', description: 'Entry entity type', required: true }, entry_id: { type: 'string', description: 'Entry entity id', required: true } }, returns: 'Entities reached, with hop depth' },
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
          summary: `${stats.total} entries across ${Object.keys(stats.byPurpose).length} purposes. Avg content length: ${stats.avgContentLength} chars. Abstract coverage: ${stats.abstractCoverage.withAbstract}/${stats.total}.`,
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'search_knowledge',
      'Search the knowledge base using hybrid search (combines semantic similarity with keyword matching). Returns abstracts — use read_knowledge to get full content. Results are filtered to those with meaningful relevance; an empty list means no relevant knowledge exists.',
      createParameterSchema({
        query: { type: 'string', description: 'The search query', required: true },
        limit: { type: 'number', description: 'Max results to return (default: 5)', default: 5 },
        purpose: { type: 'string', description: 'Filter by row purpose: document, code, message, image_description, knowledge_artifact, ephemeral, or omit for all. Agent outputs no longer land here — sibling-agent results live in task_state (see .octipus/memory-redesign.md Phase B).' },
        mode: { type: 'string', description: 'Search mode: hybrid (default), semantic (vector only), keyword (full-text only), or graph (hybrid entry points, then follow authored knowledge_links edges one hop).' },
        min_similarity: { type: 'number', description: 'Minimum cosine similarity (0–1) to keep a result. Defaults: 0.35 semantic, 0.3 hybrid, 0 keyword.' },
      }),
      async (args, context) => {
        const service = getEmbeddingService();
        const limit = (args.limit as number) || 5;
        const purpose = args.purpose as EmbeddingPurpose | undefined;
        const mode = (args.mode as string) || 'hybrid';
        const userMin = typeof args.min_similarity === 'number' ? (args.min_similarity as number) : undefined;

        // 'graph' builds on hybrid: find entry points by similarity, then
        // follow authored edges from those hits.
        const searchMode = mode === 'graph' ? 'hybrid' : mode;

        // Defaults chosen so that for a typical embedding model, "0.35" is the
        // boundary between "actually relevant" and "nearest of an unrelated
        // bunch". Tune per-deployment via min_similarity if needed.
        const minSimilarity = userMin ?? (searchMode === 'semantic' ? 0.35 : searchMode === 'keyword' ? 0 : 0.3);

        let results;
        switch (searchMode) {
          case 'semantic':
            results = await service.search(args.query as string, limit, purpose, minSimilarity);
            break;
          case 'keyword':
            results = await service.ftsSearch(args.query as string, limit, purpose);
            break;
          default:
            results = await service.hybridSearch(args.query as string, limit, purpose, undefined, minSimilarity);
        }

        if (results.length === 0) {
          return {
            results: [],
            message: `No knowledge above similarity ${minSimilarity.toFixed(2)} matches "${args.query}". The knowledge base may not contain information on this topic — do NOT fabricate an answer.`,
          };
        }

        const base = {
          results: results.map(r => ({
            id: r.id,
            abstract: r.abstract || r.content.slice(0, 200),
            similarity: r.similarity.toFixed(3),
            purpose: r.purpose,
            sourceId: r.sourceId,
            filePath: r.metadata.filePath,
          })),
          hint: 'Use read_knowledge with an entry ID to get the full content. Similarity is cosine (0–1); below 0.3 means the match is weak.',
        };

        if (mode !== 'graph') return base;

        // Graph mode — derive entity entry points from the hits (those
        // whose source_id follows the `<type>:<uuid>` convention) and
        // follow authored edges one hop in both directions.
        const entries: EntityRef[] = [];
        const seen = new Set<string>();
        for (const r of results) {
          const ref = entityRefFromSourceId(r.sourceId);
          if (ref && !seen.has(`${ref.type}:${ref.id}`)) {
            seen.add(`${ref.type}:${ref.id}`);
            entries.push(ref);
          }
        }
        if (entries.length === 0) {
          return { ...base, linked: [], note: 'No graph entry points among the hits (their source ids do not address knowledge entities).' };
        }
        const traversal = await getKnowledgeGraph().traverse(context.userId, entries, { hops: 1, direction: 'both', maxNodes: 25 });
        return {
          ...base,
          linked: traversal.nodes.map((n) => ({ type: n.type, id: n.id, depth: n.depth, via: n.viaDirection })),
          hint: `${base.hint} 'linked' lists entities reached by following authored edges from the matched entries.`,
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
          purpose: entry.purpose,
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
      async (args, context) => {
        const indexer = getFileIndexer();
        const fs = workspaceFor(context);
        const safePath = resolveInWorkspace(fs, args.path as string);
        const chunks = await indexer.indexFile(
          safePath,
          (args.type as 'document' | 'code') || 'document',
        );
        return { indexed: true, chunks, path: safePath };
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
      async (args, context) => {
        const indexer = getFileIndexer();
        const patterns = ((args.patterns as string) || '**/*.md,**/*.txt').split(',').map(p => p.trim());
        const fs = workspaceFor(context);
        const safePath = resolveInWorkspace(fs, args.path as string);
        const result = await indexer.indexDirectory(safePath, patterns, {
          isAllowed: (p) => fs.resolveOptional(p) !== null,
        });
        return result;
      },
      { permissionAction: 'index' },
    );

    this.registerTool(
      'cleanup_knowledge',
      'Clean up the knowledge base: orphaned document embeddings, very short entries, and any remaining stale ephemeral rows. Returns counts of removed entries. Use dry_run=true to preview without deleting. Note: agent outputs no longer land in this table (see task_state in .octipus/memory-redesign.md Phase B); the staleAgentOutputs count is expected to stay at 0.',
      createParameterSchema({
        max_age_days: { type: 'number', description: 'Max age in days for ephemeral entries (default: 30)', default: 30 },
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

    this.registerTool(
      'link_knowledge',
      'Create an explicit edge between two knowledge entities (note, document, memory, artifact). Edges are directed and authored — unlike similarity, they record an intentional relationship the agent can later traverse and explain. Provide either to_id (resolved target) or to_ref (a slug for a target that may not exist yet — a "ghost" link that resolves when the target is created).',
      createParameterSchema({
        from_type: { type: 'string', description: 'Source entity type: note | document | memory | artifact', required: true },
        from_id: { type: 'string', description: 'Source entity UUID', required: true },
        to_type: { type: 'string', description: 'Target entity type (omit for an unresolved ghost link)' },
        to_id: { type: 'string', description: 'Target entity UUID (omit for a ghost link by ref)' },
        to_ref: { type: 'string', description: 'Canonical target slug. Strongly recommended whenever you know the target title — it is what get_backlinks(ref) and ghost resolution match on. If omitted while to_id is given, the id is stored as the ref and backlink-by-slug lookups will not find this edge.' },
        link_type: { type: 'string', description: 'references (default) | derived_from | contradicts | mentions | child_of', default: 'references' },
        label: { type: 'string', description: 'Optional edge label / alias' },
      }),
      async (args, context) => {
        const toId = (args.to_id as string) || undefined;
        const toRef = (args.to_ref as string) || (toId ? toId : undefined);
        if (!toRef) {
          throw new Error('link_knowledge requires either to_id or to_ref to identify the target.');
        }
        const link = await getKnowledgeLinkRepository().create({
          userId: context.userId,
          workspaceId: context.workspaceId ?? null,
          fromType: args.from_type as string,
          fromId: args.from_id as string,
          toType: (args.to_type as string) || null,
          toId: toId ?? null,
          toRef: slugify(toRef),
          linkType: (args.link_type as string) || 'references',
          label: (args.label as string) || null,
          origin: 'agent',
          createdByAgentId: context.id,
        });
        return { linked: true, id: link.id, resolved: link.toId !== null };
      },
      { permissionAction: 'link' },
    );

    this.registerTool(
      'get_backlinks',
      'List edges pointing AT an entity ("what links to X"). Pass entity_id for resolved backlinks, or ref to also include unresolved ghost links and tag membership (ref = a tag).',
      createParameterSchema({
        entity_type: { type: 'string', description: 'Entity type when using entity_id: note | document | memory | artifact' },
        entity_id: { type: 'string', description: 'Entity UUID' },
        ref: { type: 'string', description: 'Canonical slug/tag to find backlinks by reference (catches ghosts + tags)' },
      }),
      async (args, context) => {
        const repo = getKnowledgeLinkRepository();
        let links;
        if (args.ref) {
          links = await repo.getBacklinksByRef(context.userId, slugify(args.ref as string));
        } else if (args.entity_type && args.entity_id) {
          links = await repo.getBacklinks(context.userId, args.entity_type as string, args.entity_id as string);
        } else {
          throw new Error('get_backlinks requires either ref, or both entity_type and entity_id.');
        }
        return {
          backlinks: links.map((l) => ({ id: l.id, from: { type: l.fromType, id: l.fromId }, linkType: l.linkType, label: l.label, origin: l.origin })),
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'traverse_knowledge',
      'Walk the authored knowledge graph from an entry entity via bounded BFS. Returns the entities reached by following edges, with the hop depth and which edge reached each. Use this to gather context the author explicitly connected, complementing similarity search.',
      createParameterSchema({
        entry_type: { type: 'string', description: 'Entry entity type: note | document | memory | artifact', required: true },
        entry_id: { type: 'string', description: 'Entry entity UUID', required: true },
        hops: { type: 'number', description: 'Max BFS depth (default 2)', default: 2 },
        direction: { type: 'string', description: 'out | in | both (default both)', default: 'both' },
        link_types: { type: 'string', description: 'Optional comma-separated link types to follow (e.g. "references,derived_from")' },
      }),
      async (args, context) => {
        const linkTypes = typeof args.link_types === 'string' && args.link_types
          ? (args.link_types as string).split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
        const result = await getKnowledgeGraph().traverse(
          context.userId,
          [{ type: args.entry_type as string, id: args.entry_id as string }],
          {
            hops: (args.hops as number) || 2,
            direction: ((args.direction as string) || 'both') as TraversalDirection,
            linkTypes,
          },
        );
        return {
          reached: result.nodes.map((n) => ({ type: n.type, id: n.id, depth: n.depth, via: n.viaDirection, viaEdgeId: n.viaEdgeId })),
          count: result.nodes.length,
        };
      },
      { requiresPermission: false },
    );
  }
}

export const knowledgeTool = new KnowledgeTool();
