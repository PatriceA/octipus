'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExecutionEnvironment, EnvironmentReadiness } from '../../../src/shared/execution-environment';
import { api } from '@/lib/api';
import { CliToolsTab } from './cli-tools-tab';

type Setup = { environments: ExecutionEnvironment[]; userId: string; machine: string; account: string;
  credentials: Array<{ name: string; runtimeAllowed: boolean }>; legacy: { sandbox: string; note: string } };

export function EnvironmentsTab() {
  const client = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['execution-environments'], queryFn: () => api.get<Setup>('/settings/execution-environments') });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState<ExecutionEnvironment | null>(null);
  const [folders, setFolders] = useState('');
  const [message, setMessage] = useState('');
  const [checkCommand, setCheckCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [readiness, setReadiness] = useState<Record<string, EnvironmentReadiness>>({});
  const field = <K extends keyof ExecutionEnvironment>(key: K, value: ExecutionEnvironment[K]) => setDraft(current => current ? { ...current, [key]: value } : null);
  const edit = (entry: ExecutionEnvironment) => { setDraft(entry); setFolders(entry.roots.join('\n')); setAcknowledged(false); setMessage(''); };
  const create = (backend: ExecutionEnvironment['backend']) => {
    if (!data) return;
    edit({ id: crypto.randomUUID(), revision: 0, name: backend === 'host' ? 'This computer' : backend === 'sandbox' ? 'Isolated workspace' : 'Remote machine', userId: data.userId, workspaceId: null,
      backend, credentials: [], roots: [], enabled: true, isDefault: data.environments.length === 0, network: true,
      hostIdentity: backend === 'host', hostServices: backend === 'host', approval: 'ask', background: 'ask', allowDataTransfer: false,
      ...(backend === 'ssh' ? { ssh: { host: '', user: '', port: 22 } } : {}) });
  };
  async function save() {
    if (!draft) return;
    setBusy(true); setMessage('');
    try {
      await api.put(`/settings/execution-environments/${draft.id}`, { ...draft, roots: folders.split('\n').map(path => path.trim()).filter(Boolean) });
      await client.invalidateQueries({ queryKey: ['execution-environments'] });
      setDraft(null); setMessage('Environment saved. Affected active agents stop when their environment changes; new work uses the saved policy.');
    } catch (err) { setMessage((err as Error).message); }
    finally { setBusy(false); }
  }
  async function test(entry: ExecutionEnvironment) {
    setBusy(true); setMessage('');
    try { const result = await api.post<EnvironmentReadiness>(`/settings/execution-environments/${entry.id}/test`, { command: checkCommand || undefined }); setReadiness(current => ({ ...current, [entry.id]: result })); }
    catch (err) { setMessage((err as Error).message); }
    finally { setBusy(false); }
  }
  async function revoke(entry: ExecutionEnvironment) {
    setBusy(true); setMessage('');
    try { await api.put(`/settings/execution-environments/${entry.id}`, { ...entry, enabled: false }); await client.invalidateQueries({ queryKey: ['execution-environments'] }); setMessage('Environment disabled. Bound work cannot execute further calls with this grant.'); }
    catch (err) { setMessage((err as Error).message); }
    finally { setBusy(false); }
  }
  if (isLoading) return <p role="status">Loading environments…</p>;
  if (error) return <p role="alert">Could not load environments: {error.message}</p>;
  return <div className="space-y-5">
    <h2 className="text-lg font-extrabold">Environments &amp; Access</h2>
    <p>Choose where work runs, which account it uses, and when Octipus should ask you. The same environment follows project work through agents, pipelines and Companion.</p>
    <p className="text-sm text-on-surface-variant">Octipus server: <strong>{data?.account}@{data?.machine}</strong>. “This computer” means this server, including when you open Octipus from another device.</p>
    <div className="flex flex-wrap gap-3">{(['host', 'sandbox', 'ssh'] as const).map((backend, i) => <button key={backend} type="button" disabled={busy} className="rounded border border-outline-variant px-3 py-2 text-sm" onClick={() => create(backend)}>{['Add this computer', 'Add isolated workspace', 'Add remote machine'][i]}</button>)}</div>
    {data?.environments.length === 0 && <p className="rounded border border-outline-variant p-3 text-sm">Existing installation settings remain active ({data.legacy.sandbox}). Adding an environment is an explicit choice; no existing access is widened automatically.</p>}
    <label className="block text-sm">Optional runtime check (for example oc whoami or adb devices -l)<input className="block w-full rounded border bg-surface-container p-2" aria-label="Runtime check command" value={checkCommand} onChange={event => setCheckCommand(event.target.value)} /></label>
    {data?.environments.map(entry => <section key={entry.id} className="rounded border border-outline-variant p-4 space-y-3">
      <div><strong>{entry.name}</strong><span className="ml-2 text-sm">{entry.backend === 'host' ? 'This computer' : entry.backend === 'sandbox' ? 'Isolated workspace' : `${entry.ssh?.user}@${entry.ssh?.host}`}{entry.isDefault ? ' · Default' : ''}{!entry.enabled ? ' · Disabled' : ''}</span></div>
      <p className="text-xs break-all">{entry.roots.join(' · ')}</p>
      <p className="text-sm">{entry.hostIdentity ? 'Uses this OS account’s existing CLI logins.' : entry.backend === 'ssh' ? 'Uses the remote account’s installed tools and logins.' : 'Uses a separate persistent tool home.'} Interactive: {entry.approval}. Background: {entry.background}.</p>
      <div className="flex gap-4 text-sm"><button disabled={busy} onClick={() => edit(entry)}>Edit</button><button disabled={busy || !entry.enabled} onClick={() => void test(entry)}>Test readiness</button><button disabled={busy || !entry.enabled} onClick={() => void revoke(entry)}>Disable access</button></div>
      {readiness[entry.id] && <div role="status"><p>{readiness[entry.id].summary}</p><ul className="text-sm">{readiness[entry.id].checks.map(check => <li key={check.name}>{check.passed ? '✓' : '✗'} {check.name}: {check.detail}</li>)}</ul>{readiness[entry.id].result && <pre className="whitespace-pre-wrap break-all text-xs">{readiness[entry.id].result!.stdout}{readiness[entry.id].result!.stderr}</pre>}</div>}
    </section>)}
    {draft && <form className="rounded border border-primary p-4 space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h3 className="font-bold">Configure {draft.backend === 'host' ? 'this computer' : draft.backend === 'sandbox' ? 'isolated workspace' : 'remote machine'}</h3>
      <label className="block text-sm">Name<input required className="block w-full rounded border bg-surface-container p-2" value={draft.name} onChange={event => field('name', event.target.value)} /></label>
      <label className="block text-sm">Project folders — one absolute path per line<textarea required rows={3} className="block w-full rounded border bg-surface-container p-2" value={folders} onChange={event => setFolders(event.target.value)} /></label>
      <p className="text-xs">Subfolders are included. More specific project-folder matches take precedence over a default environment.</p>
      {draft.backend === 'ssh' && <fieldset className="grid sm:grid-cols-3 gap-2"><legend>SSH connection</legend>{(['host', 'user', 'port'] as const).map(key => <label key={key}>{key}<input required className="block w-full rounded border bg-surface-container p-2" type={key === 'port' ? 'number' : 'text'} value={draft.ssh?.[key] ?? ''} onChange={event => field('ssh', { ...draft.ssh!, [key]: key === 'port' ? Number(event.target.value) : event.target.value })} /></label>)}<p className="col-span-full text-xs">Uses the server account’s existing SSH authentication and known hosts. The remote account supplies its own CLI logins. Node.js is required for remote file operations.</p></fieldset>}
      <div className="space-y-2 text-sm">
        <label className="block"><input type="checkbox" checked={draft.isDefault} onChange={event => field('isDefault', event.target.checked)} /> Use as my default environment</label>
        <label className="block"><input type="checkbox" checked={draft.enabled} onChange={event => field('enabled', event.target.checked)} /> Enabled</label>
        <label className="block"><input type="checkbox" checked={draft.network} onChange={event => field('network', event.target.checked)} /> Permit network access (enforced by isolated mode)</label>
        {draft.backend === 'host' && <label className="block"><input type="checkbox" checked={draft.hostIdentity} onChange={event => field('hostIdentity', event.target.checked)} /> Use this OS account’s existing CLI logins and configuration</label>}
        {draft.backend !== 'ssh' && <label className="block"><input type="checkbox" checked={draft.hostServices} onChange={event => field('hostServices', event.target.checked)} /> {draft.backend === 'host' ? 'Allow server integrations, including lifecycle access to existing Docker containers' : 'Expose host services and devices, including Docker and USB/ADB'}</label>}
      </div>
      <fieldset className="space-y-2"><legend className="font-medium">Connected credentials</legend><p className="text-xs">Choose encrypted secrets and the variable names required by your CLI. Values stay in the runtime and are masked from results. No source-code change or token in chat is needed.</p>
        {draft.credentials.map((binding, index) => <div className="flex flex-wrap gap-2" key={index}><input aria-label={`Credential variable ${index + 1}`} placeholder="GH_TOKEN" className="min-w-0 rounded border bg-surface-container p-2" value={binding.variable} onChange={event => field('credentials', draft.credentials.map((entry, i) => i === index ? { ...entry, variable: event.target.value } : entry))} /><select aria-label={`Connected secret ${index + 1}`} value={binding.secret} onChange={event => field('credentials', draft.credentials.map((entry, i) => i === index ? { ...entry, secret: event.target.value } : entry))} className="min-w-0 rounded border bg-surface-container p-2"><option value="">Choose a secret</option>{data?.credentials?.map(secret => <option key={secret.name} disabled={!secret.runtimeAllowed} value={secret.name}>{secret.name}{secret.runtimeAllowed ? '' : ' · restricted in Secrets'}</option>)}</select><button type="button" onClick={() => field('credentials', draft.credentials.filter((_, i) => i !== index))}>Remove binding</button></div>)}
        <button type="button" className="text-sm text-primary" onClick={() => field('credentials', [...draft.credentials, { variable: '', secret: '' }])}>Connect a credential</button>
      </fieldset>
      <label className="block text-sm">Interactive work<select aria-label="Interactive work" className="block w-full rounded border bg-surface-container p-2" value={draft.approval} onChange={event => field('approval', event.target.value as ExecutionEnvironment['approval'])}><option value="ask">Ask when permission is needed</option><option value="automatic">Allow available tools automatically</option></select></label>
      <label className="block text-sm">Companion and background work<select aria-label="Companion and background work" className="block w-full rounded border bg-surface-container p-2" value={draft.background} onChange={event => field('background', event.target.value as ExecutionEnvironment['background'])}><option value="ask">Send requests to my approval inbox</option><option value="automatic">Allow available tools automatically</option><option value="deny">Read only; block background changes</option></select></label>
      <label className="block text-sm"><input type="checkbox" checked={draft.allowDataTransfer} onChange={event => field('allowDataTransfer', event.target.checked)} /> Allow this environment to send project/private data using its approved accounts and network access</label>
      <p className="text-sm">CLI-backed models currently require a trusted This computer environment. Choose an API or local model for isolated or remote execution.</p>
      <p className="text-sm">Explicit denials, shared-workspace rules and OS permissions still apply. Automatic access includes side effects of assigned tools. Trusted host and remote commands have the selected OS account’s authority; folder selection and network switches do not confine trusted host or remote processes. Use isolation for unfamiliar code.</p>
      <label className="block text-sm"><input required type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /> I approve this environment’s execution and access policy.</label>
      <div className="flex gap-4"><button type="submit" disabled={busy || !acknowledged} className="rounded bg-primary text-on-primary px-4 py-2">{busy ? 'Saving…' : 'Save environment'}</button><button type="button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button></div>
    </form>}
    {message && <p role="status" className="text-sm">{message}</p>}
    <p className="text-sm">API connections and CLI logins are separate authentication sources. <a className="text-primary underline" href="/secrets">Manage connected accounts and secrets</a>.</p>
    <details onToggle={event => setAdvancedOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm">Advanced: sandbox programs, kubeconfig and maintenance</summary><div className="mt-4">{advancedOpen && <CliToolsTab />}</div></details>
  </div>;
}
