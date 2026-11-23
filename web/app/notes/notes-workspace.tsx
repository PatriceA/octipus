'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Network, PanelRight, RotateCcw, ScrollText } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useUndoToast } from '@/components/ui/undo-toast';
import { api, ApiError } from '@/lib/api';
import { useGatewayMessages } from '@/lib/gateway-context';
import { draftDiffers, type NoteDraftBackup, noteDraftKey, readNoteDraft, removeNoteDraft, writeNoteDraft } from '@/lib/note-drafts';
import { CTX_MAX, CTX_MIN, NAV_MAX, NAV_MIN, useNotesUiStore } from '@/lib/notes-ui-store';
import { cn } from '@/lib/utils';
import { KnowledgeGraph } from './knowledge-graph';
import { NoteContext } from './note-context';
import { type AutosaveStatus, type EditorMode, NoteEditor } from './note-editor';
import { NoteHistory } from './note-history';
import { NoteProposals } from './note-proposals';
import { useLiveNote } from './use-live-note';
import { NotesNavigator } from './notes-navigator';
import type {
  NoteDetail, NoteFilter, NoteIndexEntry, NoteListResponse, NoteRow, Suggestion, TagCount,
} from './types';
import { useWorkspace, useWorkspaceAccess, useWorkspaceId } from '@/lib/workspace-context';

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((t, i) => t === sb[i]);
}

/** Whether the body already wikilinks `title` (incl. the `[[Title|Alias]]` form). */
function hasLink(body: string, title: string): boolean {
  return body.includes(`[[${title}]]`) || body.includes(`[[${title}|`);
}

/** Phone width: one pane at a time (the list, or the open note). */
const PHONE = '(max-width: 767px)';
const watchPhone = (notify: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};

/** A personal note saves this long after the last change. */
const AUTOSAVE_MS = 800;
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

/**
 * The note a draft belongs to: an existing note's id, or null for a new one
 * until its first save fills it in. One object per opened note, so a save
 * that finishes after the user moved on knows it is no longer the open one.
 */
interface DraftTarget { id: string | null }

interface DraftFields { title: string; body: string; tags: string[]; kind: string; folder: string }
interface DraftSnapshot extends DraftFields { target: DraftTarget }
interface SavedFields { title: string; body: string; tags: string[]; kind: string; updatedAt?: string }

type SaveState = { status: 'idle' | 'saving' | 'saved' } | { status: 'error'; error: string };

/** What the open note's draft offers back from this device (see lib/note-drafts.ts). */
type DraftNotice =
  | { kind: 'restored'; at: number }
  | { kind: 'conflict'; backup: NoteDraftBackup };

function differs(draft: DraftFields, saved: SavedFields): boolean {
  return draft.title !== saved.title || draft.body !== saved.body || draft.kind !== saved.kind || !sameTags(draft.tags, saved.tags);
}

export function NotesWorkspace() {
  const workspaceId = useWorkspaceId();
  // Commenters and viewers in a space (and everyone in an archived one) read.
  const { canWrite } = useWorkspaceAccess();
  // Space notes are live documents (§7.6): edited together, saved by the hub.
  const isSpace = useWorkspace().activeWorkspace?.kind === 'shared';
  // A personal note saves itself a moment after each change (autosave); a
  // space note's text is saved by the hub and its details by "Save details".
  const personal = !isSpace;
  const [ctxTab, setCtxTab] = useState<'links' | 'history' | 'proposals'>('links');
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { navWidth, ctxWidth, ctxCollapsed, setNavWidth, setCtxWidth, toggleCtx, setCtxCollapsed } = useNotesUiStore();
  const phone = useSyncExternalStore(watchPhone, () => window.matchMedia(PHONE).matches, () => false);
  // On a phone the context panel is a full-screen sheet, closed until asked for.
  const [phoneCtxOpen, setPhoneCtxOpen] = useState(false);
  const { show: showUndo, toast: undoToast } = useUndoToast();

  // The open note and the view live in the address bar.
  const view: 'list' | 'graph' = searchParams.get('view') === 'graph' ? 'graph' : 'list';
  const selectedId = searchParams.get('note');
  // A new note being written (no id yet). On a phone it is what shows the editor.
  const [composing, setComposing] = useState(false);
  const [mode, setMode] = useState<EditorMode>('preview');

  // Draft + last-saved baseline (drives the dirty check).
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftKind, setDraftKind] = useState('note');
  const [draftFolder, setDraftFolder] = useState('');
  const [savedTitle, setSavedTitle] = useState('');
  const [savedBody, setSavedBody] = useState('');
  const [savedTags, setSavedTags] = useState<string[]>([]);
  const [savedKind, setSavedKind] = useState('note');
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const [draftNotice, setDraftNotice] = useState<DraftNotice | null>(null);
  // A failed archive or restore (autosave failures show in the editor).
  const [actionError, setActionError] = useState<string | null>(null);

  // Navigator filter state.
  const [filter, setFilter] = useState<NoteFilter>('all');
  const [search, setSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // The id whose body we've loaded into the draft — so a background refetch of
  // the SAME note doesn't clobber in-progress edits.
  const loadedRef = useRef<string | null>(null);
  const targetRef = useRef<DraftTarget>({ id: selectedId });
  // The latest draft and baseline, for saves started outside a render (the
  // debounce timer, leaving the note, closing the tab).
  const draftRef = useRef<DraftFields>({ title: '', body: '', tags: [], kind: 'note', folder: '' });
  const savedRef = useRef<SavedFields>({ title: '', body: '', tags: [], kind: 'note' });
  // Saves run one after another: a new note is created once, then updated.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const list = useQuery<NoteListResponse>({ queryKey: ['notes', workspaceId, activeTag], queryFn: () => api.get<NoteListResponse>(`/notes?limit=500${activeTag ? `&tag=${encodeURIComponent(activeTag)}` : ''}`) });
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
  const detail = useQuery<NoteDetail>({
    queryKey: ['note', selectedId, workspaceId],
    queryFn: () => api.get<NoteDetail>(`/notes/${selectedId}`),
    enabled: !!selectedId,
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

  const live = useLiveNote(selectedId, isSpace);
  const liveSession = live?.session ?? null;
  const liveVersion = live?.version ?? 0;
  const liveSynced = live?.synced ?? false;
  // The live text drives the preview and is never "unsaved" here: the hub
  // saves it. Draft and baseline both follow it.
  useEffect(() => {
    if (!liveSession || !liveSynced) return;
    const text = liveSession.text;
    const sync = () => {
      const body = text.toString();
      setDraftBody(body);
      setSavedBody(body);
      savedRef.current = { ...savedRef.current, body };
    };
    sync();
    text.observe(sync);
    return () => text.unobserve(sync);
  }, [liveSession, liveVersion, liveSynced]);

  const searching = filter !== 'archived' && searchQuery !== '';
  const navNotes = filter === 'archived' ? archivedQ.data?.notes ?? [] : searching ? searchQ.data?.notes ?? [] : list.data?.notes ?? [];
  const navLoading = filter === 'archived' ? archivedQ.isLoading : searching ? searchQ.isLoading : list.isLoading;
  const notes = list.data?.notes ?? [];
  const noteIndex = noteIndexQ.data?.notes ?? [];
  const tags = tagsQ.data?.tags ?? [];
  // An archived note opened from the archive reads only, until restored.
  const openArchived = !!selectedId && detail.data?.id === selectedId && !!detail.data.archivedAt;

  const dirty =
    draftTitle !== savedTitle || draftBody !== savedBody || draftKind !== savedKind || !sameTags(draftTags, savedTags);

  // Keep the refs on the latest render. Declared before the effects that read them.
  useEffect(() => {
    draftRef.current = { title: draftTitle, body: draftBody, tags: draftTags, kind: draftKind, folder: draftFolder };
  });

  const invalidateAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['notes'] });
    qc.invalidateQueries({ queryKey: ['note-index'] });
    qc.invalidateQueries({ queryKey: ['note-tags'] });
    qc.invalidateQueries({ queryKey: ['graph'] });
  }, [qc]);

  /**
   * Save a draft of a personal note. Runs after any save still in flight, so
   * a new note is created once; skipped when the server already has it. The
   * draft stays in the editor (and its copy on this device) when it fails.
   */
  const persist = useCallback((snap: DraftSnapshot): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const current = () => targetRef.current === snap.target;
      if (current() && !differs(snap, savedRef.current)) return true;
      if (!snap.title.trim()) return false;
      const creating = !snap.target.id;
      const slug = creating && snap.folder.trim() ? `${snap.folder.trim()}/${snap.title}` : undefined;
      if (current()) setSaveState({ status: 'saving' });
      let note: NoteRow;
      try {
        ({ note } = await api.post<{ note: NoteRow }>('/notes', {
          id: snap.target.id ?? undefined, title: snap.title, body: snap.body, tags: snap.tags, noteKind: snap.kind, slug,
          // A new note never takes over one already at its slug (an archived one included).
          ...(creating ? { createOnly: true } : {}),
        }));
      } catch (err) {
        const exists = err instanceof ApiError && err.body.code === 'exists';
        const error = exists
          ? 'a note with this title already exists (perhaps in the archive): change the title'
          : err instanceof Error ? err.message : 'Could not save the note';
        if (current()) setSaveState({ status: 'error', error });
        return false;
      }
      snap.target.id = note.id;
      // The copy on this device is no longer needed, unless typing went on
      // (then it holds the newer text; a new note's moves under its id).
      const latest = draftRef.current;
      const stillTyping = current() && differs(latest, snap);
      if (creating) {
        removeNoteDraft(noteDraftKey(workspaceId, null));
        if (stillTyping) {
          writeNoteDraft(noteDraftKey(workspaceId, note.id), {
            title: latest.title, body: latest.body, tags: latest.tags, noteKind: latest.kind, baseUpdatedAt: note.updatedAt, savedAt: Date.now(),
          });
        }
      } else if (!stillTyping) {
        removeNoteDraft(noteDraftKey(workspaceId, note.id));
      }
      if (current()) {
        savedRef.current = { title: snap.title, body: snap.body, tags: snap.tags, kind: snap.kind, updatedAt: note.updatedAt };
        setSavedTitle(snap.title); setSavedBody(snap.body); setSavedTags(snap.tags); setSavedKind(snap.kind);
        setSaveState({ status: 'saved' });
        if (creating) {
          loadedRef.current = note.id;
          setDraftFolder('');
          setComposing(false);
          // The new note gets its address; Back does not return to the blank form.
          router.replace(notesHref({ note: note.id }));
        }
      }
      invalidateAll();
      qc.invalidateQueries({ queryKey: ['note', note.id] });
      qc.invalidateQueries({ queryKey: ['note-suggestions', note.id] });
      return true;
    };
    const next = chainRef.current.then(run);
    chainRef.current = next.catch((err: unknown) => console.error('Note save chain failed', err));
    return next;
  }, [invalidateAll, qc, router, workspaceId]);

  const snapshot = useCallback((): DraftSnapshot => ({ target: targetRef.current, ...draftRef.current }), []);
  // For the page-leave handlers, which outlive a render.
  const persistRef = useRef(persist);
  useEffect(() => {
    persistRef.current = persist;
  }, [persist]);

  /** Save the open personal note now, if it has unsaved changes. False when that failed (or it has no title). */
  const flush = useCallback((): Promise<boolean> => {
    if (!personal || !differs(draftRef.current, savedRef.current)) return Promise.resolve(true);
    return persist(snapshot());
  }, [personal, persist, snapshot]);

  const resetDrafts = useCallback((kind = 'note') => {
    setDraftTitle(''); setDraftBody(''); setDraftTags([]); setDraftKind(kind); setDraftFolder('');
    setSavedTitle(''); setSavedBody(''); setSavedTags([]); setSavedKind(kind);
    savedRef.current = { title: '', body: '', tags: [], kind };
    setSaveState({ status: 'idle' });
    setDraftNotice(null);
  }, []);

  // Another note was opened (a click, back/forward, a typed address): what
  // the previous one had unsaved goes to the server, and the draft is blanked
  // until the new note's detail arrives (the load effect fills it in). A new
  // note that just got its id keeps its draft.
  useEffect(() => {
    if (selectedId === targetRef.current.id) return;
    if (personal && draftRef.current.title.trim() && differs(draftRef.current, savedRef.current)) {
      void persist(snapshot());
    }
    targetRef.current = { id: selectedId };
    loadedRef.current = null;
    resetDrafts();
    setMode('preview');
  }, [selectedId, personal, persist, snapshot, resetDrafts]);

  // Load a fetched note into the draft + clean baseline exactly once per note.
  // A copy of unsaved changes kept on this device comes back with it: at once
  // when the note has not changed since, else on the user's word.
  useEffect(() => {
    const d = detail.data;
    if (!d || d.id !== selectedId || loadedRef.current === d.id) return;
    loadedRef.current = d.id;
    savedRef.current = { title: d.title, body: d.body, tags: d.tags, kind: d.noteKind, updatedAt: d.updatedAt };
    setSavedTitle(d.title); setSavedBody(d.body); setSavedTags(d.tags); setSavedKind(d.noteKind);
    let draft = { title: d.title, body: d.body, tags: d.tags, noteKind: d.noteKind };
    let notice: DraftNotice | null = null;
    if (personal && !d.archivedAt) {
      const key = noteDraftKey(workspaceId, d.id);
      const backup = readNoteDraft(key);
      if (backup && !draftDiffers(backup, d)) removeNoteDraft(key);
      else if (backup && backup.baseUpdatedAt === d.updatedAt) {
        draft = backup;
        notice = { kind: 'restored', at: backup.savedAt };
      } else if (backup) notice = { kind: 'conflict', backup };
    }
    setDraftTitle(draft.title); setDraftBody(draft.body); setDraftTags(draft.tags); setDraftKind(draft.noteKind);
    setDraftNotice(notice);
  }, [detail.data, selectedId, personal, workspaceId]);

  // Every unsaved change of a personal note is copied to this device first.
  useEffect(() => {
    if (!personal || !dirty || openArchived) return;
    writeNoteDraft(noteDraftKey(workspaceId, targetRef.current.id), {
      title: draftTitle, body: draftBody, tags: draftTags, noteKind: draftKind, folder: draftFolder || undefined,
      baseUpdatedAt: savedRef.current.updatedAt, savedAt: Date.now(),
    });
  }, [personal, dirty, openArchived, draftTitle, draftBody, draftTags, draftKind, draftFolder, workspaceId]);

  // Autosave: a moment after the last change. A failed save waits for the
  // next change or Retry rather than retrying in a loop.
  useEffect(() => {
    if (!personal || !canWrite || openArchived || !dirty || !draftTitle.trim()) return;
    const timer = setTimeout(() => { void persist(snapshot()); }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [personal, canWrite, openArchived, dirty, draftTitle, draftBody, draftTags, draftKind, draftFolder, persist, snapshot]);

  // Leaving the page: save what is unsaved. Closing the tab with unsaved
  // changes asks first (the copy on this device is kept either way); hiding
  // it saves at once.
  useEffect(() => {
    if (!personal) return;
    const unsaved = () => differs(draftRef.current, savedRef.current) && !!draftRef.current.title.trim();
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!unsaved()) return;
      void persistRef.current(snapshot());
      e.preventDefault();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && unsaved()) void persistRef.current(snapshot());
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
      // Navigating to another page of the app.
      if (unsaved()) void persistRef.current(snapshot());
    };
  }, [personal, snapshot]);

  // Space notes: "Save details" stores the title, tags and kind; the text saves itself.
  const save = useMutation({
    mutationFn: (payload: { id?: string; title: string; body?: string; tags: string[]; noteKind: string; slug?: string; baseSha256?: string; createOnly?: boolean }) =>
      api.post<{ note: NoteRow }>('/notes', payload),
    onSuccess: (res, vars) => {
      if (!selectedId) {
        targetRef.current = { id: res.note.id };
        loadedRef.current = res.note.id;
        router.replace(notesHref({ note: res.note.id }));
      }
      savedRef.current = { title: vars.title, body: vars.body ?? savedRef.current.body, tags: vars.tags, kind: vars.noteKind, updatedAt: res.note.updatedAt };
      setSavedTitle(vars.title); if (vars.body !== undefined) setSavedBody(vars.body); setSavedTags(vars.tags); setSavedKind(vars.noteKind);
      setDraftFolder('');
      invalidateAll();
      qc.invalidateQueries({ queryKey: ['note', res.note.id] });
      qc.invalidateQueries({ queryKey: ['note-suggestions', res.note.id] });
    },
  });

  const pin = useMutation({
    mutationFn: (vars: { id: string; pinned: boolean }) => api.patch(`/notes/${vars.id}/pin`, { pinned: vars.pinned }),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['notes'] });
      qc.invalidateQueries({ queryKey: ['note', vars.id] });
    },
  });

  /**
   * Before the open note is left: its unsaved changes are saved. An untitled
   * draft cannot be, and a failed save keeps a copy on this device; either
   * way the user decides whether to go.
   */
  async function leaveCurrent(): Promise<boolean> {
    if (isSpace) {
      return !dirty || window.confirm('Discard unsaved changes?');
    }
    if (!differs(draftRef.current, savedRef.current)) return true;
    if (!draftRef.current.title.trim()) {
      if (!window.confirm('This note has no title, so it was not saved. Discard it?')) return false;
      removeNoteDraft(noteDraftKey(workspaceId, targetRef.current.id));
      return true;
    }
    if (await flush()) return true;
    return window.confirm('This note could not be saved. A copy is kept on this device and comes back when you open it again. Leave it anyway?');
  }

  async function selectNote(id: string) {
    if (id === selectedId && view === 'list') {
      setComposing(false);
      return;
    }
    if (!(await leaveCurrent())) return;
    setComposing(false);
    router.push(notesHref({ note: id }));
  }

  function openSlug(slug: string) {
    const target = notes.find((n) => n.slug === slug) ?? noteIndex.find((n) => n.slug === slug);
    if (target) void selectNote(target.id);
  }

  async function openNew(folder?: string) {
    if (!(await leaveCurrent())) return;
    targetRef.current = { id: null };
    loadedRef.current = null;
    // Match saved===draft for the initial kind so a brand-new note isn't
    // marked dirty before the user types anything.
    resetDrafts(folder?.split('/')[0] === 'daily' ? 'daily' : 'note');
    setDraftFolder(folder ?? '');
    // A new note's draft kept on this device (its save failed) comes back.
    const backup = personal ? readNoteDraft(noteDraftKey(workspaceId, null)) : null;
    if (backup && !folder) {
      setDraftTitle(backup.title); setDraftBody(backup.body); setDraftTags(backup.tags); setDraftKind(backup.noteKind);
      setDraftFolder(backup.folder ?? '');
      setDraftNotice({ kind: 'restored', at: backup.savedAt });
    }
    setComposing(true);
    setMode('edit');
    // From an open note, Back returns to it. (A new note saved just now by
    // `leaveCurrent` put its own id in the address: that one is replaced.)
    if (selectedId || view !== 'list') router.push(notesHref());
    else router.replace(notesHref());
  }

  /** Back to the list (a phone shows one pane at a time). */
  async function backToList() {
    if (!(await leaveCurrent())) return;
    setComposing(false);
    setPhoneCtxOpen(false);
    if (selectedId) router.push(notesHref());
    else {
      targetRef.current = { id: null };
      resetDrafts();
    }
  }

  function doSave() {
    if (personal) {
      void flush();
      return;
    }
    if (!draftTitle || !dirty || save.isPending) return;
    const isNew = !selectedId;
    const slug = isNew && draftFolder.trim() ? `${draftFolder.trim()}/${draftTitle}` : undefined;
    // A live note's text saves itself: Save stores the title, tags and kind.
    const body = isSpace && !isNew ? undefined : draftBody;
    save.mutate({ id: selectedId ?? undefined, title: draftTitle, body, tags: draftTags, noteKind: draftKind, slug, ...(isNew ? { createOnly: true } : {}) });
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
    const title = draftTitle || detail.data?.title || 'note';
    if (personal && !(await flush()) && !window.confirm('This note could not be saved. Archive it without the latest changes?')) return;
    setActionError(null);
    try {
      await api.delete(`/notes/${id}`);
    } catch (err) {
      setActionError(`Could not archive “${title}”: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    invalidateAll();
    targetRef.current = { id: null };
    loadedRef.current = null;
    resetDrafts();
    setComposing(false);
    router.replace(notesHref());
    showUndo(`Archived “${title}”`, () => void restoreNote(id, title, true));
  }

  function addLink(s: Suggestion) {
    const title = s.title ?? s.id;
    if (hasLink(draftBody, title)) return;
    if (liveSession && liveSynced) {
      // Into the shared document, like typing it.
      const text = liveSession.text;
      text.insert(text.length, text.length > 0 ? `\n\n[[${title}]]` : `[[${title}]]`);
      return;
    }
    const next = draftBody.trim() ? `${draftBody.trimEnd()}\n\n[[${title}]]` : `[[${title}]]`;
    // A personal note's autosave picks the link up; a space note is saved now,
    // naming the text it was made from.
    setDraftBody(next);
    if (isSpace && selectedId && draftTitle) {
      const baseSha256 = detail.data?.id === selectedId ? detail.data.bodySha256 : undefined;
      save.mutate({ id: selectedId, title: draftTitle, body: next, tags: draftTags, noteKind: draftKind, baseSha256 });
    }
  }

  async function changeView(v: 'list' | 'graph') {
    if (v === view) return;
    if (v === 'graph' && !(await leaveCurrent())) return;
    router.replace(v === 'graph' ? notesHref({ graph: true }) : notesHref({ note: selectedId }));
  }

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

  const pinned = detail.data?.pinned ?? false;
  const safeNavWidth = Math.min(NAV_MAX, Math.max(NAV_MIN, navWidth));
  const safeCtxWidth = Math.min(CTX_MAX, Math.max(CTX_MIN, ctxWidth));

  const resizerClass =
    'w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-primary/30 active:bg-primary/50 transition-colors';

  const autosave: AutosaveStatus | undefined = !personal ? undefined
    : saveState.status === 'error' ? saveState
    : saveState.status === 'saving' ? { status: 'saving' }
    : dirty ? { status: draftTitle.trim() ? 'unsaved' : 'untitled' }
    : { status: selectedId ? 'saved' : 'idle' };

  // A phone shows one pane: the list, or the open (or new) note.
  const editorOpen = !!selectedId || composing;
  const showNav = !phone || !editorOpen;
  const showEditor = !phone || editorOpen;
  const ctxVisible = phone ? phoneCtxOpen && editorOpen : !ctxCollapsed;
  const closeCtx = phone ? () => setPhoneCtxOpen(false) : toggleCtx;
  const actionAlert = save.error?.message || pin.error?.message || actionError;

  const contextPanel = (
    <>
      {isSpace && selectedId && (
        <div role="tablist" className="flex shrink-0 border-b border-outline-variant/30 text-[11px] font-mono">
          {(['links', 'history', 'proposals'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={ctxTab === tab}
              onClick={() => setCtxTab(tab)}
              className={cn('flex-1 px-2 py-1.5', ctxTab === tab ? 'text-primary border-b border-primary' : 'text-on-surface-variant hover:bg-surface-container-high')}
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
            detail={selectedId ? detail.data : undefined}
            suggestions={suggestions.data?.suggestions ?? []}
            suggestionsLoading={suggestions.isLoading}
            bodyHasLink={(title) => hasLink(draftBody, title)}
            onOpenNote={(id) => { setPhoneCtxOpen(false); void selectNote(id); }}
            onAddLink={canWrite && !openArchived ? addLink : undefined}
            onTagClick={(t) => { setActiveTag(t); setFilter('all'); }}
            onCollapse={closeCtx}
          />
        </div>
      )}
    </>
  );

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Top bar — prompt + view toggle */}
      {actionAlert && (
        <div role="alert" className="shrink-0 border-b border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
          {actionAlert}
          <button type="button" className="ml-3 underline" onClick={() => { save.reset(); pin.reset(); setActionError(null); }}>Dismiss</button>
        </div>
      )}
      <div className="flex items-center gap-3 px-4 h-11 shrink-0 border-b border-outline-variant/40">
        <h1 className="text-[13px] font-semibold lowercase font-mono truncate">
          <span className="text-outline">octi:</span>
          <span className="text-on-surface">~/notes</span>
          {view === 'graph' && <span className="text-on-surface-variant">/graph</span>}
          <span className="text-primary font-bold"> $</span>
          <span aria-hidden className="term-caret" />
        </h1>
        <div className="ml-auto flex items-center gap-1">
          <div className="flex items-center rounded-xs border border-outline-variant/40 overflow-hidden text-[12px] font-mono">
            <button
              type="button"
              onClick={() => void changeView('list')}
              className={cn('inline-flex items-center gap-1 px-2.5 py-1', view === 'list' ? 'bg-primary-container/50 text-primary' : 'text-on-surface-variant hover:bg-surface-container-high')}
            >
              <ScrollText size={13} /> list
            </button>
            <button
              type="button"
              onClick={() => void changeView('graph')}
              className={cn('inline-flex items-center gap-1 px-2.5 py-1 border-l border-outline-variant/40', view === 'graph' ? 'bg-primary-container/50 text-primary' : 'text-on-surface-variant hover:bg-surface-container-high')}
            >
              <Network size={13} /> graph
            </button>
          </div>
          {view === 'list' && (phone ? editorOpen && !phoneCtxOpen : ctxCollapsed) && (
            <button
              type="button"
              onClick={() => (phone ? setPhoneCtxOpen(true) : setCtxCollapsed(false))}
              title="Show context panel"
              className="p-1.5 rounded-xs border border-outline-variant/40 text-on-surface-variant hover:text-primary hover:bg-surface-container-high"
            >
              <PanelRight size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {view === 'graph' ? (
        <div className="flex-1 min-h-0">
          <KnowledgeGraph onOpenNote={(id) => void selectNote(id)} />
        </div>
      ) : (
        <div className="relative flex-1 min-h-0 flex">
          {showNav && (
            <aside
              style={phone ? undefined : { width: safeNavWidth }}
              className={cn('border-outline-variant/30 bg-surface-container-lowest/40', phone ? 'flex-1 min-w-0' : 'shrink-0 border-r')}
            >
              <NotesNavigator
                notes={navNotes}
                tags={tags}
                isLoading={navLoading}
                selectedId={selectedId}
                filter={filter}
                setFilter={setFilter}
                search={search}
                setSearch={setSearch}
                activeTag={activeTag}
                setActiveTag={setActiveTag}
                onOpen={(n) => void selectNote(n.id)}
                onNew={canWrite ? (folder) => void openNew(folder) : undefined}
                serverSearch
                showArchive
                onRestore={canWrite ? (n) => void restoreNote(n.id, n.title, false) : undefined}
              />
            </aside>
          )}
          {showNav && showEditor && <div onPointerDown={startResize('nav')} className={resizerClass} role="separator" aria-orientation="vertical" />}

          {showEditor && (
            <main className="flex-1 min-w-0 flex flex-col">
              {phone && (
                <div className="flex items-center gap-1 px-2 pt-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void backToList()}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-xs text-[13px] text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                  >
                    <ArrowLeft size={15} /> Notes
                  </button>
                </div>
              )}
              {openArchived && (
                <div data-testid="archived-note-banner" className="mx-5 mt-3 flex items-center gap-2 rounded-xs border border-outline-variant/40 bg-surface-container/60 px-3 py-2 text-[12px] text-on-surface-variant">
                  This note is archived.
                  {canWrite && selectedId && (
                    <button type="button" onClick={() => void restoreNote(selectedId, draftTitle, false)} className="inline-flex items-center gap-1 text-primary hover:underline">
                      <RotateCcw size={12} /> Restore
                    </button>
                  )}
                </div>
              )}
              {draftNotice && (
                <div data-testid="draft-notice" role="status" className="mx-5 mt-3 flex flex-wrap items-center gap-2 rounded-xs border border-outline-variant/40 bg-surface-container/60 px-3 py-2 text-[12px] text-on-surface-variant">
                  {draftNotice.kind === 'restored' ? (
                    <>
                      Restored unsaved changes from this device ({new Date(draftNotice.at).toLocaleString()}).
                      <button type="button" onClick={() => setDraftNotice(null)} className="underline">OK</button>
                    </>
                  ) : (
                    <>
                      This device kept unsaved changes from {new Date(draftNotice.backup.savedAt).toLocaleString()}, but the note has changed since.
                      <button
                        type="button"
                        onClick={() => {
                          const b = draftNotice.backup;
                          setDraftTitle(b.title); setDraftBody(b.body); setDraftTags(b.tags); setDraftKind(b.noteKind);
                          setDraftNotice(null);
                        }}
                        className="text-primary underline"
                      >
                        Use my changes
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (selectedId) removeNoteDraft(noteDraftKey(workspaceId, selectedId));
                          setDraftNotice(null);
                        }}
                        className="underline"
                      >
                        Discard them
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className="flex-1 min-h-0">
                <NoteEditor
                  selectedId={selectedId}
                  draftTitle={draftTitle}
                  setDraftTitle={setDraftTitle}
                  draftBody={draftBody}
                  setDraftBody={setDraftBody}
                  draftTags={draftTags}
                  setDraftTags={setDraftTags}
                  draftKind={draftKind}
                  setDraftKind={setDraftKind}
                  draftFolder={draftFolder}
                  setDraftFolder={setDraftFolder}
                  slug={detail.data?.slug}
                  noteDate={detail.data?.noteDate}
                  pinned={pinned}
                  onTogglePin={() => selectedId && pin.mutate({ id: selectedId, pinned: !pinned })}
                  mode={mode}
                  setMode={setMode}
                  dirty={dirty}
                  saving={save.isPending}
                  onSave={doSave}
                  onArchive={() => void archiveCurrent()}
                  noteIndex={noteIndex}
                  tags={tags}
                  onOpenSlug={openSlug}
                  onTagClick={(t) => { setActiveTag(t); setFilter('all'); }}
                  readOnly={!canWrite || openArchived}
                  live={live}
                  liveLoading={isSpace && !!selectedId && !liveSynced}
                  autosave={autosave}
                />
              </div>
            </main>
          )}

          {ctxVisible && (
            phone ? (
              <aside data-testid="note-context-sheet" className="absolute inset-0 z-20 flex flex-col bg-background">
                {contextPanel}
              </aside>
            ) : (
              <>
                <div onPointerDown={startResize('ctx')} className={resizerClass} role="separator" aria-orientation="vertical" />
                <aside style={{ width: safeCtxWidth }} className="shrink-0 border-l border-outline-variant/30 bg-surface-container-lowest/40 flex flex-col">
                  {contextPanel}
                </aside>
              </>
            )
          )}
        </div>
      )}
      {undoToast}
    </div>
  );
}
