// Shared view types for the notes workspace. These mirror the shapes returned
// by `src/api/routes/notes.ts` (web-only view models — the canonical entities
// live in `src/db/schema/notes.ts`).

export interface NoteRow {
  id: string;
  slug: string;
  title: string;
  noteKind: string;
  tags: string[];
  pinned: boolean;
  updatedAt: string;
  noteDate?: string | null;
  /** The note's properties; `GET /notes` returns them, a remote space's list does not. */
  frontmatter?: Record<string, unknown>;
  /** The markdown; `GET /notes` returns it (search results show a line of it). */
  body?: string;
  /** A line of the text instead of `body` (`GET /notes?preview=true`, the list). */
  preview?: string;
  /** Set on an archived note (the archive view, or an archived note opened from it). */
  archivedAt?: string | null;
}

export interface NoteIndexEntry {
  id: string;
  title: string;
  slug: string;
  noteKind: string;
  /** Slugs the note was moved away from (`POST /notes/:id/move`): a `[[link]]` to one still means it. */
  movedFrom?: string[];
}

export interface TagCount {
  tag: string;
  count: number;
}

/** The "other end" of a knowledge-graph edge, resolved to a title when it is a note. */
export interface LinkEndpoint {
  type: string;
  id?: string;
  ref?: string;
  title?: string;
  slug?: string;
  resolved: boolean;
}

export interface LinkEdge {
  id: string;
  linkType: string;
  label: string | null;
  origin: string;
  endpoint: LinkEndpoint;
}

export interface NoteDetail extends NoteRow {
  body: string;
  /** sha256 of `body`: the base of a write made from it (space notes, §7.3). */
  bodySha256: string;
  frontmatter: Record<string, unknown>;
  backlinks: LinkEdge[];
  outgoing: LinkEdge[];
}

export interface Suggestion {
  type: string;
  id: string;
  title?: string;
  similarity: number;
}

export interface NoteListResponse {
  notes: NoteRow[];
  total: number;
}

/**
 * What the list shows. `all` leaves out the notes a learning review wrote
 * (kind `lesson`, or tagged `session-learning`) unless pinned; `learnings`
 * shows only those. `archived`: the archive view (each with Restore).
 */
export type NoteFilter = 'all' | 'pinned' | 'daily' | 'moc' | 'learnings' | 'archived';

/** How the list is laid out: most recently edited first, by title, or as the folder tree. */
export type NoteSort = 'recent' | 'title' | 'folders';
