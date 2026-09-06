import { getCanvasBuilder } from '@/core/knowledge/canvas';
import { getNoteService } from '@/core/knowledge/notes';
import { getSuggestionService } from '@/core/knowledge/suggestions';
import { getVaultSync } from '@/core/knowledge/vault';
import { getEmbeddingService } from '@/core/rag/embeddings';
import type { ToolManifest } from '@/core/types';
import { isRootAgent } from '@/core/types';
import { getKnowledgeLinkRepository } from '@/db/repositories/knowledge-link-repository';
import { getNoteRepository } from '@/db/repositories/note-repository';
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
  readonly version = '1.1.0';
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
        { name: 'write_meeting_note', description: 'Save meeting notes, linking each attendee to their profile', parameters: { title: { type: 'string', description: 'Meeting title', required: true } }, returns: 'The note id and the attendee links' },
        { name: 'import_calendar_meetings', description: 'Create meeting notes from the connected calendars', parameters: { days: { type: 'number', description: 'Days either side of today' } }, returns: 'Imported and skipped meetings' },
        { name: 'suggest_links', description: 'Suggest unlinked but related entities for a note', parameters: { note_id: { type: 'string', description: 'Note id', required: true } }, returns: 'Suggested connections with similarity' },
        { name: 'archive_note', description: 'Soft-delete (archive) a note', parameters: { id: { type: 'string', description: 'Note id', required: true } }, returns: 'Whether the note was archived' },
        { name: 'query_notes', description: 'Bases-style property query over notes', parameters: {}, returns: 'Matching notes as a table' },
        { name: 'export_canvas', description: 'Build a JSON Canvas of a note neighbourhood', parameters: { entry_type: { type: 'string', description: 'Entry type', required: true }, entry_id: { type: 'string', description: 'Entry id', required: true } }, returns: 'A JSON Canvas document' },
        { name: 'sync_vault', description: 'Export/import notes to/from an Obsidian vault', parameters: { direction: { type: 'string', description: 'export | import', required: true } }, returns: 'Sync result counts' },
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
          // A note the user asked Octipus for directly is the USER's note, so
          // the root writes it unattributed; a spawned agent's note is stamped.
          createdByAgentId: context.role && !isRootAgent(context) ? context.id : null,
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
      'write_meeting_note',
      'Save what happened in a meeting, so it can be searched later and connected to the people who were there. Pass the attendees and each becomes an edge to their profile — bound when a profile exists, and left as a ghost that binds automatically if the profile is created later. Re-saving the same title on the same date updates the same note, so this is safe to call again with fuller notes. Use this rather than write_note whenever the content is a meeting: it is what makes "what did we agree with Ada in March" answerable.',
      createParameterSchema({
        title: { type: 'string', description: 'What the meeting was — used with the date to identify the note', required: true },
        body: { type: 'string', description: 'The notes: decisions, actions and who owns them' },
        at: { type: 'string', description: 'When it happened, ISO-8601. Defaults to now.' },
        attendees: { type: 'array', description: 'Who was there — names, email addresses, or "Name <email>"', items: { type: 'string' } },
        source: { type: 'string', description: 'Where this came from, e.g. pasted, transcript, google' },
      }),
      async (args, context) => {
        if (!context.userId) throw new Error('write_meeting_note requires an authenticated user context');
        const { ingestMeeting } = await import('@/core/knowledge/meetings');
        const result = await ingestMeeting({
          userId: context.userId,
          workspaceId: context.workspaceId ?? null,
          title: String(args.title),
          at: typeof args.at === 'string' && args.at.trim() ? new Date(args.at).toISOString() : undefined,
          body: typeof args.body === 'string' ? args.body : undefined,
          attendees: parseAttendees(args.attendees),
          source: typeof args.source === 'string' ? args.source : 'pasted',
          createdByAgentId: context.role && !isRootAgent(context) ? context.id : null,
        });
        return {
          ...result,
          hint: result.attendees.some((a) => a.profileId === null)
            ? 'Some attendees have no profile yet. Create one with profiles.create_profile and the meeting links to it automatically.'
            : undefined,
        };
      },
    );

    this.registerTool(
      'import_calendar_meetings',
      'Create a meeting note for each event on the user\'s connected calendars (Google and/or Microsoft) in a window around today, with the attendees linked. Skips all-day entries, and never overwrites a note somebody has already written into — so it is safe to run every morning. Reports which calendars answered; if none are connected it says so rather than returning an empty list as if the diary were empty.',
      createParameterSchema({
        days_back: { type: 'number', description: 'How many days before today to import (default 1)', default: 1 },
        days_ahead: { type: 'number', description: 'How many days after today to import (default 1)', default: 1 },
        include_all_day: { type: 'boolean', description: 'Include all-day entries (holidays, out-of-office). Default false.', default: false },
      }),
      async (args, context) => {
        if (!context.userId) throw new Error('import_calendar_meetings requires an authenticated user context');
        const back = clampDays(args.days_back, 1);
        const ahead = clampDays(args.days_ahead, 1);
        const now = Date.now();
        const { importCalendarMeetings } = await import('@/core/calendar/import-meetings');
        const result = await importCalendarMeetings({
          userId: context.userId,
          workspaceId: context.workspaceId ?? null,
          from: new Date(now - back * 86_400_000),
          to: new Date(now + ahead * 86_400_000),
          includeAllDay: args.include_all_day === true,
          createdByAgentId: context.role && !isRootAgent(context) ? context.id : null,
        });
        if (result.providers.length === 0 && !result.partial) {
          return {
            imported: [],
            skipped: [],
            message: 'No calendar is connected for this user. Connect Google or Microsoft in Settings > Integrations first.',
          };
        }
        return result;
      },
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

    // ── Tier 3: interoperability & spatial surfaces ──────────────────

    this.registerTool(
      'query_notes',
      'Bases-style query — list notes filtered by kind, tag, and frontmatter property equality, with a chosen sort. Returns a table of matching notes.',
      createParameterSchema({
        kind: { type: 'string', description: 'Filter by note_kind' },
        tag: { type: 'string', description: 'Filter by tag' },
        frontmatter: { type: 'object', description: 'Frontmatter property equality filter, e.g. {"status":"active"}' },
        sort: { type: 'string', description: 'updated (default) | created | title | date' },
        order: { type: 'string', description: 'asc | desc (default)' },
        limit: { type: 'number', description: 'Max rows (default 100)', default: 100 },
      }),
      async (args, context) => {
        const sort = args.sort as string | undefined;
        const order = args.order as string | undefined;
        if (sort && !['updated', 'created', 'title', 'date'].includes(sort)) {
          throw new Error(`Unknown sort "${sort}" — use updated | created | title | date.`);
        }
        if (order && !['asc', 'desc'].includes(order)) {
          throw new Error(`Unknown order "${order}" — use asc | desc.`);
        }
        const rows = await getNoteRepository().query(context.userId, {
          kind: (args.kind as string) || undefined,
          tag: (args.tag as string) || undefined,
          frontmatter: (args.frontmatter as Record<string, unknown>) || undefined,
          sort: sort as 'updated' | 'created' | 'title' | 'date' | undefined,
          order: order as 'asc' | 'desc' | undefined,
          limit: Math.min(1000, Math.max(1, (args.limit as number) || 100)),
        });
        return { notes: rows.map((n) => ({ id: n.id, slug: n.slug, title: n.title, kind: n.noteKind, tags: n.tags, noteDate: n.noteDate, frontmatter: n.frontmatter, updatedAt: n.updatedAt })) };
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'export_canvas',
      'Build a JSON Canvas (jsoncanvas.org) of the neighbourhood around a note — the note at the centre, linked entities on a ring. Opens natively in Obsidian; persist via artifacts or write to the vault as a .canvas file.',
      createParameterSchema({
        entry_type: { type: 'string', description: 'Entry entity type (e.g. note)', required: true },
        entry_id: { type: 'string', description: 'Entry entity id', required: true },
        hops: { type: 'number', description: 'Neighbourhood radius (default 1)', default: 1 },
      }),
      async (args, context) => {
        const canvas = await getCanvasBuilder().fromNeighbourhood(
          context.userId,
          { type: args.entry_type as string, id: args.entry_id as string },
          Math.min(5, Math.max(1, (args.hops as number) || 1)),
        );
        return canvas;
      },
      { requiresPermission: false },
    );

    this.registerTool(
      'sync_vault',
      'Sync notes to/from a real Obsidian vault directory. Requires vaultSync enabled in config. DB is authoritative — on import, files that differ from existing notes are reported as conflicts and skipped unless force=true.',
      createParameterSchema({
        direction: { type: 'string', description: 'export (DB→vault) | import (vault→DB)', required: true },
        force: { type: 'boolean', description: 'On import, let the file win over a differing DB note', default: false },
      }),
      async (args, context) => {
        const { getConfig } = await import('@/config');
        const cfg = getConfig().vaultSync;
        if (!cfg?.enabled) {
          throw new Error('Vault sync is disabled. Enable vaultSync in config and set a path first.');
        }
        const direction = args.direction as string;
        if (direction === 'export') {
          if (cfg.direction === 'import') throw new Error('vaultSync.direction is "import" — export is not permitted.');
          return getVaultSync().exportVault(context.userId, cfg.path);
        }
        if (direction === 'import') {
          if (cfg.direction === 'export') throw new Error('vaultSync.direction is "export" — import is not permitted.');
          return getVaultSync().importVault(context.userId, cfg.path, { force: (args.force as boolean) ?? false });
        }
        throw new Error(`Unknown sync direction "${direction}" — use "export" or "import".`);
      },
      { permissionAction: 'write' },
    );
  }
}

/**
 * Attendees arrive as free text from a model: a bare name, an address, or the
 * `Name <email>` form a calendar invite uses. All three have to work, because
 * the alternative is a nested-object parameter a small model gets wrong.
 */
function parseAttendees(raw: unknown): { name?: string; email?: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name?: string; email?: string }[] = [];
  for (const entry of raw) {
    const text = String(entry ?? '').trim();
    if (text.length === 0) continue;
    const angled = /^(.*?)\s*<([^>]+)>$/.exec(text);
    if (angled) {
      const person: { name?: string; email?: string } = { email: angled[2].trim() };
      if (angled[1].trim()) person.name = angled[1].trim().replace(/^["']|["']$/g, '');
      out.push(person);
      continue;
    }
    out.push(text.includes('@') && !text.includes(' ') ? { email: text } : { name: text });
  }
  return out;
}

function clampDays(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(Math.floor(n), 60));
}

export const notesTool = new NotesTool();
