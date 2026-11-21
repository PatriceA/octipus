'use client';

import { useQuery } from '@tanstack/react-query';
import { Archive, ArrowLeft, Forward, ListPlus, Loader2, MailOpen, Paperclip, Reply, ReplyAll, Sparkles, Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { EmailBatchAction, EmailThreadResponse } from '../../../src/shared/email';
import type { ComposeMode } from './email-compose';
import { addressList, btn, btnGhost, mailboxQuery, type Conversation, type EmailMessage, type EmailProvider, type EmailTriage, hasBlockedImages, MailHtml, priorityTone, shortDate, sourceLabel, who } from './email-shared';

const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The messages of a conversation, oldest first. A provider without thread ids gives the one message. */
async function loadThread(conversation: Conversation, provider: EmailProvider, account?: string): Promise<EmailMessage[]> {
  const { latest } = conversation;
  if (latest.threadId) {
    const res = await api.get<EmailThreadResponse & { error?: string }>(`/email/thread/${encodeURIComponent(latest.threadId)}?${mailboxQuery(provider, account)}`);
    if (res.error) throw new Error(res.error);
    if (res.messages?.length) return res.messages;
  }
  const msg = await api.get<EmailMessage & { error?: string }>(`/email/message/${encodeURIComponent(latest.id)}?${mailboxQuery(provider, account)}`);
  if (msg.error) throw new Error(msg.error);
  return [msg];
}

interface Props {
  conversation: Conversation;
  provider: EmailProvider;
  /** The account of the provider, when it is not the default one. */
  account?: string;
  categories: string[];
  folder: string;
  onBack: () => void;
  onAction: (ids: string[], action: EmailBatchAction) => void;
  onCompose: (mode: ComposeMode, source: EmailMessage) => void;
  onLabel: (message: EmailMessage, label: { priority: EmailTriage['priority']; category: string }) => Promise<void>;
  onNotice: (text: string) => void;
}

/** The read pane: one conversation, its newest message open, the earlier ones folded. */
export function EmailReader({ conversation, provider, account, categories, folder, onBack, onAction, onCompose, onLabel, onNotice }: Props) {
  const thread = useQuery({ queryKey: ['email-thread', provider, account ?? '', conversation.key], queryFn: () => loadThread(conversation, provider, account), staleTime: 30_000 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showImages, setShowImages] = useState(false);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const messages = thread.data ?? [];
  const last = messages.at(-1);
  const ids = messages.length ? messages.map((m) => m.id) : conversation.ids;

  // Opening a conversation reads it: clear the unread mark here and in the mailbox.
  const unreadIds = messages.filter((m) => m.unread).map((m) => m.id).join(',');
  useEffect(() => {
    if (unreadIds) onAction(unreadIds.split(','), 'read');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per set of unread messages
  }, [unreadIds]);

  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name); setError('');
    try { await work(); } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  const summarize = () => run('summarize', async () => {
    if (!last) return;
    const res = await api.post<{ summary?: string; error?: string }>(`/email/message/${encodeURIComponent(last.id)}/summarize?${mailboxQuery(provider, account)}`, {});
    if (res.error) throw new Error(res.error);
    setSummary(res.summary ?? '');
  });
  // An email that needs something from me becomes a to-do, linked to the thread.
  const toTask = () => run('task', async () => {
    if (!last) return;
    const res = await api.post<{ task?: { title: string }; error?: string }>(`/email/message/${encodeURIComponent(last.id)}/task?${mailboxQuery(provider, account)}`, {});
    if (res.error) throw new Error(res.error);
    onNotice(`Added to your to-do list: ${res.task?.title ?? last.subject}`);
  });
  const download = (message: EmailMessage, attachment: { id: string; name: string }) => run(`att:${attachment.id}`, async () => {
    const blob = await api.getBlob(`/email/message/${encodeURIComponent(message.id)}/attachment/${encodeURIComponent(attachment.id)}?${mailboxQuery(provider, account)}`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = attachment.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const triage = conversation.latest.triage;
  const blocked = !showImages && messages.some((m) => m.html && hasBlockedImages(m.html));
  const inTrash = folder === 'trash';

  return (
    <article aria-label={`Conversation: ${conversation.latest.subject}`} className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-outline-variant/40 px-3 py-2">
        <button onClick={onBack} aria-label="Back to the list" className={`${btnGhost} lg:hidden`}><ArrowLeft className="h-4 w-4" /></button>
        <button className={btn} disabled={!last} onClick={() => last && onCompose('reply', last)}><Reply className="h-4 w-4" /> Reply</button>
        <button className={btnGhost} aria-label="Reply all" title="Reply all" disabled={!last} onClick={() => last && onCompose('replyAll', last)}><ReplyAll className="h-4 w-4" /> <span className="hidden 2xl:inline">Reply all</span></button>
        <button className={btnGhost} aria-label="Forward" title="Forward" disabled={!last} onClick={() => last && onCompose('forward', last)}><Forward className="h-4 w-4" /> <span className="hidden 2xl:inline">Forward</span></button>
        <span className="mx-1 h-5 w-px bg-outline-variant/50" />
        {folder === 'archive' || inTrash
          ? <button className={btnGhost} onClick={() => onAction(ids, inTrash ? 'untrash' : 'unarchive')}>Move to inbox</button>
          : <button className={btnGhost} title="Archive (e)" aria-label="Archive" onClick={() => onAction(ids, 'archive')}><Archive className="h-4 w-4" /></button>}
        {!inTrash && <button className={btnGhost} title="Move to trash (#)" aria-label="Move to trash" onClick={() => onAction(ids, 'trash')}><Trash2 className="h-4 w-4" /></button>}
        <button className={btnGhost} title="Mark unread (u)" aria-label="Mark unread" onClick={() => { onAction(ids.slice(-1), 'unread'); onBack(); }}><MailOpen className="h-4 w-4" /></button>
        <button className={btnGhost} title="Star (s)" aria-label={conversation.starred ? 'Remove star' : 'Star'} aria-pressed={conversation.starred} onClick={() => onAction(ids.slice(-1), conversation.starred ? 'unstar' : 'star')}><Star className={`h-4 w-4 ${conversation.starred ? 'fill-warning text-warning' : ''}`} /></button>
        <span className="mx-1 h-5 w-px bg-outline-variant/50" />
        <button className={btnGhost} disabled={!last || busy === 'summarize'} onClick={summarize}>{busy === 'summarize' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-accent" />} Summarize</button>
        <button className={btnGhost} disabled={!last || busy === 'task'} onClick={toTask}>{busy === 'task' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListPlus className="h-4 w-4" />} To-do</button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <h2 className="text-lg font-semibold text-on-surface">{conversation.latest.subject || '(no subject)'}</h2>

        <TriageLine triage={triage} categories={categories} disabled={!last} onLabel={(label) => (last ? onLabel(last, label) : Promise.resolve())} />

        {(error || thread.error) && <p role="alert" className="rounded-md bg-error/10 px-3 py-2 text-sm text-error">{error || (thread.error as Error).message}</p>}
        {summary && (
          <div className="rounded-md border border-accent/30 bg-accent-container/40 p-3 text-sm text-on-surface whitespace-pre-wrap">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-accent">AI summary</p>
            {summary}
          </div>
        )}
        {blocked && (
          <p className="text-xs text-on-surface-variant">
            Images are not loaded, so the sender cannot see that you opened this mail.
            <button onClick={() => setShowImages(true)} className="ml-2 text-primary underline">Show images</button>
          </p>
        )}

        {thread.isLoading && (
          <div aria-hidden className="animate-pulse space-y-3 pt-2">
            <div className="h-4 w-48 rounded bg-surface-container-highest" />
            {[92, 80, 86, 60].map((w) => <div key={w} className="h-3 rounded bg-surface-container-high" style={{ width: `${w}%` }} />)}
          </div>
        )}

        {messages.map((message, index) => {
          const open = index === messages.length - 1 || expanded.has(message.id);
          return (
            <section key={message.id} aria-label={`Message from ${who(message.from)}`} className="rounded-lg border border-outline-variant/40 bg-surface">
              <button
                className="flex w-full items-baseline gap-2 px-3 py-2 text-left"
                aria-expanded={open}
                onClick={() => setExpanded((s) => { const next = new Set(s); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; })}
              >
                <span className="text-sm font-medium text-on-surface">{who(message.from)}</span>
                {open
                  ? <span className="min-w-0 flex-1 truncate text-xs text-on-surface-variant">{message.from.name ? `<${message.from.email}> ` : ''}to {addressList(message.to) || 'me'}{message.cc?.length ? `, cc ${addressList(message.cc)}` : ''}</span>
                  : <span className="min-w-0 flex-1 truncate text-xs text-on-surface-variant">{message.snippet}</span>}
                <time className="shrink-0 text-xs text-on-surface-variant" title={message.receivedAt ? new Date(message.receivedAt).toLocaleString() : ''}>{shortDate(message.receivedAt)}</time>
              </button>
              {open && (
                <div className="space-y-3 px-3 pb-3">
                  {message.html
                    ? <MailHtml html={message.html} showImages={showImages} title={`Message from ${who(message.from)}`} />
                    : <div className="whitespace-pre-wrap break-words text-sm text-on-surface">{message.body}</div>}
                  {!!message.attachments?.length && (
                    <ul aria-label="Attachments" className="flex flex-wrap gap-2">
                      {message.attachments.map((attachment) => (
                        <li key={attachment.id}>
                          <button className={btn} disabled={busy === `att:${attachment.id}`} onClick={() => download(message, attachment)} title={`Download ${attachment.name}`}>
                            {busy === `att:${attachment.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                            <span className="max-w-48 truncate">{attachment.name}</span>
                            <span className="text-xs text-on-surface-variant">{size(attachment.size)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </article>
  );
}

/** The triage of a mail, where the owner can see who decided and correct it in place. */
function TriageLine({ triage, categories, disabled, onLabel }: { triage?: EmailTriage; categories: string[]; disabled: boolean; onLabel: (label: { priority: EmailTriage['priority']; category: string }) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const save = async (label: { priority: EmailTriage['priority']; category: string }) => {
    setSaving(true);
    try { await onLabel(label); } finally { setSaving(false); }
  };
  const category = triage?.category ?? 'other';
  const options = categories.includes(category) ? categories : [category, ...categories];
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
      <span>Triage</span>
      <div role="group" aria-label="Priority" className="inline-flex overflow-hidden rounded-full border border-outline-variant/60">
        {(['high', 'normal', 'low'] as const).map((p) => (
          <button key={p} disabled={disabled || saving} aria-pressed={triage?.priority === p} onClick={() => save({ priority: p, category })} className={`px-2.5 py-0.5 ${triage?.priority === p ? priorityTone[p] + ' font-medium' : 'hover:bg-surface-container-high'}`}>{p}</button>
        ))}
      </div>
      <select aria-label="Category" disabled={disabled || saving} value={triage ? category : ''} onChange={(e) => save({ priority: triage?.priority ?? 'normal', category: e.target.value })} className="rounded-full border border-outline-variant/60 bg-surface px-2 py-0.5 text-xs text-on-surface">
        {!triage && <option value="">no category</option>}
        {options.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {triage?.source && <span>· {sourceLabel[triage.source]}</span>}
      {triage?.reason && <span className="min-w-0 truncate" title={triage.reason}>· {triage.reason}</span>}
      {!triage && <span>· not triaged yet; pick a priority to label it yourself</span>}
    </div>
  );
}
