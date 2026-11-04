'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useWorkspaceAccess, useWorkspaceId } from '@/lib/workspace-context';
import type { MailAccountView, MailMessageSummary, MailMessageView } from '../../../src/shared/mail';
import { mailAccountsKey, mailButton, mailInput } from './mailbox-manager';

export function MailboxInbox({ account }: { account: MailAccountView }) {
  const workspace = useWorkspaceId();
  const access = useWorkspaceAccess();
  const client = useQueryClient();
  const [status, setStatus] = useState('received');
  const [pages, setPages] = useState<MailMessageSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ id?: string; revision?: string; replyTo?: string; to: string; cc: string; subject: string; body: string } | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const messages = useQuery({ queryKey: ['mail-messages', workspace, account.id, status], queryFn: () => api.get<MailMessageSummary[]>(`/mail/messages?account=${encodeURIComponent(account.id)}&status=${status}&limit=50`) });
  const message = useQuery({ queryKey: ['mail-message', workspace, account.id, openId], enabled: !!openId, queryFn: () => api.get<MailMessageView>(`/mail/messages/${encodeURIComponent(openId!)}`) });
  const refresh = async () => { setPages([]); setExhausted(false); await client.invalidateQueries({ queryKey: ['mail-messages', workspace, account.id] }); await client.invalidateQueries({ queryKey: ['mail-message', workspace, account.id] }); };
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (e) { setError(e instanceof Error ? e.message : 'Mail operation failed'); }
    finally { setBusy(false); }
  };
  const saveDraft = async () => {
    if (!draft) return;
    const result = draft.id
      ? await api.patch<MailMessageView>(`/mail/drafts/${draft.id}`, { to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body })
      : await api.post<MailMessageView>('/mail/drafts', draft.replyTo ? { replyTo: draft.replyTo, body: draft.body } : { accountId: account.id, to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body });
    setDraft({ id: result.id, revision: result.revision, to: result.to.map(a => a.address).join(', '), cc: result.cc.map(a => a.address).join(', '), subject: result.subject, body: result.text });
    setDraftDirty(false);
    setNotice('Draft saved. Nothing was sent.'); await refresh();
  };
  const rows = [...(messages.data ?? []), ...pages];
  const canSend = !!account.outgoing && access.canWrite;
  return <section className="space-y-4" aria-label={`Inbox ${account.label}`}>
    <div className="flex flex-wrap gap-3 justify-between items-center"><div><h1 className="text-2xl font-bold">{account.label}</h1><p className="text-sm text-on-surface-variant">{account.address} · {account.outgoing ? 'SMTP enabled' : 'Receive only'}</p></div>
      <div className="flex gap-2">{access.canWrite && <button className={mailButton} disabled={busy} onClick={() => action(async () => { const r = await api.post<{ stored: number; error?: string }>(`/mail/accounts/${account.id}/sync`, {}); if (r.error) throw new Error(r.error); setNotice(`Synced ${r.stored} new messages.`); await refresh(); await client.invalidateQueries({ queryKey: mailAccountsKey(workspace) }); })}>Sync inbox</button>}
        {canSend && <button className={mailButton} disabled={busy} onClick={() => { setDraft({ to: '', cc: '', subject: '', body: '' }); setDraftDirty(true); setConfirmSend(false); }}>New message</button>}</div>
    </div>
    {(error || messages.error || message.error) && <p role="alert" className="text-error">{error || messages.error?.message || message.error?.message}</p>}
    {notice && <p role="status">{notice}</p>}
    {account.lastError && <p className="text-error">Last sync: {account.lastError}</p>}
    <label className="block max-w-xs">Folder<select className={mailInput} disabled={busy} value={status} onChange={e => { setStatus(e.target.value); setPages([]); setExhausted(false); setOpenId(null); }}><option value="received">Inbox</option><option value="draft">Drafts</option><option value="sent">Sent</option><option value="failed">Failed sends</option><option value="sending">Sending</option></select></label>
    <div className="grid lg:grid-cols-[20rem_1fr] gap-4">
      <div className="space-y-2">{messages.isLoading && <p>Loading messages…</p>}{!messages.isLoading && rows.length === 0 && <p>No messages in this folder. Use Sync inbox to fetch new mail.</p>}
        {rows.map(row => <button key={row.id} disabled={busy} className={`${mailButton} w-full text-left ${openId === row.id ? 'bg-primary/10' : ''}`} onClick={() => { setOpenId(row.id); setDraft(null); setConfirmSend(false); }}><span className="block font-bold">{row.unread ? '● ' : ''}{row.subject || '(No subject)'}</span><span className="block text-xs">{row.from?.name || row.from?.address || row.to.map(a => a.address).join(', ')}</span><span className="block text-xs">{new Date(row.date).toLocaleString()}</span></button>)}
        {(messages.data?.length ?? 0) >= 50 && !exhausted && <button className={mailButton} disabled={busy} onClick={() => action(async () => { const last = rows.at(-1); if (!last) return; const more = await api.get<MailMessageSummary[]>(`/mail/messages?account=${encodeURIComponent(account.id)}&status=${status}&limit=50&before=${encodeURIComponent(last.date)}&beforeId=${encodeURIComponent(last.id)}`); setPages(prev => [...prev, ...more.filter(row => !rows.some(existing => existing.id === row.id))]); setExhausted(more.length < 50); if (more.length === 0) setNotice('All messages loaded.'); })}>Load more messages</button>}
      </div>
      <div className="min-w-0 space-y-3">{message.isLoading && openId && <p>Loading message…</p>}{message.data && <article className="rounded-md border border-outline-variant p-4 space-y-3">
        <h2 className="font-bold text-xl">{message.data.subject}</h2><p className="text-sm">From: {message.data.from?.address || account.address}<br />To: {message.data.to.map(a => a.address).join(', ')}</p>
        {message.data.error && <p role="alert" className="text-error">{message.data.error}</p>}
        <pre className="whitespace-pre-wrap font-sans break-words text-sm">{message.data.text}</pre>
        {message.data.attachments.map(attachment => <button key={attachment.index} className={mailButton} disabled={busy || !message.data?.rawKept} onClick={() => action(async () => { const blob = await api.getBlob(`/mail/messages/${message.data!.id}/attachments/${attachment.index}`); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = attachment.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })}>Download {attachment.filename}</button>)}
        <div className="flex gap-2 flex-wrap">{access.canWrite && message.data.status === 'received' && <button disabled={busy} className={mailButton} onClick={() => action(async () => { await api.patch(`/mail/messages/${message.data!.id}`, { unread: !message.data!.unread }); await refresh(); })}>{message.data.unread ? 'Mark read' : 'Mark unread'}</button>}
          {canSend && message.data.status === 'received' && <button disabled={busy} className={mailButton} onClick={() => { setDraft({ replyTo: message.data!.id, to: '', cc: '', subject: '', body: '' }); setDraftDirty(true); setConfirmSend(false); }}>Reply</button>}
          {canSend && ['draft', 'failed'].includes(message.data.status) && <button disabled={busy} className={mailButton} onClick={() => { const m = message.data!; setDraft({ id: m.id, revision: m.revision, to: m.to.map(a => a.address).join(', '), cc: m.cc.map(a => a.address).join(', '), subject: m.subject, body: m.text }); setDraftDirty(false); setConfirmSend(false); }}>Edit draft</button>}
        </div>
      </article>}
      {draft && <form aria-label="Mail draft" className="border border-outline-variant p-4 rounded-md space-y-3" onSubmit={e => { e.preventDefault(); action(saveDraft); }}>
        <fieldset disabled={busy || confirmSend} className="space-y-3"><h2 className="font-bold">{draft.replyTo ? 'Write reply' : 'Compose message'}</h2>
          {!draft.replyTo && <><label className="block">To<input required className={mailInput} value={draft.to} onChange={e => { setDraft({ ...draft, to: e.target.value }); setDraftDirty(true); }} /></label><label className="block">Cc<input className={mailInput} value={draft.cc} onChange={e => { setDraft({ ...draft, cc: e.target.value }); setDraftDirty(true); }} /></label><label className="block">Subject<input className={mailInput} maxLength={500} value={draft.subject} onChange={e => { setDraft({ ...draft, subject: e.target.value }); setDraftDirty(true); }} /></label></>}
          <label className="block">Message<textarea required className={mailInput} rows={8} maxLength={100000} value={draft.body} onChange={e => { setDraft({ ...draft, body: e.target.value }); setDraftDirty(true); }} /></label>
          <button className={mailButton} type="submit">Save draft</button>{' '}<button type="button" className={mailButton} onClick={() => { setDraft(null); setConfirmSend(false); }}>Close draft</button>
        </fieldset>
        {draftDirty && draft.id && <p className="text-sm">Save changes before reviewing the send.</p>}
        {draft.id && !confirmSend && <button disabled={busy || draftDirty || !draft.revision} type="button" className={mailButton} onClick={() => setConfirmSend(true)}>Review send</button>}
        {confirmSend && draft.id && <div role="alertdialog" aria-label="Confirm email send" className="space-y-2"><p>Send the saved draft from {account.address} to {draft.to}{draft.cc ? ` (cc: ${draft.cc})` : ''}?</p><p>Subject: {draft.subject}</p><p className="text-sm">Save any changes before sending. Sending delivers this email immediately.</p>
          <button type="button" className={mailButton} disabled={busy} onClick={() => action(async () => { try { await api.post(`/mail/drafts/${draft.id}/send`, { confirm: true, expectedRevision: draft.revision }); setDraft(null); setNotice('Message sent.'); await refresh(); } finally { setConfirmSend(false); } })}>Confirm send</button>{' '}<button type="button" className={mailButton} disabled={busy} onClick={() => setConfirmSend(false)}>Cancel send</button>
        </div>}
      </form>}
      </div>
    </div>
  </section>;
}
