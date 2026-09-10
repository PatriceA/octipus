'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/ui/page-header';

interface Permission {
  toolId: string; action: string; level: string; reason?: string;
  expiresAt?: string; conditions?: { type: string; value: unknown }[];
}

export default function PermissionsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['tool-permissions'], queryFn: () => api.get<{ permissions: Permission[] }>('/tools/permissions') });
  const [toolId, setToolId] = useState('');
  const [action, setAction] = useState('');
  const [scopeType, setScopeType] = useState('sessionId');
  const [scopeValue, setScopeValue] = useState('');
  const [expiry, setExpiry] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);
  const field = 'block w-full p-2 border border-outline-variant rounded bg-surface-container text-on-surface';
  async function grant() {
    setBusy(true); setError('');
    try {
      await api.put('/tools/permissions', { toolId, action, level: 'ALLOW',
        reason: 'Explicit scoped authorization', scope: { [scopeType]: scopeValue, expiresAt: new Date(expiry).toISOString() } });
      await client.invalidateQueries({ queryKey: ['tool-permissions'] });
      setReview(false);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save permission'); }
    finally { setBusy(false); }
  }
  async function revoke(permission: Permission) {
    try {
      await api.put('/tools/permissions', { toolId: permission.toolId, action: permission.action, level: 'ASK', reason: 'Scoped authorization revoked' });
      await client.invalidateQueries({ queryKey: ['tool-permissions'] });
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not revoke permission'); }
  }
  return <div className="space-y-6 max-w-3xl">
    <PageHeader title="scoped permissions" description="Authorize a specific tool action for bounded unattended work." />
    <p className="text-sm">An unattended action requiring approval stops until authorized. Grants inherit the run’s existing token and time budgets. A grant does not increase those budgets. <a href="/tools" className="underline text-primary">Find tool action names and general policy</a>.</p>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); setReview(true); }}>
      <label className="block">Tool ID<input required className={field} value={toolId} onChange={e => { setToolId(e.target.value); setReview(false); }} placeholder="filesystem" /></label>
      <label className="block">Permission action<input required className={field} value={action} onChange={e => { setAction(e.target.value); setReview(false); }} placeholder="write" /></label>
      <label className="block">Scope<select className={field} value={scopeType} onChange={e => { setScopeType(e.target.value); setReview(false); }}>
        <option value="sessionId">One session (including its delegated work)</option>
        <option value="workspaceId">One workspace</option>
        <option value="pathPattern">File path pattern (regular expression)</option>
        <option value="commandPattern">Command pattern (regular expression)</option>
      </select></label>
      <label className="block">Scope value<input required className={field} value={scopeValue} onChange={e => { setScopeValue(e.target.value); setReview(false); }} /></label>
      <label className="block">Expires at (your local time)<input required type="datetime-local" className={field} value={expiry} onChange={e => { setExpiry(e.target.value); setReview(false); }} /></label>
      <button className="text-primary underline" type="submit">Review grant</button>
    </form>
    {review && <div className="border border-warning p-4 space-y-2">
      <p>Allow <strong>{toolId}.{action}</strong> without asking again when <strong>{scopeType}: {scopeValue}</strong> matches, until {new Date(expiry).toLocaleString()}.</p>
      <p className="text-sm">This replaces the existing permission for this action. Descendants keep the same scope. Stored denials must be reviewed separately.</p>
      <button disabled={busy} className="underline text-primary" onClick={() => void grant()}>Confirm scoped grant</button>
    </div>}
    {(error || query.isError) && <div role="alert" className="text-error">{error || query.error?.message}<button className="ml-2 underline" onClick={() => void query.refetch()}>Retry permissions</button></div>}
    {query.isPending && <p>Loading permissions…</p>}
    {query.data?.permissions.length === 0 && <p>No permission overrides.</p>}
    {query.data?.permissions.map(permission => <div key={`${permission.toolId}.${permission.action}`} className="border border-outline-variant p-3">
      <p>{permission.toolId}.{permission.action} · {permission.level}</p>
      <p className="text-sm">{permission.conditions?.map(c => `${c.type}: ${String(c.value)}`).join(' · ') || 'No scope restriction'}</p>
      <p className="text-sm">{permission.expiresAt ? `Expires ${new Date(permission.expiresAt).toLocaleString()}` : 'No expiration'}</p>
      {permission.level === 'ALLOW' && <button className="underline text-primary" onClick={() => void revoke(permission)}>Revoke grant (require approval)</button>}
    </div>)}
  </div>;
}
