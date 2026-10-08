'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const DESCRIPTION_HELP =
  'One sentence on what this server offers. Agents see it in their list of MCP servers, so they know when to use it. ' +
  "Without one, the server's own self-description is used.";

/** Edit the server's description (src/mcp/servers-section.ts). Saved on demand, not per keystroke. */
export function ServerDescriptionControl({ serverId, serverName, description }: {
  serverId: string;
  serverName: string;
  description: string;
}) {
  const client = useQueryClient();
  const [value, setValue] = useState(description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const dirty = value.trim() !== description.trim();

  async function save() {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await api.put(`/mcp/servers/${encodeURIComponent(serverId)}/description`, { description: value.trim() });
      await client.invalidateQueries({ queryKey: ['mcp-servers'] });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save description');
    } finally {
      setBusy(false);
    }
  }

  return <div className="mb-3 space-y-1 text-xs">
    <label className="flex flex-wrap items-center gap-2">
      <span className="text-on-surface-variant">Description</span>
      <input
        aria-label={`Description for ${serverName}`}
        value={value}
        maxLength={500}
        disabled={busy}
        onChange={event => { setValue(event.target.value); setSaved(false); }}
        placeholder="e.g. Search and read the product documentation"
        className="min-w-0 flex-1 rounded border border-outline-variant bg-surface-container px-2 py-1 text-on-surface disabled:opacity-50"
      />
      <button
        disabled={busy || !dirty}
        onClick={() => void save()}
        className="rounded border border-outline-variant px-3 py-1 disabled:opacity-50"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
    </label>
    <p className="text-on-surface-variant">{DESCRIPTION_HELP}</p>
    {saved && <p role="status" className="text-tertiary">Description saved.</p>}
    {error && <p role="alert" className="text-error">{error}</p>}
  </div>;
}
