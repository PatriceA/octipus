'use client';

import { FileText, Loader2, Send, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { addressList, btn, btnGhost, btnPrimary, type EmailMessage, type EmailProvider, field, type Mailbox, mailboxKeyOf, mailboxQuery, who } from './email-shared';

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';
export interface ComposeDraft {
  mode: ComposeMode;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  /** The message a reply answers (threads the mail) or a forward quotes. */
  source?: EmailMessage;
}

const re = (subject: string) => (/^re\s*:/i.test(subject) ? subject : `Re: ${subject}`);
const fwd = (subject: string) => (/^fwd?\s*:/i.test(subject) ? subject : `Fwd: ${subject}`);
const quote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n');

/** A fresh draft for a mode. `self` is the mailbox's own address, left out of reply-all recipients. */
export function composeFor(mode: ComposeMode, source?: EmailMessage, self?: string): ComposeDraft {
  if (!source || mode === 'new') return { mode: 'new', to: '', cc: '', bcc: '', subject: '', body: '' };
  const when = source.receivedAt ? new Date(source.receivedAt).toLocaleString() : '';
  if (mode === 'forward') {
    const head = ['---------- Forwarded message ----------', `From: ${source.from.name ? `${source.from.name} <${source.from.email}>` : source.from.email}`, when && `Date: ${when}`, `Subject: ${source.subject}`, source.to?.length ? `To: ${addressList(source.to)}` : ''].filter(Boolean).join('\n');
    return { mode, to: '', cc: '', bcc: '', subject: fwd(source.subject), body: `\n\n${head}\n\n${source.body}`, source };
  }
  const own = self?.toLowerCase();
  const others = [...(source.to ?? []), ...(source.cc ?? [])].filter((a) => a.email && a.email.toLowerCase() !== own && a.email.toLowerCase() !== source.from.email.toLowerCase());
  // Outlook's reply quotes the original itself; a second quote from here would double it.
  const quoted = source.provider === 'microsoft' ? '' : `\n\nOn ${when}, ${who(source.from)} wrote:\n${quote(source.body.slice(0, 8000))}`;
  return { mode, to: source.from.email, cc: mode === 'replyAll' ? addressList(others) : '', bcc: '', subject: re(source.subject), body: quoted, source };
}

const TITLE: Record<ComposeMode, string> = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' };

/**
 * The compose panel, docked at the bottom of the mail window. Sending is two
 * steps: "Send" shows who gets the mail, "Send now" delivers it.
 */
export function EmailCompose({ draft, provider, account, accounts, onProvider, onChange, onClose, onSent }: {
  draft: ComposeDraft;
  provider: EmailProvider;
  /** The account of that provider that sends, when it is not the default one. */
  account?: string;
  /** For a new message with several mailboxes connected: which one sends it. */
  accounts?: Mailbox[];
  onProvider?: (mailbox: Mailbox) => void;
  onChange: (draft: ComposeDraft) => void;
  onClose: () => void;
  onSent: (notice: string) => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [showCc, setShowCc] = useState(!!draft.cc || !!draft.bcc);
  const [options, setOptions] = useState<string[] | null>(null);
  const isReply = draft.mode === 'reply' || draft.mode === 'replyAll';
  const set = (patch: Partial<ComposeDraft>) => { setConfirming(false); onChange({ ...draft, ...patch }); };

  const send = async () => {
    setBusy('send'); setError('');
    try {
      const res = await api.post<{ sent?: boolean; error?: string }>('/email/send', {
        to: draft.to, ...(draft.cc.trim() ? { cc: draft.cc } : {}), ...(draft.bcc.trim() ? { bcc: draft.bcc } : {}),
        subject: draft.subject, body: draft.body, confirm: true, provider, ...(account ? { account } : {}),
        ...(isReply && draft.source ? { replyTo: draft.source.id } : {}),
      });
      if (res.error) { setError(res.error); setConfirming(false); } else onSent('Message sent.');
    } catch (err) { setError((err as Error).message); setConfirming(false); } finally { setBusy(''); }
  };

  // Keep a reply in the mailbox's own Drafts, to finish from any mail app.
  const saveDraft = async () => {
    if (!draft.source) return;
    setBusy('save'); setError('');
    try {
      const res = await api.post<{ saved?: boolean; error?: string }>(`/email/message/${encodeURIComponent(draft.source.id)}/save-draft?${mailboxQuery(provider, account)}`, { body: draft.body });
      if (res.error) setError(res.error); else onSent('Saved to your mailbox drafts. Nothing was sent.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };

  // The model proposes directions; the owner picks one before anything is written.
  const suggest = async () => {
    if (!draft.source) return;
    setBusy('options'); setError('');
    try {
      const res = await api.post<{ options?: string[]; error?: string }>(`/email/message/${encodeURIComponent(draft.source.id)}/reply-options?${mailboxQuery(provider, account)}`, {});
      if (res.error) setError(res.error); else setOptions(res.options?.length ? res.options : ['Write a reply']);
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  const writeWith = async (instruction: string) => {
    if (!draft.source) return;
    setBusy('draft'); setError('');
    try {
      const res = await api.post<{ body?: string; error?: string }>(`/email/message/${encodeURIComponent(draft.source.id)}/draft?${mailboxQuery(provider, account)}`, { instruction });
      if (res.error) setError(res.error);
      else { set({ body: `${res.body ?? ''}${draft.body.startsWith('\n\nOn ') ? draft.body : ''}` }); setOptions(null); }
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };

  return (
    <form
      aria-label={TITLE[draft.mode]}
      onSubmit={(e) => { e.preventDefault(); setConfirming(true); }}
      className="absolute bottom-0 right-0 z-20 flex max-h-[85%] w-full flex-col rounded-t-xl border border-outline-variant bg-surface shadow-2xl sm:right-4 sm:w-[34rem]"
    >
      <div className="flex items-center justify-between rounded-t-xl bg-surface-container-high px-3 py-2">
        <h2 className="text-sm font-medium text-on-surface">{TITLE[draft.mode]}</h2>
        <button type="button" onClick={onClose} aria-label="Discard" className={btnGhost}><X className="h-4 w-4" /></button>
      </div>
      <fieldset disabled={busy === 'send'} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {error && <p role="alert" className="rounded-md bg-error/10 px-2.5 py-1.5 text-sm text-error">{error}</p>}
        {accounts && (
          <label className="flex items-center gap-2 text-sm text-on-surface-variant">From
            <select aria-label="From" value={mailboxKeyOf({ provider, account })} onChange={(e) => { const m = accounts.find((a) => a.key === e.target.value); if (m) onProvider?.(m); }} className={field}>
              {accounts.map((a) => <option key={a.key} value={a.key}>{a.address ?? (a.provider === 'google' ? 'Gmail' : 'Outlook')}</option>)}
            </select>
          </label>
        )}
        <div className="flex items-center gap-2">
          <input aria-label="To" required placeholder="To" value={draft.to} onChange={(e) => set({ to: e.target.value })} className={field} />
          {!showCc && <button type="button" className={btnGhost} onClick={() => setShowCc(true)}>Cc/Bcc</button>}
        </div>
        {showCc && <input aria-label="Cc" placeholder="Cc" value={draft.cc} onChange={(e) => set({ cc: e.target.value })} className={field} />}
        {showCc && <input aria-label="Bcc" placeholder="Bcc" value={draft.bcc} onChange={(e) => set({ bcc: e.target.value })} className={field} />}
        <input aria-label="Subject" placeholder="Subject" maxLength={500} value={draft.subject} onChange={(e) => set({ subject: e.target.value })} className={field} />
        {isReply && provider === 'microsoft' && <p className="text-xs text-on-surface-variant">Outlook keeps the conversation&apos;s subject and adds the original message below your reply.</p>}
        {draft.mode === 'forward' && <p className="text-xs text-on-surface-variant">The text is forwarded. Attachments of the original are not.</p>}
        <textarea aria-label="Message" required rows={9} maxLength={100000} value={draft.body} onChange={(e) => set({ body: e.target.value })} className={`${field} min-h-40 flex-1 resize-y`} autoFocus />
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
            <p className="min-w-0 flex-1 truncate text-sm text-on-surface">Send to {draft.to}{draft.cc.trim() ? `, cc ${draft.cc}` : ''}{draft.bcc.trim() ? `, bcc ${draft.bcc}` : ''}?</p>
            <button type="button" className={btnPrimary} disabled={busy === 'send'} onClick={send}>{busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send now</button>
            <button type="button" className={btnGhost} disabled={busy === 'send'} onClick={() => setConfirming(false)}>Back</button>
          </div>
        ) : (
          <>
            <button type="submit" className={btnPrimary}><Send className="h-4 w-4" /> Send</button>
            {isReply && <button type="button" className={btn} disabled={!draft.body.trim() || busy === 'save'} onClick={saveDraft} title="Save this reply in your mailbox's Drafts folder without sending it"><FileText className="h-4 w-4" /> Save to drafts</button>}
            {isReply && <button type="button" className={btn} disabled={busy === 'options' || busy === 'draft'} onClick={suggest}>{busy === 'options' || busy === 'draft' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-accent" />} Draft with AI</button>}
          </>
        )}
      </div>
    </form>
  );
}
