'use client';

import { Bold, FileText, Italic, Link2, List, ListOrdered, Loader2, Paperclip, Quote, Send, Sparkles, X } from 'lucide-react';
import { type DragEvent, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { addressList, btn, btnGhost, btnPrimary, type EmailMessage, type EmailProvider, field, who } from './email-shared';

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

/**
 * A file on the mail being written: one uploaded from this computer (held on
 * the server until the send), or one of the forwarded message's own files
 * (fetched from the mailbox when the mail is sent).
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
  attachments: ComposeAttachment[];
  /** Light formatting on: **bold**, _italic_, lists, quotes and links become the mail's HTML. Off: plain text only. */
  rich: boolean;
}

/** What one mail may carry, as the server checks it (core/email/send-mime.ts). */
export const MAX_FILES = 20;
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const re = (subject: string) => (/^re\s*:/i.test(subject) ? subject : `Re: ${subject}`);
const fwd = (subject: string) => (/^fwd?\s*:/i.test(subject) ? subject : `Fwd: ${subject}`);
const quote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n');
export const fileSize = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
let keySeq = 0;
const nextKey = () => `att-${++keySeq}`;

/** A fresh draft for a mode. `self` is the mailbox's own address, left out of reply-all recipients. */
export function composeFor(mode: ComposeMode, source?: EmailMessage, self?: string): ComposeDraft {
  const blank = { cc: '', bcc: '', attachments: [] as ComposeAttachment[], rich: true };
  if (!source || mode === 'new') return { ...blank, mode: 'new', to: '', subject: '', body: '' };
  const when = source.receivedAt ? new Date(source.receivedAt).toLocaleString() : '';
  if (mode === 'forward') {
    const head = ['---------- Forwarded message ----------', `From: ${source.from.name ? `${source.from.name} <${source.from.email}>` : source.from.email}`, when && `Date: ${when}`, `Subject: ${source.subject}`, source.to?.length ? `To: ${addressList(source.to)}` : ''].filter(Boolean).join('\n');
    // The original's files go along unless the writer removes them.
    const attachments: ComposeAttachment[] = (source.attachments ?? []).map((a) => ({ key: nextKey(), kind: 'forward', name: a.name, size: a.size, messageId: source.id, attachmentId: a.id }));
    return { ...blank, mode, to: '', subject: fwd(source.subject), body: `\n\n${head}\n\n${source.body}`, source, attachments };
  }
  const own = self?.toLowerCase();
  const others = [...(source.to ?? []), ...(source.cc ?? [])].filter((a) => a.email && a.email.toLowerCase() !== own && a.email.toLowerCase() !== source.from.email.toLowerCase());
  // Outlook's reply quotes the original itself; a second quote from here would double it.
  const quoted = source.provider === 'microsoft' ? '' : `\n\nOn ${when}, ${who(source.from)} wrote:\n${quote(source.body.slice(0, 8000))}`;
  return { ...blank, mode, to: source.from.email, cc: mode === 'replyAll' ? addressList(others) : '', subject: re(source.subject), body: quoted, source };
}

const TITLE: Record<ComposeMode, string> = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' };

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
 */
export function EmailCompose({ draft, provider, accounts, onProvider, onChange, onClose, onSent }: {
  draft: ComposeDraft;
  provider: EmailProvider;
  /** For a new message with several mailboxes connected: which one sends it. */
  accounts?: Array<{ provider: EmailProvider; address?: string }>;
  onProvider?: (provider: EmailProvider) => void;
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
  const [dragging, setDragging] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const isReply = draft.mode === 'reply' || draft.mode === 'replyAll';
  const set = (patch: Partial<ComposeDraft>) => { setConfirming(false); onChange((d) => ({ ...d, ...patch })); };
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
    set({ body: next.text, rich: true });
    requestAnimationFrame(() => { area.focus(); area.setSelectionRange(next.start, next.end); });
  };

  const send = async () => {
    setBusy('send'); setError('');
    try {
      const attachments = draft.attachments.map((a) => (a.kind === 'upload' ? { upload: a.id! } : { forward: { messageId: a.messageId, attachmentId: a.attachmentId } }));
      const res = await api.post<{ sent?: boolean; error?: string }>('/email/send', {
        to: draft.to, ...(draft.cc.trim() ? { cc: draft.cc } : {}), ...(draft.bcc.trim() ? { bcc: draft.bcc } : {}),
        subject: draft.subject, body: draft.body, format: draft.rich ? 'rich' : 'plain', confirm: true, provider,
        ...(isReply && draft.source ? { replyTo: draft.source.id } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      if (res.error) { setError(res.error); setConfirming(false); } else onSent('Message sent.');
    } catch (err) { setError((err as Error).message); setConfirming(false); } finally { setBusy(''); }
  };

  // Keep a reply in the mailbox's own Drafts, to finish from any mail app.
  const saveDraft = async () => {
    if (!draft.source) return;
    setBusy('save'); setError('');
    try {
      const res = await api.post<{ saved?: boolean; error?: string }>(`/email/message/${encodeURIComponent(draft.source.id)}/save-draft?provider=${provider}`, { body: draft.body });
      if (res.error) setError(res.error); else onSent('Saved to your mailbox drafts. Nothing was sent.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };

  // The model proposes directions; the owner picks one before anything is written.
  const suggest = async () => {
    if (!draft.source) return;
    setBusy('options'); setError('');
    try {
      const res = await api.post<{ options?: string[]; error?: string }>(`/email/message/${encodeURIComponent(draft.source.id)}/reply-options?provider=${provider}`, {});
      if (res.error) setError(res.error); else setOptions(res.options?.length ? res.options : ['Write a reply']);
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  const writeWith = async (instruction: string) => {
    if (!draft.source) return;
    setBusy('draft'); setError('');
    try {
      const res = await api.post<{ body?: string; error?: string }>(`/email/message/${encodeURIComponent(draft.source.id)}/draft?provider=${provider}`, { instruction });
      if (res.error) setError(res.error);
      else { set({ body: `${res.body ?? ''}${draft.body.startsWith('\n\nOn ') ? draft.body : ''}` }); setOptions(null); }
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };

  const tool = 'rounded p-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface disabled:opacity-40';

  return (
    <form
      aria-label={TITLE[draft.mode]}
      onSubmit={(e) => { e.preventDefault(); setConfirming(true); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
      className={`absolute bottom-0 right-0 z-20 flex max-h-[85%] w-full flex-col rounded-t-xl border bg-surface shadow-2xl sm:right-4 sm:w-[36rem] ${dragging ? 'border-primary ring-2 ring-primary/40' : 'border-outline-variant'}`}
    >
      <div className="flex items-center justify-between rounded-t-xl bg-surface-container-high px-3 py-2">
        <h2 className="text-sm font-medium text-on-surface">{TITLE[draft.mode]}</h2>
        <button type="button" onClick={onClose} aria-label="Discard" className={btnGhost}><X className="h-4 w-4" /></button>
      </div>
      <fieldset disabled={busy === 'send'} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {error && <p role="alert" className="rounded-md bg-error/10 px-2.5 py-1.5 text-sm text-error">{error}</p>}
        {accounts && (
          <label className="flex items-center gap-2 text-sm text-on-surface-variant">From
            <select aria-label="From" value={provider} onChange={(e) => onProvider?.(e.target.value as EmailProvider)} className={field}>
              {accounts.map((a) => <option key={a.provider} value={a.provider}>{a.address ?? (a.provider === 'google' ? 'Gmail' : 'Outlook')}</option>)}
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
        <textarea ref={textRef} aria-label="Message" required rows={9} maxLength={100000} value={draft.body} onChange={(e) => set({ body: e.target.value })} className={`${field} min-h-40 flex-1 resize-y`} autoFocus />

        {draft.attachments.length > 0 && (
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
        {options && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-on-surface-variant">How do you want to reply?</span>
            {options.map((opt) => <button key={opt} type="button" disabled={busy === 'draft'} onClick={() => writeWith(opt)} className="rounded-full border border-primary/40 px-2.5 py-1 text-xs text-on-surface hover:bg-primary-container disabled:opacity-50">{opt}</button>)}
            <button type="button" className={btnGhost} onClick={() => setOptions(null)}>Cancel</button>
          </div>
        )}
      </fieldset>
      <input ref={fileRef} type="file" multiple hidden aria-label="Add files" onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      <div className="flex flex-wrap items-center gap-2 border-t border-outline-variant/40 px-3 py-2">
        {confirming ? (
          <div role="alertdialog" aria-label="Confirm send" className="flex w-full flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-sm text-on-surface">
              Send to {draft.to}{draft.cc.trim() ? `, cc ${draft.cc}` : ''}{draft.bcc.trim() ? `, bcc ${draft.bcc}` : ''}{draft.attachments.length ? ` with ${draft.attachments.length} ${draft.attachments.length === 1 ? 'attachment' : 'attachments'}` : ''}?
            </p>
            <button type="button" className={btnPrimary} disabled={busy === 'send'} onClick={send}>{busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send now</button>
            <button type="button" className={btnGhost} disabled={busy === 'send'} onClick={() => setConfirming(false)}>Back</button>
          </div>
        ) : (
          <>
            <button type="submit" className={btnPrimary} disabled={uploading || broken} title={uploading ? 'Waiting for the attachments to upload' : broken ? 'Remove the attachment that failed' : undefined}><Send className="h-4 w-4" /> Send</button>
            <button type="button" className={btnGhost} aria-label="Attach files" title="Attach files (or drop them here)" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /></button>
            {isReply && <button type="button" className={btn} disabled={!draft.body.trim() || busy === 'save'} onClick={saveDraft} title={draft.attachments.length ? 'Save the text of this reply in your mailbox\'s Drafts folder (attachments are not saved there)' : 'Save this reply in your mailbox\'s Drafts folder without sending it'}><FileText className="h-4 w-4" /> Save to drafts</button>}
            {isReply && <button type="button" className={btn} disabled={busy === 'options' || busy === 'draft'} onClick={suggest}>{busy === 'options' || busy === 'draft' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-accent" />} Draft with AI</button>}
            {draft.attachments.length > 0 && <span className="ml-auto text-xs text-on-surface-variant">{fileSize(totalBytes)} of 25 MB</span>}
          </>
        )}
      </div>
    </form>
  );
}
