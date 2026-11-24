'use client';

import {
  ArrowDownAZ, CalendarDays, ChevronDown, ChevronRight, Clock, Folder, FolderOpen, FolderTree, Hash, Loader2, Network, Plus, RotateCcw, Search, Send, Star, X,
} from 'lucide-react';
import { type DragEvent, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { bodyPreview } from '../../../src/shared/note-text';
import type { NoteFilter, NoteRow, NoteSort, TagCount } from './types';

interface NavigatorProps {
  notes: NoteRow[];
  tags: TagCount[];
  isLoading: boolean;
  selectedId: string | null;
  filter: NoteFilter;
  setFilter: (f: NoteFilter) => void;
  /** How the list is laid out: most recently edited first (default), by title, or as the folder tree. */
  sort?: NoteSort;
  setSort?: (s: NoteSort) => void;
  search: string;
  setSearch: (s: string) => void;
  activeTag: string | null;
  setActiveTag: (t: string | null) => void;
  onOpen: (n: NoteRow) => void;
  /** Absent for a role that cannot create notes. */
  onNew?: (folder?: string) => void;
  /** Open (or create) today's daily note. */
  onToday?: () => void;
  /** The one-line capture box: the text goes into today's daily note. Resolves to the daily note's id. */
  onCapture?: (text: string) => Promise<string>;
  /** Open a note by id (the daily note a capture went into). */
  onOpenId?: (id: string) => void;
  /** Open the graph of every note. */
  onGraph?: () => void;
  /** A note dragged onto a folder ('' = the top level): move it there. */
  onMoveTo?: (note: NoteRow, folder: string) => void;
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
  /** Where the search box is, so the page's `/` shortcut can focus it. */
  searchRef?: React.Ref<HTMLInputElement>;
}

/** The drag payload of a note row. */
const DRAG_TYPE = 'application/x-octipus-note';

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

/** Every folder the notes are filed in (`projects`, `projects/octipus`, …), for "Move to…". */
export function noteFolders(notes: Array<{ slug: string }>): string[] {
  const out = new Set<string>();
  for (const n of notes) {
    const segs = n.slug.split('/').filter(Boolean);
    for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join('/'));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
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

/** The tag a learning review puts on the notes it writes. */
const LESSON_TAG = 'session-learning';

/** A note a learning review wrote: its kind, or the tag such notes carried before they had one. */
export function isLesson(n: NoteRow): boolean {
  return n.noteKind === 'lesson' || n.tags.includes(LESSON_TAG);
}

/** How often a learning review saw a lesson, when more than once. */
function sightings(n: NoteRow): number | null {
  const seen = n.frontmatter?.sightings;
  return typeof seen === 'number' && Number.isFinite(seen) && seen > 1 ? Math.floor(seen) : null;
}

/** When a row says it was edited: a time today, a weekday this week, else a date. */
function rowTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const now = new Date();
  if (then.toDateString() === now.toDateString()) return then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = (now.getTime() - then.getTime()) / 86_400_000;
  if (days < 6) return then.toLocaleDateString([], { weekday: 'short' });
  return then.toLocaleDateString([], { day: 'numeric', month: 'short', year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** A daily note's day for its row ("Mon 23 Nov"), from its date or slug. */
function dailyLabel(n: NoteRow): string {
  const date = n.noteDate ?? n.slug.split('/').pop() ?? '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return n.title;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

/** A daily note's day, for newest-first ordering ('' for other notes). */
const dayOf = (n: NoteRow) => (n.noteKind === 'daily' ? n.noteDate ?? n.slug.split('/').pop() ?? '' : '');

/** Recent list sections, by when the note was last edited. */
function recentGroup(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = then.getTime();
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - 86_400_000) return 'Yesterday';
  if (t >= startOfToday - 6 * 86_400_000) return 'Previous 7 days';
  return 'Earlier';
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

// --- module-scope sub-components --------------------------------------------
// (Stable identities so the tree doesn't remount on every navigator keystroke.)

interface RowCtx {
  selectedId: string | null;
  onOpen: (n: NoteRow) => void;
  /** Rows can be dragged onto folders. */
  draggable: boolean;
}
interface FolderCtx extends RowCtx {
  collapsed: Set<string>;
  toggle: (path: string) => void;
  onNew?: (folder?: string) => void;
  dropTarget: string | null;
  setDropTarget: (path: string | null) => void;
  onDropNote: (e: DragEvent, folder: string) => void;
}
interface TagCtx {
  activeTag: string | null;
  setActiveTag: (t: string | null) => void;
}

function NoteRowButton({ note, depth = 0, ctx, snippet, compact = false }: { note: NoteRow; depth?: number; ctx: RowCtx; snippet?: string; compact?: boolean }) {
  const active = note.id === ctx.selectedId;
  const daily = note.noteKind === 'daily';
  const label = daily ? dailyLabel(note) : note.title || 'Untitled';
  const seen = isLesson(note) ? sightings(note) : null;
  const preview = snippet ?? (compact ? '' : bodyPreview(note.body, note.title));
  return (
    <button
      type="button"
      onClick={() => ctx.onOpen(note)}
      title={note.slug}
      aria-current={active ? 'true' : undefined}
      draggable={ctx.draggable}
      onDragStart={ctx.draggable ? (e) => { e.dataTransfer.setData(DRAG_TYPE, note.id); e.dataTransfer.effectAllowed = 'move'; } : undefined}
      style={depth ? { paddingLeft: 12 + depth * 14 } : undefined}
      className={cn('notes-row', compact && 'is-compact')}
    >
      <span className="notes-row-main">
        <span className="notes-row-title">
          {daily && <CalendarDays size={13} className="notes-row-icon" />}
          <span className="truncate">{label}</span>
          {seen !== null && <span className="notes-row-count" title={`seen in ${seen} learning reviews`}>{` ×${seen}`}</span>}
        </span>
        {preview && <span data-testid={snippet ? 'note-snippet' : 'note-preview'} className="notes-row-preview">{preview}</span>}
      </span>
      <span className="notes-row-side">
        {note.pinned && <Star size={11} className="text-accent fill-current" aria-label="pinned" />}
        <span className="notes-row-time">{rowTime(note.archivedAt ?? note.updatedAt)}</span>
      </span>
    </button>
  );
}

function FolderBranch({ name, path, node, depth, ctx }: { name: string; path: string; node: FolderNode; depth: number; ctx: FolderCtx }) {
  const open = !ctx.collapsed.has(path);
  const childFolders = [...node.folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  // Daily notes newest first; everything else by title.
  const childNotes = [...node.notes].sort((a, b) => dayOf(b).localeCompare(dayOf(a)) || a.title.localeCompare(b.title));
  return (
    <div>
      <div
        className={cn('notes-folder group/fld', ctx.dropTarget === path && 'is-drop')}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => ctx.toggle(path)}
        onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); ctx.setDropTarget(path); } }}
        onDragLeave={() => ctx.setDropTarget(null)}
        onDrop={(e) => ctx.onDropNote(e, path)}
        data-folder={path}
      >
        {open ? <ChevronDown size={13} className="shrink-0 text-outline" /> : <ChevronRight size={13} className="shrink-0 text-outline" />}
        {open ? <FolderOpen size={14} className="shrink-0 text-primary" /> : <Folder size={14} className="shrink-0 text-primary" />}
        <span className="truncate flex-1">{name}</span>
        <span className="notes-row-time">{node.notes.length || ''}</span>
        {ctx.onNew && (
          <button
            type="button"
            title={`New note in ${path}`}
            onClick={(e) => { e.stopPropagation(); ctx.onNew?.(path); }}
            className="opacity-0 group-hover/fld:opacity-100 focus:opacity-100 p-0.5 rounded hover:bg-surface-container-highest text-on-surface-variant"
          >
            <Plus size={13} />
          </button>
        )}
      </div>
      {open && (
        <div>
          {childFolders.map(([childName, childNode]) => (
            <FolderBranch key={childName} name={childName} path={`${path}/${childName}`} node={childNode} depth={depth + 1} ctx={ctx} />
          ))}
          {childNotes.map((n) => <NoteRowButton key={n.id} note={n} depth={depth + 1} ctx={ctx} compact />)}
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
        style={{ paddingLeft: 10 + depth * 12 }}
        aria-pressed={isActive}
        className="notes-tag-row"
      >
        <Hash size={11} className="shrink-0 text-outline" />
        <span className="truncate flex-1">{node.name}</span>
        {node.count > 0 && <span className="notes-row-time">{node.count}</span>}
      </button>
      {children.map((c) => <TagBranch key={c.full} node={c} depth={depth + 1} ctx={ctx} />)}
    </div>
  );
}

const SORTS: { key: NoteSort; label: string; icon: React.ReactNode }[] = [
  { key: 'recent', label: 'Recent', icon: <Clock size={13} /> },
  { key: 'title', label: 'A–Z', icon: <ArrowDownAZ size={13} /> },
  { key: 'folders', label: 'Folders', icon: <FolderTree size={13} /> },
];

/** The one-line capture box: a thought goes into today's daily note without opening it. */
function QuickCapture({ onCapture, onOpenDaily }: { onCapture: (text: string) => Promise<string>; onOpenDaily: (id: string) => void }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'saving' } | { kind: 'done'; id: string } | { kind: 'error'; error: string }>({ kind: 'idle' });
  async function submit() {
    const line = text.trim();
    if (!line || state.kind === 'saving') return;
    setState({ kind: 'saving' });
    try {
      const id = await onCapture(line);
      setText('');
      setState({ kind: 'done', id });
    } catch (err) {
      // The text stays in the box to try again.
      setState({ kind: 'error', error: err instanceof Error ? err.message : 'Could not add it' });
    }
  }
  return (
    <div className="notes-capture-wrap">
      <form className="notes-capture" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); if (state.kind !== 'saving') setState({ kind: 'idle' }); }}
          placeholder="Jot something down…"
          aria-label="Quick note for today"
          maxLength={2000}
        />
        <button type="submit" aria-label="Add to today's note" title="Add to today's note (Enter)" disabled={!text.trim() || state.kind === 'saving'}>
          {state.kind === 'saving' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </form>
      {state.kind === 'done' && (
        <p role="status" className="notes-capture-note">
          Added to today’s note. <button type="button" onClick={() => onOpenDaily(state.id)}>Open it</button>
        </p>
      )}
      {state.kind === 'error' && <p role="alert" className="notes-capture-note is-error">Not added: {state.error}</p>}
    </div>
  );
}

export function NotesNavigator({
  notes, tags, isLoading, selectedId, filter, setFilter, sort = 'recent', setSort, search, setSearch, activeTag, setActiveTag, onOpen, onNew,
  onToday, onCapture, onOpenId, onGraph, onMoveTo, serverSearch = false, showArchive = false, onRestore, searchRef,
}: NavigatorProps) {
  // Default-expanded: a folder is open unless explicitly collapsed.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [showTags, setShowTags] = useState(true);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const q = search.trim().toLowerCase();
  // Search results and the archive are a flat list, in the server's order.
  const flat = filter === 'archived' || (serverSearch && !!q);
  // Automated learnings stay searchable, but have their own filter: they do
  // not crowd the user's own notes. A user pin is an explicit choice and
  // keeps that note in the ordinary list.
  const learningsCount = useMemo(() => notes.filter((n) => isLesson(n) && !n.pinned).length, [notes]);
  const visible = useMemo(() => {
    let r = notes;
    if (filter === 'pinned') r = r.filter((n) => n.pinned);
    else if (filter === 'daily') r = r.filter((n) => n.noteKind === 'daily');
    else if (filter === 'moc') r = r.filter((n) => n.noteKind === 'moc');
    else if (filter === 'learnings') r = r.filter((n) => isLesson(n));
    if (filter !== 'learnings' && filter !== 'archived' && !(serverSearch && q)) r = r.filter((n) => n.pinned || !isLesson(n));
    if (activeTag) r = r.filter((n) => n.tags.includes(activeTag));
    if (q && !serverSearch) {
      r = r.filter(
        (n) => n.title.toLowerCase().includes(q) || n.slug.toLowerCase().includes(q) || n.tags.some((t) => t.includes(q)),
      );
    }
    return r;
  }, [notes, filter, activeTag, q, serverSearch]);

  const ordered = useMemo(() => {
    if (flat) return visible;
    const rows = [...visible];
    // Daily notes, newest day first.
    if (filter === 'daily' && sort !== 'title') return rows.sort((a, b) => dayOf(b).localeCompare(dayOf(a)) || b.updatedAt.localeCompare(a.updatedAt));
    if (sort === 'title') return rows.sort((a, b) => a.title.localeCompare(b.title));
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [visible, flat, filter, sort]);

  const tree = useMemo(() => buildFolderTree(visible), [visible]);
  // The learnings' tag is theirs: shown only with their filter on.
  const tagTree = useMemo(() => buildTagTree(filter === 'learnings' ? tags : tags.filter((t) => t.tag !== LESSON_TAG && !t.tag.startsWith(`${LESSON_TAG}/`))), [tags, filter]);

  function toggleFolder(path: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function onDropNote(e: DragEvent, folder: string) {
    setDropTarget(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    const note = notes.find((n) => n.id === id);
    if (!note || !onMoveTo) return;
    e.preventDefault();
    e.stopPropagation();
    onMoveTo(note, folder);
  }

  const asTree = !flat && sort === 'folders';
  const rowCtx: FolderCtx = {
    selectedId, onOpen, collapsed: collapsedFolders, toggle: toggleFolder, onNew,
    draggable: !!onMoveTo && asTree, dropTarget, setDropTarget, onDropNote,
  };
  const tagCtx: TagCtx = { activeTag, setActiveTag };

  const rootFolders = [...tree.folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const rootNotes = [...tree.notes].sort((a, b) => a.title.localeCompare(b.title));
  const tagRoots = [...tagTree.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // The recent list in sections (pinned first), when it is the plain list of everything.
  const sectioned = !flat && sort === 'recent' && filter === 'all' && !activeTag && !q;
  const sections = useMemo(() => {
    if (!sectioned) return [];
    const out: Array<{ label: string; rows: NoteRow[] }> = [];
    const pinned = ordered.filter((n) => n.pinned);
    if (pinned.length) out.push({ label: 'Pinned', rows: pinned });
    for (const n of ordered) {
      if (n.pinned) continue;
      const label = recentGroup(n.updatedAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(n);
      else out.push({ label, rows: [n] });
    }
    return out;
  }, [ordered, sectioned]);

  const filters: { key: NoteFilter; label: string; count?: number }[] = [
    { key: 'all', label: 'All' },
    { key: 'pinned', label: 'Pinned' },
    { key: 'daily', label: 'Daily' },
    // Maps of content only where there are any.
    ...(notes.some((n) => n.noteKind === 'moc') || filter === 'moc' ? [{ key: 'moc' as const, label: 'Maps' }] : []),
    ...(learningsCount > 0 || filter === 'learnings' ? [{ key: 'learnings' as const, label: 'Learnings', count: learningsCount }] : []),
    ...(showArchive ? [{ key: 'archived' as const, label: 'Archive' }] : []),
  ];

  return (
    <div className="notes-nav-inner">
      <div className="notes-nav-head">
        <h1>Notes</h1>
        <div className="flex items-center gap-0.5">
          {onGraph && (
            <button type="button" onClick={onGraph} className="notes-icon-btn" title="Graph of all notes" aria-label="Graph view">
              <Network size={17} />
            </button>
          )}
          {onToday && (
            <button type="button" onClick={onToday} className="notes-text-btn" title="Today’s daily note (T)">
              <CalendarDays size={15} /> Today
            </button>
          )}
          {onNew && (
            <button type="button" onClick={() => onNew()} className="notes-text-btn is-primary" title="New note" aria-label="New note">
              <Plus size={15} /> New
            </button>
          )}
        </div>
      </div>

      {onCapture && onOpenId && <QuickCapture onCapture={onCapture} onOpenDaily={onOpenId} />}

      <div className="notes-search">
        <Search size={14} className="shrink-0 text-outline" />
        <input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={filter === 'archived' ? 'Search the archive' : 'Search notes'}
          aria-label="Search notes"
          onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); e.currentTarget.blur(); } }}
        />
        {search ? (
          <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="text-outline hover:text-on-surface">
            <X size={13} />
          </button>
        ) : <kbd className="notes-kbd" aria-hidden>/</kbd>}
      </div>

      <div className="notes-filters" role="tablist" aria-label="Show">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
            className="notes-chip"
          >
            {f.label}{f.count !== undefined && <span className="notes-chip-count">{f.count}</span>}
          </button>
        ))}
      </div>

      {setSort && !flat && (
        <div className="notes-sort" role="group" aria-label="Sort">
          {SORTS.map((s) => (
            <button key={s.key} type="button" aria-pressed={sort === s.key} onClick={() => setSort(s.key)}>
              {s.icon} {s.label}
            </button>
          ))}
        </div>
      )}

      {/* Active tag filter chip */}
      {activeTag && (
        <div className="px-3 pb-1 shrink-0">
          <button type="button" onClick={() => setActiveTag(null)} className="notes-tag-chip is-active">
            <X size={10} /> #{activeTag}
          </button>
        </div>
      )}

      <div
        className={cn('notes-list', asTree && dropTarget === '' && 'is-drop')}
        onDragOver={asTree && onMoveTo ? (e) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); setDropTarget(''); } } : undefined}
        onDrop={asTree && onMoveTo ? (e) => onDropNote(e, '') : undefined}
      >
        {isLoading && <Loader2 className="animate-spin mx-3 my-2 text-on-surface-variant" size={15} />}

        {!isLoading && visible.length === 0 && (
          <div className="notes-empty">
            <p>
              {activeTag ? `No notes tagged #${activeTag}` : q ? 'No matches' : filter === 'archived' ? 'The archive is empty' : filter === 'learnings' ? 'No session learnings' : 'No notes yet'}
            </p>
            {!q && filter === 'all' && !activeTag && onNew && <p className="text-[12px]">Press <kbd className="notes-kbd">N</kbd> for a new note, or jot something above.</p>}
          </div>
        )}

        {flat ? (
          ordered.map((n) => (
            <div key={n.id} className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <NoteRowButton note={n} ctx={rowCtx} snippet={q ? previewLine(n.body, search) : undefined} />
              </div>
              {filter === 'archived' && onRestore && (
                <button type="button" onClick={() => onRestore(n)} aria-label={`Restore ${n.title}`} className="notes-text-btn shrink-0">
                  <RotateCcw size={13} /> Restore
                </button>
              )}
            </div>
          ))
        ) : asTree ? (
          <>
            {rootFolders.map(([name, node]) => (
              <FolderBranch key={name} name={name} path={name} node={node} depth={0} ctx={rowCtx} />
            ))}
            {rootNotes.map((n) => <NoteRowButton key={n.id} note={n} ctx={rowCtx} compact />)}
          </>
        ) : sectioned ? (
          sections.map((s) => (
            <section key={s.label} aria-label={s.label}>
              <h2 className="notes-group-title">{s.label === 'Pinned' && <Star size={11} />} {s.label}</h2>
              {s.rows.map((n) => <NoteRowButton key={n.id} note={n} ctx={rowCtx} />)}
            </section>
          ))
        ) : (
          ordered.map((n) => <NoteRowButton key={n.id} note={n} ctx={rowCtx} />)
        )}

        {tagRoots.length > 0 && !flat && (
          <div className="notes-tags">
            <button type="button" aria-expanded={showTags} onClick={() => setShowTags((v) => !v)} className="notes-group-title is-toggle">
              {showTags ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Tags
            </button>
            {showTags && tagRoots.map((node) => <TagBranch key={node.full} node={node} depth={0} ctx={tagCtx} />)}
          </div>
        )}
      </div>
    </div>
  );
}
