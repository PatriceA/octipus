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
}

export interface NoteIndexEntry {
  id: string;
  title: string;
  slug: string;
  noteKind: string;
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

export type NoteFilter = 'all' | 'pinned' | 'daily' | 'moc';
