'use client';

import {
  Bold, BookOpen, Check, CloudOff, Heading2, Image as ImageIcon, Italic, Link2, List, ListChecks, Loader2, PencilLine, Save, Trash2,
} from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type { LiveNoteState } from '@/lib/live-note';
import { Markdown } from '@/components/ui/markdown-renderer';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import NotesMarkdownEditor, { type MarkdownEditorHandle } from './markdown-codemirror';
import { NoteDetailsMenu } from './note-details';
import type { NoteIndexEntry, TagCount } from './types';
import type { LiveNote } from './use-live-note';

/** `edit`: the live-preview editor (click and type, the default). `read`: the rendered note. */
export type EditorMode = 'edit' | 'read';

/**
 * Where a personal note's autosave stands (the workspace saves the draft a
 * moment after the last change): shown in place of a Save button.
 */
export type AutosaveStatus =
  | { status: 'idle' | 'saved' | 'saving' | 'unsaved' | 'untitled' }
  | { status: 'error'; error: string };

export interface NoteEditorProps {
  selectedId: string | null;
  draftTitle: string;
  /** A title set by hand; empty takes it from the first line again (`titleAuto`). */
  setDraftTitle: (v: string) => void;
  /**
   * The title is the first line's: no title field shows, the first line reads
   * as the title, and editing it renames the note (its slug stays).
   */
  titleAuto?: boolean;
  draftBody: string;
  setDraftBody: (v: string) => void;
  draftTags: string[];
  setDraftTags: (v: string[]) => void;
  draftKind: string;
  setDraftKind: (v: string) => void;
  draftFolder: string;
  setDraftFolder: (v: string) => void;
  slug?: string;
  noteDate?: string | null;
  /** When the note was last saved (a quiet "Edited …" line). */
  updatedAt?: string;
  pinned: boolean;
  onTogglePin: () => void;
  mode: EditorMode;
  setMode: (m: EditorMode) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onArchive: () => void;
  /** "Move to…" in the details menu; absent where a note cannot be moved. */
  onMove?: () => void;
  noteIndex: NoteIndexEntry[];
  tags: TagCount[];
  /** Open a linked note from a `[[wikilink]]` (its target as written). */
  onOpenSlug?: (target: string) => void;
  /** Filter by an inline `#tag` clicked in the note. */
  onTagClick?: (tag: string) => void;
  /** A reading view's task checkbox: tick the task whose list item starts at `offset`. */
  onToggleTask?: (offset: number, checked: boolean) => void;
  /**
   * The caller may not edit (a commenter or viewer in a space, or an
   * archived space): the note shows as a reading view with no editing controls.
   */
  readOnly?: boolean;
  /**
   * A space note being edited live (§7.6): the editor binds to the shared
   * document, the body saves itself ("Saved"), and Save stores only the
   * title, tags and kind.
   */
  live?: LiveNote | null;
  /** A space note whose live session has not synced yet: no editor until it has. */
  liveLoading?: boolean;
  /**
   * The note saves itself (a personal note): a quiet status takes the Save
   * button's place, with Retry after a failed save. `onSave` (⌘S) saves now.
   */
  autosave?: AutosaveStatus;
  /** The title field gained (true) or lost (false) the focus: a new note is not created mid-title. */
  onTitleEditing?: (editing: boolean) => void;
  /**
   * Only the text is edited here — a note of a space on another install
   * (federation §8.3): its title, tags, kind, pin and archive are the
   * host's to manage, so none of those controls show.
   */
  textOnly?: boolean;
  /** Put the caret in the text when the editor mounts (a new note). */
  autoFocus?: boolean;
  /** Escape in the text: the page's shortcuts take over. */
  onEscape?: () => void;
  /** The top bar's start (Back to the list on a phone, back/forward between notes). */
  leading?: ReactNode;
  /** The top bar's end (the links panel toggle). */
  trailing?: ReactNode;
  /** Notices shown at the top of the page (an archived note, a kept draft). */
  notices?: ReactNode;
}

function ToolBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection
      onClick={onClick}
      className="notes-icon-btn is-small"
    >
      {children}
    </button>
  );
}

interface Peer {
  clientId: number;
  name: string;
  color: string;
}

const NO_PEERS: Peer[] = [];
const peerCache = new WeakMap<Awareness, Peer[]>();

function readPeers(awareness: Awareness): Peer[] {
  const seen = new Set<string>();
  const out: Peer[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    const user = (state as { user?: { id?: string; name?: string; color?: string } }).user;
    if (clientId === awareness.clientID || !user?.name) continue;
    const key = user.id ?? String(clientId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ clientId, name: user.name, color: user.color ?? '#8CACFF' });
  }
  return out;
}

/** Who else has this note open, from the document's awareness (cursors carry the same names and colors). */
function usePeers(live: LiveNote | null | undefined): Peer[] {
  const awareness = live?.session.awareness ?? null;
  const subscribe = useCallback((onChange: () => void) => {
    if (!awareness) return () => undefined;
    const update = () => {
      peerCache.set(awareness, readPeers(awareness));
      onChange();
    };
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [awareness]);
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!awareness) return NO_PEERS;
      let peers = peerCache.get(awareness);
      if (!peers) {
        peers = readPeers(awareness);
        peerCache.set(awareness, peers);
      }
      return peers;
    },
    () => NO_PEERS,
  );
}

function PresenceStack({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null;
  return (
    <div data-testid="note-presence" className="flex -space-x-1.5" aria-label={`Also here: ${peers.map((p) => p.name).join(', ')}`}>
      {peers.slice(0, 5).map((p) => (
        <span
          key={p.clientId}
          title={`${p.name} is editing`}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-black"
          style={{ backgroundColor: p.color }}
        >
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {peers.length > 5 && <span className="pl-2 text-[11px] text-on-surface-variant">+{peers.length - 5}</span>}
    </div>
  );
}

function liveLabel(state: LiveNoteState): { text: string; icon: React.ReactNode } {
  switch (state.status) {
    case 'saved':
      return { text: 'Saved', icon: <Check size={12} /> };
    case 'unsaved':
      return { text: 'Saving…', icon: <Loader2 size={12} className="animate-spin" /> };
    case 'offline':
      return { text: 'Offline — reconnecting', icon: <CloudOff size={12} /> };
    case 'closed':
      return { text: state.notice ?? 'Closed', icon: <CloudOff size={12} /> };
    default:
      return { text: 'Connecting…', icon: <Loader2 size={12} className="animate-spin" /> };
  }
}

function AutosaveIndicator({ state, onRetry }: { state: AutosaveStatus; onRetry: () => void }) {
  if (state.status === 'idle') return null;
  if (state.status === 'error') {
    return (
      <span data-testid="note-save-status" role="alert" className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-error">
        <CloudOff size={13} className="shrink-0" />
        <span className="truncate max-w-[18rem]" title={state.error}>Not saved: {state.error}</span>
        <button type="button" onClick={onRetry} className="shrink-0 underline underline-offset-2 hover:opacity-80">Retry</button>
      </span>
    );
  }
  const view = {
    saved: { text: 'Saved', icon: <Check size={13} /> },
    saving: { text: 'Saving…', icon: <Loader2 size={13} className="animate-spin" /> },
    unsaved: { text: 'Editing', icon: null },
    untitled: { text: 'Write a first line to save', icon: null },
  }[state.status];
  return (
    <span data-testid="note-save-status" className="inline-flex shrink-0 items-center gap-1 text-[12px] text-on-surface-variant">
      {view.icon} {view.text}
    </span>
  );
}

/** "Edited 5 minutes ago", for the quiet line under the title. */
function editedText(iso: string | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'Edited just now';
  if (mins < 60) return `Edited ${mins} min ago`;
  const sameDay = then.toDateString() === new Date().toDateString();
  if (sameDay) return `Edited at ${then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return `Edited ${then.toLocaleDateString([], { day: 'numeric', month: 'short', year: then.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}`;
}

/** A daily note's day, as a heading reads it ("Monday, 23 November"). */
function dayLabel(date: string | null | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * The note as a page of paper: a quiet bar on top (status, reading view,
 * details), then the title and the text in one live-preview editor. Click
 * and type. Embeddable: everything it shows and does comes in as props
 * (`useNoteDraft` supplies them for a page of the user's own notes).
 */
export function NoteEditor(props: NoteEditorProps) {
  const {
    selectedId, draftTitle, setDraftTitle, draftBody, setDraftBody, draftTags, setDraftTags,
    draftKind, setDraftKind, draftFolder, setDraftFolder, slug, noteDate, pinned, onTogglePin,
    mode: requestedMode, setMode, dirty, saving, onSave, onArchive, noteIndex, tags, onOpenSlug, onTagClick, live,
  } = props;
  const readOnly = (props.readOnly ?? false) || (live?.synced === true && live.state.readOnly);
  const textOnly = props.textOnly ?? false;
  const titleAuto = (props.titleAuto ?? false) && !textOnly;
  const mode: EditorMode = readOnly ? 'read' : requestedMode;
  const peers = usePeers(live);
  const collab = useMemo(
    () => (live?.synced ? { text: live.session.text, awareness: live.session.awareness } : undefined),
    // A new epoch replaces the document: rebind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live?.session, live?.version, live?.synced],
  );
  const status = live ? liveLabel(live.state) : null;

  const editorRef = useRef<MarkdownEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const isNew = !selectedId;

  /**
   * Upload pasted/dropped/picked images and swap each placeholder for the
   * finished markdown.
   *
   * Storage reuses the documents pipeline rather than adding a parallel
   * attachment store: it already writes per-principal, serves the bytes back
   * with the right content type, and 404s cross-tenant reads. The upload is
   * also OCR'd and indexed, which is why a pasted screenshot becomes
   * searchable alongside the note text.
   */
  async function uploadImages(files: File[]) {
    const editor = editorRef.current;
    if (!editor || files.length === 0) return;
    setUploadError(null);
    for (const file of files) {
      // A stable, unlikely-to-be-typed placeholder so the caret can keep moving
      // while the upload is in flight.
      const token = `![uploading ${file.name || 'image'}…](#upload-${Math.random().toString(36).slice(2, 10)})`;
      editor.insert(`\n${token}\n`);
      try {
        const res = await api.upload<{ uploaded: Array<{ id: string; filename: string; status: string }> }>(
          '/documents/upload',
          [file],
        );
        const up = res.uploaded?.[0];
        if (!up?.id) throw new Error(up?.status || 'upload rejected');
        const alt = (file.name || 'image').replace(/[[\]]/g, '');
        editor.replaceToken(token, `![${alt}](/api/documents/${up.id}/raw)`);
      } catch (err) {
        // Take the placeholder back out — a note left holding a dead
        // `#upload-…` link is worse than no image.
        editor.replaceToken(token, '');
        setUploadError(err instanceof Error ? err.message : 'Image upload failed');
      }
    }
  }

  const editor = (live && !collab) || props.liveLoading ? (
    <div className="py-2 text-[13px] text-on-surface-variant inline-flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Opening the note…</div>
  ) : (
    <NotesMarkdownEditor
      key={collab ? `${live?.session.noteId}:${live?.version}` : `plain:${selectedId ?? 'new'}`}
      ref={editorRef}
      collab={collab}
      value={draftBody}
      onChange={setDraftBody}
      onSave={onSave}
      getNotes={() => noteIndex}
      getTags={() => tags}
      onFiles={uploadImages}
      onOpenWikilink={onOpenSlug}
      onTag={onTagClick}
      placeholder={titleAuto && !draftBody ? 'Start with a title, then write…' : 'Start writing…'}
      onEscape={props.onEscape}
      autoFocus={props.autoFocus}
    />
  );

  const reading = draftBody.trim() ? (
    <Markdown
      content={draftBody}
      className="notes-prose"
      onWikilink={onOpenSlug}
      onTag={onTagClick}
      untrusted={textOnly}
      onToggleTask={readOnly ? undefined : props.onToggleTask}
    />
  ) : (
    <p className="text-[15px] text-on-surface-variant/70">
      {isNew ? 'Pick a note to read.' : 'This note is empty.'}
    </p>
  );

  const edited = editedText(props.updatedAt);
  // Tags written in the text show there; the line above names the others.
  const inlineTags = useMemo(() => new Set([...draftBody.matchAll(/(?:^|\s)#([a-zA-Z0-9_/-]*[a-zA-Z_/-][a-zA-Z0-9_/-]*)/g)].map((m) => m[1].toLowerCase())), [draftBody]);
  const day = draftKind === 'daily' ? dayLabel(noteDate) : null;
  // The meta line: the day (a daily note), where it is filed, when it was last edited, its tags.
  const folder = slug && slug.includes('/') ? slug.slice(0, slug.lastIndexOf('/')) : null;
  const meta = (
    <div className="notes-meta">
      {day && <span>{day}</span>}
      {folder && draftKind !== 'daily' && <span title={slug}>in {folder}</span>}
      {isNew && draftFolder && <span>in {draftFolder}</span>}
      {edited && !isNew && <span>{edited}</span>}
      {draftTags.filter((t) => !inlineTags.has(t)).map((t) => (
        <button key={t} type="button" onClick={() => onTagClick?.(t)} className="notes-tag-chip">#{t}</button>
      ))}
      {readOnly && <span className="notes-badge">Read-only</span>}
    </div>
  );

  const showTitleField = !titleAuto && (!readOnly || !!draftTitle);
  const title = readOnly || textOnly ? (
    draftTitle && !titleAuto ? <h1 className="notes-title">{draftTitle}</h1> : null
  ) : showTitleField ? (
    <input
      value={draftTitle}
      onChange={(e) => setDraftTitle(e.target.value)}
      onFocus={() => props.onTitleEditing?.(true)}
      onBlur={() => props.onTitleEditing?.(false)}
      onKeyDown={(e) => {
        // Enter goes on into the text, as on paper.
        if (e.key === 'Enter') { e.preventDefault(); editorRef.current?.focus(); }
      }}
      placeholder="Untitled note"
      aria-label="Title"
      className="notes-title"
    />
  ) : null;

  const canEdit = !readOnly;
  return (
    <div className="notes-editor" data-testid={readOnly ? 'note-reader' : 'note-editor'}>
      <div className="notes-bar">
        {props.leading}
        <div className="flex-1 min-w-0" />
        {mode === 'edit' && canEdit && (
          <div className="notes-format" role="toolbar" aria-label="Format">
            <ToolBtn title="Bold (⌘B)" onClick={() => editorRef.current?.wrap('**')}><Bold size={15} /></ToolBtn>
            <ToolBtn title="Italic (⌘I)" onClick={() => editorRef.current?.wrap('*')}><Italic size={15} /></ToolBtn>
            <ToolBtn title="Heading" onClick={() => editorRef.current?.linePrefix('## ')}><Heading2 size={15} /></ToolBtn>
            <ToolBtn title="Bullet list" onClick={() => editorRef.current?.linePrefix('- ')}><List size={15} /></ToolBtn>
            <ToolBtn title="Checklist" onClick={() => editorRef.current?.linePrefix('- [ ] ')}><ListChecks size={15} /></ToolBtn>
            <ToolBtn title="Link to a note ([[…]])" onClick={() => editorRef.current?.wrap('[[', ']]', 'Note title')}><Link2 size={15} /></ToolBtn>
            <ToolBtn title="Image (or just paste / drop one)" onClick={() => fileInputRef.current?.click()}><ImageIcon size={15} /></ToolBtn>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                // Reset first so picking the SAME file twice still fires change.
                e.target.value = '';
                void uploadImages(picked);
              }}
            />
            <span className="notes-bar-sep" />
          </div>
        )}
        {uploadError && (
          <button type="button" onClick={() => setUploadError(null)} title="Dismiss" className="text-[11px] text-error hover:opacity-80 truncate max-w-[12rem]">
            {uploadError} ✕
          </button>
        )}
        <PresenceStack peers={peers} />
        {status && (
          <span data-testid="live-status" className="inline-flex shrink-0 items-center gap-1 text-[12px] text-on-surface-variant" title={live?.state.savedAt ? `Saved ${new Date(live.state.savedAt).toLocaleTimeString()}` : undefined}>
            {status.icon} {status.text}
          </span>
        )}
        {live && live.state.notice && live.state.status !== 'closed' && (
          <span data-testid="live-notice" className="text-[11px] text-error max-w-[16rem] truncate" title={live.state.notice}>{live.state.notice}</span>
        )}
        {live && live.state.unmerged !== null && (
          <button
            type="button"
            onClick={() => {
              const text = live.state.unmerged ?? '';
              navigator.clipboard.writeText(text).then(
                () => live.session.dismissUnmerged(),
                (err: unknown) => console.error('Copying the unmerged text failed', err),
              );
            }}
            title="Copy the text you had, to redo what did not merge"
            className="notes-text-btn"
          >
            Copy my version
          </button>
        )}
        {props.autosave && !live && !textOnly && canEdit && <AutosaveIndicator state={props.autosave} onRetry={onSave} />}
        {!textOnly && canEdit && (live || !props.autosave) && (
          <button
            type="button"
            disabled={!(draftTitle || draftBody.trim()) || !dirty || saving}
            onClick={onSave}
            title={!dirty ? 'No changes' : live ? 'Save title, tags and kind (the text saves itself)' : 'Save (⌘S)'}
            className={cn('notes-text-btn', !live && 'is-primary')}
          >
            {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />} {live ? 'Save details' : 'Save'}
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => setMode(mode === 'read' ? 'edit' : 'read')}
            aria-pressed={mode === 'read'}
            title={mode === 'read' ? 'Back to editing' : 'Reading view'}
            aria-label={mode === 'read' ? 'Edit' : 'Reading view'}
            className="notes-icon-btn"
          >
            {mode === 'read' ? <PencilLine size={17} /> : <BookOpen size={17} />}
          </button>
        )}
        {!isNew && !textOnly && canEdit && (
          <button type="button" onClick={onArchive} title="Archive note" aria-label="Archive note" className="notes-icon-btn is-danger">
            <Trash2 size={17} />
          </button>
        )}
        {!textOnly && canEdit && (
          <NoteDetailsMenu
            isNew={isNew}
            title={titleAuto ? '' : draftTitle}
            titlePlaceholder={titleAuto ? draftTitle || 'From the first line' : 'From the first line'}
            setTitle={setDraftTitle}
            tags={draftTags}
            setTags={setDraftTags}
            tagSuggestions={tags}
            kind={draftKind}
            setKind={setDraftKind}
            folder={draftFolder}
            setFolder={setDraftFolder}
            slug={slug}
            noteDate={noteDate}
            pinned={pinned}
            onTogglePin={onTogglePin}
            onMove={props.onMove}
            onTitleEditing={props.onTitleEditing}
          />
        )}
        {props.trailing}
      </div>
      {props.notices}
      <div className="notes-scroll">
        <article className="notes-sheet">
          {title}
          {meta}
          {mode === 'read' ? <div className="notes-reading">{reading}</div> : <div className={cn('notes-body', titleAuto && 'is-title-first')}>{editor}</div>}
        </article>
      </div>
    </div>
  );
}
