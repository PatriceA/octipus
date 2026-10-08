'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  MCP_EXPOSURES,
  type McpExposure,
  ownToolExposure,
  resolveToolExposure,
} from '../../../src/shared/mcp-exposure';

/** One line per mode, as the select shows it. Semantics: src/shared/mcp-exposure.ts. */
export const EXPOSURE_LABELS: Record<McpExposure, string> = {
  direct: 'Direct — declared on every request',
  deferred: 'Deferred — found through mcp_list_tools',
  codemode: 'Codemode — scripts only',
  hidden: 'Hidden — unreachable',
};

export const EXPOSURE_HELP =
  'How these tools reach agents. Direct puts each tool in every request (best for a few tools used constantly). ' +
  'Deferred lists them on demand. Codemode keeps them out of the conversation: agents call them from codemode scripts, ' +
  'and agents without codemode see them as deferred. Hidden blocks them. Applies to agents started after the change.';

const serverPath = (serverId: string) => `/mcp/servers/${encodeURIComponent(serverId)}`;

function useSave(serverId: string) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(request: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await request();
      await Promise.all([
        client.invalidateQueries({ queryKey: ['mcp-servers'] }),
        client.invalidateQueries({ queryKey: ['mcp-tools', serverId] }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save exposure');
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, save };
}

/** Server-wide exposure: the mode every tool without an override gets. */
export function ServerExposureControl({ serverId, serverName, exposure }: {
  serverId: string;
  serverName: string;
  exposure: McpExposure;
}) {
  const { busy, error, save } = useSave(serverId);
  return <div className="mb-3 space-y-1 text-xs">
    <label className="flex flex-wrap items-center gap-2">
      <span className="text-on-surface-variant">Exposure for all tools</span>
      <select
        aria-label={`Exposure for ${serverName}`}
        disabled={busy}
        value={exposure}
        onChange={event => void save(() => api.put(`${serverPath(serverId)}/exposure`, { exposure: event.target.value }))}
        className="rounded border border-outline-variant bg-surface-container px-2 py-1 text-on-surface disabled:opacity-50"
      >
        {MCP_EXPOSURES.map(mode => <option key={mode} value={mode}>{EXPOSURE_LABELS[mode]}</option>)}
      </select>
      {busy && <span role="status">Saving…</span>}
    </label>
    <p className="text-on-surface-variant">{EXPOSURE_HELP}</p>
    {error && <p role="alert" className="text-error">{error}</p>}
  </div>;
}

/**
 * Per-tool exposure. Sets one exact-name override (server-side, so changing
 * several tools quickly loses none); "server default" removes it. The default
 * shown is what the tool would get without its own override — the server
 * mode, or a `*` pattern set through the API.
 */
export function ToolExposureControl({ serverId, toolName, exposure, toolExposure }: {
  serverId: string;
  toolName: string;
  exposure: McpExposure;
  toolExposure: Record<string, McpExposure>;
}) {
  const { busy, error, save } = useSave(serverId);
  const own = ownToolExposure(toolExposure, toolName);
  const others = Object.fromEntries(Object.entries(toolExposure).filter(([key]) => key !== toolName));
  const inherited = resolveToolExposure({ exposure, toolExposure: others }, toolName);

  function change(value: McpExposure | 'INHERIT') {
    void save(() => api.put(`${serverPath(serverId)}/tools/${encodeURIComponent(toolName)}/exposure`, {
      exposure: value === 'INHERIT' ? null : value,
    }));
  }

  return <div className="mt-1 space-y-1 text-xs">
    <label className="flex flex-wrap items-center gap-2">
      <span className="text-on-surface-variant">Exposure</span>
      <select
        aria-label={`Exposure for ${serverId} / ${toolName}`}
        disabled={busy}
        value={own ?? 'INHERIT'}
        onChange={event => change(event.target.value as McpExposure | 'INHERIT')}
        className="rounded border border-outline-variant bg-surface-container px-2 py-1 text-on-surface disabled:opacity-50"
      >
        <option value="INHERIT">Server default ({inherited})</option>
        {MCP_EXPOSURES.map(mode => <option key={mode} value={mode}>{EXPOSURE_LABELS[mode]}</option>)}
      </select>
      {busy && <span role="status">Saving…</span>}
    </label>
    {error && <p role="alert" className="text-error">{error}</p>}
  </div>;
}
