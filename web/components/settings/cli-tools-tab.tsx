'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';

type Tool = { name: string; path: string; resolvedPath: string; available?: boolean };
type Kubeconfig = { path: string; context: string };
type ToolsResponse = { approved: Tool[]; discovered: Tool[]; kubeconfig?: Kubeconfig | null; kubeconfigCandidates?: Kubeconfig[] };

export function CliToolsTab() {
  const client = useQueryClient();
  const { data, error, isFetching, refetch } = useQuery({ queryKey: ['cli-tools'], queryFn: () => api.get<ToolsResponse>('/settings/cli-tools') });
  const [search, setSearch] = useState('');
  const [path, setPath] = useState('');
  const [kubePath, setKubePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const change = async (action: 'approve' | 'remove', tool: Pick<Tool, 'name' | 'path'>) => {
    setBusy(true); setMessage('');
    try {
      const url = `/settings/cli-tools/${encodeURIComponent(tool.name)}`;
      if (action === 'approve') await api.put(url, { path: tool.path });
      else await api.delete(url);
      setMessage(action === 'approve' ? `${tool.name} approved. Available to new sandbox commands immediately.` : `${tool.name} removed from the additional runtime list. Already running commands are unaffected.`);
      await client.invalidateQueries({ queryKey: ['cli-tools'] });
    } catch (err) { setMessage((err as Error).message); }
    finally { setBusy(false); }
  };
  const selectKubeconfig = async (selected: string | null) => {
    setBusy(true); setMessage('');
    try {
      await api.put('/settings/cli-tools-kubeconfig', { path: selected });
      setMessage(selected ? 'Kubeconfig selected for your personal shell commands and test runners.' : 'Personal kubeconfig access removed.');
      await client.invalidateQueries({ queryKey: ['cli-tools'] });
    } catch (err) { setMessage((err as Error).message); }
    finally { setBusy(false); }
  };
  const approved = new Map((data?.approved ?? []).map(tool => [tool.name, tool]));
  const candidates = (data?.discovered ?? []).filter(tool => !approved.has(tool.name) && `${tool.name} ${tool.path}`.toLowerCase().includes(search.toLowerCase()));
  const row = (tool: Tool, active: boolean) => (
    <li key={tool.name} className="flex items-start justify-between gap-3 border border-outline-variant rounded-md p-3">
      <div className="min-w-0">
        <p className="font-medium">{tool.name}{active && tool.available === false ? ' · Missing or target changed' : ''}</p>
        <p className="text-xs text-on-surface-variant break-all">{tool.path}</p>
        {tool.path !== tool.resolvedPath && <p className="text-xs text-on-surface-variant break-all">Points to {tool.resolvedPath}</p>}
        {active && tool.available === false && <p className="text-xs text-on-surface-variant">Remove and approve the current executable again.</p>}
      </div>
      <button type="button" disabled={busy} onClick={() => change(active ? 'remove' : 'approve', tool)} className="text-sm text-primary disabled:opacity-50 shrink-0">{active ? 'Remove' : 'Approve'}</button>
    </li>
  );
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-extrabold">CLI tools</h2>
      <p className="text-sm text-on-surface-variant">Make installed commands available to sandboxed shell steps and test runners on this Octipus server. Approvals apply across this installation and take effect for new commands without a restart.</p>
      <p className="text-sm text-on-surface-variant">Executables are exposed read-only. Credentials, network access and action permissions are configured separately. Standard system tools remain available; this list adds tools that the sandbox cannot otherwise see. Scripts may need their interpreter or additional dependencies installed in the sandbox.</p>
      {(message || error) && <p role="status" className="text-sm">{message || (error as Error).message}</p>}
      <section className="space-y-3 border border-outline-variant rounded-md p-3">
        <h3 className="font-medium">Kubernetes / OpenShift login</h3>
        <p className="text-sm text-on-surface-variant">Use an existing server kubeconfig for oc, kubectl and scripts that call them. The file is exposed read-only to your personal shell commands and test runners. Commands can read its credentials; other users and shared spaces do not receive it. Only its path and current context are saved in settings.</p>
        {data?.kubeconfig && <div className="space-y-1"><p className="text-sm break-all">Selected: {data.kubeconfig.path}</p><p className="text-xs text-on-surface-variant break-all">Context: {data.kubeconfig.context}</p><button type="button" disabled={busy} onClick={() => void selectKubeconfig(null)} className="text-sm text-primary">Remove kubeconfig access</button></div>}
        {(data?.kubeconfigCandidates ?? []).filter(candidate => candidate.path !== data?.kubeconfig?.path).map(candidate => <div key={candidate.path} className="flex justify-between gap-3"><div className="min-w-0"><p className="text-sm break-all">{candidate.path}</p><p className="text-xs text-on-surface-variant break-all">Context: {candidate.context}</p></div><button type="button" disabled={busy} onClick={() => void selectKubeconfig(candidate.path)} className="text-sm text-primary shrink-0">Use this kubeconfig</button></div>)}
        <form onSubmit={event => { event.preventDefault(); void selectKubeconfig(kubePath); }} className="space-y-2">
          <label htmlFor="cli-kubeconfig-path" className="block text-sm">Kubeconfig path</label>
          <div className="flex gap-2"><input id="cli-kubeconfig-path" value={kubePath} onChange={event => setKubePath(event.target.value)} placeholder="/home/you/.kube/config" className="min-w-0 flex-1 bg-surface-container-low border border-outline-variant rounded-md p-2 text-sm" /><button type="submit" disabled={busy || !kubePath.startsWith('/')} className="text-sm text-primary disabled:opacity-50">Use path</button></div>
        </form>
      </section>
      <div className="space-y-2">
        <h3 className="font-medium">Approved tools</h3>
        <ul className="space-y-2">{(data?.approved ?? []).map(tool => row(tool, true))}</ul>
        {data && !data.approved.length && <p className="text-sm text-on-surface-variant">No additional tools approved yet.</p>}
      </div>
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); const name = path.split('/').pop() ?? ''; if (name) void change('approve', { name, path }); }}>
        <label htmlFor="cli-path" className="block font-medium">Add by executable path</label>
        <div className="flex gap-2">
          <input id="cli-path" value={path} onChange={event => setPath(event.target.value)} placeholder="/home/you/.local/bin/oc" className="min-w-0 flex-1 bg-surface-container-low border border-outline-variant rounded-md p-2 text-sm" />
          <button type="submit" disabled={busy || !path.startsWith('/')} className="text-sm text-primary disabled:opacity-50">Approve path</button>
        </div>
      </form>
      <div className="space-y-2">
        <div className="flex items-center justify-between"><h3 className="font-medium">Installed commands</h3><button type="button" disabled={isFetching} onClick={() => void refetch()} className="text-sm text-primary">{isFetching ? 'Discovering…' : 'Refresh discovery'}</button></div>
        <p className="text-xs text-on-surface-variant">Discovery searches the server’s command paths without running any executable.</p>
        <input aria-label="Search installed commands" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search commands, e.g. oc" className="w-full bg-surface-container-low border border-outline-variant rounded-md p-2 text-sm" />
        <p className="text-xs text-on-surface-variant">{candidates.length} commands found{candidates.length > 100 ? ' · Showing the first 100; narrow your search.' : ''}</p>
        <ul className="space-y-2 max-h-96 overflow-y-auto">{candidates.slice(0, 100).map(tool => row(tool, false))}</ul>
      </div>
    </div>
  );
}
