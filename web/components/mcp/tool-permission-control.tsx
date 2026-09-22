'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

type Level = 'ALLOW' | 'ASK' | 'DENY';
interface Permission {
  toolId: string;
  action: string;
  level: Level;
  conditions?: { type: string; value: unknown }[];
  expiresAt?: string;
}

/** Uses the same server.tool action identity as eager and lazy MCP dispatch. */
export function McpToolPermissionControl({ serverId, toolName }: {
  serverId: string;
  toolName: string;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const query = useQuery({
    queryKey: ['tool-permissions'],
    queryFn: () => api.get<{ permissions: Permission[] }>('/tools/permissions'),
  });
  const action = `${serverId}.${toolName}`;
  const permission = query.data?.permissions?.find(p => p.toolId === 'mcp' && p.action === action);
  const restricted = !!permission?.conditions?.length || !!permission?.expiresAt;
  const expired = !!permission?.expiresAt && new Date(permission.expiresAt) <= new Date();

  async function change(level: Level | 'DEFAULT') {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      if (level === 'DEFAULT') {
        await api.delete(`/tools/permissions/mcp/${encodeURIComponent(action)}`);
      } else {
        await api.put('/tools/permissions', { toolId: 'mcp', action, level });
      }
      await client.invalidateQueries({ queryKey: ['tool-permissions'] });
      setSaved(level === 'DEFAULT' ? 'Override removed.' : 'Permission saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save permission');
    } finally {
      setBusy(false);
    }
  }

  return <div className="mt-2 space-y-1 text-xs">
    <label className="flex flex-wrap items-center gap-2">
      <span className="text-on-surface-variant">Your permission</span>
      <select
        aria-label={`Permission for ${serverId} / ${toolName}`}
        disabled={busy || query.isPending || query.isError || !query.data?.permissions}
        value={permission?.level ?? 'DEFAULT'}
        onChange={event => void change(event.target.value as Level | 'DEFAULT')}
        className="rounded border border-outline-variant bg-surface-container px-2 py-1 text-on-surface disabled:opacity-50"
      >
        <option value="DEFAULT">Default (ask unless a rule applies)</option>
        <option value="ALLOW">Allow — no confirmation</option>
        <option value="ASK">Ask — every call</option>
        <option value="DENY">Deny — block tool</option>
      </select>
      {busy && <span role="status">Saving…</span>}
    </label>
    {restricted && <p className="text-warning">
      {expired ? 'Existing permission has expired.' : 'Existing permission has scope or expiry restrictions.'}
      {' '}Changing this selection replaces it with a permanent permission for this tool.
      {' '}<a href="/permissions" className="underline">Review restrictions</a>
      {' '}<button disabled={busy || query.isError} className="underline disabled:opacity-50"
        onClick={() => void change(permission!.level)}>Make this setting permanent</button>
    </p>}
    {saved && <p role="status" className="text-tertiary">{saved}</p>}
    {(error || query.isError) && <p role="alert" className="text-error">
      {error || 'Could not load permissions.'}
      {query.isError && <button className="ml-2 underline" onClick={() => void query.refetch()}>Retry</button>}
    </p>}
  </div>;
}
