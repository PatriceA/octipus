import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Portal } from '@/components/ui/portal';
import type { MCPServerConfigView, MCPServerEdit } from '../../../src/shared/mcp-config';

export function ServerEditor({ serverId, onClose, onSaved }: {
  serverId: string; onClose: () => void; onSaved: () => void;
}) {
  const query = useQuery({
    queryKey: ['mcp-edit', serverId],
    queryFn: () => api.get<{ server: MCPServerConfigView }>(`/mcp/servers/${encodeURIComponent(serverId)}/config`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    gcTime: 0,
  });
  return <Portal><div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
    <div role="dialog" aria-modal="true" aria-label="Edit MCP server" className="w-full max-w-xl max-h-[90vh] overflow-auto rounded-xl bg-surface p-6 space-y-4">
      <h2 className="text-lg font-semibold">Edit MCP server</h2>
      {query.isPending && <p>Loading configuration…</p>}
      {query.error && <p role="alert" className="text-error">{query.error.message}</p>}
      {query.data && <EditorForm key={query.data.server.revision} initial={query.data.server} onSaved={onSaved} onClose={onClose} />}
      {!query.data && <button onClick={onClose}>Close</button>}
    </div>
  </div></Portal>;
}

function EditorForm({ initial, onSaved, onClose }: {
  initial: MCPServerConfigView; onSaved: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [transport, setTransport] = useState(initial.transport ?? 'stdio');
  const [command, setCommand] = useState(initial.command);
  const [args, setArgs] = useState(JSON.stringify(initial.args ?? []));
  const [cwd, setCwd] = useState(initial.cwd ?? '');
  const [url, setUrl] = useState(initial.sseUrl ?? '');
  const [postUrl, setPostUrl] = useState(initial.postUrl ?? '');
  const [authorization, setAuthorization] = useState('');
  const [removeAuth, setRemoveAuth] = useState(false);
  const [env, setEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputClass = 'w-full rounded border border-outline-variant bg-surface-container px-3 py-2 text-on-surface';

  async function save() {
    setBusy(true); setError('');
    try {
      const edit: MCPServerEdit = { revision: initial.revision };
      if (name.trim() !== initial.name) edit.name = name.trim();
      if (transport !== (initial.transport ?? 'stdio')) edit.transport = transport;
      if (transport === 'stdio') {
        const parsed: unknown = JSON.parse(args);
        if (!Array.isArray(parsed) || !parsed.every(arg => typeof arg === 'string')) throw new Error('Arguments must be a JSON array of strings');
        if (command !== initial.command) edit.command = command;
        if (JSON.stringify(parsed) !== JSON.stringify(initial.args ?? [])) edit.args = parsed;
        if (cwd !== (initial.cwd ?? '')) edit.cwd = cwd;
        if (env.trim()) {
          edit.envPatch = {};
          for (const line of env.split('\n').filter(line => line.trim())) {
            const eq = line.indexOf('=');
            const key = (eq < 0 ? line : line.slice(0, eq)).trim();
            if (!key) throw new Error('Environment variable names cannot be empty');
            edit.envPatch[key] = eq < 0 ? null : line.slice(eq + 1);
          }
        }
      } else {
        if (url !== (initial.sseUrl ?? '')) edit.sseUrl = url;
        if (transport === 'sse' && postUrl !== (initial.postUrl ?? '')) edit.postUrl = postUrl;
        if (removeAuth) edit.authorization = null;
        else if (authorization.trim()) edit.authorization = authorization.trim();
      }
      await api.put(`/mcp/servers/${encodeURIComponent(initial.id)}/config`, edit);
      onSaved(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save server'); }
    finally { setBusy(false); }
  }

  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset disabled={busy} className="space-y-4">
      <label className="block">Name<input className={inputClass} value={name} required onChange={e => setName(e.target.value)} /></label>
      <label className="block">Transport<select className={inputClass} value={transport} onChange={e => setTransport(e.target.value as typeof transport)}>
        <option value="streamable-http">Streamable HTTP</option><option value="sse">SSE</option><option value="stdio">stdio</option>
      </select></label>
      {transport === 'stdio' ? <>
        <label className="block">Command or executable path<input className={inputClass} value={command} required onChange={e => setCommand(e.target.value)} /></label>
        <label className="block">Arguments (JSON array)<textarea className={inputClass} value={args} onChange={e => setArgs(e.target.value)} /></label>
        <p className="text-xs text-on-surface-variant">Each array entry is one argument; spaces inside paths are preserved.</p>
        <label className="block">Working directory<input className={inputClass} value={cwd} onChange={e => setCwd(e.target.value)} /></label>
        <label className="block">Environment changes<textarea className={inputClass} value={env} onChange={e => setEnv(e.target.value)} placeholder="API_TOKEN=new-value" /></label>
        <p className="text-xs text-on-surface-variant">Stored names: {initial.envNames.join(', ') || 'none'}. Values stay hidden. Enter KEY=value to set, or KEY alone to remove, one per line. Unlisted variables are preserved.</p>
      </> : <>
        <label className="block">{transport === 'sse' ? 'SSE URL' : 'Server URL'}<input className={inputClass} type="url" value={url} required onChange={e => setUrl(e.target.value)} /></label>
        {transport === 'sse' && <label className="block">POST URL<input className={inputClass} type="url" value={postUrl} required onChange={e => setPostUrl(e.target.value)} /></label>}
        <label className="block">Authorization header<input className={inputClass} type="password" autoComplete="new-password" value={authorization} disabled={removeAuth} placeholder="Bearer your-token" onChange={e => setAuthorization(e.target.value)} /></label>
        <p className="text-xs text-on-surface-variant">{initial.hasAuthorization ? 'A credential is stored.' : 'No Authorization header stored.'} Leave blank to preserve it. Other headers are preserved.</p>
        <label className="flex gap-2"><input type="checkbox" checked={removeAuth} onChange={e => setRemoveAuth(e.target.checked)} />Remove stored Authorization header</label>
      </>}
    </fieldset>
    <p className="text-sm text-on-surface-variant">Changes apply on the next connection. To apply now, save, then disconnect and connect this server. Active connections are left running.</p>
    {error && <p role="alert" className="text-error">{error}</p>}
    <div className="flex justify-end gap-3"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={busy} className="rounded bg-primary px-4 py-2 text-on-primary">{busy ? 'Saving…' : 'Save changes'}</button></div>
  </form>;
}
