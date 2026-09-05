'use client';

import { Archive, FileText, ListPlus, Loader2, Mail, RefreshCw, Send, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';

interface Addr { name?: string; email: string }
interface Triage { priority: 'high' | 'normal' | 'low'; category?: string; reason?: string }
interface InboxItem {
  id: string;
  provider: string;
  from: Addr;
  subject: string;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  triage?: Triage;
}
interface EmailMessage extends InboxItem { body: string; html?: string; to?: Addr[] }
interface Draft { to: string; subject: string; body: string }

const priorityBadge: Record<string, string> = {
  high: 'bg-error/10 text-error',
  normal: 'bg-surface-container-high text-on-surface-variant',
  low: 'bg-surface-container-high text-on-surface-variant/60',
};

/** Triage priority rail — 3px left border, same idiom as the mobile inbox. */
const priorityRail: Record<string, string> = {
  high: 'border-l-error',
  normal: 'border-l-transparent',
  low: 'border-l-outline-variant',
};

export default function EmailPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openMsg, setOpenMsg] = useState<EmailMessage | null>(null);
  const [busy, setBusy] = useState('');
  const [summary, setSummary] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState('');
  // Reply-options flow: the model proposes directions, the user picks one,
  // THEN a draft is generated — instead of the model assuming a stance.
  const [replyOpts, setReplyOpts] = useState<string[] | null>(null);
  // Inbox filter (client-side over the loaded page): all / unread / by priority.
  const [filter, setFilter] = useState<'all' | 'unread' | 'high' | 'normal' | 'low'>('all');

  const loadInbox = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ provider: string | null; items: InboxItem[]; nextPageToken?: string; error?: string }>('/email/inbox');
      if (res.error) setError(res.error);
      else { setProvider(res.provider); setItems(res.items || []); setNextPageToken(res.nextPageToken); setError(''); }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = async () => {
    if (!nextPageToken) return;
    setLoadingMore(true);
    try {
      const res = await api.get<{ items: InboxItem[]; nextPageToken?: string; error?: string }>(
        `/email/inbox?pageToken=${encodeURIComponent(nextPageToken)}`,
      );
      if (res.error) setError(res.error);
      else {
        // Dedupe — provider pages can overlap.
        setItems((xs) => {
          const seen = new Set(xs.map((x) => x.id));
          return [...xs, ...(res.items || []).filter((x) => !seen.has(x.id))];
        });
        setNextPageToken(res.nextPageToken);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load inbox once on mount
    loadInbox();
  }, [loadInbox]);

  const open = async (id: string) => {
    setOpenMsg(null); setSummary(''); setDraft(null); setReplyOpts(null); setBusy('open');
    try {
      const msg = await api.get<EmailMessage & { error?: string }>(`/email/message/${id}`);
      if (msg.error) { setError(msg.error); return; }
      setOpenMsg(msg);
      // Mark read on open: clear the unread flag locally + in the provider.
      if (msg.unread) {
        setItems((xs) => xs.map((x) => (x.id === id ? { ...x, unread: false } : x)));
        api.post(`/email/message/${id}/mark-read`, {}).catch(() => {
          // Revert the optimistic flag if the provider call fails.
          setItems((xs) => xs.map((x) => (x.id === id ? { ...x, unread: true } : x)));
        });
      }
    } finally {
      setBusy('');
    }
  };

  const summarize = async () => {
    if (!openMsg) return;
    setBusy('summarize'); setSummary('');
    try {
      const res = await api.post<{ summary?: string; error?: string }>(`/email/message/${openMsg.id}/summarize`, {});
      setSummary(res.summary || res.error || '');
    } finally { setBusy(''); }
  };

  // Step 1: ask the model for reply directions; the user picks one next.
  const fetchReplyOptions = async () => {
    if (!openMsg) return;
    setBusy('options'); setReplyOpts(null); setDraft(null);
    try {
      const res = await api.post<{ options?: string[]; error?: string }>(`/email/message/${openMsg.id}/reply-options`, {});
      if (res.error) setError(res.error);
      else setReplyOpts(res.options && res.options.length > 0 ? res.options : ['Write a reply']);
    } finally { setBusy(''); }
  };

  // Step 2: draft a reply in the direction the user chose.
  const draftWith = async (instruction: string) => {
    if (!openMsg) return;
    setBusy('draft');
    try {
      const res = await api.post<Draft & { error?: string }>(`/email/message/${openMsg.id}/draft`, { instruction });
      if (res.error) setError(res.error);
      else { setDraft({ to: res.to, subject: res.subject, body: res.body }); setReplyOpts(null); }
    } finally { setBusy(''); }
  };

  // An email that needs something from me becomes a to-do, linked to the thread.
  const toTask = async () => {
    if (!openMsg) return;
    setBusy('task');
    try {
      const res = await api.post<{ task?: { id: string; title: string }; error?: string }>(`/email/message/${openMsg.id}/task`, {});
      if (res.error) setError(res.error);
      else setSummary(`Added to your to-do list: ${res.task?.title ?? openMsg.subject}`);
    } finally { setBusy(''); }
  };

  const archive = async () => {
    if (!openMsg) return;
    setBusy('archive');
    try {
      await api.post(`/email/message/${openMsg.id}/archive`, {});
      setItems((xs) => xs.filter((x) => x.id !== openMsg.id));
      setOpenMsg(null);
    } finally { setBusy(''); }
  };

  const send = async () => {
    if (!draft) return;
    if (!confirm(`Send this reply to ${draft.to}?`)) return;
    setBusy('send');
    try {
      const res = await api.post<{ sent?: boolean; error?: string }>('/email/send', { ...draft, confirm: true });
      if (res.error) setError(res.error);
      else { setDraft(null); setSummary('Reply sent.'); }
    } finally { setBusy(''); }
  };

  const triage = async () => {
    setTriaging(true); setNotice('');
    try {
      const res = await api.post<{ triage?: Record<string, Triage>; error?: string }>('/email/triage', {});
      if (res.triage) {
        const t = res.triage;
        setItems((xs) => xs.map((x) => (t[x.id] ? { ...x, triage: t[x.id] } : x)));
        const counts = Object.values(t).reduce(
          (acc, v) => { acc[v.priority] = (acc[v.priority] ?? 0) + 1; return acc; },
          {} as Record<string, number>,
        );
        setNotice(`Triaged ${Object.keys(t).length}: ${counts.high ?? 0} high · ${counts.normal ?? 0} normal · ${counts.low ?? 0} low.`);
      } else if (res.error) setError(res.error);
    } finally { setTriaging(false); }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-20"><RefreshCw className="w-6 h-6 animate-spin text-on-surface-variant" /></div>;
  }

  const unreadCount = items.filter((it) => it.unread).length;
  const visibleItems = items.filter((it) => {
    if (filter === 'all') return true;
    if (filter === 'unread') return it.unread;
    return it.triage?.priority === filter;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="email"
        description="triage assistant — read, summarize, draft replies, archive. sends always ask first"
        actions={provider ? (
          <button
            onClick={triage}
            disabled={triaging}
            title="Use AI to sort the inbox into high / normal / low priority. Reads only sender, subject and snippet — never full bodies."
            className="px-3 py-2 text-sm border border-outline-variant/20 rounded-full hover:bg-surface-container-high inline-flex items-center gap-1.5 text-on-surface disabled:opacity-50"
          >
            {triaging ? <Loader2 className="w-4 h-4 animate-spin text-accent" /> : <Sparkles className="w-4 h-4 text-accent" />} Triage inbox
          </button>
        ) : undefined}
      />

      {error && <div className="bg-error/10 border border-error/20 rounded-xs px-4 py-3 text-error text-sm">{error}<button onClick={() => setError('')} className="ml-2 underline">dismiss</button></div>}
      {notice && <div className="bg-primary/10 border border-primary/20 rounded-xs px-4 py-2 text-primary text-sm">{notice}<button onClick={() => setNotice('')} className="ml-2 underline">dismiss</button></div>}

      {!provider ? (
        <div className="text-center py-12 text-on-surface-variant">
          <Mail className="w-10 h-10 mx-auto mb-3 text-outline-variant" />
          <p>No mailbox connected.</p>
          <p className="text-sm mt-1">Connect Google or Microsoft 365 in <a href="/settings" className="text-primary hover:underline">Settings → Integrations</a>.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[24rem_1fr] gap-4 items-start">
          {/* Inbox list */}
          <div className="space-y-1 stagger">
            {/* Filter bar — counts reflect the loaded page; "Load more" pulls the rest. */}
            <div className="flex flex-wrap gap-1.5 pb-2">
              {([
                ['all', `All ${items.length}`],
                ['unread', `Unread ${unreadCount}`],
                ['high', 'High'],
                ['normal', 'Normal'],
                ['low', 'Low'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    filter === key
                      ? 'border-primary/40 bg-primary-container/30 text-on-surface'
                      : 'border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-high'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {items.length === 0 && (
              <div className="py-10 text-center font-mono">
                <p aria-hidden className="text-2xl text-on-surface-variant/40">@</p>
                <p className="mt-2 text-sm text-on-surface-variant">inbox empty</p>
              </div>
            )}
            {items.length > 0 && visibleItems.length === 0 && (
              <p className="text-sm text-on-surface-variant">No messages match this filter.</p>
            )}
            {visibleItems.map((it) => (
              <button
                key={it.id}
                onClick={() => open(it.id)}
                className={`w-full text-left px-3 py-2.5 rounded-xs border border-l-[3px] ${priorityRail[it.triage?.priority ?? 'normal'] ?? 'border-l-transparent'} ${openMsg?.id === it.id ? 'border-primary/40 bg-primary-container/20' : 'border-outline-variant/10 bg-surface hover:bg-surface-container-low'}`}
              >
                <div className="flex items-center gap-2">
                  {it.unread && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />}
                  <span className={`text-sm truncate flex-1 ${it.unread ? 'font-semibold text-on-surface' : 'text-on-surface-variant'}`}>{it.from.name || it.from.email}</span>
                  {it.triage && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${priorityBadge[it.triage.priority]}`}>{it.triage.priority}</span>}
                </div>
                <div className="text-sm text-on-surface truncate">{it.subject}</div>
                <div className="text-xs text-on-surface-variant/70 truncate">{it.snippet}</div>
              </button>
            ))}
            {nextPageToken && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="w-full text-sm text-on-surface-variant hover:text-on-surface py-2 inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Load more
              </button>
            )}
          </div>

          {/* Read pane */}
          <div className="lg:sticky lg:top-4">
            {!openMsg ? (
              <div className="text-sm text-on-surface-variant/70 px-3 py-8 text-center border border-dashed border-outline-variant/20 rounded-xs">
                {busy === 'open' ? 'Loading…' : 'Select a message to read.'}
              </div>
            ) : (
              <div className="space-y-3 rounded-xs border border-outline-variant/10 bg-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="font-semibold text-on-surface">{openMsg.subject}</h2>
                    <p className="text-sm text-on-surface-variant">{openMsg.from.name || openMsg.from.email} · {new Date(openMsg.receivedAt).toLocaleString()}</p>
                  </div>
                  <button onClick={() => setOpenMsg(null)} className="text-on-surface-variant hover:text-error shrink-0"><X className="w-4 h-4" /></button>
                </div>

                <div className="flex flex-wrap gap-2">
                  <ActionBtn onClick={summarize} busy={busy === 'summarize'} icon={Sparkles}>Summarize</ActionBtn>
                  <ActionBtn onClick={fetchReplyOptions} busy={busy === 'options' || busy === 'draft'} icon={FileText}>Draft reply</ActionBtn>
                  <ActionBtn onClick={toTask} busy={busy === 'task'} icon={ListPlus}>To-do</ActionBtn>
                  <ActionBtn onClick={archive} busy={busy === 'archive'} icon={Archive}>Archive</ActionBtn>
                </div>

                {summary && (
                  <div className="text-sm border border-accent/30 bg-accent-container/30 rounded-xs p-3 text-on-surface whitespace-pre-wrap">
                    <p className="text-[10px] uppercase tracking-widest font-semibold text-accent mb-1.5">ai summary</p>
                    {summary}
                  </div>
                )}

                {/* Email body — render sanitized HTML when present (most mail is
                    HTML); fall back to plain text. The body is the important
                    part, so give it at least half the viewport. */}
                {openMsg.html ? (
                  <div
                    className="email-html text-sm text-on-surface min-h-[40vh] max-h-[60vh] overflow-y-auto border-t border-outline-variant/10 pt-3 [&_a]:text-primary [&_a]:underline [&_img]:max-w-full"
                    // Sanitized server-side via the shared allowlist sanitizer
                    // (src/core/html/sanitize.ts) — no scripts/handlers/unsafe URLs survive.
                    dangerouslySetInnerHTML={{ __html: openMsg.html }}
                  />
                ) : (
                  <div className="text-sm text-on-surface whitespace-pre-wrap min-h-[40vh] max-h-[60vh] overflow-y-auto border-t border-outline-variant/10 pt-3">{openMsg.body}</div>
                )}

                {/* Reply directions — the user chooses before a draft is written. */}
                {replyOpts && (
                  <div className="space-y-2 border-t border-outline-variant/10 pt-3">
                    <p className="text-xs uppercase tracking-wide text-accent">How do you want to reply?</p>
                    <div className="flex flex-wrap gap-2">
                      {replyOpts.map((opt) => (
                        <button
                          key={opt}
                          onClick={() => draftWith(opt)}
                          disabled={busy === 'draft'}
                          className="px-2.5 py-1.5 text-sm border border-primary/30 rounded-full hover:bg-primary-container/20 text-on-surface disabled:opacity-50"
                        >
                          {opt}
                        </button>
                      ))}
                      <button onClick={() => setReplyOpts(null)} className="px-2 py-1.5 text-sm text-on-surface-variant hover:text-on-surface">Cancel</button>
                    </div>
                  </div>
                )}

                {draft && (
                  <div className="space-y-2 border-t border-outline-variant/10 pt-3">
                    <p className="text-xs uppercase tracking-wide text-accent">Draft reply to {draft.to}</p>
                    <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} className="w-full rounded-xs border border-accent/30 bg-surface px-2 py-1.5 text-sm text-on-surface" />
                    <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={6} className="w-full rounded-xs border border-accent/30 bg-surface px-2 py-1.5 text-sm text-on-surface resize-y" />
                    <div className="flex gap-2">
                      <button onClick={send} disabled={busy === 'send'} className="px-3 py-1.5 text-sm bg-linear-to-r from-primary to-primary-container text-on-primary rounded-full hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1.5">
                        <Send className="w-3.5 h-3.5" /> Send
                      </button>
                      <button onClick={() => setDraft(null)} className="px-3 py-1.5 text-sm text-on-surface-variant hover:text-on-surface">Discard</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ActionBtn({ onClick, busy, icon: Icon, children }: { onClick: () => void; busy: boolean; icon: typeof Mail; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={busy} className="px-2.5 py-1.5 text-sm border border-outline-variant/20 rounded-xs hover:bg-surface-container-high disabled:opacity-50 inline-flex items-center gap-1.5 text-on-surface">
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />} {children}
    </button>
  );
}
