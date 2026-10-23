'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Link2, Plus, Search, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { BUTTON, CARD, ErrorText, formatWhen, INPUT, LABEL, PRIMARY, browserZone, problemsOf, useDebounced } from '@/components/business/common';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspaceAccess, useWorkspaceId } from '@/lib/workspace-context';
import {
  CASE_ENTITY_VALUES,
  CASE_STATUS_VALUES,
  type CaseDetailView,
  type CaseEntityValue,
  type CaseView,
  type ContactView,
  type RecordView,
} from '../../../src/shared/business';

const STATUS_TITLE: Record<string, string> = { open: 'Open', waiting: 'Waiting', done: 'Done', archived: 'Archived' };
const STATUS_STYLE: Record<string, string> = {
  open: 'bg-primary-container/60 text-primary',
  waiting: 'bg-warning-container/60 text-warning',
  done: 'bg-tertiary-container/60 text-tertiary',
  archived: 'bg-surface-container-high text-on-surface-variant',
};

/**
 * Cases ("Vorgänge", docs/CASES.md): the matters of business, with what
 * belongs to each and the follow-ups that bring them back. In a space every
 * member sees the space's cases; editors change them.
 */
export default function CasesPage() {
  const workspaceId = useWorkspaceId();
  const { canWrite } = useWorkspaceAccess();
  const [status, setStatus] = useState<string>('active');
  const [query, setQuery] = useState('');
  // The selection belongs to the workspace it was made in: switching drops it.
  const [selection, setSelection] = useState<{ workspaceId: string | null; id: string } | null>(null);
  const selected = selection?.workspaceId === workspaceId ? selection.id : null;
  const setSelected = (id: string | null) => setSelection(id ? { workspaceId, id } : null);
  const [creating, setCreating] = useState(false);
  const term = useDebounced(query.trim());

  const params = new URLSearchParams();
  if (status === 'active') params.set('active', 'true');
  else if (status !== 'all') params.set('status', status);
  if (term) params.set('q', term);
  const list = useQuery({
    queryKey: ['cases', workspaceId, status, term],
    queryFn: () => api.get<CaseView[]>(`/cases?${params.toString()}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="cases"
        description="Matters of business — an invoice, a complaint, an inquiry — with the people, documents and follow-ups that belong to them."
        actions={canWrite ? <button type="button" className={PRIMARY} onClick={() => setCreating(true)}><Plus className="w-4 h-4" />New case</button> : undefined}
      />
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-48">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-on-surface-variant" />
          <input className={cn(INPUT, 'pl-9')} placeholder="Search title and summary" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search cases" />
        </div>
        <select className={cn(INPUT, 'w-auto')} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="active">Open and waiting</option>
          {CASE_STATUS_VALUES.map((s) => <option key={s} value={s}>{STATUS_TITLE[s]}</option>)}
          <option value="all">All</option>
        </select>
      </div>
      {creating && <NewCase onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelected(id); }} />}
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-2">
          {list.isLoading && <p className="text-sm text-on-surface-variant">Loading…</p>}
          {list.error && <ErrorText error={problemsOf(list.error)} />}
          {list.data?.length === 0 && <p className="text-sm text-on-surface-variant">No cases here yet.</p>}
          {list.data?.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => setSelected(c.id)}
              className={cn(CARD, 'w-full text-left p-3 cursor-pointer hover:border-primary/30', selected === c.id && 'border-primary/50')}
            >
              <div className="flex items-center gap-2">
                <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_STYLE[c.status])}>{STATUS_TITLE[c.status] ?? c.status}</span>
                {c.kind && <span className="text-xs text-on-surface-variant">{c.kind}</span>}
              </div>
              <div className="text-sm font-medium text-on-surface mt-1 break-words">{c.title}</div>
              <div className="text-xs text-on-surface-variant mt-0.5">changed {formatWhen(c.updatedAt)}</div>
            </button>
          ))}
        </div>
        <div>{selected ? <CaseDetail key={selected} id={selected} canWrite={canWrite} onDeleted={() => setSelected(null)} /> : <p className="text-sm text-on-surface-variant">Pick a case to see what belongs to it.</p>}</div>
      </div>
    </div>
  );
}

function NewCase({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<CaseView>('/cases', { title, ...(kind.trim() ? { kind } : {}), ...(summary.trim() ? { summary } : {}) });
      await qc.invalidateQueries({ queryKey: ['cases'] });
      onCreated(created.id);
    } catch (err) {
      setError(problemsOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={cn(CARD, 'p-4 mb-4 space-y-3')} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold text-on-surface">New case</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-on-surface-variant cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      <div>
        <label className={LABEL} htmlFor="case-title">Title *</label>
        <input id="case-title" className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div>
        <label className={LABEL} htmlFor="case-kind">Kind</label>
        <input id="case-kind" className={INPUT} placeholder="invoice, complaint, inquiry…" value={kind} onChange={(e) => setKind(e.target.value)} />
      </div>
      <div>
        <label className={LABEL} htmlFor="case-summary">Summary</label>
        <textarea id="case-summary" className={cn(INPUT, 'min-h-20')} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>
      <ErrorText error={error} />
      <button type="submit" className={PRIMARY} disabled={busy || !title.trim()}>Create</button>
    </form>
  );
}

function CaseDetail({ id, canWrite, onDeleted }: { id: string; canWrite: boolean; onDeleted: () => void }) {
  const qc = useQueryClient();
  const workspaceId = useWorkspaceId();
  const detail = useQuery({ queryKey: ['case', id, workspaceId], queryFn: () => api.get<CaseDetailView>(`/cases/${id}`) });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['case', id] }), qc.invalidateQueries({ queryKey: ['cases'] })]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(problemsOf(err));
    }
  };

  if (detail.isLoading) return <p className="text-sm text-on-surface-variant">Loading…</p>;
  if (detail.error || !detail.data) return <ErrorText error={detail.error ? problemsOf(detail.error) : 'Case not found'} />;
  const c = detail.data;
  return (
    <div className={cn(CARD, 'p-4 space-y-4')}>
      <div className="space-y-2">
        <EditableText label="Title" required value={c.title} disabled={!canWrite} onSave={(title) => act(() => api.patch(`/cases/${id}`, { title }))} />
        <div className="flex flex-wrap gap-3">
          <div>
            <label className={LABEL} htmlFor="case-status">Status</label>
            <select id="case-status" className={cn(INPUT, 'w-auto')} value={c.status} disabled={!canWrite} onChange={(e) => act(() => api.patch(`/cases/${id}`, { status: e.target.value }))}>
              {CASE_STATUS_VALUES.map((s) => <option key={s} value={s}>{STATUS_TITLE[s]}</option>)}
            </select>
          </div>
          <div className="flex-1 min-w-40">
            <EditableText label="Kind" value={c.kind ?? ''} disabled={!canWrite} onSave={(kind) => act(() => api.patch(`/cases/${id}`, { kind: kind || null }))} />
          </div>
        </div>
        <EditableText label="Summary" multiline value={c.summary ?? ''} disabled={!canWrite} onSave={(summary) => act(() => api.patch(`/cases/${id}`, { summary: summary || null }))} />
        {c.closedAt && <p className="text-xs text-on-surface-variant">Closed {formatWhen(c.closedAt)}</p>}
      </div>

      <section>
        <h3 className="text-sm font-semibold text-on-surface flex items-center gap-1.5 mb-2"><Link2 className="w-4 h-4" />Linked</h3>
        {c.links.length === 0 && <p className="text-sm text-on-surface-variant">Nothing linked yet.</p>}
        <ul className="space-y-1">
          {c.links.map((l) => (
            <li key={l.id} className="flex items-center gap-2 text-sm">
              <span className="text-xs w-16 text-on-surface-variant">{l.entityType}</span>
              <span className="flex-1 text-on-surface break-words">{l.label}{l.detail ? <span className="text-on-surface-variant"> · {l.detail}</span> : null}</span>
              {l.role && <span className="text-xs px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant">{l.role}</span>}
              {canWrite && (
                <button type="button" aria-label={`Unlink ${l.label}`} className="text-on-surface-variant hover:text-error cursor-pointer" onClick={() => act(() => api.delete(`/cases/${id}/links/${l.id}`))}>
                  <X className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {canWrite && <AddLink caseId={id} onLinked={refresh} />}
      </section>

      {canWrite && <AddFollowUp caseId={id} onAdded={refresh} />}

      <ErrorText error={error} />
      {canWrite && (
        <button
          type="button"
          className={cn(BUTTON, 'text-error')}
          onClick={() => { if (window.confirm('Delete this case and its links? Linked documents, contacts and tasks stay.')) void act(async () => { await api.delete(`/cases/${id}`); onDeleted(); }); }}
        >
          <Trash2 className="w-4 h-4" />Delete case
        </button>
      )}
    </div>
  );
}

/** A text that edits in place and saves on blur, when it changed. */
function EditableText({ label, value, onSave, disabled, multiline, required }: { label: string; value: string; onSave: (v: string) => void; disabled?: boolean; multiline?: boolean; required?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const id = `edit-${label.toLowerCase()}`;
  const save = () => {
    // A required text left empty goes back to what is stored instead of being sent.
    if (required && !draft.trim()) {
      setDraft(value);
      return;
    }
    if (draft.trim() !== value.trim()) onSave(draft.trim());
  };
  return (
    <div>
      <label className={LABEL} htmlFor={id}>{label}</label>
      {multiline
        ? <textarea id={id} className={cn(INPUT, 'min-h-20')} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={save} />
        : <input id={id} className={INPUT} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={save} />}
    </div>
  );
}

/** Pick what to link: contacts and records by search; any other entity by its id. */
function AddLink({ caseId, onLinked }: { caseId: string; onLinked: () => Promise<unknown> }) {
  const workspaceId = useWorkspaceId();
  const [entityType, setEntityType] = useState<CaseEntityValue>('contact');
  const [search, setSearch] = useState('');
  const [entityId, setEntityId] = useState('');
  const [role, setRole] = useState('');
  const [error, setError] = useState<string | null>(null);
  const searchable = entityType === 'contact' || entityType === 'record';
  const term = useDebounced(search.trim());
  const found = useQuery({
    queryKey: ['link-search', entityType, term, workspaceId],
    enabled: searchable && term.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const q = encodeURIComponent(term);
      if (entityType === 'contact') return (await api.get<ContactView[]>(`/contacts?q=${q}&limit=10`)).map((c) => ({ id: c.id, label: c.name }));
      return (await api.get<RecordView[]>(`/records?q=${q}&limit=10`)).map((r) => ({ id: r.id, label: r.title ?? r.id }));
    },
  });
  const link = async (id: string) => {
    setError(null);
    try {
      await api.post(`/cases/${caseId}/links`, { entityType, entityId: id, ...(role.trim() ? { role } : {}) });
      setSearch('');
      setEntityId('');
      await onLinked();
    } catch (err) {
      setError(problemsOf(err));
    }
  };
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <select className={cn(INPUT, 'w-auto')} value={entityType} onChange={(e) => setEntityType(e.target.value as CaseEntityValue)} aria-label="What to link">
          {CASE_ENTITY_VALUES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className={cn(INPUT, 'w-36')} placeholder="role (optional)" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role" />
        {searchable
          ? <input className={cn(INPUT, 'flex-1 min-w-40')} placeholder={`Search ${entityType}s`} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find something to link" />
          : (
            <>
              <input className={cn(INPUT, 'flex-1 min-w-40')} placeholder={`${entityType} id`} value={entityId} onChange={(e) => setEntityId(e.target.value)} aria-label="Id" />
              <button type="button" className={BUTTON} disabled={!entityId.trim()} onClick={() => link(entityId.trim())}>Link</button>
            </>
          )}
      </div>
      {searchable && found.data && (
        <ul className="space-y-1">
          {found.data.length === 0 && <li className="text-xs text-on-surface-variant">No match.</li>}
          {found.data.map((r) => (
            <li key={r.id}>
              <button type="button" className={cn(BUTTON, 'w-full justify-start')} onClick={() => link(r.id)}><Plus className="w-3.5 h-3.5" />{r.label}</button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={error} />
    </div>
  );
}

/** A follow-up ("Wiedervorlage"): a task that comes back on a date. */
function AddFollowUp({ caseId, onAdded }: { caseId: string; onAdded: () => Promise<unknown> }) {
  const [title, setTitle] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/cases/${caseId}/follow-ups`, { title, remindAt, tz: browserZone() });
      setTitle('');
      setRemindAt('');
      await onAdded();
    } catch (err) {
      setError(problemsOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h3 className="text-sm font-semibold text-on-surface flex items-center gap-1.5 mb-2"><BellRing className="w-4 h-4" />Follow-up</h3>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input className={cn(INPUT, 'flex-1 min-w-40')} placeholder="What to follow up on" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Follow-up" />
        <input className={cn(INPUT, 'w-auto')} type="date" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} aria-label="Remind on" />
        <button type="submit" className={BUTTON} disabled={busy || !title.trim() || !remindAt}><Plus className="w-4 h-4" />Add</button>
      </form>
      <ErrorText error={error} />
    </section>
  );
}
