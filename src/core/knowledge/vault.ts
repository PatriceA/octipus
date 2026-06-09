import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { coreLogger } from '@/utils/logger';
import { getNoteService, type NoteService } from './notes';
import type { Note } from '@/db/schema/notes';
import { slugify } from './wikilink';

/**
 * Knowledge-graph Tier 3 — two-way Obsidian-vault sync.
 * See `docs/KNOWLEDGE-GRAPH.md`.
 *
 * Postgres stays the source of truth; the vault is a *projection* and a
 * read-back path. Export materialises notes as `.md` (frontmatter +
 * `[[wikilinks]]` already in the body); import runs each file through the
 * same `NoteService.save` pipeline so an externally-edited file lands in
 * the graph identically to a UI edit.
 *
 * Conflict policy: DB authoritative. On import, if a note already exists
 * and its body differs from the file, the clash is *surfaced* (reported,
 * not merged) and skipped — unless `force` is set, which lets the file win.
 */

export interface ParsedNoteFile {
  title: string;
  slug: string;
  noteKind: string;
  noteDate: string | null;
  tags: string[];
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/** Strip characters that would break the single-line frontmatter values. */
function fmValue(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').trim();
}

/** Serialise a note to markdown with a YAML-ish frontmatter block. */
export function serializeNote(note: Pick<Note, 'title' | 'slug' | 'noteKind' | 'noteDate' | 'tags' | 'body'>): string {
  const fm: string[] = ['---', `title: ${fmValue(note.title)}`, `slug: ${fmValue(note.slug)}`, `kind: ${fmValue(note.noteKind)}`];
  if (note.noteDate) fm.push(`date: ${note.noteDate}`);
  if (note.tags.length) fm.push(`tags: [${note.tags.join(', ')}]`);
  fm.push('---', '');
  return `${fm.join('\n')}\n${note.body}`;
}

/** Parse a `.md` file (optional frontmatter) into note fields. `fallbackSlug` from the path. */
export function parseNoteFile(content: string, fallbackSlug: string): ParsedNoteFile {
  let body = content;
  const fields: Record<string, string> = {};
  const m = FRONTMATTER_RE.exec(content);
  if (m) {
    body = content.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key) fields[key] = value;
    }
  }
  const tags = fields.tags
    ? fields.tags.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const slug = fields.slug ? slugify(fields.slug) : fallbackSlug;
  return {
    title: fields.title || slug,
    slug,
    noteKind: fields.kind || 'note',
    noteDate: fields.date || null,
    tags,
    body: body.replace(/^\n/, ''),
  };
}

export interface VaultExportResult { exported: number; dir: string; truncated: boolean }
export interface VaultImportResult { imported: number; updated: number; unchanged: number; conflicts: string[] }

const EXPORT_LIMIT = 10000;

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export class VaultSync {
  constructor(private readonly notes: NoteService = getNoteService()) {}

  /**
   * Export a user's active, user-level notes to `<dir>/<slug>.md`.
   * Workspace-scoped notes are out of scope for vault sync (lookup on
   * import is user-level) and are skipped to avoid duplicate round-trips.
   */
  async exportVault(userId: string, dir: string): Promise<VaultExportResult> {
    const all = (await this.notes.list(userId, { limit: EXPORT_LIMIT })).filter((n) => n.workspaceId === null);
    const truncated = all.length >= EXPORT_LIMIT;
    if (truncated) {
      coreLogger.warn({ component: 'vault', userId, limit: EXPORT_LIMIT }, 'Vault export hit the note limit — some notes were not exported');
    }
    const root = resolve(dir);
    let exported = 0;
    for (const note of all) {
      const filePath = join(root, `${note.slug}.md`);
      // Defense in depth: a slug should never escape the vault dir (slugify
      // strips `.`), but never write outside it even if one slips through.
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        coreLogger.error({ component: 'vault', slug: note.slug }, 'Slug escapes vault dir — skipping note');
        continue;
      }
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, serializeNote(note), 'utf8');
      exported++;
    }
    coreLogger.info({ component: 'vault', userId, dir, exported, truncated }, 'Exported notes to vault');
    return { exported, dir, truncated };
  }

  /**
   * Import `.md` files from a vault directory. DB authoritative: differing
   * bodies are reported as conflicts and skipped unless `force`.
   */
  async importVault(userId: string, dir: string, opts: { force?: boolean } = {}): Promise<VaultImportResult> {
    const files = await collectMarkdown(dir);
    const result: VaultImportResult = { imported: 0, updated: 0, unchanged: 0, conflicts: [] };
    for (const abs of files) {
      const rel = relative(dir, abs).replace(/\.md$/i, '');
      const content = await readFile(abs, 'utf8');
      const parsed = parseNoteFile(content, slugify(rel));
      const existing = await this.notes.getBySlug(userId, null, parsed.slug);
      if (existing) {
        // Compare normalised bodies — editors routinely add/strip a
        // trailing newline, which must not register as a content conflict.
        const bodySame = existing.body.trimEnd() === parsed.body.trimEnd();
        const metaSame =
          existing.title === parsed.title &&
          existing.noteKind === parsed.noteKind &&
          (existing.noteDate ?? null) === (parsed.noteDate ?? null) &&
          arraysEqual(existing.tags, parsed.tags);
        if (bodySame && metaSame) {
          result.unchanged++;
          continue;
        }
        if (bodySame && !metaSame) {
          // Body matches; only frontmatter (tags/kind/date/title) changed —
          // a safe metadata sync, not a content conflict.
          await this.notes.save({ userId, id: existing.id, title: parsed.title, body: parsed.body, noteKind: parsed.noteKind, noteDate: parsed.noteDate, tags: parsed.tags });
          result.updated++;
          continue;
        }
        if (!opts.force) {
          // Body differs and DB wins; surface the clash rather than overwriting.
          result.conflicts.push(parsed.slug);
          continue;
        }
        await this.notes.save({ userId, id: existing.id, title: parsed.title, body: parsed.body, noteKind: parsed.noteKind, noteDate: parsed.noteDate, tags: parsed.tags });
        result.updated++;
      } else {
        await this.notes.save({ userId, slug: parsed.slug, title: parsed.title, body: parsed.body, noteKind: parsed.noteKind, noteDate: parsed.noteDate, tags: parsed.tags });
        result.imported++;
      }
    }
    coreLogger.info({ component: 'vault', userId, dir, ...result, conflicts: result.conflicts.length }, 'Imported notes from vault');
    return result;
  }
}

/** Recursively collect `*.md` paths under a directory. */
async function collectMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // A missing dir is valid on first sync; anything else (EACCES, EIO) is
    // a real problem we must not swallow.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectMarkdown(abs)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(abs);
    }
  }
  return out;
}

let _instance: VaultSync | null = null;
export function getVaultSync(): VaultSync {
  if (!_instance) _instance = new VaultSync();
  return _instance;
}
