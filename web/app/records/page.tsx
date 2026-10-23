'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Database, Link as LinkIcon, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import {
  BUTTON,
  CARD,
  ErrorText,
  FieldInputs,
  type FieldValues,
  formatWhen,
  fromFieldValues,
  INPUT,
  LABEL,
  PRIMARY,
  problemsOf,
  showValue,
  toFieldValues,
} from '@/components/business/common';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspaceAccess, useWorkspaceId } from '@/lib/workspace-context';
import { FIELD_TYPES, type FieldDef, type FieldType } from '../../../src/shared/record-fields';
import type { FormLinkView, MintedFormLinkView, RecordTypeView, RecordView } from '../../../src/shared/business';

/** Columns the records table shows; the rest are in the record's form. */
const TABLE_FIELDS = 5;

/**
 * Records (docs/RECORDS.md): structured data with fields you define —
 * invoices, vehicles, licences — and the form links that let people outside
 * submit one.
 */
export default function RecordsPage() {
  const workspaceId = useWorkspaceId();
  const { canWrite } = useWorkspaceAccess();
  const [typeId, setTypeId] = useState<string | null>(null);
  const [editingType, setEditingType] = useState<RecordTypeView | 'new' | null>(null);
  const types = useQuery({ queryKey: ['record-types', workspaceId], queryFn: () => api.get<RecordTypeView[]>('/record-types') });
  const type = types.data?.find((t) => t.id === typeId) ?? types.data?.[0] ?? null;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="records"
        description="Structured data with fields you define. Link records to cases; publish a form so people outside can submit one."
        actions={canWrite ? <button type="button" className={PRIMARY} onClick={() => setEditingType('new')}><Plus className="w-4 h-4" />New record type</button> : undefined}
      />
      {types.error && <ErrorText error={problemsOf(types.error)} />}
      {editingType && (
        <TypeEditor
          key={editingType === 'new' ? 'new' : editingType.id}
          initial={editingType === 'new' ? null : editingType}
          onClose={() => setEditingType(null)}
          onSaved={(t) => { setEditingType(null); setTypeId(t.id); }}
        />
      )}
      {types.data?.length === 0 && !editingType && (
        <p className="text-sm text-on-surface-variant">No record types yet. Define one — an invoice, a vehicle, an application — and its fields.</p>
      )}
      {type && (
        <>
          <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Record types">
            {types.data?.map((t) => (
              <button type="button" role="tab" aria-selected={t.id === type.id} key={t.id} onClick={() => setTypeId(t.id)} className={cn(BUTTON, t.id === type.id && 'bg-primary-container/60 text-primary')}>
                <Database className="w-4 h-4" />{t.name}
              </button>
            ))}
          </div>
          <TypeView key={type.id} type={type} canWrite={canWrite} onEdit={() => setEditingType(type)} onDeleted={() => setTypeId(null)} />
        </>
      )}
    </div>
  );
}

interface FieldDraft extends FieldDef {
  optionsText: string;
}

function TypeEditor({ initial, onClose, onSaved }: { initial: RecordTypeView | null; onClose: () => void; onSaved: (t: RecordTypeView) => void }) {
  const qc = useQueryClient();
  const [key, setKey] = useState(initial?.key ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [titleField, setTitleField] = useState(initial?.titleField ?? '');
  const [fields, setFields] = useState<FieldDraft[]>((initial?.fields ?? []).map((f) => ({ ...f, optionsText: f.options?.join(', ') ?? '' })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (i: number, patch: Partial<FieldDraft>) => setFields(fields.map((f, j) => (i === j ? { ...f, ...patch } : f)));
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      key,
      name,
      description: description.trim() || (initial ? null : undefined),
      titleField: titleField || (initial ? null : undefined),
      fields: fields.map(({ optionsText, ...f }) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        ...(f.required ? { required: true } : {}),
        ...(f.type === 'select' ? { options: optionsText.split(',').map((o) => o.trim()).filter(Boolean) } : {}),
        ...(f.help?.trim() ? { help: f.help.trim() } : {}),
      })),
    };
    try {
      const saved = initial ? await api.patch<RecordTypeView>(`/record-types/${initial.id}`, body) : await api.post<RecordTypeView>('/record-types', body);
      await qc.invalidateQueries({ queryKey: ['record-types'] });
      onSaved(saved);
    } catch (err) {
      setError(problemsOf(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={cn(CARD, 'p-4 mb-4 space-y-3')} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold text-on-surface">{initial ? `Edit ${initial.name}` : 'New record type'}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-on-surface-variant cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="type-name">Name *</label>
          <input id="type-name" className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="Invoice" />
        </div>
        <div>
          <label className={LABEL} htmlFor="type-key">Key *</label>
          <input id="type-key" className={INPUT} value={key} onChange={(e) => setKey(e.target.value)} placeholder="invoice" />
        </div>
      </div>
      <div>
        <label className={LABEL} htmlFor="type-description">Description</label>
        <input id="type-description" className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="space-y-2">
        <div className={LABEL}>Fields</div>
        {fields.map((f, i) => (
          <div key={i} className="grid gap-2 grid-cols-[1fr_1fr_auto_auto_auto] items-center">
            <input className={INPUT} aria-label={`Field ${i + 1} label`} placeholder="Label" value={f.label} onChange={(e) => update(i, { label: e.target.value })} />
            <input className={INPUT} aria-label={`Field ${i + 1} key`} placeholder="key" value={f.key} onChange={(e) => update(i, { key: e.target.value })} />
            <select className={cn(INPUT, 'w-auto')} aria-label={`Field ${i + 1} type`} value={f.type} onChange={(e) => update(i, { type: e.target.value as FieldType })}>
              {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="flex items-center gap-1 text-xs text-on-surface-variant"><input type="checkbox" checked={f.required === true} onChange={(e) => update(i, { required: e.target.checked })} />required</label>
            <button type="button" aria-label={`Remove field ${f.label || i + 1}`} className="text-on-surface-variant hover:text-error cursor-pointer" onClick={() => setFields(fields.filter((_, j) => j !== i))}><X className="w-4 h-4" /></button>
            {f.type === 'select' && (
              <input className={cn(INPUT, 'col-span-5')} aria-label={`Field ${i + 1} options`} placeholder="Options, comma separated" value={f.optionsText} onChange={(e) => update(i, { optionsText: e.target.value })} />
            )}
          </div>
        ))}
        <button type="button" className={BUTTON} onClick={() => setFields([...fields, { key: '', label: '', type: 'text', optionsText: '' }])}><Plus className="w-4 h-4" />Add field</button>
      </div>
      <div>
        <label className={LABEL} htmlFor="type-title">Title field</label>
        <select id="type-title" className={cn(INPUT, 'w-auto')} value={titleField} onChange={(e) => setTitleField(e.target.value)}>
          <option value="">First filled text field</option>
          {fields.filter((f) => f.type === 'text' && f.key).map((f) => <option key={f.key} value={f.key}>{f.label || f.key}</option>)}
        </select>
      </div>
      <ErrorText error={error} />
      <button type="submit" className={PRIMARY} disabled={busy || !name.trim() || !key.trim()}>Save type</button>
    </form>
  );
}

function TypeView({ type, canWrite, onEdit, onDeleted }: { type: RecordTypeView; canWrite: boolean; onEdit: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const workspaceId = useWorkspaceId();
  const [editing, setEditing] = useState<RecordView | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const records = useQuery({ queryKey: ['records', type.id, workspaceId], queryFn: () => api.get<RecordView[]>(`/records?type=${type.id}`) });
  const columns = type.fields.slice(0, TABLE_FIELDS);
  const removeType = async () => {
    if (!window.confirm(`Delete the record type "${type.name}"? Only a type without records can be deleted.`)) return;
    setError(null);
    try {
      await api.delete(`/record-types/${type.id}`);
      await qc.invalidateQueries({ queryKey: ['record-types'] });
      onDeleted();
    } catch (err) {
      setError(problemsOf(err));
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {type.description && <p className="text-sm text-on-surface-variant flex-1">{type.description}</p>}
        {canWrite && (
          <>
            <button type="button" className={PRIMARY} onClick={() => setEditing('new')}><Plus className="w-4 h-4" />New {type.name}</button>
            <button type="button" className={BUTTON} onClick={onEdit}><Pencil className="w-4 h-4" />Edit fields</button>
            <button type="button" className={cn(BUTTON, 'text-error')} onClick={removeType}><Trash2 className="w-4 h-4" />Delete type</button>
          </>
        )}
      </div>
      <ErrorText error={error} />
      {editing && (
        <RecordForm key={editing === 'new' ? 'new' : editing.id} type={type} record={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} canWrite={canWrite} />
      )}
      <div className={cn(CARD, 'overflow-x-auto')}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-on-surface-variant">
              {columns.map((f) => <th key={f.key} className="px-3 py-2 font-medium">{f.label}</th>)}
              <th className="px-3 py-2 font-medium">Changed</th>
            </tr>
          </thead>
          <tbody>
            {records.data?.map((r) => (
              <tr key={r.id} className="border-t border-outline-variant/10 hover:bg-surface-container-high cursor-pointer" onClick={() => setEditing(r)}>
                {columns.map((f) => <td key={f.key} className="px-3 py-2 text-on-surface">{showValue(f, r.data[f.key])}</td>)}
                <td className="px-3 py-2 text-on-surface-variant">{formatWhen(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.data?.length === 0 && <p className="text-sm text-on-surface-variant p-3">No {type.name} records yet.</p>}
        {records.error && <div className="p-3"><ErrorText error={problemsOf(records.error)} /></div>}
      </div>
      <FormLinks type={type} canWrite={canWrite} />
    </div>
  );
}

function RecordForm({ type, record, onClose, onSaved, canWrite }: { type: RecordTypeView; record: RecordView | null; onClose: () => void; onSaved: () => void; canWrite: boolean }) {
  const qc = useQueryClient();
  const [values, setValues] = useState<FieldValues>(toFieldValues(type.fields, record?.data));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['records', type.id] });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = fromFieldValues(type.fields, values);
      if (record) await api.patch(`/records/${record.id}`, { data });
      else await api.post('/records', { type: type.id, data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)) });
      await refresh();
      onSaved();
    } catch (err) {
      setError(problemsOf(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!record || !window.confirm('Delete this record? Its links to cases are removed.')) return;
    try {
      await api.delete(`/records/${record.id}`);
      // Its case links went with it.
      await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ['cases'] }), qc.invalidateQueries({ queryKey: ['case'] })]);
      onClose();
    } catch (err) {
      setError(problemsOf(err));
    }
  };
  return (
    <form className={cn(CARD, 'p-4 space-y-3')} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold text-on-surface">{record ? (record.title ?? type.name) : `New ${type.name}`}</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-on-surface-variant cursor-pointer"><X className="w-4 h-4" /></button>
      </div>
      <FieldInputs fields={type.fields} values={values} onChange={setValues} disabled={!canWrite} />
      {record?.source === 'form' && <p className="text-xs text-warning">Submitted through a public form: the content is from outside.</p>}
      <ErrorText error={error} />
      {canWrite && (
        <div className="flex gap-2">
          <button type="submit" className={PRIMARY} disabled={busy}>Save</button>
          {record && <button type="button" className={cn(BUTTON, 'text-error')} onClick={remove}><Trash2 className="w-4 h-4" />Delete</button>}
        </div>
      )}
    </form>
  );
}

/** Form links: a URL people outside fill in. The link itself is shown once, when it is made. */
function FormLinks({ type, canWrite }: { type: RecordTypeView; canWrite: boolean }) {
  const qc = useQueryClient();
  const workspaceId = useWorkspaceId();
  const links = useQuery({ queryKey: ['form-links', type.id, workspaceId], queryFn: () => api.get<FormLinkView[]>(`/record-types/${type.id}/form-links`) });
  const [title, setTitle] = useState('');
  const [caseKind, setCaseKind] = useState('');
  const [minted, setMinted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mint = async () => {
    setError(null);
    try {
      const link = await api.post<MintedFormLinkView>(`/record-types/${type.id}/form-links`, { title, ...(caseKind.trim() ? { caseKind } : {}) });
      setMinted(`${window.location.origin}${link.path}`);
      setTitle('');
      await qc.invalidateQueries({ queryKey: ['form-links', type.id] });
    } catch (err) {
      setError(problemsOf(err));
    }
  };
  const revoke = async (linkId: string) => {
    if (!window.confirm('Revoke this form link? It stops working at once.')) return;
    try {
      await api.delete(`/record-types/${type.id}/form-links/${linkId}`);
      await qc.invalidateQueries({ queryKey: ['form-links', type.id] });
    } catch (err) {
      setError(problemsOf(err));
    }
  };
  return (
    <section className={cn(CARD, 'p-4 space-y-3')}>
      <h3 className="text-sm font-semibold text-on-surface flex items-center gap-1.5"><LinkIcon className="w-4 h-4" />Public forms</h3>
      <p className="text-xs text-on-surface-variant">Anyone with the link can submit a record of type {type.name}, without an account. Submissions are saved as you.</p>
      {minted && (
        <div className="flex items-center gap-2 p-2 rounded-xs bg-primary-container/30 text-sm">
          <code className="flex-1 break-all text-on-surface">{minted}</code>
          <button type="button" className={BUTTON} onClick={() => void navigator.clipboard.writeText(minted)}><Copy className="w-4 h-4" />Copy</button>
          <span className="text-xs text-on-surface-variant">Shown once.</span>
        </div>
      )}
      <ul className="space-y-1 text-sm">
        {links.data?.map((l) => (
          <li key={l.id} className="flex items-center gap-2">
            <span className={cn('flex-1', l.revokedAt ? 'text-on-surface-variant line-through' : 'text-on-surface')}>{l.title}</span>
            <span className="text-xs text-on-surface-variant">{l.submissionCount}{l.maxSubmissions ? ` / ${l.maxSubmissions}` : ''} submitted{l.caseKind ? ` · opens a ${l.caseKind} case` : ''}</span>
            {canWrite && !l.revokedAt && <button type="button" className={cn(BUTTON, 'text-error')} onClick={() => revoke(l.id)}>Revoke</button>}
          </li>
        ))}
      </ul>
      {canWrite && (
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void mint(); }}>
          <input className={cn(INPUT, 'flex-1 min-w-40')} placeholder="Form title, e.g. Apply now" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Form title" />
          <input className={cn(INPUT, 'w-44')} placeholder="open a case of kind…" value={caseKind} onChange={(e) => setCaseKind(e.target.value)} aria-label="Case kind" />
          <button type="submit" className={BUTTON} disabled={!title.trim()}><Plus className="w-4 h-4" />Make link</button>
        </form>
      )}
      <ErrorText error={error} />
    </section>
  );
}
