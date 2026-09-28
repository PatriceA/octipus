'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

interface Destination {
  id: string;
  orgId: string | null;
  channelType: string;
  channelId: string;
  label: string | null;
  createdAt: string;
}

interface AdminOrg {
  id: string;
  name: string;
}

/**
 * Admin → Notification destinations.
 *
 * Hooks, notifications, monitors and unattended agents may always message
 * the owner's own linked chats. Shared chats (a Slack #alerts channel, a
 * Telegram group) must be approved here first, for everyone or for one org.
 */
export default function AdminDestinationsPage() {
  const queryClient = useQueryClient();
  const [channelType, setChannelType] = useState<string>('slack');
  const [channelId, setChannelId] = useState('');
  const [label, setLabel] = useState('');
  const [orgId, setOrgId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'notification-destinations'],
    // channelTypes comes from the server (EXTERNAL_CHANNEL_TYPES) so the list has one source.
    queryFn: () => api.get<{ destinations: Destination[]; channelTypes: string[] }>('/admin/notification-destinations'),
  });

  // Orgs are optional (flag-gated); a 404 just means "everyone" is the only scope.
  const { data: orgData } = useQuery({
    queryKey: ['admin', 'orgs'],
    queryFn: () => api.get<{ orgs: AdminOrg[] }>('/admin/orgs'),
    retry: false,
  });
  const orgs = orgData?.orgs ?? [];
  const orgName = (id: string | null) => (id ? orgs.find((o) => o.id === id)?.name ?? id : 'everyone');

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'notification-destinations'] });

  const addMutation = useMutation({
    mutationFn: () => api.post<Destination>('/admin/notification-destinations', {
      channelType,
      channelId: channelId.trim(),
      label: label.trim() || null,
      orgId: orgId || null,
    }),
    onSuccess: () => {
      setChannelId('');
      setLabel('');
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/notification-destinations/${id}`),
    onSuccess: invalidate,
  });

  const destinations = data?.destinations ?? [];
  const inputCls = 'mt-1 w-full px-2 py-1.5 bg-surface-container border border-outline-variant/20 rounded text-sm text-on-surface';
  const labelCls = 'text-[10px] uppercase tracking-widest font-bold text-on-surface-variant';

  return (
    <div className="space-y-4">
      <div>
        <h2 className="section-label">notification destinations</h2>
        <p className="mt-1 text-xs text-on-surface-variant">
          Shared chats that hooks, notifications, monitors and unattended agents may message besides each
          user&apos;s own linked chats.
        </p>
      </div>

      <div className="term-frame rounded-xs p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr_1fr_auto_auto] gap-2 items-end">
          <div>
            <label className={labelCls} htmlFor="dest-type">Channel</label>
            <select id="dest-type" value={channelType} onChange={(e) => setChannelType(e.target.value)} className={inputCls}>
              {(data?.channelTypes ?? [channelType]).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="dest-id">Channel / chat id</label>
            <input id="dest-id" value={channelId} onChange={(e) => setChannelId(e.target.value)} placeholder="C0123ALERTS" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="dest-label">Label</label>
            <input id="dest-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="#alerts" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="dest-org">For</label>
            <select id="dest-org" value={orgId} onChange={(e) => setOrgId(e.target.value)} className={inputCls}>
              <option value="">everyone</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <button
            type="button"
            onClick={() => addMutation.mutate()}
            disabled={!channelId.trim() || addMutation.isPending}
            className="px-3 py-1.5 text-sm bg-primary text-on-primary font-bold rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            {addMutation.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
        {error && <p className="text-xs text-error">! {error}</p>}
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-on-surface-variant">Loading…</div>
      ) : destinations.length === 0 ? (
        <div className="p-8 text-center text-on-surface-variant border border-outline-variant/40 rounded-xs border-dashed">
          <p aria-hidden className="text-[16px] text-outline mb-1">[ ]</p>
          <p className="text-[12px]">no shared destinations approved</p>
        </div>
      ) : (
        <ul className="term-frame rounded-xs divide-y divide-outline-variant/10">
          {destinations.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="text-on-surface-variant w-20 shrink-0">{d.channelType}</span>
              <span className="text-on-surface break-all flex-1">
                {d.channelId}
                {d.label && <span className="text-on-surface-variant"> · {d.label}</span>}
              </span>
              <span className="text-xs text-on-surface-variant">{orgName(d.orgId)}</span>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Remove ${d.channelType}:${d.channelId}? Hooks targeting it will stop sending there.`)) {
                    removeMutation.mutate(d.id);
                  }
                }}
                title="Remove destination"
                aria-label={`Remove ${d.channelType}:${d.channelId}`}
                className="text-on-surface-variant/60 hover:text-error cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
