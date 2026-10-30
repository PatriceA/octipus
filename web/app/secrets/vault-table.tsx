'use client';

import { AlertTriangle, Link2, Plus, RotateCcw, Search, Trash2, } from 'lucide-react';
import { useState, } from 'react';
import { ApiConnectionForm } from './api-connection-form';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import {
  CREDENTIAL_TYPE_COLORS,
  type Credential,
  type CredentialType,
  SYSTEM_SCOPED_SECRET_NAMES,
} from '@/lib/vault-config';

type NewSecret={name:string;value?:string;username?:string;password?:string;domain?:string;allowInsecureHttp?:boolean;credentialType:CredentialType;description?:string;tags?:string[];scope:'user'|'workspace';connectApi?:boolean};

interface VaultTableProps {
  credentials: Credential[];
  onRefresh: () => void;
  workspaceId?: string | null;
  workspaceName?: string | null;
}

export function VaultTable({ credentials, onRefresh, workspaceId, workspaceName }: VaultTableProps) {
  const [connectCredential, setConnectCredential] = useState<Credential | null>(null);
  const [notice, setNotice] = useState('');
  const [addError,setAddError]=useState('');
  const [editLogin,setEditLogin]=useState<Credential|null>(null);
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const filtered = credentials.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.credentialType.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.tags?.some((t) => t.toLowerCase().includes(q))
    );
  });

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/vault/${id}`);
      onRefresh();
      setDeleteId(null);
    } catch (error) {
      console.error('Failed to delete credential:', error);
    }
  };

  const handleRotate = async (id: string, newValue: string) => {
    try {
      await api.post(`/vault/${id}/rotate`, { value: newValue });
      setRotateId(null);
      onRefresh();
    } catch (error) {
      console.error('Failed to rotate credential:', error);
    }
  };

  const handleAdd = async (data: NewSecret) => {
    setAddError('');
    try {
      const { connectApi, ...secret } = data;
      const payload: Record<string, unknown> = { ...secret };
      if (data.scope === 'workspace' && workspaceId) {
        payload.workspaceId = workspaceId;
      }
      const saved = await api.post<Credential>('/vault', payload);
      setShowAddModal(false);
      onRefresh();
      if (connectApi) setConnectCredential(saved);
      else setNotice('Secret stored. To use it with an API, choose Connect API and approve the server and allowed requests.');
    } catch (error) {
      setAddError(error instanceof Error?error.message:'Could not save credential');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-extrabold tracking-tighter text-on-surface">
          All Vault Entries
        </h2>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-[#0e0e0e] rounded-lg hover:bg-primary-container cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Secret
        </button>
      </div>

      <p className="mb-3 text-sm text-on-surface-variant">For an API token: save the secret, choose <strong>Connect API</strong>, then approve the server, authentication and allowed requests. Tell your agent the connection name. Model provider and channel cards above already configure their integrations.</p>
      {notice && <p role="status" className="mb-3 text-sm text-on-surface-variant">{notice}</p>}
      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name, type, or tag..."
          className="w-full pl-10 pr-4 py-2 text-sm bg-surface-container-high border border-outline-variant rounded-md text-on-surface placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-10 text-sm text-on-surface-variant">
          {credentials.length === 0
            ? 'No secrets stored yet.'
            : 'No secrets match your filter.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xs bg-surface-container">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-outline-variant/10">
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider">Name</th>
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider">Type</th>
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider">Tags</th>
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider">Access</th>
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider">Last Used</th>
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider w-24">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/10">
              {filtered.map((cred) => {
                const colors = CREDENTIAL_TYPE_COLORS[cred.credentialType] || CREDENTIAL_TYPE_COLORS.other;
                return (
                  <tr
                    key={cred.id}
                    className="hover:bg-surface-container-high transition-colors"
                  >
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-sm text-on-surface">{cred.name}</div>
                      {cred.metadata?.login&&<p className="text-xs text-on-surface-variant">{cred.metadata.login.origin}</p>}
                      {!!cred.apiConnections?.length && <p className="text-xs text-on-surface-variant mt-1">API: {cred.apiConnections.map(c=>`${c.id} · ${c.methods.join('/')} ${c.pathPrefix}`).join(', ')}</p>}
                      {cred.description && (
                        <div className="text-xs text-on-surface-variant mt-0.5">{cred.description}</div>
                      )}
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${colors.bg} ${colors.text}`}>
                        {cred.credentialType.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex flex-wrap gap-1">
                        {cred.tags?.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex px-1.5 py-0.5 text-[10px] rounded bg-surface-container-high text-on-surface-variant"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-sm text-on-surface-variant tabular-nums">
                      {cred.accessCount}
                    </td>
                    <td className="py-2.5 px-4 text-sm text-on-surface-variant">
                      {cred.lastAccessedAt
                        ? new Date(cred.lastAccessedAt).toLocaleDateString()
                        : 'Never'}
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-1">
                        {cred.scope !== 'system' && <button onClick={() => setConnectCredential(cred)} title={`Connect API for ${cred.name}`} aria-label={`Connect API for ${cred.name}`} className="p-1.5 text-on-surface-variant hover:text-primary rounded-md hover:bg-surface-container-high cursor-pointer"><Link2 className="w-3.5 h-3.5" /></button>}
                        <button
                          onClick={() => cred.credentialType==='login'?setEditLogin(cred):setRotateId(cred.id)}
                          className="p-1.5 text-on-surface-variant hover:text-primary rounded-md hover:bg-surface-container-high cursor-pointer"
                          title={cred.credentialType==='login'?'Edit Login':'Rotate'}
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteId(cred.id)}
                          className="p-1.5 text-on-surface-variant hover:text-error rounded-md hover:bg-surface-container-high cursor-pointer"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!connectCredential} onClose={() => setConnectCredential(null)} title="Connect API" maxWidth="md">
        {connectCredential && <ApiConnectionForm key={connectCredential.id} credential={connectCredential} workspaceId={workspaceId} onCancel={() => setConnectCredential(null)} onSaved={name => {setConnectCredential(null);setNotice(name ? `API connection ${name} saved. Tell your agent to use the ${name} connection. Vault access restrictions still apply.` : 'API connection removed. The secret remains in the vault.');onRefresh();}} />}
      </Modal>
      {/* Add Modal */}
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add Secret" maxWidth="md">
        <AddSecretForm
          onCancel={() => setShowAddModal(false)}
          onAdd={handleAdd}
          error={addError}
          workspaceName={workspaceName ?? null}
          workspaceAvailable={!!workspaceId}
        />
      </Modal>

      <Modal open={!!editLogin} onClose={()=>setEditLogin(null)} title="Edit Login" maxWidth="md">
        {editLogin&&<EditLoginForm key={editLogin.id} credential={editLogin} workspaceId={workspaceId} onCancel={()=>setEditLogin(null)} onSaved={()=>{setEditLogin(null);onRefresh();}}/>}
      </Modal>
      {/* Rotate Modal */}
      <Modal open={!!rotateId} onClose={() => setRotateId(null)} title="Rotate Secret" maxWidth="sm">
        <RotateForm
          onCancel={() => setRotateId(null)}
          onRotate={(value) => rotateId && handleRotate(rotateId, value)}
        />
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={!!deleteId} onClose={() => setDeleteId(null)} title="Delete Secret" maxWidth="sm">
        <div className="space-y-4">
          <p className="text-sm text-on-surface-variant">
            This will deactivate the credential. This action cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDeleteId(null)}
              className="px-4 py-2 text-sm text-on-surface-variant hover:bg-surface-container rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => deleteId && handleDelete(deleteId)}
              className="px-4 py-2 text-sm bg-error text-on-surface rounded-lg hover:bg-error-dim cursor-pointer"
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function AddSecretForm({
  onCancel,
  onAdd,
  workspaceName,
  workspaceAvailable,
  error,
}: {
  onCancel: () => void;
  onAdd: (data: NewSecret) => void;
  error:string;
  workspaceName: string | null;
  workspaceAvailable: boolean;
}) {
  const [connectApi, setConnectApi] = useState(true);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [credentialType, setCredentialType] = useState<CredentialType>('api_key');
  const [username,setUsername]=useState('');
  const [domain,setDomain]=useState('');
  const [allowHttp,setAllowHttp]=useState(false);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [scope, setScope] = useState<'user' | 'workspace'>('user');

  const isSystemSecret = SYSTEM_SCOPED_SECRET_NAMES.has(name.trim());

  return (
    <div className="max-h-[75vh] overflow-y-auto space-y-3 pr-1">
      <div>
        <label htmlFor="vault-secret-name" className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Name</label>
        <input
          id="vault-secret-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
          placeholder="my_api_key"
        />
      </div>

      {isSystemSecret && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <p className="text-xs leading-relaxed">
            <span className="font-bold">{name.trim()}</span> is a system-wide secret.
            Saving it here as a user{workspaceAvailable ? '/workspace' : ''} secret has
            <span className="font-bold"> no effect</span> — the backend only reads it at
            system scope. Use the dedicated card in the section above instead.
          </p>
        </div>
      )}
      {credentialType==='login'&&<LoginFields username={username} onUsername={setUsername} password={value} onPassword={setValue} domain={domain} onDomain={setDomain} allowHttp={allowHttp} onAllowHttp={setAllowHttp}/>}
      {credentialType!=='login'&&<div>
        <label htmlFor="vault-secret-value" className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Value</label>
        <input
          id="vault-secret-value"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm focus:ring-1 focus:ring-primary"
        />
      </div>}
      <div>
        <label htmlFor="vault-secret-type" className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Type</label>
        <select id="vault-secret-type"
          value={credentialType}
          onChange={(e) => setCredentialType(e.target.value as CredentialType)}
          className="w-full bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm focus:ring-1 focus:ring-primary"
        >
          <option value="api_key">API Key</option>
          <option value="oauth_token">OAuth Token</option>
          <option value="password">Password</option>
          <option value="login">Login (username + password)</option>
          <option value="ssh_key">SSH Key</option>
          <option value="certificate">Certificate</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div>
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
          placeholder="Optional description"
        />
      </div>
      {workspaceAvailable && (
        <div>
          <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Scope</label>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as 'user' | 'workspace')}
            className="w-full bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm focus:ring-1 focus:ring-primary"
          >
            <option value="user">User (visible everywhere)</option>
            <option value="workspace">Workspace ({workspaceName ?? 'current'})</option>
          </select>
        </div>
      )}
      <div>
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Tags (comma-separated)</label>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className="w-full bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
          placeholder="production, openai"
        />
      </div>
      {!isSystemSecret && !['ssh_key','certificate','login'].includes(credentialType) && <label className="flex items-start gap-2 text-xs text-on-surface-variant"><input type="checkbox" checked={connectApi} onChange={e=>setConnectApi(e.target.checked)}/>Set up API access after saving. You will choose the server and allowed requests next; no need to paste this token again.</label>}
      {error&&<p role="alert" className="text-sm text-error">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-on-surface-variant hover:bg-surface-container rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() =>
            onAdd({
              name,
              ...(credentialType==='login'?{username,password:value,domain,allowInsecureHttp:allowHttp}:{value}),
              credentialType,
              description: description || undefined,
              tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
              scope,
              connectApi: connectApi && !isSystemSecret && !['ssh_key','certificate','login'].includes(credentialType),
            })
          }
          disabled={!name || !value || (credentialType==='login'&&(!username||!domain||(domain.startsWith('http:')&&!allowHttp)))}
          className="px-4 py-2 text-sm bg-primary text-[#0e0e0e] rounded-lg hover:bg-primary-container disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {connectApi && !isSystemSecret && !['ssh_key','certificate','login'].includes(credentialType) ? 'Save secret & set up API' : 'Save secret'}
        </button>
      </div>
    </div>
  );
}

function RotateForm({
  onCancel,
  onRotate,
}: {
  onCancel: () => void;
  onRotate: (value: string) => void;
}) {
  const [value, setValue] = useState('');

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">New Value</label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="flex justify-end gap-3">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-on-surface-variant hover:bg-surface-container rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() => onRotate(value)}
          disabled={!value}
          className="px-4 py-2 text-sm bg-primary text-[#0e0e0e] rounded-lg hover:bg-primary-container disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Rotate
        </button>
      </div>
    </div>
  );
}

function LoginFields({username,onUsername,password,onPassword,domain,onDomain,allowHttp,onAllowHttp,editing=false}:{username:string;onUsername:(v:string)=>void;password:string;onPassword:(v:string)=>void;domain:string;onDomain:(v:string)=>void;allowHttp:boolean;onAllowHttp:(v:boolean)=>void;editing?:boolean}){
  const style='w-full bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm';
  return <fieldset className="space-y-3"><legend className="text-xs text-on-surface-variant">Credentials stay in the vault. Agents can fill this website or use an approved HTTP Basic API connection.</legend>
    <div><label htmlFor="login-domain" className="block text-xs mb-1">Domain</label><input id="login-domain" className={style} value={domain} onChange={e=>onDomain(e.target.value)} placeholder="https://example.com"/><p className="text-xs text-on-surface-variant">Exact server, including protocol and port. Subdomains require their own entry.</p></div>
    <div><label htmlFor="login-username" className="block text-xs mb-1">Username</label><input id="login-username" className={style} autoComplete="off" value={username} onChange={e=>onUsername(e.target.value)} placeholder={editing?'Leave blank to keep current username':''}/></div>
    <div><label htmlFor="login-password" className="block text-xs mb-1">Password</label><input id="login-password" className={style} type="password" autoComplete="new-password" value={password} onChange={e=>onPassword(e.target.value)} placeholder={editing?'Leave blank to keep current password':''}/></div>
    {domain.startsWith('http:')&&<label className="flex gap-2 text-xs"><input type="checkbox" checked={allowHttp} onChange={e=>onAllowHttp(e.target.checked)}/>Allow unencrypted HTTP for this domain. Credentials can be intercepted.</label>}
  </fieldset>;
}
function EditLoginForm({credential,workspaceId,onCancel,onSaved}:{credential:Credential;workspaceId?:string|null;onCancel:()=>void;onSaved:()=>void}){
  const [domain,setDomain]=useState(credential.metadata?.login?.origin??'');
  const [username,setUsername]=useState('');const [password,setPassword]=useState('');
  const [allowHttp,setAllowHttp]=useState(credential.metadata?.login?.allowInsecureHttp??false);
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  async function save(){setBusy(true);setError('');try{
    await api.put(`/vault/${credential.id}/login${workspaceId?`?workspaceId=${encodeURIComponent(workspaceId)}`:''}`,{domain,allowInsecureHttp:allowHttp,...(username?{username}:{}),...(password?{password}:{})});onSaved();
  }catch(e){setError(e instanceof Error?e.message:'Could not save Login');}finally{setBusy(false);}}
  return <form className="space-y-4" onSubmit={e=>{e.preventDefault();void save();}}><p className="text-sm">{credential.name}. Leave credentials blank to keep them. Changing the domain removes the existing API connection; approve it again afterwards.</p><LoginFields username={username} onUsername={setUsername} password={password} onPassword={setPassword} domain={domain} onDomain={setDomain} allowHttp={allowHttp} onAllowHttp={setAllowHttp} editing/>{error&&<p role="alert" className="text-error text-sm">{error}</p>}<div className="flex justify-end gap-3"><button type="button" onClick={onCancel} disabled={busy}>Cancel</button><button type="submit" disabled={busy||!domain||(domain.startsWith('http:')&&!allowHttp)} className="rounded-lg bg-primary px-4 py-2 text-sm text-[#0e0e0e] disabled:opacity-40">{busy?'Saving…':'Save Login'}</button></div></form>;
}
