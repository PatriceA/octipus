'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bold, Code, Eye, Hash, Heading1, Heading2, Italic, Link2, List, Loader2,
  Pencil, Plus, Quote, Save, Sparkles, Trash2, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '@/components/ui/markdown-renderer';
import { api } from '@/lib/api';

interface NoteRow {
  id: string;
  slug: string;
  title: string;
  noteKind: string;
  tags: string[];
  updatedAt: string;
}
interface NoteListResponse { notes: NoteRow[]; total: number }

interface LinkEdge { id: string; from?: { type: string; id: string }; to?: { type: string; id: string } | null; linkType: string; label: string | null; }
interface NoteDetail extends NoteRow { body: string; backlinks: LinkEdge[]; outgoing: LinkEdge[] }
interface Suggestion { type: string; id: string; title?: string; similarity: number }

export default function NotesPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  // The last-saved snapshot — drives the dirty check so Save only lights up on
  // a real change (the QA: "save button just enabled if there was a change").
  const [savedTitle, setSavedTitle] = useState('');
  const [savedBody, setSavedBody] = useState('');
  // Preview is the default on open; Edit is the deliberate switch (the QA).
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Id whose body we've already loaded into the draft — so a background
  // refetch of the SAME note doesn't clobber in-progress edits, while
  // switching to a DIFFERENT note still loads fresh.
  const loadedRef = useRef<string | null>(null);

  const list = useQuery<NoteListResponse>({
    queryKey: ['notes', tagFilter],
    queryFn: () => api.get<NoteListResponse>(`/notes${tagFilter ? `?tag=${encodeURIComponent(tagFilter)}` : ''}`),
  });

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

  // Load the fetched note into the draft + clean baseline exactly once per
  // note (keyed by loadedRef). Deriving from the query — rather than a second
  // imperative fetch in openNote — keeps the dirty check from going
  // false-positive after a background refetch.
  useEffect(() => {
    const d = detail.data;
    if (d && d.id === selectedId && loadedRef.current !== d.id) {
      loadedRef.current = d.id;
      setDraftTitle(d.title); setDraftBody(d.body);
      setSavedTitle(d.title); setSavedBody(d.body);
    }
  }, [detail.data, selectedId]);

  // Every distinct tag across the loaded list, for the filter rail.
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const n of list.data?.notes ?? []) for (const t of n.tags) s.add(t);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [list.data]);

  const dirty = draftTitle !== savedTitle || draftBody !== savedBody;

  const save = useMutation({
    mutationFn: (payload: { id?: string; title: string; body: string }) =>
      api.post<{ note: NoteRow }>('/notes', payload),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: ['notes'] });
      setSelectedId(res.note.id);
      // The just-saved values become the clean baseline. Mark this id loaded so
      // the refetch effect doesn't reload (and clobber) edits made after save.
      loadedRef.current = res.note.id;
      setSavedTitle(vars.title);
      setSavedBody(vars.body);
      qc.invalidateQueries({ queryKey: ['note', res.note.id] });
      qc.invalidateQueries({ queryKey: ['note-suggestions', res.note.id] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/notes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notes'] });
      setSelectedId(null);
      loadedRef.current = null;
      setDraftTitle(''); setDraftBody(''); setSavedTitle(''); setSavedBody('');
    },
  });

  function openNew() {
    setSelectedId(null);
    loadedRef.current = null;
    setDraftTitle(''); setDraftBody('');
    setSavedTitle(''); setSavedBody('');
    setMode('edit'); // a blank note opens ready to type
  }

  function openNote(n: NoteRow) {
    setSelectedId(n.id);
    setMode('preview'); // existing notes open in preview, edit on demand
    // The draft/baseline is loaded by the effect above once `detail` resolves.
  }

  function doSave() {
    if (!draftTitle || !dirty) return;
    save.mutate({ id: selectedId ?? undefined, title: draftTitle, body: draftBody });
  }

  /** Wrap the current selection (or a placeholder) with markdown delimiters. */
  function wrap(before: string, after = before, placeholder = 'text') {
    const ta = bodyRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const sel = draftBody.slice(start, end) || placeholder;
    const next = draftBody.slice(0, start) + before + sel + after + draftBody.slice(end);
    setDraftBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + before.length, start + before.length + sel.length);
    });
  }

  /** Prepend a token to the start of the line the caret is on (headings/list/quote). */
  function linePrefix(prefix: string) {
    const ta = bodyRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const lineStart = draftBody.lastIndexOf('\n', start - 1) + 1;
    const next = draftBody.slice(0, lineStart) + prefix + draftBody.slice(lineStart);
    setDraftBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + prefix.length, start + prefix.length);
    });
  }

  /** Add a suggested note as a [[wikilink]] and persist (the QA's "+ to add"). */
  function addLink(s: Suggestion) {
    const title = s.title ?? s.id;
    if (hasLink(draftBody, title)) return;
    const next = draftBody.trim() ? `${draftBody.trimEnd()}\n\n[[${title}]]` : `[[${title}]]`;
    setDraftBody(next);
    // Persist immediately for an existing note so the graph/backlinks update;
    // for an unsaved note it just stages the link for the next Save.
    if (selectedId && draftTitle) save.mutate({ id: selectedId, title: draftTitle, body: next });
  }

  return (
    <div className="flex h-full">
      {/* List */}
      <aside className="w-72 border-r border-border overflow-y-auto p-3 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold lowercase font-mono">
            <span className="text-outline">octi:</span>
            <span className="text-on-surface">~/notes</span>
            <span className="text-primary font-bold"> $</span>
            <span aria-hidden className="term-caret" />
          </h2>
          <button type="button" onClick={openNew} className="p-1 rounded hover:bg-surface-container-high" title="New note">
            <Plus size={16} />
          </button>
        </div>

        {/* Tag filter rail — chips you can click to narrow the list (the QA:
            "i cant filter by tag"). */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {tagFilter && (
              <button
                type="button"
                onClick={() => setTagFilter(null)}
                className="text-[11px] px-1.5 py-0.5 rounded-full bg-primary-container text-primary inline-flex items-center gap-0.5"
              >
                <X size={10} /> {tagFilter}
              </button>
            )}
            {allTags.filter((t) => t !== tagFilter).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTagFilter(t)}
                className="text-[11px] px-1.5 py-0.5 rounded-full bg-surface-container-high text-muted-foreground hover:text-on-surface inline-flex items-center gap-0.5"
              >
                <Hash size={9} />{t}
              </button>
            ))}
          </div>
        )}

        {list.isLoading && <Loader2 className="animate-spin" size={16} />}
        <ul className="space-y-1 stagger">
          {list.data?.notes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => openNote(n)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-surface-container-high ${selectedId === n.id ? 'bg-primary-container/40' : ''}`}
              >
                <div className="font-medium truncate">{n.title}</div>
                <div className="text-xs text-muted-foreground truncate">{n.slug} · {n.noteKind}</div>
                {n.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {n.tags.slice(0, 4).map((t) => (
                      <span
                        key={t}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); setTagFilter(t); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setTagFilter(t); } }}
                        className="text-[10px] px-1 rounded bg-primary-container/60 text-primary inline-flex items-center"
                      >
                        <Hash size={8} />{t}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            </li>
          ))}
          {list.data?.notes.length === 0 && (
            <li className="py-8 text-center font-mono">
              <p aria-hidden className="text-2xl text-on-surface-variant/40">#</p>
              <p className="mt-2 text-sm text-muted-foreground">{tagFilter ? `no notes tagged #${tagFilter}` : 'no notes yet'}</p>
            </li>
          )}
        </ul>
      </aside>

      {/* Editor */}
      <main className="flex-1 overflow-y-auto p-6 max-w-3xl">
        <input
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          placeholder="Note title"
          className="w-full text-2xl font-semibold bg-transparent outline-none mb-3"
        />

        {/* Mode toggle */}
        <div className="flex items-center gap-1 mb-2">
          <button
            type="button"
            onClick={() => setMode('edit')}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${mode === 'edit' ? 'bg-primary-container/40 text-primary' : 'hover:bg-surface-container-high'}`}
          >
            <Pencil size={12} /> Edit
          </button>
          <button
            type="button"
            onClick={() => setMode('preview')}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${mode === 'preview' ? 'bg-primary-container/40 text-primary' : 'hover:bg-surface-container-high'}`}
          >
            <Eye size={12} /> Preview
          </button>
        </div>

        {mode === 'edit' ? (
          <>
            {/* Formatting toolbar — acts on the textarea selection. */}
            <div className="flex items-center gap-0.5 mb-1 border border-border rounded-t bg-surface/50 px-1 py-1">
              <ToolBtn title="Bold (**)" onClick={() => wrap('**')}><Bold size={14} /></ToolBtn>
              <ToolBtn title="Italic (*)" onClick={() => wrap('*')}><Italic size={14} /></ToolBtn>
              <ToolBtn title="Inline code (`)" onClick={() => wrap('`')}><Code size={14} /></ToolBtn>
              <span className="w-px h-4 bg-border mx-1" />
              <ToolBtn title="Heading 1" onClick={() => linePrefix('# ')}><Heading1 size={14} /></ToolBtn>
              <ToolBtn title="Heading 2" onClick={() => linePrefix('## ')}><Heading2 size={14} /></ToolBtn>
              <ToolBtn title="Bullet list" onClick={() => linePrefix('- ')}><List size={14} /></ToolBtn>
              <ToolBtn title="Quote" onClick={() => linePrefix('> ')}><Quote size={14} /></ToolBtn>
              <span className="w-px h-4 bg-border mx-1" />
              <ToolBtn title="Link to a note ([[…]])" onClick={() => wrap('[[', ']]', 'Note Title')}><Link2 size={14} /></ToolBtn>
            </div>
            <textarea
              ref={bodyRef}
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder="Write markdown. Use [[wikilinks]] to connect notes and #tags to categorise."
              className="w-full h-80 bg-transparent border border-t-0 border-border rounded-b p-3 font-mono text-sm outline-none resize-y"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              <span className="font-mono">[[Note Title]]</span> links a note ·{' '}
              <span className="font-mono">#tag</span> categorises · select text and use the toolbar, or write markdown directly.
            </p>
          </>
        ) : (
          <div className="w-full min-h-80 border border-border rounded p-4">
            {draftBody.trim() ? (
              <Markdown content={draftBody} />
            ) : (
              <p className="text-sm text-muted-foreground">Nothing to preview yet — switch to Edit to start writing.</p>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            disabled={!draftTitle || !dirty || save.isPending}
            onClick={doSave}
            title={!draftTitle ? 'Add a title first' : !dirty ? 'No changes to save' : 'Save'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
          >
            {save.isPending ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />} Save
          </button>
          {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
          {selectedId && (
            <button
              type="button"
              onClick={() => del.mutate(selectedId)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-sm hover:bg-surface-container-high ml-auto"
            >
              <Trash2 size={14} /> Archive
            </button>
          )}
        </div>

        {selectedId && detail.data && (
          <div className="mt-6 grid grid-cols-2 gap-6 text-sm">
            <section>
              <h3 className="section-label mb-2">Backlinks</h3>
              {detail.data.backlinks.length === 0 && <p className="text-muted-foreground">None.</p>}
              <ul className="space-y-1">
                {detail.data.backlinks.map((b) => (
                  <li key={b.id} className="text-muted-foreground">← {b.from?.type}:{b.from?.id.slice(0, 8)} ({b.linkType})</li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="section-label mb-2 flex items-center gap-1.5"><Sparkles size={14} className="text-accent" /> Suggested connections</h3>
              {suggestions.isLoading && <Loader2 className="animate-spin" size={14} />}
              {suggestions.data?.suggestions.length === 0 && <p className="text-muted-foreground">No suggestions.</p>}
              <ul className="space-y-1">
                {suggestions.data?.suggestions.map((s) => {
                  const linked = hasLink(draftBody, s.title ?? s.id);
                  return (
                    <li key={s.id} className="flex items-center gap-1.5 group">
                      {/* + adds the suggestion as a [[wikilink]] — no need to
                          remember exact titles (the QA's "click + to add"). */}
                      <button
                        type="button"
                        disabled={linked}
                        onClick={() => addLink(s)}
                        title={linked ? 'Already linked' : 'Add as a link'}
                        className="shrink-0 p-0.5 rounded hover:bg-surface-container-high text-accent disabled:opacity-30"
                      >
                        <Plus size={13} />
                      </button>
                      <span className="text-muted-foreground truncate">{s.title ?? s.id.slice(0, 8)}</span>
                      <span className="text-xs text-muted-foreground/60 ml-auto shrink-0">{(s.similarity * 100).toFixed(0)}%</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

/** Whether the body already wikilinks `title`, including the `[[Title|Alias]]` form. */
function hasLink(body: string, title: string): boolean {
  return body.includes(`[[${title}]]`) || body.includes(`[[${title}|`);
}

function ToolBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      // preventDefault on mousedown keeps the textarea selection while the
      // toolbar acts on it (a click would otherwise blur + collapse it).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="p-1.5 rounded text-muted-foreground hover:bg-surface-container-high hover:text-on-surface"
    >
      {children}
    </button>
  );
}
