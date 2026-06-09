'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, NotebookPen, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
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

  const list = useQuery<NoteListResponse>({
    queryKey: ['notes'],
    queryFn: () => api.get<NoteListResponse>('/notes'),
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

  const save = useMutation({
    mutationFn: (payload: { id?: string; title: string; body: string }) =>
      api.post<{ note: NoteRow }>('/notes', payload),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['notes'] });
      setSelectedId(res.note.id);
      qc.invalidateQueries({ queryKey: ['note', res.note.id] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/notes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notes'] });
      setSelectedId(null);
    },
  });

  function openNew() {
    setSelectedId(null);
    setDraftTitle('');
    setDraftBody('');
  }

  function openNote(n: NoteRow) {
    setSelectedId(n.id);
    api.get<NoteDetail>(`/notes/${n.id}`).then((d) => {
      setDraftTitle(d.title);
      setDraftBody(d.body);
    });
  }

  return (
    <div className="flex h-full">
      {/* List */}
      <aside className="w-72 border-r border-border overflow-y-auto p-3">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold flex items-center gap-2"><NotebookPen size={16} /> Notes</h2>
          <button type="button" onClick={openNew} className="p-1 rounded hover:bg-accent" title="New note">
            <Plus size={16} />
          </button>
        </div>
        {list.isLoading && <Loader2 className="animate-spin" size={16} />}
        <ul className="space-y-1">
          {list.data?.notes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => openNote(n)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm hover:bg-accent ${selectedId === n.id ? 'bg-accent' : ''}`}
              >
                <div className="font-medium truncate">{n.title}</div>
                <div className="text-xs text-muted-foreground truncate">{n.slug} · {n.noteKind}</div>
              </button>
            </li>
          ))}
          {list.data?.notes.length === 0 && <li className="text-sm text-muted-foreground">No notes yet.</li>}
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
        <textarea
          value={draftBody}
          onChange={(e) => setDraftBody(e.target.value)}
          placeholder="Write markdown. Use [[wikilinks]] to connect notes and #tags to categorise."
          className="w-full h-80 bg-transparent border border-border rounded p-3 font-mono text-sm outline-none resize-y"
        />
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            disabled={!draftTitle || save.isPending}
            onClick={() => save.mutate({ id: selectedId ?? undefined, title: draftTitle, body: draftBody })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
          >
            {save.isPending ? <Loader2 className="animate-spin" size={14} /> : <Save size={14} />} Save
          </button>
          {selectedId && (
            <button
              type="button"
              onClick={() => del.mutate(selectedId)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-sm hover:bg-accent"
            >
              <Trash2 size={14} /> Archive
            </button>
          )}
        </div>

        {selectedId && detail.data && (
          <div className="mt-6 grid grid-cols-2 gap-6 text-sm">
            <section>
              <h3 className="font-semibold mb-2">Backlinks</h3>
              {detail.data.backlinks.length === 0 && <p className="text-muted-foreground">None.</p>}
              <ul className="space-y-1">
                {detail.data.backlinks.map((b) => (
                  <li key={b.id} className="text-muted-foreground">← {b.from?.type}:{b.from?.id.slice(0, 8)} ({b.linkType})</li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="font-semibold mb-2 flex items-center gap-1.5"><Sparkles size={14} /> Suggested connections</h3>
              {suggestions.isLoading && <Loader2 className="animate-spin" size={14} />}
              {suggestions.data?.suggestions.length === 0 && <p className="text-muted-foreground">No suggestions.</p>}
              <ul className="space-y-1">
                {suggestions.data?.suggestions.map((s) => (
                  <li key={s.id} className="text-muted-foreground">{s.title ?? s.id.slice(0, 8)} · {(s.similarity * 100).toFixed(0)}%</li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
