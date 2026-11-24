'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useGateway } from '@/lib/gateway-context';
import { type RemoteSpace, remoteNotesSource } from '@/lib/remote-spaces';
import { useWorkspaceAccess } from '@/lib/workspace-context';
import { type EditorMode, NoteEditor } from './note-editor';
import { NotesNavigator } from './notes-navigator';
import type { NoteFilter, NoteRow } from './types';
import { useLiveNote } from './use-live-note';

/** Merging a rebuilt document's leftovers is a host route visitors do not have: the text stays the member's to copy. */
const keepUnmerged = async (): Promise<'conflict'> => 'conflict';

/**
 * The notes of a space on another install (federation §8.3), in the same
 * navigator and editor as a space here, through the remote notes source:
 * the list and each note are read live from the host; an editor edits the
 * note live through `remote.frame` (the host saves it, "Saved"); a
 * commenter or viewer reads. Titles, tags, history and proposals are the
 * host's to manage there.
 */
export function RemoteNotesWorkspace({ remote }: { remote: RemoteSpace }) {
  const gateway = useGateway();
  const { canWrite } = useWorkspaceAccess();
  const source = useMemo(() => remoteNotesSource(remote.id, gateway), [remote.id, gateway]);
  const via = useMemo(() => ({ gateway: source.gateway, merge: keepUnmerged }), [source]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>('edit');
  const [filter, setFilter] = useState<NoteFilter>('all');
  const [search, setSearch] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState('');

  const list = useQuery({ queryKey: ['remote-notes', remote.id], queryFn: () => source.list() });
  const detail = useQuery({
    queryKey: ['remote-note', remote.id, selectedId],
    queryFn: () => source.read(selectedId as string),
    enabled: !!selectedId,
  });
  const live = useLiveNote(selectedId, canWrite, via);
  const liveSession = live?.session ?? null;
  const liveVersion = live?.version ?? 0;
  const liveSynced = live?.synced ?? false;

  // The live text drives the preview; before it syncs, the note as read.
  useEffect(() => {
    if (!liveSession || !liveSynced) return;
    const text = liveSession.text;
    const sync = () => setDraftBody(text.toString());
    sync();
    text.observe(sync);
    return () => text.unobserve(sync);
  }, [liveSession, liveVersion, liveSynced]);

  const notes: NoteRow[] = (list.data ?? []).map((n) => ({ id: n.id, slug: n.slug, title: n.title, noteKind: 'note', tags: [], pinned: false, updatedAt: n.updatedAt }));
  const noop = () => {};

  return (
    <div className="notes-page is-row" data-testid="remote-notes">
      <aside className="notes-nav" style={{ width: 300 }}>
        <NotesNavigator
          notes={notes}
          tags={[]}
          isLoading={list.isLoading}
          selectedId={selectedId}
          filter={filter}
          setFilter={setFilter}
          search={search}
          setSearch={setSearch}
          activeTag={activeTag}
          setActiveTag={setActiveTag}
          onOpen={(n) => { setSelectedId(n.id); setMode('edit'); }}
        />
      </aside>
      <main className="notes-main">
        <div className="px-5 pt-2 text-[12px] text-on-surface-variant" title={remote.hostFingerprint}>
          {remote.spaceName} · hosted by <span className="font-mono">{remote.hostBadge}</span>
          {list.error && <span role="alert" className="text-error"> · ! {(list.error as Error).message}</span>}
          {detail.error && <span role="alert" className="text-error"> · ! {(detail.error as Error).message}</span>}
        </div>
        <div className="flex-1 min-h-0 flex flex-col">
          {!selectedId ? (
            <div className="notes-blank-inner"><p>Pick a note on the left.</p></div>
          ) : <NoteEditor
            selectedId={selectedId}
            draftTitle={detail.data?.title ?? ''}
            setDraftTitle={noop}
            draftBody={liveSynced ? draftBody : detail.data?.id === selectedId ? (detail.data?.body ?? '') : ''}
            setDraftBody={setDraftBody}
            draftTags={[]}
            setDraftTags={noop}
            draftKind="note"
            setDraftKind={noop}
            draftFolder=""
            setDraftFolder={noop}
            slug={detail.data?.slug}
            pinned={false}
            onTogglePin={noop}
            mode={mode}
            setMode={setMode}
            dirty={false}
            saving={false}
            onSave={noop}
            onArchive={noop}
            noteIndex={[]}
            tags={[]}
            readOnly={!canWrite}
            live={live}
            liveLoading={canWrite && !!selectedId && !liveSynced}
            textOnly
          />}
        </div>
      </main>
    </div>
  );
}
