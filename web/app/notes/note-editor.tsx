'use client';

import {
  Bold, Check, CloudOff, Code, Columns2, ExternalLink, Eye, Hash, Heading1, Heading2, Image as ImageIcon,
  Italic, Link2, List, Loader2, Pencil, Quote, Save, Star, Trash2, X,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type { LiveNoteState } from '@/lib/live-note';
import { Markdown } from '@/components/ui/markdown-renderer';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import NotesMarkdownEditor, { type MarkdownEditorHandle } from './markdown-codemirror';
import type { NoteIndexEntry, TagCount } from './types';
import type { LiveNote } from './use-live-note';

export type EditorMode = 'edit' | 'preview' | 'split';

interface EditorProps {
  selectedId: string | null;
  draftTitle: string;
  setDraftTitle: (v: string) => void;
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
  pinned: boolean;
  onTogglePin: () => void;
  mode: EditorMode;
  setMode: (m: EditorMode) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onArchive: () => void;
  noteIndex: NoteIndexEntry[];
  tags: TagCount[];
  /** Open a linked note from a `[[wikilink]]` in the preview. */
  onOpenSlug?: (slug: string) => void;
  /** Filter by an inline `#tag` clicked in the preview. */
  onTagClick?: (tag: string) => void;
  /**
   * The caller may not edit (a commenter or viewer in a space, or an
   * archived space): the note shows as a preview with no editing controls.
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
   * Only the text is edited here — a note of a space on another install
   * (federation §8.3): its title, tags, kind, pin and archive are the
   * host's to manage, so none of those controls show.
   */
  textOnly?: boolean;
}

const KINDS = ['note', 'daily', 'moc', 'literature'];

function ToolBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()} // keep the editor selection
      onClick={onClick}
      className="p-1.5 rounded-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
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

function ModeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 rounded-xs text-[11px] transition-colors',
        active ? 'bg-primary-container/50 text-primary' : 'text-on-surface-variant hover:bg-surface-container-high',
      )}
    >
      {children}
    </button>
  );
}

export function NoteEditor(props: EditorProps) {
  const {
    selectedId, draftTitle, setDraftTitle, draftBody, setDraftBody, draftTags, setDraftTags,
    draftKind, setDraftKind, draftFolder, setDraftFolder, slug, noteDate, pinned, onTogglePin,
    mode: requestedMode, setMode, dirty, saving, onSave, onArchive, noteIndex, tags, onOpenSlug, onTagClick, live,
  } = props;
  const readOnly = (props.readOnly ?? false) || (live?.synced === true && live.state.readOnly);
  const textOnly = props.textOnly ?? false;
  const mode: EditorMode = readOnly ? 'preview' : requestedMode;
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
  const [tagInput, setTagInput] = useState('');
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

  function addTag(raw: string) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9/_-]/g, '');
    if (t && !draftTags.includes(t)) setDraftTags([...draftTags, t]);
    setTagInput('');
  }

  const editor = (live && !collab) || props.liveLoading ? (
    <div className="p-4 text-[12px] text-on-surface-variant inline-flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Opening the note…</div>
  ) : (
    <NotesMarkdownEditor
      key={collab ? `${live?.session.noteId}:${live?.version}` : 'plain'}
      ref={editorRef}
      collab={collab}
      value={draftBody}
      onChange={setDraftBody}
      onSave={onSave}
      getNotes={() => noteIndex}
      getTags={() => tags}
      onFiles={uploadImages}
    />
  );

  const preview = draftBody.trim() ? (
    <Markdown content={draftBody} className="max-w-none px-1" onWikilink={onOpenSlug} onTag={onTagClick} untrusted={textOnly} />
  ) : (
    <p className="text-[13px] text-on-surface-variant/60">
      {readOnly ? (isNew ? 'Pick a note to read.' : 'This note is empty.') : 'Nothing to preview yet — switch to Edit to start writing.'}
    </p>
  );

  if (readOnly) {
    return (
      <div className="h-full flex flex-col min-w-0" data-testid="note-reader">
        <div className="flex items-center gap-2 px-5 pt-4 shrink-0">
          <h2 className="flex-1 min-w-0 text-xl font-semibold truncate">{draftTitle || (isNew ? 'Notes' : '')}</h2>
          <PresenceStack peers={peers} />
          {live?.state.notice && <span className="text-[11px] text-error">{live.state.notice}</span>}
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xs border border-outline-variant/40 text-[11px] text-on-surface-variant">
            <Eye size={12} /> read-only
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 pt-2 pb-2 shrink-0 text-[12px]">
          {draftTags.map((t) => (
            <span key={t} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-primary-container/60 text-primary text-[11px]">
              <Hash size={9} />{t}
            </span>
          ))}
          {!isNew && (
            <span className="inline-flex items-center gap-1 text-on-surface-variant/60 font-mono text-[11px]">
              {draftKind} <span className="text-outline">·</span> {slug}
              {noteDate && <span className="text-outline"> · {noteDate}</span>}
            </span>
          )}
        </div>
        <div className="flex-1 min-h-0 px-5 pb-5">
          <div className="h-full overflow-y-auto term-frame rounded-xs p-4">{preview}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-w-0">
      {/* Title + actions */}
      <div className="flex items-center gap-2 px-5 pt-4 shrink-0">
        <input
          value={draftTitle}
          readOnly={textOnly}
          onChange={(e) => setDraftTitle(e.target.value)}
          placeholder="Untitled note"
          className="flex-1 min-w-0 text-xl font-semibold bg-transparent outline-none placeholder:text-on-surface-variant/40"
        />
        <PresenceStack peers={peers} />
        {status && (
          <span data-testid="live-status" className="inline-flex items-center gap-1 text-[11px] text-on-surface-variant" title={live?.state.savedAt ? `Saved ${new Date(live.state.savedAt).toLocaleTimeString()}` : undefined}>
            {status.icon} {status.text}
          </span>
        )}
        {live && live.state.notice && live.state.status !== 'closed' && (
          <span data-testid="live-notice" className="text-[11px] text-error max-w-[22rem] truncate" title={live.state.notice}>{live.state.notice}</span>
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
            className="px-2 py-1 rounded-xs border border-outline-variant/40 text-[11px] hover:bg-surface-container-high"
          >
            Copy my version
          </button>
        )}
        {!isNew && !textOnly && (
          <button
            type="button"
            onClick={onTogglePin}
            title={pinned ? 'Unpin' : 'Pin'}
            className={cn('p-1.5 rounded-xs hover:bg-surface-container-high', pinned ? 'text-warning' : 'text-on-surface-variant')}
          >
            <Star size={16} className={pinned ? 'fill-warning/40' : ''} />
          </button>
        )}
        {!textOnly && <button
          type="button"
          disabled={!draftTitle || !dirty || saving}
          onClick={onSave}
          title={!draftTitle ? 'Add a title first' : !dirty ? 'No changes' : live ? 'Save title, tags and kind (the text saves itself)' : 'Save (⌘S)'}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xs text-[13px] font-medium disabled:opacity-40',
            live ? 'border border-outline-variant/40 text-on-surface' : 'bg-primary text-on-primary',
          )}
        >
          {saving ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />} {live ? 'Save details' : 'Save'}
        </button>}
        {!isNew && !textOnly && (
          <button
            type="button"
            onClick={onArchive}
            title="Archive note"
            className="p-1.5 rounded-xs border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container-high hover:text-error"
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>

      {/* Properties bar: tags · kind · location/date */}
      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 pt-2 pb-2 shrink-0 text-[12px]', textOnly && 'hidden')}>
        <div className="flex flex-wrap items-center gap-1">
          {draftTags.map((t) => (
            <span key={t} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-primary-container/60 text-primary text-[11px]">
              <Hash size={9} />{t}
              <button type="button" onClick={() => setDraftTags(draftTags.filter((x) => x !== t))} className="hover:text-on-surface ml-0.5">
                <X size={9} />
              </button>
            </span>
          ))}
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput); }
              if (e.key === 'Backspace' && !tagInput && draftTags.length) setDraftTags(draftTags.slice(0, -1));
            }}
            list="note-tag-suggestions"
            placeholder="+ tag"
            className="w-20 bg-transparent outline-none text-[11px] placeholder:text-on-surface-variant/40"
          />
          <datalist id="note-tag-suggestions">
            {tags.map((t) => <option key={t.tag} value={t.tag} />)}
          </datalist>
        </div>

        <span className="text-outline">·</span>

        <label className="inline-flex items-center gap-1 text-on-surface-variant">
          kind
          <select
            value={draftKind}
            onChange={(e) => setDraftKind(e.target.value)}
            className="bg-surface-container-high border border-outline-variant/40 rounded-xs px-1 py-0.5 text-[11px] text-on-surface outline-none"
          >
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>

        {isNew ? (
          <label className="inline-flex items-center gap-1 text-on-surface-variant">
            <span className="text-outline">·</span> folder
            <input
              value={draftFolder}
              onChange={(e) => setDraftFolder(e.target.value)}
              placeholder="e.g. projects/octipus"
              className="w-40 bg-surface-container-high border border-outline-variant/40 rounded-xs px-1.5 py-0.5 text-[11px] outline-none placeholder:text-on-surface-variant/40"
            />
          </label>
        ) : (
          <span className="inline-flex items-center gap-1 text-on-surface-variant/60 font-mono text-[11px]">
            <span className="text-outline">·</span> {slug}
            {noteDate && <span className="text-outline"> · {noteDate}</span>}
          </span>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          <ModeBtn active={mode === 'edit'} onClick={() => setMode('edit')}><Pencil size={12} /> edit</ModeBtn>
          <ModeBtn active={mode === 'split'} onClick={() => setMode('split')}><Columns2 size={12} /> split</ModeBtn>
          <ModeBtn active={mode === 'preview'} onClick={() => setMode('preview')}><Eye size={12} /> preview</ModeBtn>
        </div>
      </div>

      {/* Formatting toolbar (edit/split only) */}
      {mode !== 'preview' && (
        <div className="flex items-center gap-0.5 mx-5 mb-1.5 px-1 py-0.5 border border-outline-variant/40 rounded-xs bg-surface-container/50 shrink-0">
          <ToolBtn title="Bold" onClick={() => editorRef.current?.wrap('**')}><Bold size={14} /></ToolBtn>
          <ToolBtn title="Italic" onClick={() => editorRef.current?.wrap('*')}><Italic size={14} /></ToolBtn>
          <ToolBtn title="Inline code" onClick={() => editorRef.current?.wrap('`')}><Code size={14} /></ToolBtn>
          <span className="w-px h-4 bg-outline-variant/40 mx-1" />
          <ToolBtn title="Heading 1" onClick={() => editorRef.current?.linePrefix('# ')}><Heading1 size={14} /></ToolBtn>
          <ToolBtn title="Heading 2" onClick={() => editorRef.current?.linePrefix('## ')}><Heading2 size={14} /></ToolBtn>
          <ToolBtn title="Bullet list" onClick={() => editorRef.current?.linePrefix('- ')}><List size={14} /></ToolBtn>
          <ToolBtn title="Quote" onClick={() => editorRef.current?.linePrefix('> ')}><Quote size={14} /></ToolBtn>
          <span className="w-px h-4 bg-outline-variant/40 mx-1" />
          <ToolBtn title="Link to a note ([[…]])" onClick={() => editorRef.current?.wrap('[[', ']]', 'Note Title')}><Link2 size={14} /></ToolBtn>
          <ToolBtn title="Web link" onClick={() => editorRef.current?.wrap('[', '](https://)', 'link text')}><ExternalLink size={14} /></ToolBtn>
          <ToolBtn title="Image (or just paste / drop one)" onClick={() => fileInputRef.current?.click()}><ImageIcon size={14} /></ToolBtn>
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
          {uploadError && (
            <button
              type="button"
              onClick={() => setUploadError(null)}
              title="Dismiss"
              className="ml-2 text-[10px] text-error hover:opacity-80"
            >
              {uploadError} ✕
            </button>
          )}
          {dirty && <span className="ml-auto pr-1 text-[10px] text-on-surface-variant/60">unsaved</span>}
        </div>
      )}

      {/* Body — fills remaining height to the very bottom */}
      <div className="flex-1 min-h-0 px-5 pb-5">
        {mode === 'preview' && (
          <div className="h-full overflow-y-auto term-frame rounded-xs p-4">{preview}</div>
        )}
        {mode === 'edit' && (
          <div className="h-full term-frame rounded-xs overflow-hidden">{editor}</div>
        )}
        {mode === 'split' && (
          <div className="h-full grid grid-cols-2 gap-3">
            <div className="h-full term-frame rounded-xs overflow-hidden">{editor}</div>
            <div className="h-full overflow-y-auto term-frame rounded-xs p-4">{preview}</div>
          </div>
        )}
      </div>
    </div>
  );
}
