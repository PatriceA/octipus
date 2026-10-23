'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Search, Trash2, User, X } from 'lucide-react';
import { useState } from 'react';
import { BUTTON, CARD, ErrorText, INPUT, LABEL, PRIMARY, problemsOf, useDebounced } from '@/components/business/common';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspaceAccess, useWorkspaceId } from '@/lib/workspace-context';
import type { ContactDetailView, ContactView } from '../../../src/shared/business';

interface Draft {
  kind: 'person' | 'organization';
  name: string;
  email: string;
  phone: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  organizationId: string;
  tags: string;
  notes: string;
}

const EMPTY: Draft = { kind: 'person', name: '', email: '', phone: '', street: '', postalCode: '', city: '', country: '', organizationId: '', tags: '', notes: '' };

function draftOf(c: ContactView): Draft {
  return {
    kind: c.kind === 'organization' ? 'organization' : 'person',
    name: c.name,
    email: c.email ?? '',
    phone: c.phone ?? '',
    street: c.address?.street ?? '',
    postalCode: c.address?.postalCode ?? '',
    city: c.address?.city ?? '',
    country: c.address?.country ?? '',
    organizationId: c.organizationId ?? '',
    tags: c.tags.join(', '),
    notes: c.notes ?? '',
  };
}

/** The body of a create or an update: empty fields clear, tags split on commas. */
function bodyOf(d: Draft, forUpdate: boolean) {
  const opt = (v: string) => (v.trim() ? v.trim() : forUpdate ? null : undefined);
  const address = {
    street: d.street.trim() || undefined,
    postalCode: d.postalCode.trim() || undefined,
    city: d.city.trim() || undefined,
    country: d.country.trim() || undefined,
  };
  const hasAddress = Object.values(address).some(Boolean);
  return {
    kind: d.kind,
    name: d.name,
    email: opt(d.email),
    phone: opt(d.phone),
    address: hasAddress ? address : forUpdate ? null : undefined,
    organizationId: d.kind === 'person' ? opt(d.organizationId) : forUpdate ? null : undefined,
    tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean),
    notes: opt(d.notes),
  };
}

/**
 * Contacts ("Personen", docs/CASES.md): the people and organisations of a
 * workspace — clients, relatives, referrers, suppliers. In a space every
 * member reads them; editors change them.
 */
export default function ContactsPage() {
  const workspaceId = useWorkspaceId();
  const { canWrite } = useWorkspaceAccess();
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  // The selection belongs to the workspace it was made in: switching drops it.
  const [selection, setSelection] = useState<{ workspaceId: string | null; id: string } | null>(null);
  const selected = selection?.workspaceId === workspaceId ? selection.id : null;
  const setSelected = (id: string | null) => setSelection(id ? { workspaceId, id } : null);
  const [creating, setCreating] = useState(false);
  const term = useDebounced(query.trim());
  const tagTerm = useDebounced(tag.trim());
  const params = new URLSearchParams();
  if (term) params.set('q', term);
  if (tagTerm) params.set('tag', tagTerm);
  const list = useQuery({
    queryKey: ['contacts', workspaceId, term, tagTerm],
    queryFn: () => api.get<ContactView[]>(`/contacts?${params.toString()}`),
    placeholderData: keepPreviousData,
  });
  const organizations = useQuery({
    queryKey: ['contacts', workspaceId, 'organizations'],
    queryFn: () => api.get<ContactView[]>('/contacts?kind=organization'),
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="contacts"
        description="The people and organisations you work with. Link them to cases to see everything about them in one place."
        actions={canWrite ? <button type="button" className={PRIMARY} onClick={() => { setCreating(true); setSelected(null); }}><Plus className="w-4 h-4" />New contact</button> : undefined}
      />
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-48">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-on-surface-variant" />
          <input className={cn(INPUT, 'pl-9')} placeholder="Search name, email, phone" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search contacts" />
        </div>
        <input className={cn(INPUT, 'w-40')} placeholder="tag" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag" />
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-2">
          {list.isLoading && <p className="text-sm text-on-surface-variant">Loading…</p>}
          {list.error && <ErrorText error={problemsOf(list.error)} />}
          {list.data?.length === 0 && <p className="text-sm text-on-surface-variant">No contacts here yet.</p>}
          {list.data?.map((c) => {
            const Icon = c.kind === 'organization' ? Building2 : User;
            return (
              <button type="button" key={c.id} onClick={() => { setSelected(c.id); setCreating(false); }} className={cn(CARD, 'w-full text-left p-3 cursor-pointer hover:border-primary/30', selected === c.id && 'border-primary/50')}>
                <div className="flex items-center gap-2 text-sm font-medium text-on-surface"><Icon className="w-4 h-4 text-on-surface-variant" />{c.name}</div>
                <div className="text-xs text-on-surface-variant mt-0.5">{[c.email, c.phone].filter(Boolean).join(' · ')}</div>
                {c.tags.length > 0 && <div className="flex gap-1 mt-1">{c.tags.map((t) => <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant">{t}</span>)}</div>}
              </button>
            );
          })}
        </div>
        <div>
          {creating && <ContactForm organizations={organizations.data ?? []} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); setSelected(id); }} />}
          {!creating && selected && <ContactDetail key={selected} id={selected} canWrite={canWrite} organizations={organizations.data ?? []} onDeleted={() => setSelected(null)} />}
          {!creating && !selected && <p className="text-sm text-on-surface-variant">Pick a contact to see their details and cases.</p>}
        </div>
      </div>
    </div>
  );
}

function ContactForm({ initial, id, organizations, onClose, onSaved }: {
  initial?: Draft;
  id?: string;
  organizations: ContactView[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(initial ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = id
        ? await api.patch<ContactView>(`/contacts/${id}`, bodyOf(d, true))
        : await api.post<ContactView>('/contacts', bodyOf(d, false));
      await Promise.all([qc.invalidateQueries({ queryKey: ['contacts'] }), qc.invalidateQueries({ queryKey: ['contact', saved.id] })]);
      onSaved(saved.id);
    } catch (err) {
      setError(problemsOf(err));
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof Draft, label: string, type = 'text') => (
    <div>
      <label className={LABEL} htmlFor={`contact-${k}`}>{label}</label>
      <input id={`contact-${k}`} className={INPUT} type={type} value={d[k]} onChange={set(k)} />
    </div>
  );
  return (
    <form className={cn(CARD, 'p-4 space-y-3')} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold text-on-surface">{id ? 'Edit contact' : 'New contact'}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-on-surface-variant cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      <div>
        <label className={LABEL} htmlFor="contact-kind">Kind</label>
        <select id="contact-kind" className={cn(INPUT, 'w-auto')} value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as Draft['kind'] })}>
          <option value="person">Person</option>
          <option value="organization">Organisation</option>
        </select>
      </div>
      {field('name', 'Name *')}
      <div className="grid grid-cols-2 gap-3">{field('email', 'Email', 'email')}{field('phone', 'Phone', 'tel')}</div>
      {field('street', 'Street')}
      <div className="grid grid-cols-[1fr_2fr] gap-3">{field('postalCode', 'Postal code')}{field('city', 'City')}</div>
      {field('country', 'Country')}
      {d.kind === 'person' && (
        <div>
          <label className={LABEL} htmlFor="contact-org">Organisation</label>
          <select id="contact-org" className={INPUT} value={d.organizationId} onChange={set('organizationId')}>
            <option value="">—</option>
            {organizations.filter((o) => o.id !== id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
      )}
      {field('tags', 'Tags (comma separated)')}
      <div>
        <label className={LABEL} htmlFor="contact-notes">Notes</label>
        <textarea id="contact-notes" className={cn(INPUT, 'min-h-20')} value={d.notes} onChange={set('notes')} />
      </div>
      <ErrorText error={error} />
      <button type="submit" className={PRIMARY} disabled={busy || !d.name.trim()}>Save</button>
    </form>
  );
}

function ContactDetail({ id, canWrite, organizations, onDeleted }: { id: string; canWrite: boolean; organizations: ContactView[]; onDeleted: () => void }) {
  const qc = useQueryClient();
  const workspaceId = useWorkspaceId();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['contact', id, workspaceId], queryFn: () => api.get<ContactDetailView>(`/contacts/${id}`) });
  if (detail.isLoading) return <p className="text-sm text-on-surface-variant">Loading…</p>;
  if (detail.error || !detail.data) return <ErrorText error={detail.error ? problemsOf(detail.error) : 'Contact not found'} />;
  const c = detail.data;
  if (editing) return <ContactForm id={id} initial={draftOf(c)} organizations={organizations} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />;
  const org = organizations.find((o) => o.id === c.organizationId);
  const address = [c.address?.street, [c.address?.postalCode, c.address?.city].filter(Boolean).join(' '), c.address?.country].filter(Boolean).join(', ');
  const remove = async () => {
    if (!window.confirm(`Delete ${c.name}? Their links to cases are removed.`)) return;
    try {
      await api.delete(`/contacts/${id}`);
      // Its case links went with it.
      await Promise.all(['contacts', 'cases', 'case'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      onDeleted();
    } catch (err) {
      setError(problemsOf(err));
    }
  };
  return (
    <div className={cn(CARD, 'p-4 space-y-3')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">{c.name}</h2>
          <p className="text-xs text-on-surface-variant">{c.kind === 'organization' ? 'Organisation' : 'Person'}{org ? ` · ${org.name}` : ''}</p>
        </div>
        {canWrite && <button type="button" className={BUTTON} onClick={() => setEditing(true)}>Edit</button>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {c.email && <><dt className="text-on-surface-variant">Email</dt><dd className="text-on-surface break-all">{c.email}</dd></>}
        {c.phone && <><dt className="text-on-surface-variant">Phone</dt><dd className="text-on-surface">{c.phone}</dd></>}
        {address && <><dt className="text-on-surface-variant">Address</dt><dd className="text-on-surface">{address}</dd></>}
        {c.tags.length > 0 && <><dt className="text-on-surface-variant">Tags</dt><dd className="text-on-surface">{c.tags.join(', ')}</dd></>}
      </dl>
      {c.notes && <p className="text-sm text-on-surface whitespace-pre-line">{c.notes}</p>}
      <section>
        <h3 className="text-sm font-semibold text-on-surface mb-1">Cases</h3>
        {c.cases.length === 0 && <p className="text-sm text-on-surface-variant">Not linked to a case.</p>}
        <ul className="space-y-1 text-sm">
          {c.cases.map((k) => <li key={k.id} className="text-on-surface">{k.title} <span className="text-on-surface-variant">· {k.status}{k.role ? ` · ${k.role}` : ''}</span></li>)}
        </ul>
      </section>
      <ErrorText error={error} />
      {canWrite && <button type="button" className={cn(BUTTON, 'text-error')} onClick={remove}><Trash2 className="w-4 h-4" />Delete contact</button>}
    </div>
  );
}
