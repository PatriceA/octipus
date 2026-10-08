'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** `FederationInstanceView` (src/core/federation/host-ops.ts). */
interface FederationInstance {
  instanceId: string;
  badge: string;
  status: 'active' | 'blocked';
  firstSeen: string;
  lastSeen: string;
  blockedAt: string | null;
  linkUp: boolean;
  liveMemberships: number;
  turnsInFlight: number;
  virtualConnections: number;
}

const KEY = ['admin', 'federation', 'instances'] as const;

/** The full id in four groups, to compare with what the other install shows. */
function grouped(id: string): string {
  return [id.slice(0, 7), id.slice(7, 14), id.slice(14, 20), id.slice(20)].join('-');
}

/**
 * Admin → Federation (docs/plans/federation-spec.md §7.6, §10): the other
 * installs whose members joined spaces here. Blocking one closes its link,
 * refuses its members at once and removes every membership they hold here
 * (audited); unblocking restores the status only. Space owners remove a
 * single member of another install from the space's members, like any
 * member.
 */
export default function AdminFederationPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<{ instances: FederationInstance[] }>('/admin/federation/instances'),
    refetchInterval: 15_000,
  });
  const act = useMutation({
    mutationFn: ({ id, op }: { id: string; op: 'block' | 'unblock' }) =>
      api.post<{ success: boolean; membershipsRemoved?: number; warning?: string }>(`/admin/federation/instances/${id}/${op}`, {}),
    onSuccess: (res) => {
      setError(res.warning ?? null);
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (err: Error) => setError(err.message),
  });
  const instances = data?.instances ?? [];

  return (
    <div className="space-y-4" data-testid="admin-federation">
      <div>
        <h2 className="section-label">federation</h2>
        <p className="mt-1 text-xs text-on-surface-variant">
          Other installs whose members joined a space here with an invite. Each is known by its fingerprint, verified on
          every connection. Blocking an install closes its link and removes every membership its members hold here; their
          agents can no longer read or post. Hosting is on while <code>federation.mode</code> is <code>host</code> or <code>both</code>.
        </p>
      </div>
      {error && <p role="alert" className="text-xs text-error">! {error}</p>}
      {isLoading ? (
        <div className="p-8 text-center text-on-surface-variant">Loading…</div>
      ) : instances.length === 0 ? (
        <div className="p-8 text-center text-on-surface-variant border border-outline-variant/40 rounded-xs border-dashed">
          <p aria-hidden className="text-[16px] text-outline mb-1">[ ]</p>
          <p className="text-[12px]">no other install has joined a space here</p>
        </div>
      ) : (
        <ul className="term-frame rounded-xs divide-y divide-outline-variant/10">
          {instances.map((i) => (
            <li key={i.instanceId} className="px-4 py-2 flex flex-wrap items-center gap-3 text-sm" data-testid="federation-instance">
              <span className="text-primary shrink-0">{i.badge}</span>
              <span className="text-on-surface break-all flex-1 min-w-0 font-mono text-xs" title="The install's full fingerprint">{grouped(i.instanceId)}</span>
              <span className={cn('text-xs', i.status === 'blocked' ? 'text-error' : i.linkUp ? 'text-tertiary' : 'text-on-surface-variant')}>
                {i.status === 'blocked' ? 'blocked' : i.linkUp ? 'link up' : 'link down'}
              </span>
              <span className="text-xs text-on-surface-variant">
                {i.liveMemberships} {i.liveMemberships === 1 ? 'membership' : 'memberships'} · {i.turnsInFlight} turns in flight · {i.virtualConnections} connections
              </span>
              <span className="text-xs text-on-surface-variant" title={`first seen ${new Date(i.firstSeen).toLocaleString()}`}>
                last seen {new Date(i.lastSeen).toLocaleString()}
              </span>
              {i.status === 'active' ? (
                <button
                  type="button"
                  disabled={act.isPending}
                  onClick={() => {
                    if (confirm(`Block ${i.badge}? Its link closes and the ${i.liveMemberships} memberships its members hold here are removed.`)) {
                      act.mutate({ id: i.instanceId, op: 'block' });
                    }
                  }}
                  className="inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-error cursor-pointer disabled:opacity-50"
                >
                  <Ban className="w-3.5 h-3.5" /> block
                </button>
              ) : (
                <button
                  type="button"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ id: i.instanceId, op: 'unblock' })}
                  title="Restores the status only: removed memberships stay removed"
                  className="inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer disabled:opacity-50"
                >
                  <CircleCheck className="w-3.5 h-3.5" /> unblock
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
