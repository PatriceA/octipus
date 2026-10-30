'use client';

import { useRef, useState } from 'react';
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
  const login=credential.metadata?.login;
  const [name,setName] = useState(current?.id ?? credential.name.toLowerCase().replace(/(?:_api)?_(?:token|key)$/,'').replace(/[^a-z0-9_-]/g,'-'));
  const [origin,setOrigin] = useState(current?.origin ?? login?.origin ?? '');
  const originRef=useRef(origin);
  const [tlsMode,setTlsMode]=useState<'system'|'pinned'>(current?.tls?.mode??'system');
  const [pin,setPin]=useState(current?.tls?.mode==='pinned'?current.tls.certificateSha256:'');
  const [trusted,setTrusted]=useState(current?.tls?.mode==='pinned');
  const [certificate,setCertificate]=useState<{origin:string;certificateSha256:string;commonName:string;issuer:string;validFrom:string;validTo:string;verificationError:string|null}|null>(null);
  const [prefix,setPrefix] = useState(current?.pathPrefix ?? '/api');
  const [auth,setAuth] = useState<ApiConnectionConfig['auth']['type']>(current?.auth.type ?? (login?'login':'bearer'));
  const [username,setUsername] = useState(current?.auth.type === 'basic' ? current.auth.username ?? '' : '');
  const [usernameCredential,setUsernameCredential] = useState(current?.auth.type === 'basic' ? current.auth.usernameCredential ?? '' : '');
  const [header,setHeader] = useState(current?.auth.type === 'header' ? current.auth.name : 'X-API-Key');
  const [headerPrefix,setHeaderPrefix] = useState(current?.auth.type === 'header' ? current.auth.prefix : '');
  const [publicHeaders,setPublicHeaders] = useState(() => Object.entries(current?.headers ?? {}).map(([name,value])=>({name,value})));
  const [methods,setMethods] = useState<string[]>(current?.methods ?? ['GET']);
  const [allowHttp,setAllowHttp] = useState(current?.allowInsecureHttp ?? login?.allowInsecureHttp ?? false);
  const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  const endpoint = `/vault/${encodeURIComponent(credential.id)}/api-connection${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`;
  function changeOrigin(value:string){
    if(value.trim()!==originRef.current.trim()){setPin('');setTrusted(false);setCertificate(null);setTlsMode('system');}
    originRef.current=value;setOrigin(value);
  }
  async function inspectCertificate(){
    setBusy(true);setError('');const requested=origin.trim();
    try{
      const result=await api.post<{certificate:NonNullable<typeof certificate>}>(endpoint.replace('/api-connection','/api-certificate'),{origin:requested});
      if(originRef.current.trim()!==requested)return;
      setCertificate(result.certificate);setPin(result.certificate.certificateSha256);setTrusted(false);
    }catch(e){setError(e instanceof Error?e.message:'Could not inspect the certificate');}finally{setBusy(false);}
  }
  async function save(remove=false) {
    setBusy(true);setError('');
    try {
      if(!remove&&tlsMode==='pinned'&&(!pin||!trusted)){setError('Inspect and explicitly trust this certificate before saving.');return;}
      const config = remove ? null : { id:name.trim(), origin:origin.trim(), pathPrefix:prefix.trim(), methods, allowInsecureHttp:allowHttp,
        ...(tlsMode==='pinned'?{tls:{mode:'pinned',certificateSha256:pin}}:{}),
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
    <div><label htmlFor="api-connection-name" className="block text-xs mb-1">Connection name</label><input id="api-connection-name" className={inputClass} required pattern="[a-zA-Z0-9_-]{1,80}" value={name} onChange={e=>setName(e.target.value)} placeholder="sonarqube"/><p className="text-xs text-on-surface-variant mt-1">The name you tell your agent to use.</p></div>
    <div><label htmlFor="api-connection-origin" className="block text-xs mb-1">Server origin</label><input id="api-connection-origin" type="url" required className={inputClass} value={origin} onChange={e=>changeOrigin(e.target.value)} disabled={busy} readOnly={!!login} placeholder="https://api.example.com"/><p className="text-xs text-on-surface-variant mt-1">Protocol, server and optional port; no API path or credentials.</p></div>
    {origin.trim().startsWith('https:')&&<fieldset className="rounded-md border border-outline-variant p-3 space-y-2"><legend className="text-xs">HTTPS certificate verification</legend><label htmlFor="api-connection-tls" className="block text-xs">Certificate trust</label><select id="api-connection-tls" className={inputClass} value={tlsMode} disabled={busy} onChange={e=>{setTlsMode(e.target.value as typeof tlsMode);setTrusted(false);}}><option value="system">Normal certificate verification</option><option value="pinned" disabled={!user?.isAdmin}>Trust one exact certificate (administrator)</option></select>{tlsMode==='pinned'&&<><p className="text-xs text-on-surface-variant">For devices such as OPNsense with self-signed or expired certificates. HTTPS remains encrypted. Normal issuer, expiry and hostname checks are replaced with the exact certificate fingerprint below; a changed certificate is refused. This applies only to this connection.</p><button type="button" disabled={busy||!user?.isAdmin} className="text-xs text-primary underline disabled:opacity-40" onClick={()=>void inspectCertificate()}>Inspect server certificate</button>{certificate&&<dl className="text-xs space-y-1"><div>Server: {certificate.origin}</div><div>Name: {certificate.commonName}</div><div>Issuer: {certificate.issuer}</div><div>Valid from: {certificate.validFrom}</div><div>Valid until: {certificate.validTo}</div>{certificate.verificationError&&<div>Verification: {certificate.verificationError}</div>}</dl>}{pin&&<><p className="text-xs break-all">SHA-256: <code>{pin}</code></p><label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={trusted} disabled={busy||!user?.isAdmin} onChange={e=>setTrusted(e.target.checked)}/>I trust this exact certificate for this connection, including its expiry, issuer and hostname exceptions.</label></>}</>}</fieldset>}
    <div><label htmlFor="api-connection-path" className="block text-xs mb-1">Allowed path prefix</label><input id="api-connection-path" required className={inputClass} value={prefix} onChange={e=>setPrefix(e.target.value)} placeholder="/api"/></div>
    <div><label htmlFor="api-connection-auth" className="block text-xs mb-1">Authentication</label><select id="api-connection-auth" className={inputClass} value={auth} onChange={e=>setAuth(e.target.value as typeof auth)}>
      {login?<option value="login">Saved Login (username + password)</option>:<><option value="bearer">Bearer token</option><option value="basic-token">Basic token (empty password)</option><option value="basic">Basic username + this secret as password</option><option value="header">API key header</option></>}
    </select></div>
    {auth==='basic' && <><div><label htmlFor="api-connection-username" className="block text-xs mb-1">Public username</label><input id="api-connection-username" className={inputClass} value={username} onChange={e=>setUsername(e.target.value)} disabled={!!usernameCredential}/></div><div><label htmlFor="api-connection-username-ref" className="block text-xs mb-1">Or username vault entry</label><input id="api-connection-username-ref" className={inputClass} value={usernameCredential} onChange={e=>setUsernameCredential(e.target.value)} placeholder="JENKINS_USER"/></div></>}
    {auth==='header' && <><div><label htmlFor="api-connection-header" className="block text-xs mb-1">Header name</label><input id="api-connection-header" required className={inputClass} value={header} onChange={e=>setHeader(e.target.value)}/></div><div><label htmlFor="api-connection-header-prefix" className="block text-xs mb-1">Header prefix (optional)</label><input id="api-connection-header-prefix" className={inputClass} value={headerPrefix} onChange={e=>setHeaderPrefix(e.target.value)} placeholder="Leave empty for an API key"/></div></>}
    <fieldset className="space-y-2"><legend className="text-xs mb-1">Public request headers (optional)</legend><p className="text-xs text-on-surface-variant">Non-secret settings such as a project identifier. Never enter tokens or passwords here. Agents cannot override these headers.</p>{publicHeaders.map((row,i)=><div key={i} className="flex gap-2 items-center"><input aria-label={`Public header ${i+1} name`} required className={inputClass} value={row.name} placeholder="X-Project-ID" onChange={e=>setPublicHeaders(rows=>rows.map((r,j)=>j===i?{...r,name:e.target.value}:r))}/><input aria-label={`Public header ${i+1} value`} required className={inputClass} value={row.value} placeholder="Public value" onChange={e=>setPublicHeaders(rows=>rows.map((r,j)=>j===i?{...r,value:e.target.value}:r))}/><button type="button" aria-label={`Remove public header ${i+1}`} onClick={()=>setPublicHeaders(rows=>rows.filter((_,j)=>j!==i))} className="text-xs text-error">Remove</button></div>)}<button type="button" className="text-xs text-primary underline" onClick={()=>setPublicHeaders(rows=>[...rows,{name:'',value:''}])}>Add public header</button></fieldset>
    <fieldset><legend className="text-xs mb-2">Allowed requests</legend><div className="flex flex-wrap gap-3">{['GET','HEAD','POST','PUT','PATCH','DELETE'].map(method=><label key={method} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={methods.includes(method)} onChange={e=>setMethods(e.target.checked?[...methods,method]:methods.filter(m=>m!==method))}/>{method}</label>)}</div><p className="text-xs text-on-surface-variant mt-2">GET is read-only. Other requests may change data and still require normal tool permission.</p></fieldset>
    {origin.trim().startsWith('http:') && <label className="flex items-start gap-2 text-xs text-on-surface-variant"><input type="checkbox" checked={allowHttp} onChange={e=>setAllowHttp(e.target.checked)}/>Allow unencrypted HTTP to this server. Authentication is sent without TLS.</label>}
    {error && <p role="alert" className="text-sm text-error">{error}</p>}
    <div className="flex flex-wrap justify-end gap-3 pt-2">{current && <button type="button" disabled={busy} onClick={()=>void save(true)} className="text-xs text-error mr-auto">Remove API connection</button>}<button type="button" onClick={onCancel} disabled={busy} className="px-3 py-2 text-sm">Cancel</button><button type="submit" disabled={busy||!name.trim()||!origin.trim()||!prefix.trim()||!methods.length||(tlsMode==='pinned'&&(!trusted||!pin))||(origin.trim().startsWith('http:')&&!allowHttp)} className="rounded-lg bg-primary px-4 py-2 text-sm text-[#0e0e0e] disabled:opacity-40">{busy?'Saving…':'Save API connection'}</button></div>
  </form>;
}
