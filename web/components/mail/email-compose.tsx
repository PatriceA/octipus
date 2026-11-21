'use client';

import { FileText, Loader2, Send, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { MailMessageView } from '../../../src/shared/mail';
import { addressList, btn, btnGhost, btnPrimary, type EmailMessage, field, who } from './email-shared';
import { aiPath, type Mailbox } from './mailboxes';

/** `draft`: an IMAP / POP3 draft (or failed send) opened again from its folder. */
export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward' | 'draft';
export interface ComposeDraft {
  mode: ComposeMode;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  /** The message a reply answers (threads the mail) or a forward quotes. */
  source?: EmailMessage;
  /** IMAP / POP3: the saved draft this compose edits, and the revision a send is bound to. */
  saved?: { id: string; revision?: string };
}

const re = (subject: string) => (/^re\s*:/i.test(subject) ? subject : `Re: ${subject}`);
const fwd = (subject: string) => (/^fwd?\s*:/i.test(subject) ? subject : `Fwd: ${subject}`);
const quote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n');

/**
 * A fresh draft for a mode. `self` is the mailbox's own address, left out of
 * reply-all recipients. An IMAP / POP3 reply leaves the recipients, the
 * subject and the quote to the server, which takes them from the original
 * (its Reply-To included) when the draft is saved.
 */
export function composeFor(mode: ComposeMode, source?: EmailMessage, self?: string): ComposeDraft {
  if (mode === 'draft' && source) {
    return { mode, to: addressList(source.to), cc: addressList(source.cc), bcc: '', subject: source.subject, body: source.body, source, saved: { id: source.id, ...(source.revision ? { revision: source.revision } : {}) } };
  }
  if (!source || mode === 'new' || mode === 'draft') return { mode: 'new', to: '', cc: '', bcc: '', subject: '', body: '' };
  const when = source.receivedAt ? new Date(source.receivedAt).toLocaleString() : '';
  if (mode === 'forward') {
    const head = ['---------- Forwarded message ----------', `From: ${source.from.name ? `${source.from.name} <${source.from.email}>` : source.from.email}`, when && `Date: ${when}`, `Subject: ${source.subject}`, source.to?.length ? `To: ${addressList(source.to)}` : ''].filter(Boolean).join('\n');
    return { mode, to: '', cc: '', bcc: '', subject: fwd(source.subject), body: `\n\n${head}\n\n${source.body}`, source };
  }
  if (source.provider === 'imap') return { mode, to: '', cc: '', bcc: '', subject: re(source.subject), body: '', source };
  const own = self?.toLowerCase();
  const others = [...(source.to ?? []), ...(source.cc ?? [])].filter((a) => a.email && a.email.toLowerCase() !== own && a.email.toLowerCase() !== source.from.email.toLowerCase());
  // Outlook's reply quotes the original itself; a second quote from here would double it.
  const quoted = source.provider === 'microsoft' ? '' : `\n\nOn ${when}, ${who(source.from)} wrote:\n${quote(source.body.slice(0, 8000))}`;
  return { mode, to: source.from.email, cc: mode === 'replyAll' ? addressList(others) : '', bcc: '', subject: re(source.subject), body: quoted, source };
}

const TITLE: Record<ComposeMode, string> = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward', draft: 'Draft' };
const addresses = (list: Array<{ address: string }>) => list.map((a) => a.address).join(', ');

/**
 * The compose panel, docked at the bottom of the mail window. Sending is two
 * steps: "Send" shows who gets the mail, "Send now" delivers it.
 *
 * An IMAP / POP3 mailbox sends a saved draft (/api/mail): "Send" saves the
 * draft first, and "Send now" sends exactly that saved content (its revision).
 * Any change after that is saved again before it can be sent.
 */
export function EmailCompose({ draft, mailbox, senders, ai = true, onMailbox, onChange, onClose, onSent }: {
  draft: ComposeDraft;
  mailbox: Mailbox;
  /** The AI help (the Email & calendar module) is available. */
  ai?: boolean;
  /** For a new message with several mailboxes that can send: which one sends it. */
  senders?: Mailbox[];
  onMailbox?: (mailbox: Mailbox) => void;
  onChange: (draft: ComposeDraft) => void;
  onClose: () => void;
  onSent: (notice: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [showCc, setShowCc] = useState(!!draft.cc || !!draft.bcc);
  const [options, setOptions] = useState<string[] | null>(null);
  const imap = mailbox.kind === 'imap';
  // IMAP: the content as last saved; any edit since needs saving before a send.
  const [dirty, setDirty] = useState(!draft.saved);
  const isReply = draft.mode === 'reply' || draft.mode === 'replyAll';
  // An IMAP reply gets its recipients from the original when it is first saved.
  const recipientsLater = imap && isReply && !draft.saved;
  const set = (patch: Partial<ComposeDraft>) => { setConfirming(false); setDirty(true); onChange({ ...draft, ...patch }); };

  const failed = (err: unknown) => { setError((err as Error).message); setConfirming(false); };

  /** IMAP: save the draft (create or change), and show what was saved. */
  const saveImap = async (): Promise<ComposeDraft> => {
    const body = { to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body };
    const view = draft.saved
      ? await api.patch<MailMessageView>(`/mail/drafts/${encodeURIComponent(draft.saved.id)}`, body)
      : await api.post<MailMessageView>('/mail/drafts', isReply && draft.source
        ? { replyTo: draft.source.id, body: draft.body, all: draft.mode === 'replyAll' }
        : { accountId: mailbox.account!.id, ...body });
    const next: ComposeDraft = { ...draft, to: addresses(view.to), cc: addresses(view.cc), subject: view.subject, body: view.text, saved: { id: view.id, ...(view.revision ? { revision: view.revision } : {}) } };
    onChange(next);
    setDirty(false);
    return next;
  };

  const review = async () => {
    setError('');
    if (!imap) { setConfirming(true); return; }
    setBusy('save');
    try { if (dirty || !draft.saved) await saveImap(); setConfirming(true); }
    catch (err) { failed(err); } finally { setBusy(''); }
  };

  const send = async () => {
    setBusy('send'); setError('');
    try {
      if (imap) {
        if (!draft.saved || dirty) throw new Error('Save the changes before sending.');
        await api.post(`/mail/drafts/${encodeURIComponent(draft.saved.id)}/send`, { confirm: true, ...(draft.saved.revision ? { expectedRevision: draft.saved.revision } : {}) });
        onSent('Message sent.');
        return;
      }
      const res = await api.post<{ sent?: boolean; error?: string }>('/email/send', {
        to: draft.to, ...(draft.cc.trim() ? { cc: draft.cc } : {}), ...(draft.bcc.trim() ? { bcc: draft.bcc } : {}),
        subject: draft.subject, body: draft.body, confirm: true, provider: mailbox.key,
        ...(isReply && draft.source ? { replyTo: draft.source.id } : {}),
      });
      if (res.error) failed(new Error(res.error)); else onSent('Message sent.');
    } catch (err) { failed(err); } finally { setBusy(''); }
  };

  // Keep the mail as a draft: an IMAP mailbox's own drafts, or a reply in the provider's Drafts folder.
  const saveDraft = async () => {
    setBusy('save'); setError('');
    try {
      if (imap) { await saveImap(); onSent('Draft saved. Nothing was sent.'); return; }
      if (!draft.source) return;
      const res = await api.post<{ saved?: boolean; error?: string }>(`/email/message/${encodeURIComponent(draft.source.id)}/save-draft?provider=${mailbox.key}`, { body: draft.body });
      if (res.error) setError(res.error); else onSent('Saved to your mailbox drafts. Nothing was sent.');
    } catch (err) { failed(err); } finally { setBusy(''); }
  };

  // The model proposes directions; the owner picks one before anything is written.
  const suggest = async () => {
    if (!draft.source) return;
    setBusy('options'); setError('');
    try {
      const res = await api.post<{ options?: string[]; error?: string }>(aiPath(mailbox, draft.source.id, 'reply-options'), {});
      if (res.error) setError(res.error); else setOptions(res.options?.length ? res.options : ['Write a reply']);
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  const writeWith = async (instruction: string) => {
    if (!draft.source) return;
    setBusy('draft'); setError('');
    try {
      const res = await api.post<{ body?: string; error?: string }>(aiPath(mailbox, draft.source.id, 'draft'), { instruction });
      if (res.error) setError(res.error);
      else { set({ body: `${res.body ?? ''}${draft.body.startsWith('\n\nOn ') ? draft.body : ''}` }); setOptions(null); }
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };

  const canSaveDraft = imap || isReply;
  return (
    <form
      aria-label={TITLE[draft.mode]}
      onSubmit={(e) => { e.preventDefault(); void review(); }}
      className="absolute bottom-0 right-0 z-20 flex max-h-[85%] w-full flex-col rounded-t-xl border border-outline-variant bg-surface shadow-2xl sm:right-4 sm:w-[34rem]"
    >
      <div className="flex items-center justify-between rounded-t-xl bg-surface-container-high px-3 py-2">
        <h2 className="text-sm font-medium text-on-surface">{TITLE[draft.mode]}</h2>
        <button type="button" onClick={onClose} aria-label="Discard" className={btnGhost}><X className="h-4 w-4" /></button>
      </div>
      <fieldset disabled={busy === 'send' || busy === 'save'} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {error && <p role="alert" className="rounded-md bg-error/10 px-2.5 py-1.5 text-sm text-error">{error}</p>}
        {draft.source?.sendError && draft.mode === 'draft' && <p className="rounded-md bg-error/10 px-2.5 py-1.5 text-sm text-error">The last send failed: {draft.source.sendError}</p>}
        {senders && senders.length > 1 && !draft.saved && (
          <label className="flex items-center gap-2 text-sm text-on-surface-variant">From
            <select aria-label="From" value={mailbox.key} onChange={(e) => { const next = senders.find((s) => s.key === e.target.value); if (next) onMailbox?.(next); }} className={field}>
              {senders.map((s) => <option key={s.key} value={s.key}>{s.address ?? s.label}</option>)}
            </select>
          </label>
        )}
        {recipientsLater ? (
          <p className="text-xs text-on-surface-variant">Recipients, subject and the quoted original are taken from the message when the draft is saved; you can change them then.</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <input aria-label="To" required placeholder="To" value={draft.to} onChange={(e) => set({ to: e.target.value })} className={field} />
              {!showCc && <button type="button" className={btnGhost} onClick={() => setShowCc(true)}>{imap ? 'Cc' : 'Cc/Bcc'}</button>}
            </div>
            {showCc && <input aria-label="Cc" placeholder="Cc" value={draft.cc} onChange={(e) => set({ cc: e.target.value })} className={field} />}
            {showCc && !imap && <input aria-label="Bcc" placeholder="Bcc" value={draft.bcc} onChange={(e) => set({ bcc: e.target.value })} className={field} />}
            <input aria-label="Subject" placeholder="Subject" maxLength={500} value={draft.subject} onChange={(e) => set({ subject: e.target.value })} className={field} />
          </>
        )}
        {isReply && mailbox.key === 'microsoft' && <p className="text-xs text-on-surface-variant">Outlook keeps the conversation&apos;s subject and adds the original message below your reply.</p>}
        {draft.mode === 'forward' && <p className="text-xs text-on-surface-variant">The text is forwarded. Attachments of the original are not.</p>}
        <textarea aria-label="Message" required rows={9} maxLength={100000} value={draft.body} onChange={(e) => set({ body: e.target.value })} className={`${field} min-h-40 flex-1 resize-y`} autoFocus />
        {imap && draft.saved && dirty && <p className="text-xs text-on-surface-variant">Changed since it was saved: it is saved again before it can be sent.</p>}
        {options && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-on-surface-variant">How do you want to reply?</span>
            {options.map((opt) => <button key={opt} type="button" disabled={busy === 'draft'} onClick={() => writeWith(opt)} className="rounded-full border border-primary/40 px-2.5 py-1 text-xs text-on-surface hover:bg-primary-container disabled:opacity-50">{opt}</button>)}
            <button type="button" className={btnGhost} onClick={() => setOptions(null)}>Cancel</button>
          </div>
        )}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant/40 px-3 py-2">
        {confirming ? (
          <div role="alertdialog" aria-label="Confirm send" className="flex w-full flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-on-surface">
              {imap ? `Send the saved draft from ${mailbox.address ?? mailbox.short} to ` : 'Send to '}{draft.to}{draft.cc.trim() ? `, cc ${draft.cc}` : ''}{draft.bcc.trim() ? `, bcc ${draft.bcc}` : ''}?
              {imap && <span className="block truncate text-xs text-on-surface-variant">Subject: {draft.subject}</span>}
            </p>
            <button type="button" className={btnPrimary} disabled={busy === 'send'} onClick={send}>{busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send now</button>
            <button type="button" className={btnGhost} disabled={busy === 'send'} onClick={() => setConfirming(false)}>Back</button>
          </div>
        ) : (
          <>
            <button type="submit" className={btnPrimary}>{busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send</button>
            {canSaveDraft && <button type="button" className={btn} disabled={!draft.body.trim() || busy === 'save'} onClick={saveDraft} title={imap ? 'Keep it in this mailbox\'s drafts without sending it' : 'Save this reply in your mailbox\'s Drafts folder without sending it'}><FileText className="h-4 w-4" /> {imap ? 'Save draft' : 'Save to drafts'}</button>}
            {isReply && ai && <button type="button" className={btn} disabled={busy === 'options' || busy === 'draft'} onClick={suggest}>{busy === 'options' || busy === 'draft' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-accent" />} Draft with AI</button>}
          </>
        )}
      </div>
    </form>
  );
}
