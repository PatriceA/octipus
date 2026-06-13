'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, PanelRight, ScrollText } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { CTX_MAX, CTX_MIN, NAV_MAX, NAV_MIN, useNotesUiStore } from '@/lib/notes-ui-store';
import { cn } from '@/lib/utils';
import { KnowledgeGraph } from './knowledge-graph';
import { NoteContext } from './note-context';
import { type EditorMode, NoteEditor } from './note-editor';
import { NotesNavigator } from './notes-navigator';
import type {
  NoteDetail, NoteFilter, NoteIndexEntry, NoteListResponse, NoteRow, Suggestion, TagCount,
} from './types';

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

export function NotesWorkspace() {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { navWidth, ctxWidth, ctxCollapsed, setNavWidth, setCtxWidth, toggleCtx, setCtxCollapsed } = useNotesUiStore();

  const [view, setView] = useState<'list' | 'graph'>(searchParams.get('view') === 'graph' ? 'graph' : 'list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  // Navigator filter state.
  const [filter, setFilter] = useState<NoteFilter>('all');
  const [search, setSearch] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // The id whose body we've loaded into the draft — so a background refetch of
  // the SAME note doesn't clobber in-progress edits.
  const loadedRef = useRef<string | null>(null);

  const list = useQuery<NoteListResponse>({ queryKey: ['notes'], queryFn: () => api.get<NoteListResponse>('/notes?limit=500') });
  const detail = useQuery<NoteDetail>({
    queryKey: ['note', selectedId],
    queryFn: () => api.get<NoteDetail>(`/notes/${selectedId}`),
    enabled: !!selectedId,
  });
  const suggestions = useQuery<{ suggestions: Suggestion[] }>({
    queryKey: ['note-suggestions', selectedId],
    queryFn: () => api.get<{ suggestions: Suggestion[] }>(`/notes/${selectedId}/suggestions`),
    enabled: !!selectedId,
  });
  const noteIndexQ = useQuery<{ notes: NoteIndexEntry[] }>({
    queryKey: ['note-index'],
    queryFn: () => api.get<{ notes: NoteIndexEntry[] }>('/notes/index'),
  });
  const tagsQ = useQuery<{ tags: TagCount[] }>({
    queryKey: ['note-tags'],
    queryFn: () => api.get<{ tags: TagCount[] }>('/notes/tags'),
  });

  const notes = list.data?.notes ?? [];
  const noteIndex = noteIndexQ.data?.notes ?? [];
  const tags = tagsQ.data?.tags ?? [];

  // Load a fetched note into the draft + clean baseline exactly once per note.
  useEffect(() => {
    const d = detail.data;
    if (d && d.id === selectedId && loadedRef.current !== d.id) {
      loadedRef.current = d.id;
      setDraftTitle(d.title); setDraftBody(d.body); setDraftTags(d.tags); setDraftKind(d.noteKind);
      setSavedTitle(d.title); setSavedBody(d.body); setSavedTags(d.tags); setSavedKind(d.noteKind);
    }
  }, [detail.data, selectedId]);

  const dirty =
    draftTitle !== savedTitle || draftBody !== savedBody || draftKind !== savedKind || !sameTags(draftTags, savedTags);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['notes'] });
    qc.invalidateQueries({ queryKey: ['note-index'] });
    qc.invalidateQueries({ queryKey: ['note-tags'] });
    qc.invalidateQueries({ queryKey: ['graph'] });
  };

  const save = useMutation({
    mutationFn: (payload: { id?: string; title: string; body: string; tags: string[]; noteKind: string; slug?: string }) =>
      api.post<{ note: NoteRow }>('/notes', payload),
    onSuccess: (res, vars) => {
      setSelectedId(res.note.id);
      loadedRef.current = res.note.id;
      setSavedTitle(vars.title); setSavedBody(vars.body); setSavedTags(vars.tags); setSavedKind(vars.noteKind);
      setDraftFolder('');
      invalidateAll();
      qc.invalidateQueries({ queryKey: ['note', res.note.id] });
      qc.invalidateQueries({ queryKey: ['note-suggestions', res.note.id] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/notes/${id}`),
    onSuccess: () => {
      setSelectedId(null);
      loadedRef.current = null;
      setDraftTitle(''); setDraftBody(''); setDraftTags([]); setDraftKind('note');
      setSavedTitle(''); setSavedBody(''); setSavedTags([]); setSavedKind('note');
      invalidateAll();
    },
  });

  const pin = useMutation({
    mutationFn: (vars: { id: string; pinned: boolean }) => api.patch(`/notes/${vars.id}/pin`, { pinned: vars.pinned }),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['notes'] });
      qc.invalidateQueries({ queryKey: ['note', vars.id] });
    },
  });

  function confirmDiscard(): boolean {
    return !dirty || window.confirm('Discard unsaved changes?');
  }

  function resetDrafts(kind = 'note') {
    setDraftTitle(''); setDraftBody(''); setDraftTags([]); setDraftKind(kind);
    setSavedTitle(''); setSavedBody(''); setSavedTags([]); setSavedKind(kind);
  }

  function selectNote(id: string) {
    if (id === selectedId) return;
    if (!confirmDiscard()) return;
    setSelectedId(id);
    loadedRef.current = null;
    // Blank the draft until the note's detail resolves so the editor never
    // shows the previous note's content (the load effect repopulates).
    resetDrafts();
    setMode('preview');
    if (view !== 'list') changeView('list');
  }

  function openSlug(slug: string) {
    const target = notes.find((n) => n.slug === slug) ?? noteIndex.find((n) => n.slug === slug);
    if (target) selectNote(target.id);
  }

  function openNew(folder?: string) {
    if (!confirmDiscard()) return;
    setSelectedId(null);
    loadedRef.current = null;
    // Match saved===draft for the initial kind so a brand-new note isn't
    // marked dirty before the user types anything.
    resetDrafts(folder?.split('/')[0] === 'daily' ? 'daily' : 'note');
    setDraftFolder(folder ?? '');
    setMode('edit');
    if (view !== 'list') changeView('list');
  }

  function doSave() {
    if (!draftTitle || !dirty || save.isPending) return;
    const isNew = !selectedId;
    const slug = isNew && draftFolder.trim() ? `${draftFolder.trim()}/${draftTitle}` : undefined;
    save.mutate({ id: selectedId ?? undefined, title: draftTitle, body: draftBody, tags: draftTags, noteKind: draftKind, slug });
  }

  function addLink(s: Suggestion) {
    const title = s.title ?? s.id;
    if (hasLink(draftBody, title)) return;
    const next = draftBody.trim() ? `${draftBody.trimEnd()}\n\n[[${title}]]` : `[[${title}]]`;
    setDraftBody(next);
    if (selectedId && draftTitle) {
      save.mutate({ id: selectedId, title: draftTitle, body: next, tags: draftTags, noteKind: draftKind });
    }
  }

  function changeView(v: 'list' | 'graph') {
    setView(v);
    router.replace(v === 'graph' ? '/notes?view=graph' : '/notes');
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

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Top bar — prompt + view toggle */}
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
              onClick={() => changeView('list')}
              className={cn('inline-flex items-center gap-1 px-2.5 py-1', view === 'list' ? 'bg-primary-container/50 text-primary' : 'text-on-surface-variant hover:bg-surface-container-high')}
            >
              <ScrollText size={13} /> list
            </button>
            <button
              type="button"
              onClick={() => changeView('graph')}
              className={cn('inline-flex items-center gap-1 px-2.5 py-1 border-l border-outline-variant/40', view === 'graph' ? 'bg-primary-container/50 text-primary' : 'text-on-surface-variant hover:bg-surface-container-high')}
            >
              <Network size={13} /> graph
            </button>
          </div>
          {view === 'list' && ctxCollapsed && (
            <button
              type="button"
              onClick={() => setCtxCollapsed(false)}
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
          <KnowledgeGraph onOpenNote={(id) => selectNote(id)} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          <aside style={{ width: safeNavWidth }} className="shrink-0 border-r border-outline-variant/30 bg-surface-container-lowest/40">
            <NotesNavigator
              notes={notes}
              tags={tags}
              isLoading={list.isLoading}
              selectedId={selectedId}
              filter={filter}
              setFilter={setFilter}
              search={search}
              setSearch={setSearch}
              activeTag={activeTag}
              setActiveTag={setActiveTag}
              onOpen={(n) => selectNote(n.id)}
              onNew={openNew}
            />
          </aside>
          <div onPointerDown={startResize('nav')} className={resizerClass} role="separator" aria-orientation="vertical" />

          <main className="flex-1 min-w-0">
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
              onArchive={() => selectedId && del.mutate(selectedId)}
              noteIndex={noteIndex}
              tags={tags}
              onOpenSlug={openSlug}
              onTagClick={(t) => { setActiveTag(t); setFilter('all'); }}
            />
          </main>

          {!ctxCollapsed && (
            <>
              <div onPointerDown={startResize('ctx')} className={resizerClass} role="separator" aria-orientation="vertical" />
              <aside style={{ width: safeCtxWidth }} className="shrink-0 border-l border-outline-variant/30 bg-surface-container-lowest/40">
                <NoteContext
                  detail={selectedId ? detail.data : undefined}
                  suggestions={suggestions.data?.suggestions ?? []}
                  suggestionsLoading={suggestions.isLoading}
                  bodyHasLink={(title) => hasLink(draftBody, title)}
                  onOpenNote={(id) => selectNote(id)}
                  onAddLink={addLink}
                  onTagClick={(t) => { setActiveTag(t); setFilter('all'); }}
                  onCollapse={toggleCtx}
                />
              </aside>
            </>
          )}
        </div>
      )}
    </div>
  );
}
