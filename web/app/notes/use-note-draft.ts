'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useWorkspaceId } from '@/lib/workspace-context';
import { draftDiffers, latestNewNoteDraft, newDraftLocal, type NoteDraftBackup, noteDraftKey, readNoteDraft, removeNoteDraft, writeNoteDraft } from '@/lib/note-drafts';
import { noteTitleFrom, toggleSeenTask, toggleTaskAt } from '../../../src/shared/note-text';
import { merge3 } from '../../../src/core/docs/text-merge';
import type { AutosaveStatus } from './note-editor';
import type { NoteDetail, NoteRow, Suggestion } from './types';
import { type LiveNote, useLiveNote } from './use-live-note';

// ---------------------------------------------------------------------------
// The open note's draft, and everything that keeps it safe: the engine behind
// the notes page, usable by any page that embeds the note editor (a Today
// page showing the daily note, for one).
//
//   • A personal note saves itself a moment after each change (autosave),
//     only over the text it was made from (`ifSha256`), after any save still
//     in flight; a copy of every unsaved change is kept on this device until
//     the server has it, and offered back when the note is opened again. A
//     save refused because the note changed meanwhile (a to-do's tick reached
//     its line, another device saved) is merged with that change and saved
//     again when the two touch different text; only a real clash asks.
//   • A new note needs no title: it takes its title from its first line, and
//     so does an existing note whose title is its first line (rename by
//     editing that line; the slug never changes, so links keep working).
//   • A space note is a live document (§7.6): its text is edited together and
//     saved by the hub; its title, tags and kind by `saveDetails`.
// ---------------------------------------------------------------------------

/** A personal note saves this long after the last change. */
const AUTOSAVE_MS = 800;
/**
 * A new note waits this long while its first line (its title, and so its
 * slug) is still the only line being typed. Enter ends that wait (the usual
 * `AUTOSAVE_MS` follows); leaving the note or the page saves it at once.
 */
const FIRST_LINE_MS = 2500;

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((t, i) => t === sb[i]);
}

/** Whether the body already wikilinks `title` (incl. the `[[Title|Alias]]` form). */
export function hasLink(body: string, title: string): boolean {
  return body.includes(`[[${title}]]`) || body.includes(`[[${title}|`);
}

/**
 * The note a draft belongs to: an existing note's id, or null for a new one
 * until its first save fills it in. One object per opened note, so a save
 * that finishes after the user moved on knows it is no longer the open one.
 *
 * It also records where the draft was typed: the workspace and sign-in the
 * API client had then. A save only goes out while the client still has
 * them, so a draft never lands in another workspace (a switch changes the
 * client's header before this page re-renders) or another account; it stays
 * in its own workspace's copy on this device. `local` names that copy.
 */
interface DraftTarget {
  id: string | null;
  workspaceId: string | null;
  token: string | null;
  local: string;
  /** The body sha of this note's last save from here: the base of the next one. */
  sha?: string;
}

function newTarget(id: string | null, local?: string): DraftTarget {
  return { id, workspaceId: api.getWorkspaceId(), token: api.getToken(), local: id ?? local ?? newDraftLocal() };
}

interface DraftFields { title: string; body: string; tags: string[]; kind: string; folder: string }
/** `baseSha256`: the server body the draft was made from (absent for a new note). */
interface DraftSnapshot extends DraftFields { target: DraftTarget; baseSha256?: string }
interface SavedFields { title: string; body: string; tags: string[]; kind: string; sha256?: string }

type SaveState = { status: 'idle' | 'saving' | 'saved' } | { status: 'error'; error: string };

/** What the open note's draft offers back from this device (see lib/note-drafts.ts), or a save refused as stale. */
export type DraftNotice =
  | { kind: 'restored'; at: number }
  | { kind: 'conflict'; backup: NoteDraftBackup }
  | { kind: 'stale'; currentSha256: string };

function differs(draft: DraftFields, saved: SavedFields): boolean {
  return draft.title !== saved.title || draft.body !== saved.body || draft.kind !== saved.kind || !sameTags(draft.tags, saved.tags);
}

/** Whether a note's title follows its first line (the title is what that line reads as). */
function followsFirstLine(title: string, body: string): boolean {
  return title !== '' && title === noteTitleFrom(body);
}

export interface NoteDraftOptions {
  /** The open note, or null for a new one (or none). */
  noteId: string | null;
  /** A space note: a live document, saved by the hub. */
  isSpace: boolean;
  canWrite: boolean;
  /** A new note got its id from its first save (the page puts it in its address). Not called once the page was left. */
  onCreated: (id: string) => void;
  /** Saves changed the notes (lists, index, tags and graph are stale). */
  onSaved: () => void;
  /**
   * How a new note comes to exist, instead of a create-only save of the
   * draft: called by its first save (a page's own note, made on its first
   * keystroke: the Today page's daily note). The draft is then saved over
   * the note it answers, merged with it when that already had other text.
   */
  create?: () => Promise<NoteDetail>;
}

export function useNoteDraft({ noteId, isSpace, canWrite, onCreated, onSaved, create }: NoteDraftOptions) {
  // A personal note saves itself a moment after each change (autosave); a
  // space note's text is saved by the hub and its details by "Save details".
  const personal = !isSpace;
  const qc = useQueryClient();
  const workspaceId = useWorkspaceId();

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
  // The title is the first line's (a personal note's default), until a title is set by hand.
  const [titleAuto, setTitleAutoState] = useState(personal);
  const titleAutoRef = useRef(personal);
  const setTitleAuto = useCallback((auto: boolean) => {
    titleAutoRef.current = auto;
    setTitleAutoState(auto);
  }, []);

  const detail = useQuery<NoteDetail>({
    queryKey: ['note', noteId, workspaceId],
    queryFn: () => api.get<NoteDetail>(`/notes/${noteId}`),
    enabled: !!noteId,
    // Always read the note again on opening: the editor loads only text
    // fetched since (a cached copy may be older than the server's).
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const live = useLiveNote(noteId, isSpace);
  const liveSession = live?.session ?? null;
  const liveVersion = live?.version ?? 0;
  const liveSynced = live?.synced ?? false;

  // The id whose body we've loaded into the draft — so a background refetch of
  // the SAME note doesn't clobber in-progress edits.
  const loadedRef = useRef<string | null>(null);
  const [firstTarget] = useState(() => newTarget(noteId));
  const targetRef = useRef<DraftTarget>(firstTarget);
  // When the open note was opened: only detail fetched after it is fresh
  // enough to load (a cached copy may be older than the server's text).
  const openedAtRef = useRef(0);
  // A save that finishes after the page was left must not navigate.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    openedAtRef.current = Date.now();
    return () => { mountedRef.current = false; };
  }, []);
  // A title typed by hand for a new note is not created from half of it (its
  // slug is fixed at creation): it is created once the title field is left.
  const [titleEditing, setTitleEditing] = useState(false);
  // The latest draft and baseline, for saves started outside a render (the
  // debounce timer, leaving the note, closing the tab).
  const draftRef = useRef<DraftFields>({ title: '', body: '', tags: [], kind: 'note', folder: '' });
  const savedRef = useRef<SavedFields>({ title: '', body: '', tags: [], kind: 'note' });
  // Saves run one after another: a new note is created once, then updated.
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const onCreatedRef = useRef(onCreated);
  const onSavedRef = useRef(onSaved);
  const createRef = useRef(create);
  useEffect(() => {
    onCreatedRef.current = onCreated;
    onSavedRef.current = onSaved;
    createRef.current = create;
  });

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

  // An archived note opened from the archive reads only, until restored.
  const openArchived = !!noteId && detail.data?.id === noteId && !!detail.data.archivedAt;

  const dirty =
    draftTitle !== savedTitle || draftBody !== savedBody || draftKind !== savedKind || !sameTags(draftTags, savedTags);

  // Keep the refs on the latest render. Declared before the effects that read them.
  useEffect(() => {
    draftRef.current = { title: draftTitle, body: draftBody, tags: draftTags, kind: draftKind, folder: draftFolder };
  });

  /** The body changed (typing, a ticked task, a link added): a title that follows the first line follows it. */
  const setBody = useCallback((body: string) => {
    setDraftBody(body);
    if (titleAutoRef.current) setDraftTitle(noteTitleFrom(body));
  }, []);

  /**
   * A title set by hand. Empty takes a personal note's title from its first
   * line again, except while the title field is being typed in (`typing`):
   * a title erased letter by letter to write another is not given up.
   */
  const setTitle = useCallback((title: string, typing = false) => {
    if (title.trim() === '' && personal && !typing) {
      setTitleAuto(true);
      setDraftTitle(noteTitleFrom(draftRef.current.body));
      return;
    }
    setTitleAuto(false);
    setDraftTitle(title);
  }, [personal, setTitleAuto]);

  /**
   * The note changed on the server since the draft's base (a to-do ticked its
   * line, another device saved): take the server's text as the new base and
   * merge the draft's own changes into it (diff3, as a space note's writers
   * are). When that merges cleanly the draft is the merged text, saved again
   * over the new base by the caller. Null on a clash or a failed read:
   * nothing changes and the stale save asks. Returns the merged draft.
   */
  const rebaseOnServer = useCallback(async (id: string): Promise<DraftFields | null> => {
    let server: NoteDetail;
    try {
      server = await api.get<NoteDetail>(`/notes/${id}`);
    } catch (err) {
      console.warn('Could not read the note again to merge a refused save', err);
      return null;
    }
    if (targetRef.current.id !== id) return null;
    const before = savedRef.current;
    const mine = draftRef.current;
    const merged = merge3(before.body, server.body, mine.body);
    if (!merged.ok) return null;
    const tags = sameTags(mine.tags, before.tags) ? server.tags : mine.tags;
    const title = titleAutoRef.current ? noteTitleFrom(merged.text) : mine.title === before.title ? server.title : mine.title;
    savedRef.current = { title: server.title, body: server.body, tags: server.tags, kind: server.noteKind, sha256: server.bodySha256 };
    targetRef.current.sha = server.bodySha256;
    setSavedTitle(server.title); setSavedBody(server.body); setSavedTags(server.tags); setSavedKind(server.noteKind);
    setDraftTags(tags);
    setDraftTitle(title);
    setDraftBody(merged.text);
    draftRef.current = { ...mine, title, body: merged.text, tags };
    return { ...mine, title, body: merged.text, tags };
  }, []);

  /**
   * Save a draft of a personal note. Runs after any save still in flight, so
   * a new note is created once; skipped when the server already has it. The
   * draft stays in the editor (and its copy on this device) when it fails.
   */
  const persist = useCallback((first: DraftSnapshot): Promise<boolean> => {
    // `rebased`: this is the save again after a stale one merged with the server's text (once).
    const run = async (snap: DraftSnapshot = first, rebased = false): Promise<boolean> => {
      const current = () => targetRef.current === snap.target;
      if (current() && !differs(snap, savedRef.current)) return true;
      if (!snap.title.trim()) return false;
      // Typed in another workspace or sign-in than the client has now: it is
      // not sent anywhere. Its copy on this device stays in its workspace.
      if (api.getWorkspaceId() !== snap.target.workspaceId || api.getToken() !== snap.target.token) {
        if (current() && mountedRef.current) setSaveState({ status: 'error', error: 'the workspace changed; this draft is kept on this device' });
        return false;
      }
      let creating = !snap.target.id;
      // A note the page makes itself: made now, then this draft is saved over it.
      if (creating && createRef.current) {
        let made: NoteDetail;
        try {
          made = await createRef.current();
        } catch (err) {
          if (current()) setSaveState({ status: 'error', error: err instanceof Error ? err.message : 'Could not create the note' });
          return false;
        }
        // What the draft was started from; the note may already hold more (made elsewhere meanwhile).
        const seed = current() ? savedRef.current.body : made.body;
        const merged = made.body === seed ? { ok: true as const, text: snap.body } : merge3(seed, made.body, snap.body);
        const wasLocal = snap.target.local;
        snap.target.id = made.id;
        snap.target.local = made.id;
        snap.target.sha = made.bodySha256;
        removeNoteDraft(noteDraftKey(snap.target.workspaceId, wasLocal));
        if (current()) {
          savedRef.current = { title: made.title, body: made.body, tags: made.tags, kind: made.noteKind, sha256: made.bodySha256 };
          setSavedTitle(made.title); setSavedBody(made.body); setSavedTags(made.tags); setSavedKind(made.noteKind);
          loadedRef.current = made.id;
          if (merged.ok && merged.text !== snap.body) {
            setDraftBody(merged.text);
            draftRef.current = { ...draftRef.current, body: merged.text };
          }
        }
        if (mountedRef.current) onCreatedRef.current(made.id);
        if (!merged.ok) {
          if (current()) {
            setSaveState({ status: 'error', error: 'the note was written elsewhere meanwhile' });
            setDraftNotice({ kind: 'stale', currentSha256: made.bodySha256 });
          }
          return false;
        }
        snap = { ...snap, body: merged.text, baseSha256: made.bodySha256 };
        creating = false;
        if (current() && !differs(snap, savedRef.current)) {
          setSaveState({ status: 'saved' });
          return true;
        }
      }
      // A title is a name, never a path: "Notes 11/24" is not a folder `notes-11`.
      const name = snap.title.replace(/\//g, '-');
      const folder = snap.folder.trim().replace(/^\/+|\/+$/g, '');
      const slug = !creating ? undefined : folder ? `${folder}/${name}` : name !== snap.title ? name : undefined;
      // The text this edit is saved over, read now (not when the save was
      // queued: a save still in flight then has changed it since).
      const base = current() ? savedRef.current.sha256 : snap.target.sha ?? snap.baseSha256;
      if (current()) setSaveState({ status: 'saving' });
      let note: NoteRow & { bodySha256: string };
      try {
        ({ note } = await api.post<{ note: NoteRow & { bodySha256: string } }>('/notes', {
          id: snap.target.id ?? undefined, title: snap.title, body: snap.body, tags: snap.tags, noteKind: snap.kind, slug,
          // A new note never takes over one already at its slug (an archived one included).
          ...(creating ? { createOnly: true } : {}),
          // An edit is saved only over the text it was made from.
          ...(!creating && base ? { ifSha256: base } : {}),
        }));
      } catch (err) {
        const code = err instanceof ApiError ? err.body.code : undefined;
        const error = code === 'exists'
          ? 'a note with this title already exists (perhaps in the archive): change the first line or the title'
          : code === 'stale' ? 'the note was changed elsewhere since you opened it'
          : err instanceof Error ? err.message : 'Could not save the note';
        // Changed elsewhere meanwhile: merged with that change when they do not clash, and saved again.
        if (code === 'stale' && !rebased && current() && snap.target.id) {
          const merged = await rebaseOnServer(snap.target.id);
          if (merged) return run({ ...snap, ...merged, baseSha256: savedRef.current.sha256 }, true);
        }
        if (current()) {
          setSaveState({ status: 'error', error });
          if (code === 'stale' && err instanceof ApiError && typeof err.body.currentSha256 === 'string') {
            setDraftNotice({ kind: 'stale', currentSha256: err.body.currentSha256 });
          }
        }
        return false;
      }
      const wasLocal = snap.target.local;
      snap.target.id = note.id;
      snap.target.local = note.id;
      snap.target.sha = note.bodySha256;
      // The copy on this device is no longer needed, unless typing went on
      // (then it holds the newer text; a new note's moves under its id).
      const latest = draftRef.current;
      const stillTyping = current() && differs(latest, snap);
      const ws = snap.target.workspaceId;
      if (creating) {
        removeNoteDraft(noteDraftKey(ws, wasLocal));
        if (stillTyping) {
          writeNoteDraft(noteDraftKey(ws, note.id), {
            title: latest.title, body: latest.body, tags: latest.tags, noteKind: latest.kind, baseSha256: note.bodySha256, savedAt: Date.now(),
          });
        }
      } else if (!stillTyping) {
        removeNoteDraft(noteDraftKey(ws, note.id));
      }
      if (current()) {
        savedRef.current = { title: snap.title, body: snap.body, tags: snap.tags, kind: snap.kind, sha256: note.bodySha256 };
        setSavedTitle(snap.title); setSavedBody(snap.body); setSavedTags(snap.tags); setSavedKind(snap.kind);
        setSaveState({ status: 'saved' });
        if (creating) {
          loadedRef.current = note.id;
          setDraftFolder('');
          // The new note gets its address. Not once the page was left: that
          // would pull the user back.
          if (mountedRef.current) onCreatedRef.current(note.id);
        }
      }
      onSavedRef.current();
      qc.invalidateQueries({ queryKey: ['note', note.id] });
      qc.invalidateQueries({ queryKey: ['note-suggestions', note.id] });
      return true;
    };
    const next = chainRef.current.then(() => run());
    chainRef.current = next.catch((err: unknown) => console.error('Note save chain failed', err));
    return next;
  }, [qc, rebaseOnServer]);

  const snapshot = useCallback((): DraftSnapshot => ({ target: targetRef.current, ...draftRef.current, baseSha256: savedRef.current.sha256 }), []);
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
    setTitleAuto(personal);
  }, [personal, setTitleAuto]);

  // Another note was opened (a click, back/forward, a typed address): what
  // the previous one had unsaved goes to the server, and the draft is blanked
  // until the new note's detail arrives (the load effect fills it in). A new
  // note that just got its id keeps its draft.
  useEffect(() => {
    if (noteId === targetRef.current.id) return;
    if (personal && draftRef.current.title.trim() && differs(draftRef.current, savedRef.current)) {
      void persist(snapshot());
    }
    targetRef.current = newTarget(noteId);
    openedAtRef.current = Date.now();
    loadedRef.current = null;
    resetDrafts();
  }, [noteId, personal, persist, snapshot, resetDrafts]);

  // Load the open note into the draft + clean baseline, from detail fetched
  // since it was opened (a cached copy can be older than the server's text).
  // A copy of unsaved changes kept on this device comes back with it: at once
  // when the note's text is the one the copy was made from, else on the
  // user's word. Newer server text arriving later replaces a clean draft; an
  // edited one keeps the user's text (its save is refused as stale, and asks).
  const detailFetching = detail.isFetching;
  const detailUpdatedAt = detail.dataUpdatedAt;
  useEffect(() => {
    const d = detail.data;
    if (!d || d.id !== noteId || detailFetching || detailUpdatedAt < openedAtRef.current) return;
    if (loadedRef.current === d.id) {
      const clean = !differs(draftRef.current, savedRef.current);
      if (!personal || !clean || d.bodySha256 === savedRef.current.sha256) return;
    }
    loadedRef.current = d.id;
    savedRef.current = { title: d.title, body: d.body, tags: d.tags, kind: d.noteKind, sha256: d.bodySha256 };
    setSavedTitle(d.title); setSavedBody(d.body); setSavedTags(d.tags); setSavedKind(d.noteKind);
    let draft = { title: d.title, body: d.body, tags: d.tags, noteKind: d.noteKind };
    let notice: DraftNotice | null = null;
    if (personal && !d.archivedAt) {
      const key = noteDraftKey(targetRef.current.workspaceId, d.id);
      const backup = readNoteDraft(key);
      if (backup && !draftDiffers(backup, d)) removeNoteDraft(key);
      else if (backup && backup.baseSha256 === d.bodySha256) {
        draft = backup;
        notice = { kind: 'restored', at: backup.savedAt };
      } else if (backup) notice = { kind: 'conflict', backup };
    }
    setTitleAuto(personal && followsFirstLine(draft.title, draft.body));
    setDraftTitle(draft.title); setDraftBody(draft.body); setDraftTags(draft.tags); setDraftKind(draft.noteKind);
    setDraftNotice(notice);
  }, [detail.data, detailFetching, detailUpdatedAt, noteId, personal, setTitleAuto]);

  // Every unsaved change of a personal note is copied to this device first,
  // under the workspace it was typed in.
  useEffect(() => {
    if (!personal || !dirty || openArchived) return;
    const target = targetRef.current;
    if (api.getWorkspaceId() !== target.workspaceId) return;
    writeNoteDraft(noteDraftKey(target.workspaceId, target.local), {
      title: draftTitle, body: draftBody, tags: draftTags, noteKind: draftKind, folder: draftFolder || undefined,
      baseSha256: savedRef.current.sha256, savedAt: Date.now(),
    });
  }, [personal, dirty, openArchived, draftTitle, draftBody, draftTags, draftKind, draftFolder]);

  // Autosave: a moment after the last change. A failed save waits for the
  // next change or Retry rather than retrying in a loop; a stale one waits
  // for the user's answer. A new note's title typed by hand waits for the
  // field to be left; one taken from the first line waits a little longer
  // while that line is still the only one.
  const staleNotice = draftNotice?.kind === 'stale';
  const newTitleTyping = !noteId && !titleAuto && titleEditing;
  const firstLineOpen = !noteId && titleAuto && !draftBody.trimStart().includes('\n');
  useEffect(() => {
    if (!personal || !canWrite || openArchived || !dirty || !draftTitle.trim() || staleNotice || newTitleTyping) return;
    const timer = setTimeout(() => { void persist(snapshot()); }, firstLineOpen ? FIRST_LINE_MS : AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [personal, canWrite, openArchived, dirty, draftTitle, draftBody, draftTags, draftKind, draftFolder, staleNotice, newTitleTyping, firstLineOpen, persist, snapshot]);

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
      if (!noteId) {
        targetRef.current = newTarget(res.note.id);
        loadedRef.current = res.note.id;
        if (mountedRef.current) onCreatedRef.current(res.note.id);
      }
      savedRef.current = { title: vars.title, body: vars.body ?? savedRef.current.body, tags: vars.tags, kind: vars.noteKind };
      setSavedTitle(vars.title); if (vars.body !== undefined) setSavedBody(vars.body); setSavedTags(vars.tags); setSavedKind(vars.noteKind);
      setDraftTitle(vars.title);
      setDraftFolder('');
      onSavedRef.current();
      qc.invalidateQueries({ queryKey: ['note', res.note.id] });
      qc.invalidateQueries({ queryKey: ['note-suggestions', res.note.id] });
    },
  });

  /**
   * Before the open note is left: its unsaved changes are saved. A draft
   * with no text at all is dropped; a failed save keeps a copy on this
   * device, and the user decides whether to go.
   */
  const leave = useCallback(async (): Promise<boolean> => {
    if (isSpace) {
      return !differs(draftRef.current, savedRef.current) || window.confirm('Discard unsaved changes?');
    }
    if (!differs(draftRef.current, savedRef.current)) return true;
    if (!draftRef.current.title.trim()) {
      if (draftRef.current.body.trim() && !window.confirm('This note has no title, so it was not saved. Discard it?')) return false;
      removeNoteDraft(noteDraftKey(targetRef.current.workspaceId, targetRef.current.local));
      return true;
    }
    if (await flush()) return true;
    return window.confirm('This note could not be saved. A copy is kept on this device and comes back when you open it again. Leave it anyway?');
  }, [isSpace, flush]);

  /**
   * Start a new note (after `leave`): blank, or its draft kept on this
   * device. `folder` files it there. `seed`: the text it starts from (shown,
   * not unsaved: nothing is written until it is edited).
   */
  const startNew = useCallback((folder?: string, seed?: { title: string; body: string; kind: string }) => {
    // A new note's draft kept on this device (its save failed, or the tab
    // closed first) comes back, under its own key.
    const kept = personal && !folder && !seed ? latestNewNoteDraft(api.getWorkspaceId()) : null;
    targetRef.current = newTarget(null, kept?.local);
    loadedRef.current = null;
    // Match saved===draft for the initial kind so a brand-new note isn't
    // marked dirty before the user types anything.
    resetDrafts(seed?.kind ?? (folder?.split('/')[0] === 'daily' ? 'daily' : 'note'));
    setDraftFolder(folder ?? '');
    if (seed) {
      savedRef.current = { title: seed.title, body: seed.body, tags: [], kind: seed.kind };
      setSavedTitle(seed.title); setSavedBody(seed.body);
      setDraftTitle(seed.title); setDraftBody(seed.body);
      setTitleAuto(personal && followsFirstLine(seed.title, seed.body));
      return;
    }
    if (kept) {
      const backup = kept.draft;
      setTitleAuto(followsFirstLine(backup.title, backup.body));
      setDraftTitle(backup.title); setDraftBody(backup.body); setDraftTags(backup.tags); setDraftKind(backup.noteKind);
      setDraftFolder(backup.folder ?? '');
      setDraftNotice({ kind: 'restored', at: backup.savedAt });
    }
  }, [personal, resetDrafts, setTitleAuto]);

  /** Forget the open note (it was archived, or the page shows none): a blank new-note draft. */
  const clear = useCallback(() => {
    targetRef.current = newTarget(null);
    loadedRef.current = null;
    resetDrafts();
  }, [resetDrafts]);

  /** A new note just saved by `leave` has an id the page's address has not caught up with. */
  const currentId = useCallback(() => targetRef.current.id, []);

  /** Save now (⌘S): a personal note's draft; a space note's details (its text saves itself). */
  const saveNow = useCallback(() => {
    if (personal) {
      void flush();
      return;
    }
    const d = draftRef.current;
    // A new space note with no title takes its first line's.
    const title = d.title.trim() || noteTitleFrom(d.body);
    if (!title || !differs(d, savedRef.current) || save.isPending) return;
    const isNew = !noteId;
    const slug = isNew && d.folder.trim() ? `${d.folder.trim()}/${title}` : undefined;
    // A live note's text saves itself: Save stores the title, tags and kind.
    const body = !isNew ? undefined : d.body;
    save.mutate({ id: noteId ?? undefined, title, body, tags: d.tags, noteKind: d.kind, slug, ...(isNew ? { createOnly: true } : {}) });
  }, [personal, flush, noteId, save]);

  /** Write a change of the body the way typing would: into the live document, or the draft (which saves itself). */
  const editBody = useCallback((next: (body: string) => string | null): boolean => {
    if (liveSession && liveSynced) {
      const text = liveSession.text;
      const before = text.toString();
      const after = next(before);
      if (after === null || after === before) return false;
      // The smallest change: what differs between the two texts.
      let start = 0;
      while (start < before.length && before[start] === after[start]) start++;
      let endBefore = before.length;
      let endAfter = after.length;
      while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
      const apply = () => {
        if (endBefore > start) text.delete(start, endBefore - start);
        if (endAfter > start) text.insert(start, after.slice(start, endAfter));
      };
      if (text.doc) text.doc.transact(apply);
      else apply();
      return true;
    }
    // A space note's text is written live only: before its session syncs,
    // a change here would never be saved (a space note does not autosave).
    if (isSpace) return false;
    const after = next(draftRef.current.body);
    if (after === null) return false;
    setBody(after);
    return true;
  }, [liveSession, liveSynced, setBody, isSpace]);

  /**
   * Tick or untick the task a reading view's checkbox stands for: the item
   * at `offset` of the text it drew, whose line read `seenLine`. Applied to
   * the text as it is now (a live note may have changed since the render):
   * the same task, found again, or nothing.
   */
  const toggleTask = useCallback((offset: number, checked: boolean, seenLine?: string) => {
    editBody((body) => (seenLine === undefined ? toggleTaskAt(body, offset, checked) : toggleSeenTask(body, offset, seenLine, checked)));
  }, [editBody]);

  /** Whether the body can be written here now (a space note only once its live session has synced). */
  const canEditBody = !isSpace || (!!liveSession && liveSynced);

  /** Link a suggested note from the body. A space note's text goes into its live document, or is saved naming its base. */
  const addLink = useCallback((s: Suggestion) => {
    const title = s.title ?? s.id;
    if (hasLink(draftRef.current.body, title)) return;
    const append = (body: string) => (body.trim() ? `${body.trimEnd()}\n\n[[${title}]]` : `[[${title}]]`);
    if (liveSession && liveSynced) {
      editBody(append);
      return;
    }
    const next = append(draftRef.current.body);
    setBody(next);
    const d = draftRef.current;
    if (isSpace && noteId && d.title) {
      const baseSha256 = detail.data?.id === noteId ? detail.data.bodySha256 : undefined;
      save.mutate({ id: noteId, title: d.title, body: next, tags: d.tags, noteKind: d.kind, baseSha256 });
    }
  }, [liveSession, liveSynced, editBody, setBody, isSpace, noteId, detail.data, save]);

  /** "Keep my version": save over the newer text, knowingly. */
  const keepMine = useCallback(() => {
    if (draftNotice?.kind !== 'stale') return;
    savedRef.current = { ...savedRef.current, sha256: draftNotice.currentSha256 };
    setDraftNotice(null);
    void flush();
  }, [draftNotice, flush]);

  /** "Load the saved version": drop this device's text and read the note again. */
  const loadSaved = useCallback(() => {
    if (noteId) removeNoteDraft(noteDraftKey(targetRef.current.workspaceId, noteId));
    loadedRef.current = null;
    openedAtRef.current = Date.now();
    setDraftNotice(null);
    setSaveState({ status: 'idle' });
    void detail.refetch();
  }, [noteId, detail]);

  /** "Use my changes": the copy this device kept, over a note that changed since. */
  const takeKept = useCallback(() => {
    if (draftNotice?.kind !== 'conflict') return;
    const b = draftNotice.backup;
    setTitleAuto(personal && followsFirstLine(b.title, b.body));
    setDraftTitle(b.title); setDraftBody(b.body); setDraftTags(b.tags); setDraftKind(b.noteKind);
    setDraftNotice(null);
  }, [draftNotice, personal, setTitleAuto]);

  /** "Discard them": forget the copy this device kept. */
  const discardKept = useCallback(() => {
    if (noteId) removeNoteDraft(noteDraftKey(targetRef.current.workspaceId, noteId));
    setDraftNotice(null);
  }, [noteId]);

  const autosave: AutosaveStatus | undefined = !personal ? undefined
    : saveState.status === 'error' ? saveState
    : saveState.status === 'saving' ? { status: 'saving' }
    : dirty ? { status: draftTitle.trim() ? 'unsaved' : 'untitled' }
    : { status: noteId ? 'saved' : 'idle' };

  return {
    detail,
    live: live as LiveNote | null,
    liveSynced,
    personal,
    openArchived,
    dirty,
    autosave,
    draft: { title: draftTitle, body: draftBody, tags: draftTags, kind: draftKind, folder: draftFolder },
    titleAuto,
    setTitle,
    setBody,
    setTags: setDraftTags,
    setKind: setDraftKind,
    setFolder: setDraftFolder,
    setTitleEditing,
    draftNotice,
    dismissNotice: () => setDraftNotice(null),
    keepMine,
    loadSaved,
    takeKept,
    discardKept,
    flush,
    leave,
    startNew,
    clear,
    currentId,
    saveNow,
    saveDetails: save,
    toggleTask,
    canEditBody,
    editBody,
    addLink,
  };
}

export type NoteDraft = ReturnType<typeof useNoteDraft>;
