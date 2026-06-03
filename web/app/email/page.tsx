'use client';

import { Archive, FileText, Loader2, Mail, RefreshCw, Send, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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
interface EmailMessage extends InboxItem { body: string; to?: Addr[] }
interface Draft { to: string; subject: string; body: string }

const priorityBadge: Record<string, string> = {
  high: 'bg-error/10 text-error',
  normal: 'bg-surface-container-high text-on-surface-variant',
  low: 'bg-surface-container-high text-on-surface-variant/60',
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

  const loadInbox = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ provider: string | null; items: InboxItem[]; error?: string }>('/email/inbox');
      if (res.error) setError(res.error);
      else { setProvider(res.provider); setItems(res.items || []); setError(''); }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load inbox once on mount
    loadInbox();
  }, [loadInbox]);

  const open = async (id: string) => {
    setOpenMsg(null); setSummary(''); setDraft(null); setBusy('open');
    try {
      const msg = await api.get<EmailMessage & { error?: string }>(`/email/message/${id}`);
      if (msg.error) setError(msg.error);
      else setOpenMsg(msg);
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

  const makeDraft = async () => {
    if (!openMsg) return;
    setBusy('draft');
    try {
      const res = await api.post<Draft & { error?: string }>(`/email/message/${openMsg.id}/draft`, {});
      if (res.error) setError(res.error);
      else setDraft({ to: res.to, subject: res.subject, body: res.body });
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
    setTriaging(true);
    try {
      const res = await api.post<{ triage?: Record<string, Triage>; error?: string }>('/email/triage', {});
      if (res.triage) {
        setItems((xs) => xs.map((x) => (res.triage![x.id] ? { ...x, triage: res.triage![x.id] } : x)));
      } else if (res.error) setError(res.error);
    } finally { setTriaging(false); }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-20"><RefreshCw className="w-6 h-6 animate-spin text-on-surface-variant" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xs bg-primary/10 flex items-center justify-center"><Mail className="w-5 h-5 text-primary" /></div>
          <div>
            <h1 className="text-4xl lg:text-5xl font-extrabold tracking-tighter text-on-surface">Email</h1>
            <p className="text-on-surface-variant">Triage assistant — read, summarize, draft replies, archive. Sends always ask first.</p>
          </div>
        </div>
        {provider && (
          <button onClick={triage} disabled={triaging} className="px-3 py-2 text-sm border border-outline-variant/20 rounded-full hover:bg-surface-container-high inline-flex items-center gap-1.5 text-on-surface disabled:opacity-50">
            {triaging ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-primary" />} Triage inbox
          </button>
        )}
      </div>

      {error && <div className="bg-error/10 border border-error/20 rounded-xs px-4 py-3 text-error text-sm">{error}<button onClick={() => setError('')} className="ml-2 underline">dismiss</button></div>}

      {!provider ? (
        <div className="text-center py-12 text-on-surface-variant">
          <Mail className="w-10 h-10 mx-auto mb-3 text-outline-variant" />
          <p>No mailbox connected.</p>
          <p className="text-sm mt-1">Connect Google or Microsoft 365 in <a href="/settings" className="text-primary hover:underline">Settings → Integrations</a>.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[24rem_1fr] gap-4 items-start">
          {/* Inbox list */}
          <div className="space-y-1">
            {items.length === 0 && <p className="text-sm text-on-surface-variant">Inbox empty.</p>}
            {items.map((it) => (
              <button
                key={it.id}
                onClick={() => open(it.id)}
                className={`w-full text-left px-3 py-2.5 rounded-xs border ${openMsg?.id === it.id ? 'border-primary/40 bg-primary-container/20' : 'border-outline-variant/10 bg-surface hover:bg-surface-container-low'}`}
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
                  <ActionBtn onClick={makeDraft} busy={busy === 'draft'} icon={FileText}>Draft reply</ActionBtn>
                  <ActionBtn onClick={archive} busy={busy === 'archive'} icon={Archive}>Archive</ActionBtn>
                </div>

                {summary && <div className="text-sm bg-surface-container-low rounded-xs p-3 text-on-surface whitespace-pre-wrap">{summary}</div>}

                <div className="text-sm text-on-surface whitespace-pre-wrap max-h-72 overflow-y-auto border-t border-outline-variant/10 pt-3">{openMsg.body}</div>

                {draft && (
                  <div className="space-y-2 border-t border-outline-variant/10 pt-3">
                    <p className="text-xs uppercase tracking-wide text-on-surface-variant">Draft reply to {draft.to}</p>
                    <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} className="w-full rounded-xs border border-outline-variant/20 bg-surface px-2 py-1.5 text-sm text-on-surface" />
                    <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={6} className="w-full rounded-xs border border-outline-variant/20 bg-surface px-2 py-1.5 text-sm text-on-surface resize-y" />
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
