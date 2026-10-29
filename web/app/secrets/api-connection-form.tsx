'use client';

import { useState } from 'react';
import { apiConnectionSchema, apiConnectionValidationMessage, type ApiConnectionConfig } from '../../../src/shared/api-connection';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import type { Credential } from '@/lib/vault-config';

const inputClass = 'w-full rounded-md border border-outline-variant bg-surface-container-high px-3 py-2 text-sm text-on-surface';
export function ApiConnectionForm({ credential, workspaceId, onSaved, onCancel }: {
  credential: Credential; workspaceId?: string | null; onSaved: (name: string | null) => void; onCancel: () => void;
}) {
  const {user} = useAuth();
  const current = credential.metadata?.apiConnection;
  const [name,setName] = useState(current?.id ?? credential.name.toLowerCase().replace(/(?:_api)?_(?:token|key)$/,'').replace(/[^a-z0-9_-]/g,'-'));
  const [origin,setOrigin] = useState(current?.origin ?? '');
  const [prefix,setPrefix] = useState(current?.pathPrefix ?? '/api');
  const [auth,setAuth] = useState<ApiConnectionConfig['auth']['type']>(current?.auth.type ?? 'bearer');
  const [username,setUsername] = useState(current?.auth.type === 'basic' ? current.auth.username ?? '' : '');
  const [usernameCredential,setUsernameCredential] = useState(current?.auth.type === 'basic' ? current.auth.usernameCredential ?? '' : '');
  const [header,setHeader] = useState(current?.auth.type === 'header' ? current.auth.name : 'X-API-Key');
  const [headerPrefix,setHeaderPrefix] = useState(current?.auth.type === 'header' ? current.auth.prefix : '');
  const [publicHeaders,setPublicHeaders] = useState(() => Object.entries(current?.headers ?? {}).map(([name,value])=>({name,value})));
  const [methods,setMethods] = useState<string[]>(current?.methods ?? ['GET']);
  const [allowHttp,setAllowHttp] = useState(current?.allowInsecureHttp ?? false);
  const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  const endpoint = `/vault/${encodeURIComponent(credential.id)}/api-connection${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`;
  function useAppwrite() {
    setAuth('header');setHeader('X-Appwrite-Key');setHeaderPrefix('');setPrefix('/v1');
    try { if(origin.trim())setOrigin(new URL(origin.trim()).origin); } catch { /* keep input for validation */ }
    setPublicHeaders(rows=>rows.some(row=>row.name.toLowerCase()==='x-appwrite-project')?rows:[...rows,{name:'X-Appwrite-Project',value:''}]);
  }
  async function save(remove=false) {
    setBusy(true);setError('');
    try {
      const config = remove ? null : { id:name.trim(), origin:origin.trim(), pathPrefix:prefix.trim(), methods, allowInsecureHttp:allowHttp,
        ...(publicHeaders.length?{headers:Object.fromEntries(publicHeaders.map(row=>[row.name.trim(),row.value.trim()]))}:{}),
        auth:auth==='basic' ? {type:auth,...(usernameCredential.trim()?{usernameCredential:usernameCredential.trim()}:{username:username.trim()})}
          : auth==='header' ? {type:auth,name:header.trim(),prefix:headerPrefix} : {type:auth} };
      const parsed=config===null?null:apiConnectionSchema.safeParse(config);
      if(parsed && !parsed.success){setError(apiConnectionValidationMessage(parsed.error));return;}
      if(!remove&&publicHeaders.some((row,i)=>publicHeaders.some((other,j)=>j<i&&other.name.trim().toLowerCase()===row.name.trim().toLowerCase()))){setError('Use each public header name only once.');return;}
      await api.put(endpoint,parsed?.data??null);onSaved(remove?null:name.trim());
    }catch(e){setError(e instanceof Error?e.message:'Could not save API connection');}finally{setBusy(false);}
  }
  return <form className="max-h-[75vh] overflow-y-auto space-y-4 pr-1" onSubmit={e=>{e.preventDefault();void save();}}>
    <p className="text-sm text-on-surface-variant">Allow authorized agents to use <strong>{credential.name}</strong> with an API. The token stays in the vault; do not paste it into these settings.</p>
    {!!credential.apiConnections?.filter(c=>c.managedBy==='operator').length && <p className="text-xs text-on-surface-variant">Already configured by the operator: {credential.apiConnections.filter(c=>c.managedBy==='operator').map(c=>c.id).join(', ')}. Use a different name for an additional API connection.</p>}
    {!user?.isAdmin && <p className="text-xs text-on-surface-variant">Public APIs can be connected here. Ask an administrator to configure internal servers.</p>}
    <details className="rounded-md border border-outline-variant p-3 text-xs space-y-2"><summary className="cursor-pointer">Appwrite setup help</summary><p>For Appwrite, use your server origin, path <code>/v1</code>, the API key header <code>X-Appwrite-Key</code> (no prefix), and your project ID in <code>X-Appwrite-Project</code>.</p><button type="button" className="text-primary underline" onClick={useAppwrite}>Use Appwrite settings</button></details>
    <div><label htmlFor="api-connection-name" className="block text-xs mb-1">Connection name</label><input id="api-connection-name" className={inputClass} required pattern="[a-zA-Z0-9_-]{1,80}" value={name} onChange={e=>setName(e.target.value)} placeholder="sonarqube"/><p className="text-xs text-on-surface-variant mt-1">The name you tell your agent to use.</p></div>
    <div><label htmlFor="api-connection-origin" className="block text-xs mb-1">Server origin</label><input id="api-connection-origin" type="url" required className={inputClass} value={origin} onChange={e=>setOrigin(e.target.value)} placeholder="https://api.example.com"/><p className="text-xs text-on-surface-variant mt-1">Protocol, server and optional port; no API path or credentials.</p></div>
    <div><label htmlFor="api-connection-path" className="block text-xs mb-1">Allowed path prefix</label><input id="api-connection-path" required className={inputClass} value={prefix} onChange={e=>setPrefix(e.target.value)} placeholder="/api"/></div>
    <div><label htmlFor="api-connection-auth" className="block text-xs mb-1">Authentication</label><select id="api-connection-auth" className={inputClass} value={auth} onChange={e=>setAuth(e.target.value as typeof auth)}>
      <option value="bearer">Bearer token</option><option value="basic-token">Basic token (empty password)</option><option value="basic">Basic username + this secret as password</option><option value="header">API key header</option>
    </select></div>
    {auth==='basic' && <><div><label htmlFor="api-connection-username" className="block text-xs mb-1">Public username</label><input id="api-connection-username" className={inputClass} value={username} onChange={e=>setUsername(e.target.value)} disabled={!!usernameCredential}/></div><div><label htmlFor="api-connection-username-ref" className="block text-xs mb-1">Or username vault entry</label><input id="api-connection-username-ref" className={inputClass} value={usernameCredential} onChange={e=>setUsernameCredential(e.target.value)} placeholder="JENKINS_USER"/></div></>}
    {auth==='header' && <><div><label htmlFor="api-connection-header" className="block text-xs mb-1">Header name</label><input id="api-connection-header" required className={inputClass} value={header} onChange={e=>setHeader(e.target.value)}/></div><div><label htmlFor="api-connection-header-prefix" className="block text-xs mb-1">Header prefix (optional)</label><input id="api-connection-header-prefix" className={inputClass} value={headerPrefix} onChange={e=>setHeaderPrefix(e.target.value)} placeholder="Leave empty for an API key"/></div></>}
    <fieldset className="space-y-2"><legend className="text-xs mb-1">Public request headers (optional)</legend><p className="text-xs text-on-surface-variant">Non-secret settings such as an Appwrite project ID. Never enter tokens or passwords here. Agents cannot override these headers.</p>{publicHeaders.map((row,i)=><div key={i} className="flex gap-2 items-center"><input aria-label={`Public header ${i+1} name`} required className={inputClass} value={row.name} placeholder="X-Appwrite-Project" onChange={e=>setPublicHeaders(rows=>rows.map((r,j)=>j===i?{...r,name:e.target.value}:r))}/><input aria-label={`Public header ${i+1} value`} required className={inputClass} value={row.value} placeholder="Your project ID" onChange={e=>setPublicHeaders(rows=>rows.map((r,j)=>j===i?{...r,value:e.target.value}:r))}/><button type="button" aria-label={`Remove public header ${i+1}`} onClick={()=>setPublicHeaders(rows=>rows.filter((_,j)=>j!==i))} className="text-xs text-error">Remove</button></div>)}<button type="button" className="text-xs text-primary underline" onClick={()=>setPublicHeaders(rows=>[...rows,{name:'',value:''}])}>Add public header</button></fieldset>
    <fieldset><legend className="text-xs mb-2">Allowed requests</legend><div className="flex flex-wrap gap-3">{['GET','HEAD','POST','PUT','PATCH','DELETE'].map(method=><label key={method} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={methods.includes(method)} onChange={e=>setMethods(e.target.checked?[...methods,method]:methods.filter(m=>m!==method))}/>{method}</label>)}</div><p className="text-xs text-on-surface-variant mt-2">GET is read-only. Other requests may change data and still require normal tool permission.</p></fieldset>
    {origin.trim().startsWith('http:') && <label className="flex items-start gap-2 text-xs text-on-surface-variant"><input type="checkbox" checked={allowHttp} onChange={e=>setAllowHttp(e.target.checked)}/>Allow unencrypted HTTP to this server. Authentication is sent without TLS.</label>}
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
    <div className="flex flex-wrap justify-end gap-3 pt-2">{current && <button type="button" disabled={busy} onClick={()=>void save(true)} className="text-xs text-error mr-auto">Remove API connection</button>}<button type="button" onClick={onCancel} disabled={busy} className="px-3 py-2 text-sm">Cancel</button><button type="submit" disabled={busy||!name.trim()||!origin.trim()||!prefix.trim()||!methods.length||(origin.trim().startsWith('http:')&&!allowHttp)} className="rounded-lg bg-primary px-4 py-2 text-sm text-[#0e0e0e] disabled:opacity-40">{busy?'Saving…':'Save API connection'}</button></div>
  </form>;
}
