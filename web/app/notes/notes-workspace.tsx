'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChevronLeft, ChevronRight, PanelRight, RotateCcw } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { localDay } from '@/components/todos/model';
import { useUndoToast } from '@/components/ui/undo-toast';
import { api, ApiError } from '@/lib/api';
import { useGatewayMessages } from '@/lib/gateway-context';
import { pageShortcutAllowed } from '@/lib/shortcut-guard';
import { CTX_MAX, CTX_MIN, NAV_MAX, NAV_MIN, useNotesUiStore } from '@/lib/notes-ui-store';
import { cn } from '@/lib/utils';
import { KnowledgeGraph } from './knowledge-graph';
import { MoveNoteDialog } from './move-note-dialog';
import { NoteContext } from './note-context';
import { type EditorMode, NoteEditor } from './note-editor';
import { NoteHistory } from './note-history';
import { NoteProposals } from './note-proposals';
import { noteFolders, NotesNavigator } from './notes-navigator';
import { DraftNoticeBar } from './draft-notice';
import type { NoteDetail, NoteFilter, NoteIndexEntry, NoteListResponse, NoteRow, Suggestion, TagCount } from './types';
import { hasLink, useNoteDraft } from './use-note-draft';
import { useNoteTodos } from './use-note-todos';
import { useWorkspace, useWorkspaceAccess, useWorkspaceId } from '@/lib/workspace-context';

/** Phone width: one pane at a time (the list, or the open note). */
const PHONE = '(max-width: 767px)';
const watchPhone = (notify: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};

const NO_NOTES: NoteRow[] = [];
const NO_TAGS: TagCount[] = [];

/** The navigator's search asks the server this long after the last keystroke. */
const SEARCH_DEBOUNCE_MS = 250;

/** The notes page's address: the open note (`?note=`) and the graph view. Reload, bookmarks and back/forward follow it. */
function notesHref(opts: { note?: string | null; graph?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (opts.graph) params.set('view', 'graph');
  if (opts.note) params.set('note', opts.note);
  const query = params.toString();
  return query ? `/notes?${query}` : '/notes';
}

/** Client mirror of `slugify()` in src/core/knowledge/wikilink.ts: a `[[target]]`'s slug. */
function slugOf(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9/_-]/g, '').replace(/-{2,}/g, '-').replace(/\/{2,}/g, '/').replace(/^[-/]+|[-/]+$/g, '');
}

/**
 * The notes visited on this page, for its own back and forward buttons:
 * moves along with the browser's history (every open is a push), so the
 * buttons are offered only where the history holds a note.
 */
function useNoteTrail(selectedId: string | null) {
  const [trail, setTrail] = useState<{ ids: Array<string | null>; at: number }>({ ids: [selectedId], at: 0 });
  // The next change of the address replaces the current entry (a new note got its id).
  const replacing = useRef(false);
  useEffect(() => {
    setTrail((t) => {
      if (t.ids[t.at] === selectedId) return t;
      if (replacing.current) {
        replacing.current = false;
        const ids = [...t.ids];
        ids[t.at] = selectedId;
        return { ids, at: t.at };
      }
      if (t.at > 0 && t.ids[t.at - 1] === selectedId) return { ...t, at: t.at - 1 };
      if (t.at < t.ids.length - 1 && t.ids[t.at + 1] === selectedId) return { ...t, at: t.at + 1 };
      return { ids: [...t.ids.slice(0, t.at + 1), selectedId], at: t.at + 1 };
    });
  }, [selectedId]);
  return {
    canBack: trail.at > 0,
    canForward: trail.at < trail.ids.length - 1,
    markReplace: () => { replacing.current = true; },
  };
}

export function NotesWorkspace() {
  const workspaceId = useWorkspaceId();
  // Commenters and viewers in a space (and everyone in an archived one) read.
  const { canWrite } = useWorkspaceAccess();
  // Space notes are live documents (§7.6): edited together, saved by the hub.
  const isSpace = useWorkspace().activeWorkspace?.kind === 'shared';
  const [ctxTab, setCtxTab] = useState<'links' | 'history' | 'proposals'>('links');
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { navWidth, ctxWidth, ctxCollapsed, sort, setSort, setNavWidth, setCtxWidth, toggleCtx, setCtxCollapsed } = useNotesUiStore();
  const phone = useSyncExternalStore(watchPhone, () => window.matchMedia(PHONE).matches, () => false);
  // On a phone the context panel is a full-screen sheet, closed until asked for.
  const [phoneCtxOpen, setPhoneCtxOpen] = useState(false);
  const { show: showUndo, toast: undoToast } = useUndoToast();
  const searchRef = useRef<HTMLInputElement>(null);

  // The open note and the view live in the address bar.
  const view: 'list' | 'graph' = searchParams.get('view') === 'graph' ? 'graph' : 'list';
  const selectedId = searchParams.get('note');
  // A new note being written (no id yet). On a phone it is what shows the editor.
  const [composing, setComposing] = useState(false);
  const [mode, setMode] = useState<EditorMode>('edit');
  // A failed archive, restore, move or Today (autosave failures show in the editor).
  const [actionError, setActionError] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ id: string; title: string; slug: string } | null>(null);
  const trail = useNoteTrail(selectedId);

  // Navigator filter state.
  const [filter, setFilter] = useState<NoteFilter>('all');
  const [search, setSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const invalidateAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['notes'] });
    qc.invalidateQueries({ queryKey: ['note-index'] });
    qc.invalidateQueries({ queryKey: ['note-tags'] });
    qc.invalidateQueries({ queryKey: ['graph'] });
  }, [qc]);

  const note = useNoteDraft({
    noteId: selectedId,
    isSpace,
    canWrite,
    onCreated: (id) => {
      setComposing(false);
      // The new note gets its address; Back does not return to the blank form.
      trail.markReplace();
      router.replace(notesHref({ note: id }));
    },
    onSaved: invalidateAll,
  });
  const { detail, live, liveSynced, personal, openArchived } = note;
  const openTask = useCallback((taskId: string) => router.push(`/tasks?list=all&task=${encodeURIComponent(taskId)}`), [router]);
  const todos = useNoteTodos({
    noteId: selectedId,
    draft: note,
    isSpace,
    canWrite: canWrite && !openArchived,
    onError: (message) => setActionError(message),
    onOpenTask: openTask,
    showUndo,
  });

  const list = useQuery<NoteListResponse>({ queryKey: ['notes', workspaceId, activeTag], queryFn: () => api.get<NoteListResponse>(`/notes?limit=500&preview=true${activeTag ? `&tag=${encodeURIComponent(activeTag)}` : ''}`) });
  // The archive view, and server-side search (titles, tags and bodies).
  const archivedQ = useQuery<NoteListResponse>({
    queryKey: ['notes', workspaceId, 'archived', searchQuery],
    queryFn: () => api.get<NoteListResponse>(`/notes?archived=only&limit=500${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}`),
    enabled: filter === 'archived',
  });
  const searchQ = useQuery<NoteListResponse>({
    queryKey: ['notes', workspaceId, 'search', searchQuery, activeTag],
    queryFn: () => api.get<NoteListResponse>(`/notes?limit=100&q=${encodeURIComponent(searchQuery)}${activeTag ? `&tag=${encodeURIComponent(activeTag)}` : ''}`),
    enabled: filter !== 'archived' && searchQuery !== '',
  });
  const suggestions = useQuery<{ suggestions: Suggestion[] }>({
    queryKey: ['note-suggestions', selectedId, workspaceId],
    queryFn: () => api.get<{ suggestions: Suggestion[] }>(`/notes/${selectedId}/suggestions`),
    enabled: !!selectedId,
  });
  const noteIndexQ = useQuery<{ notes: NoteIndexEntry[] }>({
    queryKey: ['note-index', workspaceId],
    queryFn: () => api.get<{ notes: NoteIndexEntry[] }>('/notes/index'),
  });
  const tagsQ = useQuery<{ tags: TagCount[] }>({
    queryKey: ['note-tags', workspaceId],
    queryFn: () => api.get<{ tags: TagCount[] }>('/notes/tags'),
  });

  // The agent's pending edit proposals for the open space note (§7.4):
  // counted on the tab, refreshed when the server says they changed.
  const proposalsQ = useQuery<{ proposals: unknown[] }>({
    queryKey: ['note-proposals', selectedId],
    queryFn: () => api.get(`/notes/proposals?noteId=${selectedId}&status=pending`),
    enabled: isSpace && !!selectedId,
  });
  const pendingProposals = proposalsQ.data?.proposals.length ?? 0;
  useGatewayMessages((message) => {
    if (message.type === 'doc.proposals' && message.noteId === selectedId) {
      qc.invalidateQueries({ queryKey: ['note-proposals', selectedId] });
    }
  });

  // The server's results are shown once they answer what is typed now: while
  // the debounce runs (or just after clearing) the local filter shows instead.
  const serverSearchCurrent = searchQuery !== '' && searchQuery === search.trim();
  const searching = filter !== 'archived' && serverSearchCurrent;
  const navNotes = (filter === 'archived' ? archivedQ.data?.notes : searching ? searchQ.data?.notes : list.data?.notes) ?? NO_NOTES;
  const navLoading = filter === 'archived' ? archivedQ.isLoading : searching ? searchQ.isLoading : list.isLoading;
  const notes = list.data?.notes ?? [];
  const noteIndex = noteIndexQ.data?.notes ?? [];
  const tags = tagsQ.data?.tags ?? NO_TAGS;

  const pin = useMutation({
    mutationFn: (vars: { id: string; pinned: boolean }) => api.patch(`/notes/${vars.id}/pin`, { pinned: vars.pinned }),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['notes'] });
      qc.invalidateQueries({ queryKey: ['note', vars.id] });
    },
  });

  // Opening another note from the address (back/forward, a typed URL) shows
  // it in the editor, never the reading view the previous one was left in.
  const shownRef = useRef(selectedId);
  useEffect(() => {
    if (shownRef.current === selectedId) return;
    shownRef.current = selectedId;
    setMode('edit');
  }, [selectedId]);

  async function selectNote(id: string) {
    if (id === selectedId && view === 'list') {
      setComposing(false);
      return;
    }
    if (!(await note.leave())) return;
    setComposing(false);
    router.push(notesHref({ note: id }));
  }

  /** A `[[link]]` clicked: the note at that slug, else one moved away from it, else one of that title. */
  function openSlug(target: string) {
    const slug = slugOf(target);
    const all: Array<{ id: string; slug: string; title: string; movedFrom?: string[] }> = [...notes, ...noteIndex];
    const found = all.find((n) => n.slug === slug)
      ?? noteIndex.find((n) => n.movedFrom?.includes(slug))
      ?? all.find((n) => n.title.toLowerCase() === target.trim().toLowerCase());
    if (found) void selectNote(found.id);
    else setActionError(`No note “${target}” yet. Create it with New, and links to it will find it.`);
  }

  async function openNew(folder?: string) {
    if (!(await note.leave())) return;
    note.startNew(folder);
    setComposing(true);
    setMode('edit');
    // From an open note, Back returns to it. (A new note saved just now by
    // `leave` put its own id in the address: that one is replaced.)
    if (selectedId || view !== 'list') router.push(notesHref());
    else router.replace(notesHref());
  }

  /** Back to the list (a phone shows one pane at a time). */
  async function backToList() {
    if (!(await note.leave())) return;
    setComposing(false);
    setPhoneCtxOpen(false);
    // The draft's id, not `selectedId`: a new note saved just now by
    // `leave` has an id, and an address this render has not seen.
    if (note.currentId()) router.push(notesHref());
    else note.clear();
  }

  /** Today's daily note, created from the template the first time (the user's own calendar day). */
  async function openToday() {
    setActionError(null);
    try {
      const { note: daily } = await api.post<{ note: NoteRow }>('/notes/daily', { date: localDay(new Date()) });
      invalidateAll();
      await selectNote(daily.id);
    } catch (err) {
      setActionError(`Could not open today’s note: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One line into today's daily note. Resolves to that note's id. */
  async function capture(text: string): Promise<string> {
    const res = await api.post<{ id: string }>('/notes/capture', { text, date: localDay(new Date()) });
    invalidateAll();
    qc.invalidateQueries({ queryKey: ['note', res.id] });
    return res.id;
  }

  async function restoreNote(id: string, title: string, open: boolean) {
    setActionError(null);
    try {
      await api.post(`/notes/${id}/restore`, {});
    } catch (err) {
      setActionError(`Could not restore “${title}”: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    invalidateAll();
    qc.invalidateQueries({ queryKey: ['note', id] });
    if (open) router.push(notesHref({ note: id }));
  }

  /** Archive the open note (its last changes saved first), with Undo. */
  async function archiveCurrent() {
    if (!selectedId) return;
    const id = selectedId;
    const title = note.draft.title || detail.data?.title || 'note';
    if (personal && !(await note.flush()) && !window.confirm('This note could not be saved. Archive it without the latest changes?')) return;
    setActionError(null);
    try {
      await api.delete(`/notes/${id}`);
    } catch (err) {
      setActionError(`Could not archive “${title}”: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    invalidateAll();
    note.clear();
    setComposing(false);
    router.replace(notesHref());
    showUndo(`Archived “${title}”`, () => void restoreNote(id, title, true));
  }

  /**
   * Move a note into `folder` ('' = the top level), keeping its name. Its
   * old slug stays an alias on the server, so links to it keep working.
   * Resolves to an error message, or null when it moved.
   */
  async function moveNote(target: { id: string; title: string; slug: string }, folder: string, name?: string): Promise<string | null> {
    const leaf = name?.trim() || target.slug.split('/').pop() || target.title;
    const slug = [folder.trim().replace(/^\/+|\/+$/g, ''), leaf].filter(Boolean).join('/');
    if (slugOf(slug) === target.slug) return null;
    // An open note's unsaved text goes first: the move must not race its save.
    if (target.id === selectedId && personal && !(await note.flush())) return 'save the note first (its last changes were not saved)';
    try {
      await api.post(`/notes/${target.id}/move`, { slug });
    } catch (err) {
      const code = err instanceof ApiError ? err.body.code : undefined;
      return code === 'exists' ? `another note is already at ${slugOf(slug)}` : err instanceof Error ? err.message : String(err);
    }
    invalidateAll();
    qc.invalidateQueries({ queryKey: ['note', target.id] });
    return null;
  }

  async function dropOnFolder(row: NoteRow, folder: string) {
    setActionError(null);
    const error = await moveNote(row, folder);
    if (error) setActionError(`Could not move “${row.title}”: ${error}`);
  }

  async function changeView(v: 'list' | 'graph') {
    if (v === view) return;
    if (v === 'graph' && !(await note.leave())) return;
    router.replace(v === 'graph' ? notesHref({ graph: true }) : notesHref({ note: selectedId }));
  }

  // The list's actions, stable across renders: the list (memoised) is not
  // drawn again on every keystroke in the note.
  const navActions = useRef({ selectNote, openNew, openToday, capture, changeView, dropOnFolder, restoreNote });
  useEffect(() => {
    navActions.current = { selectNote, openNew, openToday, capture, changeView, dropOnFolder, restoreNote };
  });
  const nav = useMemo(() => ({
    onOpen: (n: NoteRow) => void navActions.current.selectNote(n.id),
    onOpenId: (id: string) => void navActions.current.selectNote(id),
    onNew: (folder?: string) => void navActions.current.openNew(folder),
    onToday: () => void navActions.current.openToday(),
    onCapture: (text: string) => navActions.current.capture(text),
    onGraph: () => void navActions.current.changeView('graph'),
    onMoveTo: (n: NoteRow, folder: string) => void navActions.current.dropOnFolder(n, folder),
    onRestore: (n: NoteRow) => void navActions.current.restoreNote(n.id, n.title, false),
  }), []);

  // Keyboard: N a new note, / search, T today's note, Esc in the text lets
  // go of it (so these work). Never while typing in a field.
  const keysRef = useRef({ openNew, openToday, canWrite });
  useEffect(() => {
    keysRef.current = { openNew, openToday, canWrite };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pageShortcutAllowed(e)) return;
      const k = keysRef.current;
      if (e.key === 'n' && k.canWrite) { e.preventDefault(); void k.openNew(); }
      else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 't' && k.canWrite) { e.preventDefault(); void k.openToday(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pane resizing (pointer-drag). Widths persist via the store.
  function startResize(side: 'nav' | 'ctx') {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = side === 'nav' ? navWidth : ctxWidth;
      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        if (side === 'nav') setNavWidth(startW + delta);
        else setCtxWidth(startW - delta);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.body.style.cursor = 'col-resize';
    };
  }

  const detailData: NoteDetail | undefined = selectedId && detail.data?.id === selectedId ? detail.data : undefined;
  const pinned = detailData?.pinned ?? false;
  const safeNavWidth = Math.min(NAV_MAX, Math.max(NAV_MIN, navWidth));
  const safeCtxWidth = Math.min(CTX_MAX, Math.max(CTX_MIN, ctxWidth));

  // A phone shows one pane: the list, or the open (or new) note.
  const editorOpen = !!selectedId || composing;
  const showNav = !phone || !editorOpen;
  const showEditor = !phone || editorOpen;
  const ctxVisible = phone ? phoneCtxOpen && editorOpen : !ctxCollapsed;
  const closeCtx = phone ? () => setPhoneCtxOpen(false) : toggleCtx;
  const actionAlert = note.saveDetails.error?.message || pin.error?.message || actionError;
  const readOnly = !canWrite || openArchived;

  const contextPanel = (
    <>
      {isSpace && selectedId && (
        <div role="tablist" className="flex shrink-0 border-b border-outline-variant/40 text-[12px]">
          {(['links', 'history', 'proposals'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={ctxTab === tab}
              onClick={() => setCtxTab(tab)}
              className={cn('flex-1 px-2 py-2', ctxTab === tab ? 'text-primary border-b-2 border-primary font-semibold' : 'text-on-surface-variant hover:bg-surface-container-high')}
            >
              {tab === 'proposals' && pendingProposals > 0 ? (
                <span data-testid="proposals-tab-count">proposals · {pendingProposals}</span>
              ) : tab}
            </button>
          ))}
        </div>
      )}
      {isSpace && selectedId && ctxTab === 'history' && (
        <div className="flex-1 min-h-0 overflow-y-auto p-3"><NoteHistory noteId={selectedId} canWrite={canWrite} /></div>
      )}
      {isSpace && selectedId && ctxTab === 'proposals' && (
        <div className="flex-1 min-h-0 overflow-y-auto p-3"><NoteProposals noteId={selectedId} canWrite={canWrite} /></div>
      )}
      {(!isSpace || !selectedId || ctxTab === 'links') && (
        <div className="flex-1 min-h-0">
          <NoteContext
            detail={detailData}
            suggestions={suggestions.data?.suggestions ?? []}
            suggestionsLoading={suggestions.isLoading}
            bodyHasLink={(title) => hasLink(note.draft.body, title)}
            onOpenNote={(id) => { setPhoneCtxOpen(false); void selectNote(id); }}
            onAddLink={canWrite && !openArchived ? note.addLink : undefined}
            onTagClick={(t) => { setActiveTag(t); setFilter('all'); }}
            onCollapse={closeCtx}
            onOpenTask={openTask}
            onSetTaskDone={canWrite && !openArchived ? (t, done) => void todos.setDone(t, done) : undefined}
          />
        </div>
      )}
    </>
  );

  const leading = (
    <>
      {phone && (
        <button type="button" onClick={() => void backToList()} className="notes-text-btn">
          <ArrowLeft size={16} /> Notes
        </button>
      )}
      {!phone && (
        <>
          <button type="button" className="notes-icon-btn" disabled={!trail.canBack} onClick={() => router.back()} title="Back (Alt+←)" aria-label="Back">
            <ChevronLeft size={18} />
          </button>
          <button type="button" className="notes-icon-btn" disabled={!trail.canForward} onClick={() => router.forward()} title="Forward (Alt+→)" aria-label="Forward">
            <ChevronRight size={18} />
          </button>
        </>
      )}
    </>
  );
  const ctxClosed = phone ? !phoneCtxOpen : ctxCollapsed;
  const trailing = ctxClosed ? (
    <button
      type="button"
      onClick={() => (phone ? setPhoneCtxOpen(true) : setCtxCollapsed(false))}
      title="Show context panel"
      aria-label="Links and related notes"
      className="notes-icon-btn"
    >
      <PanelRight size={17} />
    </button>
  ) : null;

  const notices = (
    <>
      {openArchived && (
        <div data-testid="archived-note-banner" className="notes-notice">
          This note is archived.
          {canWrite && selectedId && (
            <button type="button" onClick={() => void restoreNote(selectedId, note.draft.title, false)} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
              <RotateCcw size={13} /> Restore
            </button>
          )}
        </div>
      )}
      {note.draftNotice && <DraftNoticeBar note={note} />}
    </>
  );

  return (
    <div className="notes-page">
      {actionAlert && (
        <div role="alert" className="notes-alert">
          {actionAlert}
          <button type="button" className="ml-3 underline" onClick={() => { note.saveDetails.reset(); pin.reset(); setActionError(null); }}>Dismiss</button>
        </div>
      )}

      {view === 'graph' ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="notes-bar">
            <button type="button" className="notes-text-btn" onClick={() => void changeView('list')}>
              <ArrowLeft size={16} /> Notes
            </button>
            <span className="text-[13px] font-semibold text-on-surface">Graph</span>
          </div>
          <div className="flex-1 min-h-0 p-4">
            <KnowledgeGraph onOpenNote={(id) => void selectNote(id)} />
          </div>
        </div>
      ) : (
        <div className="relative flex-1 min-h-0 flex">
          {showNav && (
            <aside style={phone ? undefined : { width: safeNavWidth }} className={cn('notes-nav', phone && 'is-phone')}>
              <NotesNavigator
                notes={navNotes}
                tags={tags}
                isLoading={navLoading}
                selectedId={selectedId}
                filter={filter}
                setFilter={setFilter}
                sort={sort}
                setSort={setSort}
                search={search}
                setSearch={setSearch}
                activeTag={activeTag}
                setActiveTag={setActiveTag}
                onOpen={nav.onOpen}
                onOpenId={nav.onOpenId}
                onNew={canWrite ? nav.onNew : undefined}
                onToday={canWrite ? nav.onToday : undefined}
                onCapture={canWrite ? nav.onCapture : undefined}
                onGraph={nav.onGraph}
                onMoveTo={canWrite ? nav.onMoveTo : undefined}
                serverSearch={filter === 'archived' ? serverSearchCurrent : searching}
                showArchive
                onRestore={canWrite ? nav.onRestore : undefined}
                searchRef={searchRef}
              />
            </aside>
          )}
          {showNav && showEditor && <div onPointerDown={startResize('nav')} className="notes-resizer" role="separator" aria-orientation="vertical" />}

          {showEditor && (
            <main className="notes-main">
              {editorOpen ? (
                <NoteEditor
                  selectedId={selectedId}
                  draftTitle={note.draft.title}
                  setDraftTitle={note.setTitle}
                  titleAuto={note.titleAuto}
                  draftBody={note.draft.body}
                  setDraftBody={note.setBody}
                  draftTags={note.draft.tags}
                  setDraftTags={note.setTags}
                  draftKind={note.draft.kind}
                  setDraftKind={note.setKind}
                  draftFolder={note.draft.folder}
                  setDraftFolder={note.setFolder}
                  slug={detailData?.slug}
                  noteDate={detailData?.noteDate}
                  updatedAt={detailData?.updatedAt}
                  pinned={pinned}
                  onTogglePin={() => selectedId && pin.mutate({ id: selectedId, pinned: !pinned })}
                  mode={mode}
                  setMode={setMode}
                  dirty={note.dirty}
                  saving={note.saveDetails.isPending}
                  onSave={note.saveNow}
                  onArchive={() => void archiveCurrent()}
                  onMove={selectedId && detailData ? () => setMoving({ id: detailData.id, title: detailData.title, slug: detailData.slug }) : undefined}
                  noteIndex={noteIndex}
                  tags={tags}
                  onOpenSlug={openSlug}
                  onTagClick={(t) => { setActiveTag(t); setFilter('all'); }}
                  // A space note's boxes tick once its live session has synced (they would not be saved before).
                  onToggleTask={readOnly || !note.canEditBody ? undefined : note.toggleTask}
                  readOnly={readOnly}
                  live={live}
                  liveLoading={isSpace && !!selectedId && !liveSynced}
                  autosave={note.autosave}
                  onTitleEditing={note.setTitleEditing}
                  autoFocus={composing && !selectedId}
                  onEscape={() => undefined}
                  leading={leading}
                  trailing={trailing}
                  notices={notices}
                  todos={todos}
                />
              ) : (
                <div className="notes-blank">
                  <div className="notes-bar">{leading}<div className="flex-1" />{trailing}</div>
                  <div className="notes-blank-inner">
                    <p className="notes-blank-title">A clean page.</p>
                    <p>Pick a note on the left{canWrite ? ', or start one' : ''}.</p>
                    {canWrite && (
                      <div className="flex flex-wrap justify-center gap-2 mt-4">
                        <button type="button" className="notes-text-btn is-primary" onClick={() => void openNew()}>New note <kbd className="notes-kbd">N</kbd></button>
                        <button type="button" className="notes-text-btn" onClick={() => void openToday()}>Today’s note <kbd className="notes-kbd">T</kbd></button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </main>
          )}

          {ctxVisible && (
            phone ? (
              <aside data-testid="note-context-sheet" className="absolute inset-0 z-20 flex flex-col bg-background">
                {contextPanel}
              </aside>
            ) : (
              <>
                <div onPointerDown={startResize('ctx')} className="notes-resizer" role="separator" aria-orientation="vertical" />
                <aside style={{ width: safeCtxWidth }} className="notes-ctx">
                  {contextPanel}
                </aside>
              </>
            )
          )}
        </div>
      )}
      {moving && (
        <MoveNoteDialog
          note={moving}
          folders={noteFolders(noteIndex)}
          onClose={() => setMoving(null)}
          onMove={async (folder, name) => {
            const error = await moveNote(moving, folder, name);
            if (!error) setMoving(null);
            return error;
          }}
        />
      )}
      {undoToast}
    </div>
  );
}
