'use client';

import {
  ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Hash, Loader2, Plus, RotateCcw, Search, Star, X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import type { NoteFilter, NoteRow, TagCount } from './types';

interface NavigatorProps {
  notes: NoteRow[];
  tags: TagCount[];
  isLoading: boolean;
  selectedId: string | null;
  filter: NoteFilter;
  setFilter: (f: NoteFilter) => void;
  search: string;
  setSearch: (s: string) => void;
  activeTag: string | null;
  setActiveTag: (t: string | null) => void;
  onOpen: (n: NoteRow) => void;
  /** Absent for a role that cannot create notes. */
  onNew?: (folder?: string) => void;
  /**
   * `notes` already answer `search` (the server searched titles, tags and
   * bodies): shown as a flat list with a line of matching text, not filtered
   * again here. Without it the search filters titles, slugs and tags locally
   * (a remote space's list).
   */
  serverSearch?: boolean;
  /** Offer the archive view (`filter === 'archived'`: `notes` are the archived ones). */
  showArchive?: boolean;
  /** Restore an archived note; shown on each row of the archive view. */
  onRestore?: (n: NoteRow) => void;
}

// --- folder tree (derived from slug paths) ---------------------------------

interface FolderNode {
  folders: Map<string, FolderNode>;
  notes: NoteRow[];
}

function emptyFolder(): FolderNode {
  return { folders: new Map(), notes: [] };
}

function buildFolderTree(notes: NoteRow[]): FolderNode {
  const root = emptyFolder();
  for (const note of notes) {
    const segs = note.slug.split('/').filter(Boolean);
    const folders = segs.slice(0, -1);
    let cursor = root;
    for (const seg of folders) {
      let next = cursor.folders.get(seg);
      if (!next) {
        next = emptyFolder();
        cursor.folders.set(seg, next);
      }
      cursor = next;
    }
    cursor.notes.push(note);
  }
  return root;
}

// --- tag tree (nested on `/`) ----------------------------------------------

interface TagNode {
  name: string;
  full: string;
  count: number;
  children: Map<string, TagNode>;
}

function buildTagTree(tags: TagCount[]): Map<string, TagNode> {
  const root = new Map<string, TagNode>();
  for (const { tag, count } of tags) {
    const segs = tag.split('/').filter(Boolean);
    let level = root;
    let full = '';
    segs.forEach((seg, i) => {
      full = full ? `${full}/${seg}` : seg;
      let node = level.get(seg);
      if (!node) {
        node = { name: seg, full, count: 0, children: new Map() };
        level.set(seg, node);
      }
      if (i === segs.length - 1) node.count = count;
      level = node.children;
    });
  }
  return root;
}

/** A note a learning review wrote: its kind, or the tag such notes carried before they had one. */
function isLesson(n: NoteRow): boolean {
  return n.noteKind === 'lesson' || n.tags.includes('session-learning');
}

/** How often a learning review saw a lesson, when more than once. */
function sightings(n: NoteRow): number | null {
  const seen = n.frontmatter?.sightings;
  return typeof seen === 'number' && Number.isFinite(seen) && seen > 1 ? Math.floor(seen) : null;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(iso).toISOString().slice(0, 10);
}

// --- module-scope sub-components --------------------------------------------
// (Stable identities so the tree doesn't remount on every navigator keystroke.)

interface RowCtx {
  selectedId: string | null;
  onOpen: (n: NoteRow) => void;
}
interface FolderCtx extends RowCtx {
  collapsed: Set<string>;
  toggle: (path: string) => void;
  onNew?: (folder?: string) => void;
}
interface TagCtx {
  activeTag: string | null;
  setActiveTag: (t: string | null) => void;
}

/**
 * One line of a note's text for a list: around the first word of `search` it
 * holds, else its opening. Markdown markers are dropped and whitespace folded.
 */
export function previewLine(body: string | undefined, search = '', width = 90): string {
  if (!body) return '';
  const text = body.replace(/[#>*_`~[\]|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const word = search.trim().toLowerCase().split(/\s+/).find((w) => w && lower.includes(w));
  const at = word ? lower.indexOf(word) : 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  const line = text.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${line}${start + width < text.length ? '…' : ''}`;
}

function NoteRowButton({ note, depth, ctx, snippet }: { note: NoteRow; depth: number; ctx: RowCtx; snippet?: string }) {
  const active = note.id === ctx.selectedId;
  const label = note.noteKind === 'daily' ? note.slug.split('/').pop() ?? note.title : note.title;
  const seen = isLesson(note) ? sightings(note) : null;
  return (
    <button
      type="button"
      onClick={() => ctx.onOpen(note)}
      title={note.slug}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={cn(
        'group/row w-full flex items-center gap-1.5 pr-2 py-1 rounded-xs text-left transition-colors',
        active ? 'bg-primary-container/40 text-on-surface' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
      )}
    >
      <FileText size={13} className={cn('shrink-0 self-start mt-0.5', active ? 'text-primary' : 'text-outline')} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">
          {label}
          {seen !== null && <span className="text-[11px] text-on-surface-variant/70 tabular-nums" title={`seen in ${seen} learning reviews`}>{` ×${seen}`}</span>}
        </span>
        {snippet && <span data-testid="note-snippet" className="block truncate text-[11px] text-on-surface-variant/70">{snippet}</span>}
      </span>
      {note.pinned && <Star size={11} className="shrink-0 text-warning fill-warning/40" />}
      <span className="shrink-0 text-[10px] text-on-surface-variant/50 tabular-nums group-hover/row:text-on-surface-variant">
        {relativeTime(note.archivedAt ?? note.updatedAt)}
      </span>
    </button>
  );
}

function FolderBranch({ name, path, node, depth, ctx }: { name: string; path: string; node: FolderNode; depth: number; ctx: FolderCtx }) {
  const open = !ctx.collapsed.has(path);
  const childFolders = [...node.folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const childNotes = [...node.notes].sort((a, b) => a.title.localeCompare(b.title));
  return (
    <div>
      <div
        className="group/fld flex items-center gap-1 pr-1.5 py-1 rounded-xs hover:bg-surface-container-high cursor-pointer"
        style={{ paddingLeft: 4 + depth * 12 }}
        onClick={() => ctx.toggle(path)}
      >
        {open ? <ChevronDown size={13} className="shrink-0 text-outline" /> : <ChevronRight size={13} className="shrink-0 text-outline" />}
        {open ? <FolderOpen size={13} className="shrink-0 text-primary/80" /> : <Folder size={13} className="shrink-0 text-primary/80" />}
        <span className="truncate text-[13px] font-medium flex-1">{name}</span>
        {ctx.onNew && (
          <button
            type="button"
            title={`New note in ${path}`}
            onClick={(e) => { e.stopPropagation(); ctx.onNew?.(path); }}
            className="opacity-0 group-hover/fld:opacity-100 p-0.5 rounded hover:bg-surface-container-highest text-on-surface-variant"
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {open && (
        <div>
          {childFolders.map(([childName, childNode]) => (
            <FolderBranch key={childName} name={childName} path={`${path}/${childName}`} node={childNode} depth={depth + 1} ctx={ctx} />
          ))}
          {childNotes.map((n) => <NoteRowButton key={n.id} note={n} depth={depth + 1} ctx={ctx} />)}
        </div>
      )}
    </div>
  );
}

function TagBranch({ node, depth, ctx }: { node: TagNode; depth: number; ctx: TagCtx }) {
  const children = [...node.children.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const isActive = ctx.activeTag === node.full;
  return (
    <div>
      <button
        type="button"
        onClick={() => ctx.setActiveTag(isActive ? null : node.full)}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={cn(
          'w-full flex items-center gap-1.5 pr-2 py-0.5 rounded-xs text-left transition-colors',
          isActive ? 'bg-primary-container/40 text-primary' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
        )}
      >
        <Hash size={11} className="shrink-0 text-outline" />
        <span className="truncate text-[12px] flex-1">{node.name}</span>
        {node.count > 0 && <span className="shrink-0 text-[10px] tabular-nums text-on-surface-variant/60">{node.count}</span>}
      </button>
      {children.map((c) => <TagBranch key={c.full} node={c} depth={depth + 1} ctx={ctx} />)}
    </div>
  );
}

const FILTERS: { key: NoteFilter; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'pinned', label: 'pins' },
  { key: 'daily', label: 'daily' },
  { key: 'moc', label: 'moc' },
  { key: 'archived', label: 'archive' },
];

export function NotesNavigator({
  notes, tags, isLoading, selectedId, filter, setFilter, search, setSearch, activeTag, setActiveTag, onOpen, onNew,
  serverSearch = false, showArchive = false, onRestore,
}: NavigatorProps) {
  // Default-expanded: a folder is open unless explicitly collapsed.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [showTags, setShowTags] = useState(true);
  const [showLearnings, setShowLearnings] = useState(false);

  const visible = useMemo(() => {
    let r = notes;
    if (filter === 'pinned') r = r.filter((n) => n.pinned);
    else if (filter === 'daily') r = r.filter((n) => n.noteKind === 'daily');
    else if (filter === 'moc') r = r.filter((n) => n.noteKind === 'moc');
    if (activeTag) r = r.filter((n) => n.tags.includes(activeTag));
    const q = search.trim().toLowerCase();
    if (q && !serverSearch) {
      r = r.filter(
        (n) => n.title.toLowerCase().includes(q) || n.slug.toLowerCase().includes(q) || n.tags.some((t) => t.includes(q)),
      );
    }
    return r;
  }, [notes, filter, activeTag, search, serverSearch]);
  // Search results and the archive are a flat list, in the server's order.
  const flat = filter === 'archived' || (serverSearch && !!search.trim());

  // Automated learning notes remain searchable, but do not crowd the default view.
  // A user pin is an explicit choice and keeps that note in the ordinary list.
  const groupLearnings = filter === 'all' && !activeTag && !search.trim() && !flat;
  const learnings = useMemo(() => groupLearnings
    ? visible.filter(n => !n.pinned && isLesson(n))
    : [], [visible, groupLearnings]);
  const tree = useMemo(() => buildFolderTree(groupLearnings
    ? visible.filter(n => n.pinned || !isLesson(n))
    : visible), [visible, groupLearnings]);
  const tagTree = useMemo(() => buildTagTree(tags), [tags]);

  const showPinned = filter === 'all' && !activeTag && !search.trim();
  const pinned = useMemo(() => (showPinned ? notes.filter((n) => n.pinned) : []), [notes, showPinned]);

  function toggleFolder(path: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const rowCtx: FolderCtx = { selectedId, onOpen, collapsed: collapsedFolders, toggle: toggleFolder, onNew };
  const tagCtx: TagCtx = { activeTag, setActiveTag };

  const rootFolders = [...tree.folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const rootNotes = [...tree.notes].sort((a, b) => a.title.localeCompare(b.title));
  const tagRoots = [...tagTree.values()].sort((a, b) => Number(a.full === 'session-learning') - Number(b.full === 'session-learning')
    || b.count - a.count || a.name.localeCompare(b.name));

  return (
    <div className="h-full flex flex-col">
      {/* Search + new */}
      <div className="flex items-center gap-1.5 px-2.5 pt-2.5 shrink-0">
        <div className="flex-1 flex items-center gap-1.5 px-2 h-8 rounded-xs bg-surface-container-high border border-outline-variant/40 focus-within:border-primary/50">
          <Search size={13} className="shrink-0 text-outline" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={filter === 'archived' ? 'search the archive…' : 'search notes…'}
            aria-label="Search notes"
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px] placeholder:text-on-surface-variant/50"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="text-outline hover:text-on-surface">
              <X size={12} />
            </button>
          )}
        </div>
        {onNew && (
          <button
            type="button"
            onClick={() => onNew()}
            className="p-1.5 rounded-xs hover:bg-surface-container-high text-on-surface-variant hover:text-primary border border-outline-variant/40"
            title="New note"
          >
            <Plus size={15} />
          </button>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 px-2.5 pt-2 shrink-0">
        {FILTERS.filter((f) => showArchive || f.key !== 'archived').map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-2 py-0.5 rounded-full text-[11px] font-mono transition-colors',
              filter === f.key
                ? 'bg-primary-container text-primary'
                : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Active tag filter chip */}
      {activeTag && (
        <div className="px-2.5 pt-2 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTag(null)}
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-primary-container text-primary"
          >
            <X size={10} /> <Hash size={9} />{activeTag}
          </button>
        </div>
      )}

      {/* Scroll body: pinned + folder tree + tag tree */}
      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-2 stagger">
        {isLoading && <Loader2 className="animate-spin mx-3 my-2 text-on-surface-variant" size={15} />}

        {pinned.length > 0 && (
          <div className="mb-2">
            <div className="px-2 mb-0.5 section-label text-[10px] flex items-center gap-1">
              <Star size={10} className="text-warning" /> pinned
            </div>
            {pinned.map((n) => <NoteRowButton key={`pin-${n.id}`} note={n} depth={0} ctx={rowCtx} />)}
          </div>
        )}

        {!isLoading && visible.length === 0 && (
          <div className="py-10 text-center font-mono">
            <p aria-hidden className="text-2xl text-on-surface-variant/30">#</p>
            <p className="mt-2 text-[12px] text-on-surface-variant">
              {activeTag ? `no notes tagged #${activeTag}` : search ? 'no matches' : filter === 'archived' ? 'the archive is empty' : 'no notes yet'}
            </p>
          </div>
        )}

        {flat ? (
          visible.map((n) => (
            <div key={n.id} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <NoteRowButton note={n} depth={0} ctx={rowCtx} snippet={search.trim() ? previewLine(n.body, search) : undefined} />
              </div>
              {filter === 'archived' && onRestore && (
                <button
                  type="button"
                  onClick={() => onRestore(n)}
                  aria-label={`Restore ${n.title}`}
                  className="shrink-0 px-1.5 py-0.5 rounded-xs text-[11px] text-on-surface-variant hover:text-primary hover:bg-surface-container-high"
                >
                  <RotateCcw size={12} className="inline -mt-0.5" /> restore
                </button>
              )}
            </div>
          ))
        ) : (
          <>
            {rootFolders.map(([name, node]) => (
              <FolderBranch key={name} name={name} path={name} node={node} depth={0} ctx={rowCtx} />
            ))}
            {rootNotes.map((n) => <NoteRowButton key={n.id} note={n} depth={0} ctx={rowCtx} />)}
          </>
        )}

        {learnings.length > 0 && (
          <div className="mt-3 pt-2 border-t border-outline-variant/20">
            <button
              type="button"
              aria-expanded={showLearnings}
              onClick={() => setShowLearnings(v => !v)}
              className="w-full px-2 py-1 text-[12px] flex items-center gap-1 text-on-surface-variant hover:text-on-surface"
            >
              {showLearnings ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              Session learnings ({learnings.length})
            </button>
            {showLearnings && learnings.map(n => <NoteRowButton key={n.id} note={n} depth={1} ctx={rowCtx} />)}
          </div>
        )}

        {tagRoots.length > 0 && (
          <div className="mt-3 pt-2 border-t border-outline-variant/20">
            <button
              type="button"
              onClick={() => setShowTags((v) => !v)}
              className="w-full px-2 mb-0.5 section-label text-[10px] flex items-center gap-1 hover:text-on-surface"
            >
              {showTags ? <ChevronDown size={11} /> : <ChevronRight size={11} />} tags
            </button>
            {showTags && tagRoots.map((node) => <TagBranch key={node.full} node={node} depth={0} ctx={tagCtx} />)}
          </div>
        )}
      </div>
    </div>
  );
}
