'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';

interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export default function AdminAuditPage() {
  const [actionFilter, setActionFilter] = useState('');
  const [userIdFilter, setUserIdFilter] = useState('');
  const [limit, setLimit] = useState(100);

  const params = new URLSearchParams();
  if (actionFilter) params.set('action', actionFilter);
  if (userIdFilter) params.set('userId', userIdFilter);
  params.set('limit', String(limit));

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'audit', actionFilter, userIdFilter, limit],
    queryFn: () => api.get<{ entries: AuditEntry[] }>(`/admin/audit?${params.toString()}`),
  });

  const entries = data?.entries ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="section-label">audit log</h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input
          type="text"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder="Filter by action (e.g. user_created)"
          className="bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
        />
        <input
          type="text"
          value={userIdFilter}
          onChange={(e) => setUserIdFilter(e.target.value)}
          placeholder="Filter by userId (UUID)"
          className="bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
        />
        <select
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10))}
          className="bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
        >
          <option value={50}>50 rows</option>
          <option value={100}>100 rows</option>
          <option value={250}>250 rows</option>
          <option value={1000}>1000 rows</option>
        </select>
      </div>

      <div className="overflow-x-auto term-frame rounded-xs">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-on-surface-variant">
            <tr className="border-b border-outline-variant/10">
              <th className="text-left px-4 py-2 font-medium">Time</th>
              <th className="text-left px-4 py-2 font-medium">Action</th>
              <th className="text-left px-4 py-2 font-medium">User</th>
              <th className="text-left px-4 py-2 font-medium">Resource</th>
              <th className="text-left px-4 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="stagger">
            {isLoading && (
              <tr><td colSpan={5} className="px-4 py-3 text-on-surface-variant">Loading…</td></tr>
            )}
            {!isLoading && entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-on-surface-variant">
                  <p aria-hidden className="text-[16px] text-outline mb-1">[--]</p>
                  <p className="text-[12px]">no matching entries</p>
                </td>
              </tr>
            )}
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-outline-variant/5 last:border-0 align-top">
                <td className="px-4 py-2 text-on-surface-variant whitespace-nowrap">
                  {new Date(e.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-2 text-on-surface font-mono text-xs">{e.action}</td>
                <td className="px-4 py-2 text-on-surface-variant font-mono text-xs">
                  {e.userId ? e.userId.slice(0, 8) + '…' : '—'}
                </td>
                <td className="px-4 py-2 text-on-surface-variant text-xs">
                  {e.resourceType ? `${e.resourceType}` : '—'}
                  {e.resourceId && (
                    <span className="text-on-surface-variant/60 font-mono"> {e.resourceId.slice(0, 8)}…</span>
                  )}
                </td>
                <td className="px-4 py-2 text-on-surface-variant text-xs font-mono break-all max-w-md">
                  {e.details ? JSON.stringify(e.details) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
