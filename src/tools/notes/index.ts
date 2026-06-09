import { getNoteService } from '@/core/knowledge/notes';
import { getSuggestionService } from '@/core/knowledge/suggestions';
import { getEmbeddingService } from '@/core/rag/embeddings';
import type { ToolManifest } from '@/core/types';
import { getKnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * Knowledge-graph Tier 2 — the notes authoring surface as agent tools.
 * Notes are markdown, linkable, and searchable; this exposes write/read/
 * list/search plus quick-capture and link suggestions. See
 * `docs/KNOWLEDGE-GRAPH.md`.
 */
export class NotesTool extends BaseTool {
  readonly id = 'notes';
  readonly name = 'Notes';
  readonly version = '1.0.0';
  readonly description = 'Author and navigate markdown notes — create/edit notes with [[wikilinks]] and #tags, read with backlinks, search, quick-capture to a daily note, and get suggested connections.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'write', description: 'Create, edit, capture, and archive notes', defaultLevel: 'ALLOW' },
        { action: 'read', description: 'Read, list, and search notes', defaultLevel: 'ALLOW' },
      ],
      tools: [
        { name: 'write_note', description: 'Create or update a markdown note', parameters: { title: { type: 'string', description: 'Note title', required: true } }, returns: 'The saved note id, slug, and link counts' },
        { name: 'read_note', description: 'Read a note (with backlinks) by id or slug', parameters: { id: { type: 'string', description: 'Note id' } }, returns: 'Note body, metadata, and backlinks' },
        { name: 'list_notes', description: 'List notes, optionally by kind or tag', parameters: {}, returns: 'Notes (newest first)' },
        { name: 'search_notes', description: 'Hybrid search over note content', parameters: { query: { type: 'string', description: 'Search query', required: true } }, returns: 'Matching notes' },
        { name: 'capture_note', description: 'Append a timestamped line to today\'s daily note', parameters: { text: { type: 'string', description: 'Text to capture', required: true } }, returns: 'The daily note' },
        { name: 'suggest_links', description: 'Suggest unlinked but related entities for a note', parameters: { note_id: { type: 'string', description: 'Note id', required: true } }, returns: 'Suggested connections with similarity' },
        { name: 'archive_note', description: 'Soft-delete (archive) a note', parameters: { id: { type: 'string', description: 'Note id', required: true } }, returns: 'Whether the note was archived' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'write_note',
      'Create or update a markdown note. Use [[Wikilinks]] to connect to other notes/entities and #tags to categorise — both are wired into the knowledge graph automatically. Pass id to edit an existing note; omit it to create (slug derives from slug or title).',
      createParameterSchema({
        title: { type: 'string', description: 'Note title', required: true },
        body: { type: 'string', description: 'Markdown body (may contain [[wikilinks]] and #tags)' },
        id: { type: 'string', description: 'Existing note id to update (omit to create)' },
        slug: { type: 'string', description: 'Explicit slug (defaults to a slug of the title)' },
        note_kind: { type: 'string', description: 'note (default) | moc | literature | …' },
        tags: { type: 'array', description: 'Explicit tags (unioned with #tags from the body)', items: { type: 'string' } },
      }),
      async (args, context) => {
        const result = await getNoteService().save({
          userId: context.userId,
          workspaceId: context.workspaceId ?? null,
          id: (args.id as string) || undefined,
          slug: (args.slug as string) || undefined,
          title: args.title as string,
          body: (args.body as string) ?? '',
          noteKind: (args.note_kind as string) || undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
          createdByAgentId: context.role && context.role !== 'orchestrator' ? context.id : null,
        });
        return {
          id: result.note.id,
          slug: result.note.slug,
          created: result.created,
          indexed: result.indexed,
          links: result.links,
        };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'read_note',
      'Read a note by id or slug, including its backlinks (what links to it).',
      createParameterSchema({
        id: { type: 'string', description: 'Note id' },
        slug: { type: 'string', description: 'Note slug (alternative to id)' },
      }),
      async (args, context) => {
        const svc = getNoteService();
        const note = args.id
          ? await svc.getById(context.userId, args.id as string)
          : args.slug
            ? await svc.getBySlug(context.userId, context.workspaceId ?? null, args.slug as string)
            : null;
        if (!note) {
          if (!args.id && !args.slug) throw new Error('read_note requires id or slug');
          return { error: 'Note not found.' };
        }
        const backlinks = await getKnowledgeLinkRepository().getBacklinks(context.userId, 'note', note.id);
        return {
          id: note.id,
          slug: note.slug,
          title: note.title,
          body: note.body,
          tags: note.tags,
          noteKind: note.noteKind,
          backlinks: backlinks.map((b) => ({ from: { type: b.fromType, id: b.fromId }, linkType: b.linkType, label: b.label })),
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'list_notes',
      'List notes (newest first), optionally filtered by kind or tag.',
      createParameterSchema({
        kind: { type: 'string', description: 'Filter by note_kind (e.g. daily, moc)' },
        tag: { type: 'string', description: 'Filter by tag' },
        limit: { type: 'number', description: 'Max results (default 50)', default: 50 },
      }),
      async (args, context) => {
        const list = await getNoteService().list(context.userId, {
          kind: (args.kind as string) || undefined,
          tag: (args.tag as string) || undefined,
          limit: (args.limit as number) || 50,
        });
        return { notes: list.map((n) => ({ id: n.id, slug: n.slug, title: n.title, kind: n.noteKind, tags: n.tags, updatedAt: n.updatedAt })) };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'search_notes',
      'Hybrid (semantic + keyword) search over note content. Returns matching notes; use read_note for the full body.',
      createParameterSchema({
        query: { type: 'string', description: 'Search query', required: true },
        limit: { type: 'number', description: 'Max results (default 5)', default: 5 },
      }),
      async (args, context) => {
        const results = await getEmbeddingService().hybridSearch(args.query as string, (args.limit as number) || 5, 'note', undefined, 0.3, context.userId);
        return {
          results: results.map((r) => ({ id: r.id, sourceId: r.sourceId, title: r.metadata.title, abstract: r.abstract || r.content.slice(0, 200), similarity: r.similarity.toFixed(3) })),
          hint: 'sourceId is note:<noteId>. Use read_note to load the full note.',
        };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'capture_note',
      "Quick capture — append a timestamped line to today's daily note (created on first use). [[wikilinks]] and #tags in the text are wired immediately.",
      createParameterSchema({
        text: { type: 'string', description: 'Text to capture', required: true },
        date: { type: 'string', description: 'Target day (YYYY-MM-DD); defaults to today' },
      }),
      async (args, context) => {
        const note = await getNoteService().capture(
          context.userId,
          context.workspaceId ?? null,
          args.text as string,
          (args.date as string) || undefined,
        );
        return { id: note.id, slug: note.slug, captured: true };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'suggest_links',
      'Suggest related but not-yet-linked entities for a note, using semantic similarity. Returns candidates — use link_knowledge (knowledge tool) to accept one.',
      createParameterSchema({
        note_id: { type: 'string', description: 'Note id', required: true },
        limit: { type: 'number', description: 'Max suggestions (default 5)', default: 5 },
      }),
      async (args, context) => {
        const suggestions = await getSuggestionService().suggestForNote(context.userId, args.note_id as string, (args.limit as number) || 5);
        return { suggestions, hint: suggestions.length === 0 ? 'No suggestions (either nothing related, or no embedding model configured).' : 'Accept a suggestion with knowledge.link_knowledge.' };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'archive_note',
      'Archive (soft-delete) a note. It is hidden from default listings but not destroyed.',
      createParameterSchema({
        id: { type: 'string', description: 'Note id', required: true },
      }),
      async (args, context) => {
        const ok = await getNoteService().archive(context.userId, args.id as string);
        return { archived: ok };
      },
      { permissionAction: 'write' },
    );
  }
}

export const notesTool = new NotesTool();
