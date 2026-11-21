'use client';

import { Bold, FileText, Italic, Link2, List, ListOrdered, Loader2, Paperclip, Quote, Send, Sparkles, X } from 'lucide-react';
import { type DragEvent, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api } from '@/lib/api';
import type { MailMessageView } from '../../../src/shared/mail';
import { addressList, btn, btnGhost, btnPrimary, type EmailMessage, field, who } from './email-shared';
import { aiPath, type Mailbox, mailboxBody, mailboxQuery } from './mailboxes';

/** `draft`: an IMAP / POP3 draft (or failed send) opened again from its folder. */
export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward' | 'draft';

/**
 * A file on the mail being written: one uploaded from this computer (held on
 * the server until the send), or one of the forwarded message's own files
 * (fetched from the mailbox when the mail is sent). Google / Microsoft only.
 */
export type ComposeAttachment =
  | { key: string; kind: 'upload'; name: string; size: number; id?: string; status: 'uploading' | 'ready' | 'error'; error?: string }
  | { key: string; kind: 'forward'; name: string; size: number; messageId: string; attachmentId: string };
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
  /** Google / Microsoft only: files that go with the mail. */
  attachments: ComposeAttachment[];
  /** Light formatting on: **bold**, _italic_, lists, quotes and links become the mail's HTML. Off: plain text only. Google / Microsoft only. */
  rich: boolean;
  /** The quoted or forwarded original appended below what the writer types: sent as it is, never read as formatting. */
  original?: string;
}

/** Where the original starts in the body, when the body still ends with it untouched. */
export const originalAt = (draft: Pick<ComposeDraft, 'body' | 'original'>): number | undefined =>
  draft.original && draft.body.endsWith(draft.original) ? draft.body.length - draft.original.length : undefined;

/** What one mail may carry, as the server checks it (core/email/send-mime.ts). */
export const MAX_FILES = 20;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const re = (subject: string) => (/^re\s*:/i.test(subject) ? subject : `Re: ${subject}`);
const fwd = (subject: string) => (/^fwd?\s*:/i.test(subject) ? subject : `Fwd: ${subject}`);
const quote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n');
export const fileSize = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
let keySeq = 0;
const nextKey = () => `att-${++keySeq}`;

/**
 * A fresh draft for a mode. `self` is the mailbox's own address, left out of
 * reply-all recipients. An IMAP / POP3 reply leaves the recipients, the
 * subject and the quote to the server, which takes them from the original
 * (its Reply-To included) when the draft is saved.
 */
export function composeFor(mode: ComposeMode, source?: EmailMessage, self?: string): ComposeDraft {
  // IMAP / POP3 drafts are plain text without files; Google / Microsoft mail starts formatted.
  const blank = { cc: '', bcc: '', attachments: [] as ComposeAttachment[], rich: source?.provider !== 'imap' };
  if (mode === 'draft' && source) {
    return { ...blank, mode, to: addressList(source.to), cc: addressList(source.cc), subject: source.subject, body: source.body, source, saved: { id: source.id, ...(source.revision ? { revision: source.revision } : {}) } };
  }
  if (!source || mode === 'new' || mode === 'draft') return { ...blank, rich: true, mode: 'new', to: '', subject: '', body: '' };
  const when = source.receivedAt ? new Date(source.receivedAt).toLocaleString() : '';
  if (mode === 'forward') {
    const head = ['---------- Forwarded message ----------', `From: ${source.from.name ? `${source.from.name} <${source.from.email}>` : source.from.email}`, when && `Date: ${when}`, `Subject: ${source.subject}`, source.to?.length ? `To: ${addressList(source.to)}` : ''].filter(Boolean).join('\n');
    // A Google / Microsoft original's files go along unless the writer removes them.
    const attachments: ComposeAttachment[] = source.provider === 'imap' ? [] : (source.attachments ?? []).map((a) => ({ key: nextKey(), kind: 'forward', name: a.name, size: a.size, messageId: source.id, attachmentId: a.id }));
    const original = `${head}\n\n${source.body}`;
    return { ...blank, mode, to: '', subject: fwd(source.subject), body: `\n\n${original}`, original, source, attachments };
  }
  if (source.provider === 'imap') return { ...blank, mode, to: '', subject: re(source.subject), body: '', source };
  const own = self?.toLowerCase();
  const others = [...(source.to ?? []), ...(source.cc ?? [])].filter((a) => a.email && a.email.toLowerCase() !== own && a.email.toLowerCase() !== source.from.email.toLowerCase());
  // Outlook's reply quotes the original itself; a second quote from here would double it.
  const original = source.provider === 'microsoft' ? '' : `On ${when}, ${who(source.from)} wrote:\n${quote(source.body.slice(0, 8000))}`;
  return { ...blank, mode, to: source.from.email, cc: mode === 'replyAll' ? addressList(others) : '', subject: re(source.subject), body: original ? `\n\n${original}` : '', ...(original ? { original } : {}), source };
}

const TITLE: Record<ComposeMode, string> = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward', draft: 'Draft' };
const addresses = (list: Array<{ address: string }>) => list.map((a) => a.address).join(', ');

/** The server's `{ error }` out of a failed upload's text. */
function uploadError(err: unknown): string {
  const raw = (err as Error).message;
  try { return (JSON.parse(raw) as { error?: string }).error ?? raw; } catch { return raw; }
}

type Edit = { text: string; start: number; end: number };

/** Wrap the selection in a sign (or insert a placeholder between two). Pure. */
export function wrapSelection(text: string, start: number, end: number, sign: string, placeholder: string): Edit {
  const picked = text.slice(start, end) || placeholder;
  return { text: `${text.slice(0, start)}${sign}${picked}${sign}${text.slice(end)}`, start: start + sign.length, end: start + sign.length + picked.length };
}

/** Put a prefix before every line the selection touches ("- ", "1. ", "> "). Pure. */
export function prefixLines(text: string, start: number, end: number, prefix: (index: number) => string): Edit {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const toEnd = text.indexOf('\n', end);
  const to = toEnd < 0 ? text.length : toEnd;
  const lines = text.slice(from, to).split('\n').map((line, i) => `${prefix(i)}${line}`);
  const block = lines.join('\n');
  return { text: text.slice(0, from) + block + text.slice(to), start: from, end: from + block.length };
}

/** A link around the selection, with the address part selected for typing. Pure. */
export function insertLink(text: string, start: number, end: number): Edit {
  const label = text.slice(start, end) || 'link text';
  const before = `${text.slice(0, start)}[${label}](`;
  return { text: `${before}https://)${text.slice(end)}`, start: before.length, end: before.length + 'https://'.length };
}


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
  /** Change the draft from its latest state (uploads finish after other edits). */
  onChange: (update: (draft: ComposeDraft) => ComposeDraft) => void;
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
  const set = (patch: Partial<ComposeDraft>) => { setConfirming(false); setDirty(true); onChange((d) => ({ ...d, ...patch })); };
  // Files and formatting go through the Google / Microsoft send; the IMAP draft backend stores plain text only.
  const [dragging, setDragging] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const totalBytes = draft.attachments.reduce((sum, a) => sum + a.size, 0);
  const uploading = draft.attachments.some((a) => a.kind === 'upload' && a.status === 'uploading');
  const broken = draft.attachments.some((a) => a.kind === 'upload' && a.status === 'error');
  const addFiles = (files: File[]) => {
    setError(''); setConfirming(false);
    let count = draft.attachments.length;
    let bytes = totalBytes;
    for (const file of files) {
      if (count >= MAX_FILES) { setError(`At most ${MAX_FILES} attachments per message.`); break; }
      if (file.size === 0) { setError(`${file.name} is empty.`); continue; }
      if (bytes + file.size > MAX_TOTAL_BYTES) { setError(`Attachments may add up to 25 MB per message; ${file.name} does not fit.`); continue; }
      count++; bytes += file.size;
      const key = nextKey();
      onChange((d) => ({ ...d, attachments: [...d.attachments, { key, kind: 'upload', name: file.name, size: file.size, status: 'uploading' }] }));
      api.upload<{ id: string; name: string; size: number }>('/email/uploads', [file], 'file').then(
        (held) => onChange((d) => ({ ...d, attachments: d.attachments.map((a) => (a.key === key ? { ...a, kind: 'upload', id: held.id, name: held.name, status: 'ready' } as ComposeAttachment : a)) })),
        (err: unknown) => onChange((d) => ({ ...d, attachments: d.attachments.map((a) => (a.key === key ? { ...a, kind: 'upload', status: 'error', error: uploadError(err) } as ComposeAttachment : a)) })),
      );
    }
  };
  const remove = (attachment: ComposeAttachment) => {
    setConfirming(false);
    onChange((d) => ({ ...d, attachments: d.attachments.filter((a) => a.key !== attachment.key) }));
    if (attachment.kind === 'upload' && attachment.id) api.delete(`/email/uploads/${encodeURIComponent(attachment.id)}`).catch(() => {});
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); setDragging(false);
    addFiles([...e.dataTransfer.files]);
  };

  const edit = (make: (text: string, start: number, end: number) => Edit) => {
    const area = textRef.current;
    if (!area) return;
    const next = make(draft.body, area.selectionStart, area.selectionEnd);
    // Committed before the selection is put back. Left to the next frame, the
    // restore could land after a selection made meanwhile and replace it, so
    // the next toolbar action formatted the wrong lines.
    flushSync(() => set({ body: next.text, rich: true }));
    area.focus();
    area.setSelectionRange(next.start, next.end);
  };


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
    onChange(() => next);
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
      const attachments = draft.attachments.map((a) => (a.kind === 'upload' ? { upload: a.id! } : { forward: { messageId: a.messageId, attachmentId: a.attachmentId } }));
      const res = await api.post<{ sent?: boolean; error?: string }>('/email/send', {
        to: draft.to, ...(draft.cc.trim() ? { cc: draft.cc } : {}), ...(draft.bcc.trim() ? { bcc: draft.bcc } : {}),
        subject: draft.subject, body: draft.body, format: draft.rich ? 'rich' : 'plain', ...(draft.rich && originalAt(draft) !== undefined ? { originalAt: originalAt(draft) } : {}), confirm: true, ...mailboxBody(mailbox),
        ...(isReply && draft.source ? { replyTo: draft.source.id } : {}),
        ...(attachments.length ? { attachments } : {}),
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
      const res = await api.post<{ saved?: boolean; error?: string }>(`/email/message/${encodeURIComponent(draft.source.id)}/save-draft?${mailboxQuery(mailbox)}`, { body: draft.body });
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
  const tool = 'rounded p-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface disabled:opacity-40';
  return (
    <form
      aria-label={TITLE[draft.mode]}
      onSubmit={(e) => { e.preventDefault(); void review(); }}
      onDragOver={(e) => { if (!imap && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={(e) => { if (!imap) onDrop(e); }}
      className={`absolute bottom-0 right-0 z-20 flex max-h-[85%] w-full flex-col rounded-t-xl border bg-surface shadow-2xl sm:right-4 sm:w-[36rem] ${dragging ? 'border-primary ring-2 ring-primary/40' : 'border-outline-variant'}`}
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
        {isReply && mailbox.provider === 'microsoft' && <p className="text-xs text-on-surface-variant">Outlook keeps the conversation&apos;s subject and adds the original message below your reply.</p>}
        {imap ? (
          <p className="text-xs text-on-surface-variant">{draft.mode === 'forward' ? 'The text is forwarded. ' : ''}An IMAP / POP3 mailbox sends plain text without attachments.</p>
        ) : (
          <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 rounded-md border border-outline-variant/50 px-1 py-0.5">
            <button type="button" className={tool} aria-label="Bold" title="Bold (**text**)" onClick={() => edit((t, s, e) => wrapSelection(t, s, e, '**', 'bold text'))}><Bold className="h-4 w-4" /></button>
            <button type="button" className={tool} aria-label="Italic" title="Italic (_text_)" onClick={() => edit((t, s, e) => wrapSelection(t, s, e, '_', 'italic text'))}><Italic className="h-4 w-4" /></button>
            <button type="button" className={tool} aria-label="Link" title="Link ([text](https://…))" onClick={() => edit(insertLink)}><Link2 className="h-4 w-4" /></button>
            <span className="mx-1 h-4 w-px bg-outline-variant/60" />
            <button type="button" className={tool} aria-label="Bulleted list" title="Bulleted list (- item)" onClick={() => edit((t, s, e) => prefixLines(t, s, e, () => '- '))}><List className="h-4 w-4" /></button>
            <button type="button" className={tool} aria-label="Numbered list" title="Numbered list (1. item)" onClick={() => edit((t, s, e) => prefixLines(t, s, e, (i) => `${i + 1}. `))}><ListOrdered className="h-4 w-4" /></button>
            <button type="button" className={tool} aria-label="Quote" title="Quote (> line)" onClick={() => edit((t, s, e) => prefixLines(t, s, e, () => '> '))}><Quote className="h-4 w-4" /></button>
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 px-1.5 text-xs text-on-surface-variant" title="Send exactly the text as typed, without an HTML part">
              <input type="checkbox" checked={!draft.rich} onChange={(e) => set({ rich: !e.target.checked })} /> Plain text
            </label>
          </div>
        )}
        <textarea ref={textRef} aria-label="Message" required rows={9} maxLength={100000} value={draft.body} onChange={(e) => set({ body: e.target.value })} className={`${field} min-h-40 flex-1 resize-y`} autoFocus />
        {!imap && draft.attachments.length > 0 && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
            {draft.attachments.map((a) => (
              <li key={a.key} className={`inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${a.kind === 'upload' && a.status === 'error' ? 'border-error/50 text-error' : 'border-outline-variant/60 text-on-surface'}`} title={a.kind === 'upload' && a.error ? a.error : a.kind === 'forward' ? 'From the forwarded message' : undefined}>
                {a.kind === 'upload' && a.status === 'uploading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
                <span className="max-w-48 truncate">{a.name}</span>
                <span className="text-on-surface-variant">{a.kind === 'upload' && a.status === 'error' ? 'failed' : fileSize(a.size)}</span>
                <button type="button" aria-label={`Remove ${a.name}`} onClick={() => remove(a)} className="rounded p-0.5 hover:bg-surface-container-high"><X className="h-3 w-3" /></button>
              </li>
            ))}
          </ul>
        )}
        {imap && draft.saved && dirty && <p className="text-xs text-on-surface-variant">Changed since it was saved: it is saved again before it can be sent.</p>}
        {options && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-on-surface-variant">How do you want to reply?</span>
            {options.map((opt) => <button key={opt} type="button" disabled={busy === 'draft'} onClick={() => writeWith(opt)} className="rounded-full border border-primary/40 px-2.5 py-1 text-xs text-on-surface hover:bg-primary-container disabled:opacity-50">{opt}</button>)}
            <button type="button" className={btnGhost} onClick={() => setOptions(null)}>Cancel</button>
          </div>
        )}
      </fieldset>
      {!imap && <input ref={fileRef} type="file" multiple hidden aria-label="Add files" onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />}
      <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant/40 px-3 py-2">
        {confirming ? (
          <div role="alertdialog" aria-label="Confirm send" className="flex w-full flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-on-surface">
              {imap ? `Send the saved draft from ${mailbox.address ?? mailbox.short} to ` : 'Send to '}{draft.to}{draft.cc.trim() ? `, cc ${draft.cc}` : ''}{draft.bcc.trim() ? `, bcc ${draft.bcc}` : ''}{!imap && draft.attachments.length ? ` with ${draft.attachments.length} ${draft.attachments.length === 1 ? 'attachment' : 'attachments'}` : ''}?
              {imap && <span className="block truncate text-xs text-on-surface-variant">Subject: {draft.subject}</span>}
            </p>
            <button type="button" className={btnPrimary} disabled={busy === 'send'} onClick={send}>{busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send now</button>
            <button type="button" className={btnGhost} disabled={busy === 'send'} onClick={() => setConfirming(false)}>Back</button>
          </div>
        ) : (
          <>
            <button type="submit" className={btnPrimary} disabled={uploading || broken} title={uploading ? 'Waiting for the attachments to upload' : broken ? 'Remove the attachment that failed' : undefined}>{busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send</button>
            {!imap && <button type="button" className={btnGhost} aria-label="Attach files" title="Attach files (or drop them here)" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /></button>}
            {canSaveDraft && <button type="button" className={btn} disabled={!draft.body.trim() || busy === 'save'} onClick={saveDraft} title={imap ? 'Keep it in this mailbox\'s drafts without sending it' : draft.attachments.length ? 'Save the text of this reply in your mailbox\'s Drafts folder (attachments are not saved there)' : 'Save this reply in your mailbox\'s Drafts folder without sending it'}><FileText className="h-4 w-4" /> {imap ? 'Save draft' : 'Save to drafts'}</button>}
            {isReply && ai && <button type="button" className={btn} disabled={busy === 'options' || busy === 'draft'} onClick={suggest}>{busy === 'options' || busy === 'draft' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-accent" />} Draft with AI</button>}
            {!imap && draft.attachments.length > 0 && <span className="ml-auto text-xs text-on-surface-variant">{fileSize(totalBytes)} of 25 MB</span>}
          </>
        )}
      </div>
    </form>
  );
}
