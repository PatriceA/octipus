'use client';

import { FileText, Link2, Loader2, Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '@/components/ui/markdown-renderer';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { LinkedNote } from '../../../src/shared/note-todos';
import type { Todo } from './model';

/** Where a linked note opens: the notes page, at that note. */
export function noteHref(id: string): string {
  return `/notes?note=${encodeURIComponent(id)}`;
}

/**
 * A to-do's notes field: markdown, shown rendered (links open in a new tab;
 * no HTML is ever rendered) and edited as plain text on a click, Enter or
 * focus. Empty, it is the text field.
 */
export function TodoNotesField({ value, onChange, onBlur, canWrite, failed }: {
  value: string;
  onChange: (next: string) => void;
  onBlur: () => void;
  canWrite: boolean;
  failed: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);
  const rendered = !editing && value.trim() !== '';
  return (
    <section className="todo-card">
      {rendered ? (
        // A block of rendered markdown (with its own links) that turns into its editor: not a <button>, which may not hold links.
        <div
          role="button"
          tabIndex={canWrite ? 0 : -1}
          aria-label={canWrite ? 'Notes. Press Enter to edit' : 'Notes'}
          data-testid="todo-notes-rendered"
          onClick={(e) => {
            // A link in the text is followed, not edited.
            if (!canWrite || (e.target as HTMLElement).closest('a, button')) return;
            setEditing(true);
          }}
          onKeyDown={(e) => {
            if (canWrite && e.target === e.currentTarget && e.key === 'Enter') { e.preventDefault(); setEditing(true); }
          }}
          className={cn('todo-notes-rendered', canWrite && 'is-editable')}
        >
          {/* Untrusted: a to-do's notes may be written by an agent, a plugin or another member; no remote image loads by itself. */}
          <Markdown content={value} className="todo-notes-prose" untrusted />
        </div>
      ) : (
        <textarea
          ref={areaRef}
          aria-label="Notes"
          placeholder="Add a note (Markdown: **bold**, - lists, [links](https://…))"
          value={value}
          readOnly={!canWrite}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => { onBlur(); setEditing(false); }}
          onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur(); }}
          maxLength={10000}
          className="block min-h-[96px] w-full resize-y rounded-[10px] bg-transparent px-4 py-3 text-sm leading-relaxed text-on-surface [field-sizing:content] placeholder:text-on-surface-variant/80 focus:outline-none"
        />
      )}
      {failed && <p role="alert" className="px-4 py-2 text-xs text-error">Notes not saved. Your text is still here; it is tried again when you click away.</p>}
    </section>
  );
}

interface IndexEntry { id: string; title: string; slug: string; noteKind: string }

/**
 * The notes a to-do is linked to, as chips that open them (an archived one
 * says so, a line it was made from says that too), with Unlink and
 * "Attach a note": an existing one by title, or a new one.
 */
export function TodoLinkedNotes({ task, canWrite, onChanged, onError }: {
  task: Todo;
  canWrite: boolean;
  /** A link was made or removed: the list reads again. */
  onChanged: () => Promise<unknown> | void;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const linked = task.linkedNotes ?? [];
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<IndexEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!picking || index) return;
    let cancelled = false;
    api.get<{ notes: IndexEntry[] }>('/notes/index').then(
      (r) => { if (!cancelled) setIndex(r.notes ?? []); },
      (err: unknown) => { if (!cancelled) { setIndex([]); onError(`Could not list notes: ${err instanceof Error ? err.message : String(err)}`); } },
    );
    return () => { cancelled = true; };
  }, [picking, index, onError]);

  const linkedIds = new Set(linked.map((n) => n.id));
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (index ?? []).filter((n) => !linkedIds.has(n.id) && (!q || n.title.toLowerCase().includes(q) || n.slug.includes(q))).slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- linkedIds is derived from `linked`
  }, [index, query, linked]);

  const attach = async (body: { noteId: string } | { title: string }) => {
    setBusy(true);
    try {
      await api.post(`/tasks/${task.id}/notes`, body);
      setPicking(false);
      setQuery('');
      await onChanged();
    } catch (err) {
      onError(`Could not attach the note: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const unlink = async (note: LinkedNote) => {
    try {
      await api.delete(`/tasks/${task.id}/notes/${note.id}`);
      await onChanged();
    } catch (err) {
      onError(`Could not unlink the note: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (linked.length === 0 && !canWrite) return null;
  const typed = query.trim();
  return (
    <section className="todo-card" aria-label="Linked notes" data-testid="todo-linked-notes">
      {linked.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-3 py-2.5">
          {linked.map((n) => (
            <li key={n.id} className="todo-note-chip" data-testid="todo-note-chip">
              <button type="button" onClick={() => router.push(noteHref(n.id))} title={n.anchor ? 'Made from a line of this note: open it' : 'Open the note'}>
                <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{n.title}</span>
                {n.anchor && <span className="todo-note-chip-tag">line</span>}
                {n.archived && <span className="todo-note-chip-tag">archived</span>}
              </button>
              {canWrite && (
                <button type="button" className="todo-note-chip-x" aria-label={`Unlink “${n.title}”`} title="Unlink (the note stays)" onClick={() => void unlink(n)}>
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && !picking && (
        <button type="button" className="todo-card-row" onClick={() => setPicking(true)}>
          <Link2 aria-hidden /><span>{linked.length ? 'Attach another note' : 'Attach a note'}</span>
        </button>
      )}
      {canWrite && picking && (
        <div className="px-3 py-2.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setPicking(false); setQuery(''); }
              if (e.key === 'Enter' && !busy) {
                e.preventDefault();
                if (matches[0] && matches[0].title.toLowerCase() === typed.toLowerCase()) void attach({ noteId: matches[0].id });
                else if (typed) void attach({ title: typed });
              }
            }}
            aria-label="Find or name a note"
            placeholder="Find a note, or name a new one"
            maxLength={200}
            className="todo-field w-full"
          />
          <ul className="mt-1.5" aria-label="Notes">
            {index === null && <li className="flex items-center gap-2 px-2 py-1.5 text-xs text-on-surface-variant"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading notes…</li>}
            {matches.map((n) => (
              <li key={n.id}>
                <button type="button" disabled={busy} onClick={() => void attach({ noteId: n.id })} className="todo-note-pick">
                  <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="truncate">{n.title}</span>
                  {n.noteKind === 'daily' && <span className="text-[11px] text-on-surface-variant">daily</span>}
                </button>
              </li>
            ))}
            {typed && !matches.some((n) => n.title.toLowerCase() === typed.toLowerCase()) && (
              <li>
                <button type="button" disabled={busy} onClick={() => void attach({ title: typed })} className="todo-note-pick text-primary">
                  <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="truncate">New note “{typed}”</span>
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
