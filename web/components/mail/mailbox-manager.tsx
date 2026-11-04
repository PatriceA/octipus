'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useWorkspace, useWorkspaceAccess, useWorkspaceId } from '@/lib/workspace-context';
import type { MailAccountView, MailSecurity, MailServer } from '../../../src/shared/mail';

export const mailAccountsKey = (workspace: string | null) => ['mail-accounts', workspace] as const;
export const mailInput = 'w-full rounded-md border border-outline-variant bg-surface p-2 text-on-surface';
export const mailButton = 'rounded-md border border-outline-variant px-3 py-2 text-sm hover:bg-surface-container-high disabled:opacity-50';
const emptyServer = (port: number): MailServer => ({ host: '', port, security: 'tls', username: '' });

export function MailboxManager() {
  const workspace = useWorkspaceId();
  const { activeWorkspace, isLoading } = useWorkspace();
  if (isLoading) return <p>Loading workspace…</p>;
  if (activeWorkspace?.kind === 'remote') return <p>Mailboxes on another install are not available here. Select a local workspace to manage its mailboxes.</p>;
  return <MailboxManagerScope key={workspace ?? 'personal'} />;
}

function MailboxManagerScope() {
  const workspace = useWorkspaceId();
  const access = useWorkspaceAccess();
  const canManage = access.canWrite && (access.role === null || access.role === 'owner');
  const client = useQueryClient();
  const accounts = useQuery({ queryKey: mailAccountsKey(workspace), queryFn: () => api.get<MailAccountView[]>('/mail/accounts') });
  const [editing, setEditing] = useState<MailAccountView | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<MailAccountView | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: mailAccountsKey(workspace) });
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await run(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Mailbox operation failed'); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4" aria-label="Mailbox accounts">
    <div className="flex justify-between gap-3"><h2 className="text-lg font-bold">Mailboxes</h2>{canManage && <button className={mailButton} disabled={busy} onClick={() => { setEditing('new'); setError(''); }}>Add mailbox</button>}</div>
    <p className="text-sm text-on-surface-variant">Connect multiple IMAP or POP3 inboxes, with optional SMTP for sending. Google Workspace and Microsoft 365 are connected in <a className="text-primary underline" href="/settings?tab=integrations">Integrations</a>.</p>
    {access.role !== null && <p className="text-sm">These mailboxes belong to the selected space. Space owners manage connections; editors can draft and send.</p>}
    {(error || accounts.error) && <p role="alert" className="text-error">{error || accounts.error?.message}</p>}
    {notice && <p role="status">{notice}</p>}
    {accounts.isLoading && <p>Loading mailboxes…</p>}
    {accounts.data?.length === 0 && <p>No IMAP or POP3 mailboxes connected yet.</p>}
    {accounts.data?.map(account => <article className="rounded-md border border-outline-variant p-4 space-y-2" key={account.id}>
      <h3 className="font-bold">{account.label} <span className="font-normal text-sm">{account.address}</span></h3>
      <p className="text-sm">{account.protocol.toUpperCase()} · {account.incoming.host}:{account.incoming.port} · {account.outgoing ? 'SMTP configured' : 'Receive only'} · {account.enabled ? 'Sync enabled' : 'Sync paused'}</p>
      <p className="text-xs text-on-surface-variant">Last synced: {account.lastSyncAt ? new Date(account.lastSyncAt).toLocaleString() : 'Never'}</p>
      {account.lastError && <p className="text-error text-sm">{account.lastError}</p>}
      <div className="flex flex-wrap gap-2">
        {canManage && <><button disabled={busy} className={mailButton} onClick={() => setEditing(account)}>Edit {account.label}</button>
          <button disabled={busy} className={mailButton} onClick={() => action(async () => {
            const result = await api.post<{ incoming: string | null; outgoing: string | null }>(`/mail/accounts/${account.id}/test`, {});
            if (result.incoming || result.outgoing) throw new Error([result.incoming && `Incoming: ${result.incoming}`, result.outgoing && `Outgoing: ${result.outgoing}`].filter(Boolean).join('; '));
            setNotice(`${account.label}: incoming login succeeded${account.outgoing ? '; outgoing login succeeded' : ''}.`);
          })}>Test login</button>
          <button disabled={busy} className={mailButton} onClick={() => setDeleting(account)}>Remove {account.label}</button></>}
        {access.canWrite && <button disabled={busy} className={mailButton} onClick={() => action(async () => {
          const result = await api.post<{ stored: number; error?: string }>(`/mail/accounts/${account.id}/sync`, {});
          if (result.error) throw new Error(result.error);
          setNotice(`${account.label}: synced ${result.stored} new messages.`);
          await client.invalidateQueries({ queryKey: ['mail-messages', workspace] });
        })}>Sync now</button>}
      </div>
    </article>)}
    {deleting && <div role="alertdialog" aria-label="Remove mailbox" className="border border-error p-4 rounded-md space-y-3">
      <p>Remove {deleting.label}? Its messages, drafts and stored login will be deleted from Octipus. Mail on your server stays there.</p>
      <button disabled={busy} className={mailButton} onClick={() => action(async () => { await api.delete(`/mail/accounts/${deleting.id}`); setDeleting(null); setNotice('Mailbox removed.'); })}>Confirm removal</button>{' '}
      <button disabled={busy} className={mailButton} onClick={() => setDeleting(null)}>Cancel removal</button>
    </div>}
    {editing && <MailboxForm key={editing === 'new' ? 'new' : editing.id} account={editing === 'new' ? undefined : editing} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); setNotice('Mailbox saved. Use Test login to check the connection.'); await refresh(); }} />}
  </section>;
}

function MailboxForm({ account, onCancel, onSaved }: { account?: MailAccountView; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [address, setAddress] = useState(account?.address ?? '');
  const [label, setLabel] = useState(account?.label ?? '');
  const [displayName, setDisplayName] = useState(account?.displayName ?? '');
  const [protocol, setProtocol] = useState(account?.protocol ?? 'imap');
  const [incoming, setIncoming] = useState(account?.incoming ?? emptyServer(993));
  const [outgoing, setOutgoing] = useState(account?.outgoing ?? emptyServer(465));
  const [smtp, setSmtp] = useState(!!account?.outgoing);
  const [folder, setFolder] = useState(account?.folder ?? 'INBOX');
  const [enabled, setEnabled] = useState(account?.enabled ?? true);
  const [fileAttachments, setFileAttachments] = useState(account?.fileAttachments ?? false);
  const [protection, setProtection] = useState(String(account?.defaultProtectionLevel ?? ''));
  const [passwords, setPasswords] = useState({ incoming: '', outgoing: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    const body = { address, label, displayName: displayName || null, protocol, incoming, outgoing: smtp ? outgoing : null, folder, enabled, fileAttachments,
      defaultProtectionLevel: protection ? Number(protection) : null,
      passwords: { ...(passwords.incoming ? { incoming: passwords.incoming } : {}), ...(smtp && passwords.outgoing ? { outgoing: passwords.outgoing } : {}) } };
    try {
      if (account) {
        const changed = Object.fromEntries(Object.entries(body).filter(([key, value]) => key === 'passwords' || JSON.stringify(value) !== JSON.stringify(account[key as keyof MailAccountView])));
        await api.patch(`/mail/accounts/${account.id}`, changed);
      } else await api.post('/mail/accounts', body);
      setPasswords({ incoming: '', outgoing: '' }); await onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save mailbox'); }
    finally { setBusy(false); }
  };
  return <form aria-label={account ? 'Edit mailbox' : 'Add mailbox'} onSubmit={submit} className="space-y-4 rounded-md border border-outline-variant p-4">
    <fieldset disabled={busy} className="space-y-4">
      <h3 className="font-bold">{account ? 'Edit mailbox' : 'Add mailbox'}</h3>
      {error && <p role="alert" className="text-error">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label>Email address<input required type="email" maxLength={320} className={mailInput} value={address} onChange={e => setAddress(e.target.value)} /></label>
        <label>Mailbox label<input maxLength={100} className={mailInput} value={label} onChange={e => setLabel(e.target.value)} /></label>
        <label>Sender name<input maxLength={100} className={mailInput} value={displayName} onChange={e => setDisplayName(e.target.value)} /></label>
        <label>Incoming protocol<select className={mailInput} value={protocol} onChange={e => { const next = e.target.value as 'imap' | 'pop3'; setProtocol(next); setIncoming(s => ({ ...s, port: next === 'pop3' ? 995 : 993, security: 'tls' })); }}><option value="imap">IMAP</option><option value="pop3">POP3</option></select></label>
      </div>
      <ServerFields title="Incoming" server={incoming} onChange={setIncoming} password={passwords.incoming} onPassword={value => setPasswords(p => ({ ...p, incoming: value }))} passwordSet={account?.passwordSet.incoming} />
      {protocol === 'imap' && <label className="block">IMAP folder<input required maxLength={200} className={mailInput} value={folder} onChange={e => setFolder(e.target.value)} /></label>}
      <label className="flex gap-2"><input type="checkbox" checked={smtp} onChange={e => setSmtp(e.target.checked)} />Enable SMTP sending</label>
      {smtp && <><ServerFields title="Outgoing" server={outgoing} onChange={setOutgoing} password={passwords.outgoing} onPassword={value => setPasswords(p => ({ ...p, outgoing: value }))} passwordSet={account?.passwordSet.outgoing} /><p className="text-xs">Without a separate SMTP password, the incoming password is used only when both servers use the same host.</p></>}
      <p className="text-xs text-on-surface-variant">Leave a password blank to keep the saved login. Changing a server host, port or username requires a new password. Passwords are never shown again.</p>
      <label className="block">Content protection<select className={mailInput} value={protection} onChange={e => setProtection(e.target.value)}><option value="">Unspecified (treated as strictly confidential)</option><option value="1">1 — Public</option><option value="2">2 — Internal</option><option value="3">3 — Confidential</option><option value="4">4 — Strictly confidential</option></select></label>
      <label className="flex gap-2"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Automatic sync</label>
      <label className="flex gap-2"><input type="checkbox" checked={fileAttachments} onChange={e => setFileAttachments(e.target.checked)} />File incoming attachments into Documents</label>
      <div className="flex gap-2"><button className={mailButton} type="submit">{busy ? 'Saving…' : 'Save mailbox'}</button><button className={mailButton} type="button" onClick={onCancel}>Cancel</button></div>
    </fieldset>
  </form>;
}

function ServerFields({ title, server, onChange, password, onPassword, passwordSet }: { title: string; server: MailServer; onChange: (server: MailServer) => void; password: string; onPassword: (value: string) => void; passwordSet?: boolean }) {
  return <fieldset className="grid sm:grid-cols-2 gap-3 border border-outline-variant rounded-md p-3"><legend>{title} server</legend>
    <label>{title} host<input className={mailInput} required maxLength={253} value={server.host} onChange={e => onChange({ ...server, host: e.target.value })} /></label>
    <label>{title} port<input className={mailInput} required type="number" min={1} max={65535} value={server.port} onChange={e => onChange({ ...server, port: Number(e.target.value) })} /></label>
    <label>{title} security<select className={mailInput} value={server.security} onChange={e => onChange({ ...server, security: e.target.value as MailSecurity })}><option value="tls">TLS</option><option value="starttls">STARTTLS</option><option value="none">None (local servers only)</option></select></label>
    <label>{title} username<input className={mailInput} maxLength={320} value={server.username} placeholder="Email address if blank" onChange={e => onChange({ ...server, username: e.target.value })} /></label>
    <label>{title} password<input className={mailInput} type="password" autoComplete="new-password" maxLength={1000} value={password} placeholder={passwordSet ? 'Password stored — leave blank to keep' : 'Not set'} onChange={e => onPassword(e.target.value)} /></label>
  </fieldset>;
}
