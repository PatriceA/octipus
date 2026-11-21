'use client';

import { type InfiniteData, keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ChevronDown, FileText, Inbox, Loader2, Mail, MailOpen, Paperclip, PenSquare, RefreshCw, Search, Send, Settings2, Sparkles, Star, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useModuleOn } from '@/lib/modules';
import { useWorkspace, useWorkspaceId } from '@/lib/workspace-context';
import type { EmailAccountsResponse, EmailBatchAction, EmailBatchResponse, EmailListResponse } from '../../../src/shared/email';
import type { MailAccountView } from '../../../src/shared/mail';
import { type ComposeDraft, type ComposeMode, composeFor, EmailCompose } from './email-compose';
import { EmailReader } from './email-reader';
import { btn, btnGhost, btnPrimary, type Conversation, conversations, type EmailFolder, type EmailMessage, type EmailProvider, type EmailTriage, field, type InboxItem, ListSkeleton, type Mailbox, mailboxesOf, mailboxKeyOf, mailboxQuery, priorityTone, providerLabel, shortDate, triageWhy, who } from './email-shared';
import { MailboxInbox } from './mailbox-inbox';
import { MailboxManager, mailAccountsKey } from './mailbox-manager';
import { rowsInScope, startTriage, TriageDialog, type TriageRun, type TriageSettings } from './triage-dialog';

const FOLDERS: Array<{ id: EmailFolder; label: string; icon: typeof Inbox }> = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'drafts', label: 'Drafts', icon: FileText },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'trash', label: 'Trash', icon: Trash2 },
];
/** What undoes a move, for the notice's Undo. */
const INVERSE: Partial<Record<EmailBatchAction, EmailBatchAction>> = { archive: 'unarchive', trash: 'untrash', unarchive: 'archive', untrash: 'trash' };
const MOVED_TEXT: Partial<Record<EmailBatchAction, string>> = { archive: 'archived', trash: 'moved to trash', unarchive: 'moved to the inbox', untrash: 'moved to the inbox' };

type ListData = InfiniteData<EmailListResponse, string | undefined>;
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function EmailClient() {
  const { activeWorkspace, isLoading } = useWorkspace();
  const workspace = useWorkspaceId();
  if (!isLoading && activeWorkspace?.kind === 'remote') return <p className="p-6 text-on-surface-variant">Mailboxes on another install are not available here. Select a local workspace to read mail.</p>;
  // The frame renders at once; the lists inside it show placeholders until their data arrives.
  return <Client key={workspace ?? 'personal'} />;
}

function Client() {
  const workspace = useWorkspaceId();
  const client = useQueryClient();
  const mailOn = useModuleOn('mail');
  const accounts = useQuery({ queryKey: ['email-accounts'], queryFn: () => api.get<EmailAccountsResponse>('/email/accounts'), staleTime: 5 * 60_000 });
  const imap = useQuery({ queryKey: mailAccountsKey(workspace), enabled: mailOn, queryFn: () => api.get<MailAccountView[]>('/mail/accounts') });
  const [picked, setPicked] = useState('');
  const [manage, setManage] = useState(false);
  // One entry per connected account: two Gmail accounts are two mailboxes.
  const oauth = useMemo(() => mailboxesOf(accounts.data?.accounts ?? []), [accounts.data]);
  const selection = picked || oauth[0]?.key || imap.data?.[0]?.id || '';
  // "All inboxes" reads every connected Google / Microsoft account as one list.
  const all = selection === 'all' && oauth.length > 1;
  const mailbox: Mailbox | undefined = all ? undefined : oauth.find((m) => m.key === selection);
  const provider: EmailProvider | null = all ? oauth[0].provider : mailbox?.provider ?? null;
  /** The account of the chosen mailbox, when it is not its provider's default. */
  const account = mailbox?.account;
  const boxes = useMemo<Mailbox[]>(() => (all ? oauth : mailbox ? [mailbox] : []), [all, oauth, mailbox]);
  const scope = all ? 'all' : mailbox?.key ?? null;
  const imapAccount = imap.data?.find((a) => a.id === selection);
  /** The address of the mailbox a message is in (left out of reply-all recipients). */
  const addressOf = (m: { provider: EmailProvider; account?: string }) => oauth.find((b) => b.key === mailboxKeyOf(m))?.address;
  /** Which account a row is in, shown in "All inboxes" when that is not obvious. */
  const sameProviderTwice = new Set(oauth.map((m) => m.provider)).size < oauth.length;
  const settled = !accounts.isLoading && (!mailOn || !imap.isLoading);

  const [folder, setFolder] = useState<EmailFolder>('inbox');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [notice, setNotice] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const [error, setError] = useState('');
  const [triageOpen, setTriageOpen] = useState(false);
  const [run, setRun] = useState<TriageRun | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fresh = useRef(false);
  const [composeFrom, setComposeFrom] = useState<Mailbox | null>(null);

  const listKey = useMemo(() => ['email-list', scope, folder, q, filter === 'unread'] as const, [scope, folder, q, filter]);
  const list = useInfiniteQuery({
    queryKey: listKey,
    enabled: !!provider,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<EmailListResponse> => {
      // One page per mailbox. With several, the page token carries each mailbox's own token.
      const tokens: Record<string, string> = !pageParam ? {} : all ? JSON.parse(pageParam) : { [mailbox!.key]: pageParam };
      const pages = await Promise.all(boxes.filter((m) => !pageParam || tokens[m.key]).map(async (m) => {
        const params = new URLSearchParams({ folder, provider: m.provider, limit: '30' });
        if (m.account) params.set('account', m.account);
        if (q) params.set('q', q);
        if (filter === 'unread') params.set('unread', 'true');
        if (tokens[m.key]) params.set('pageToken', tokens[m.key]);
        // Refresh asks the provider, past the server's short memory of this page.
        if (fresh.current) params.set('refresh', 'true');
        const res = await api.get<EmailListResponse & { error?: string }>(`/email/messages?${params}`);
        if (res.error) throw new Error(res.error);
        // Each row names its account, so an action on it goes to the account it is in.
        return [m.key, { ...res, items: res.items.map((it) => (m.account ? { ...it, account: m.account } : it)) }] as const;
      }));
      if (!all) return pages[0][1];
      const next = Object.fromEntries(pages.filter(([, res]) => res.nextPageToken).map(([p, res]) => [p, res.nextPageToken]));
      const counts = pages.map(([, res]) => res.unreadCount).filter((n): n is number => typeof n === 'number');
      return {
        provider: provider!,
        items: pages.flatMap(([, res]) => res.items).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
        ...(Object.keys(next).length ? { nextPageToken: JSON.stringify(next) } : {}),
        ...(counts.length ? { unreadCount: counts.reduce((sum, n) => sum + n, 0) } : {}),
      };
    },
    getNextPageParam: (last) => last.nextPageToken,
    // The last list stays on screen while the next one loads.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    // New mail shows up without a reload; only while the plain inbox is open.
    refetchInterval: folder === 'inbox' && !q ? 60_000 : false,
    maxPages: 10,
  });
  const categoriesQuery = useQuery({ queryKey: ['email-categories'], enabled: !!provider, queryFn: () => api.get<{ categories: Record<string, string> }>('/email/categories'), staleTime: 5 * 60_000 });
  const categories = useMemo(() => Object.keys(categoriesQuery.data?.categories ?? {}), [categoriesQuery.data]);
  const settings = useQuery({ queryKey: ['email-triage-settings'], enabled: !!provider, queryFn: () => api.get<{ settings: TriageSettings; saved: boolean }>('/email/triage/settings') });

  const items = useMemo(() => {
    const seen = new Set<string>();
    return (list.data?.pages ?? []).flatMap((p) => p.items).filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  }, [list.data]);
  const visible = useMemo(() => {
    const rows = conversations(items);
    if (filter === 'all' || filter === 'unread') return rows;
    if (filter.startsWith('cat:')) return rows.filter((c) => c.latest.triage?.category === filter.slice(4));
    return rows.filter((c) => c.latest.triage?.priority === filter);
  }, [items, filter]);
  const categoryCounts = useMemo(() => items.reduce<Record<string, number>>((acc, it) => {
    if (it.triage?.category) acc[it.triage.category] = (acc[it.triage.category] ?? 0) + 1;
    return acc;
  }, {}), [items]);
  const open = visible.find((c) => c.key === openKey) ?? (openKey ? conversations(items).find((c) => c.key === openKey) : undefined);
  const unreadCount = folder === 'inbox' ? list.data?.pages[0]?.unreadCount : undefined;

  const patchLists = useCallback((change: (items: InboxItem[]) => InboxItem[]) => {
    client.setQueriesData<ListData>({ queryKey: ['email-list', scope] }, (data) => (data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: change(p.items) })) } : data));
  }, [client, scope]);

  /** One mailbox action on some messages: shown at once, then sent; a failure reloads the truth. */
  const apply = useCallback(async (ids: string[], action: EmailBatchAction): Promise<boolean> => {
    if (!provider || ids.length === 0) return false;
    const hit = new Set(ids);
    const moves = action in MOVED_TEXT;
    if (moves) {
      patchLists((rows) => rows.filter((it) => !hit.has(it.id)));
      setChecked(new Set());
      setOpenKey((key) => (key && conversations(items).find((c) => c.key === key)?.ids.some((id) => hit.has(id)) ? null : key));
    } else if (action === 'read' || action === 'unread') patchLists((rows) => rows.map((it) => (hit.has(it.id) ? { ...it, unread: action === 'unread' } : it)));
    else patchLists((rows) => rows.map((it) => (hit.has(it.id) ? { ...it, starred: action === 'star' } : it)));
    try {
      // Each message is changed in the mailbox (the account) it lives in.
      const owner = new Map(items.map((it) => [it.id, mailboxKeyOf(it)]));
      let failed = 0;
      for (const m of boxes) {
        const own = ids.filter((id) => (owner.get(id) ?? boxes[0]?.key) === m.key);
        if (!own.length) continue;
        const res = await api.post<EmailBatchResponse & { error?: string }>('/email/messages/batch', { ids: own, action, provider: m.provider, ...(m.account ? { account: m.account } : {}) });
        if (res.error) throw new Error(res.error);
        failed += res.failed?.length ?? 0;
      }
      if (failed) throw new Error(`${failed} of ${ids.length} could not be changed.`);
      // Other folders now hold these messages: they reload when next shown.
      if (moves) void client.invalidateQueries({ queryKey: ['email-list', scope], refetchType: 'none' });
      return true;
    } catch (err) {
      setError((err as Error).message);
      void client.invalidateQueries({ queryKey: ['email-list', scope] });
      return false;
    }
  }, [provider, boxes, scope, patchLists, items, client]);

  /** `apply`, and for a move a notice that can undo it. */
  const act = useCallback(async (ids: string[], action: EmailBatchAction, quiet = false) => {
    const ok = await apply(ids, action);
    if (!ok || quiet || !(action in MOVED_TEXT)) return;
    const inverse = INVERSE[action];
    const undo = inverse ? { action: { label: 'Undo', run: () => { setNotice(null); void apply(ids, inverse).then(() => client.invalidateQueries({ queryKey: ['email-list', scope] })); } } } : {};
    setNotice({ text: `${ids.length === 1 ? 'Conversation' : `${ids.length} messages`} ${MOVED_TEXT[action]}.`, ...undo });
  }, [apply, client, scope]);

  const label = async (message: EmailMessage, value: { priority: EmailTriage['priority']; category: string }) => {
    try {
      await api.put(`/email/triage/label/${encodeURIComponent(message.id)}?${mailboxQuery(message.provider, message.account)}`, { ...value, item: { from: message.from, subject: message.subject, snippet: message.snippet } });
      const ids = new Set(open?.ids ?? [message.id]);
      patchLists((rows) => rows.map((it) => (ids.has(it.id) ? { ...it, triage: { ...value, source: 'owner' } } : it)));
    } catch (err) { setError((err as Error).message); }
  };

  // A run in flight is followed until it ends, with the window open or not.
  const running = !!run && !run.finished;
  useEffect(() => {
    if (!provider) return;
    let stop = false;
    api.get<{ run: TriageRun | null }>('/email/triage/run').then((res) => { if (!stop && res.run && !res.run.finished) setRun(res.run); }).catch(() => {});
    return () => { stop = true; };
  }, [provider]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      api.get<{ run: TriageRun | null }>('/email/triage/run').then((res) => { if (res.run) setRun(res.run); }).catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [running]);
  const applied = useRef('');
  useEffect(() => {
    if (!run?.finished || applied.current === run.id) return;
    applied.current = run.id;
    const result = run.result;
    if (result) {
      const gone = new Set(result.archived);
      patchLists((rows) => rows.filter((it) => !gone.has(it.id)).map((it) => (result.triage[it.id] ? { ...it, triage: result.triage[it.id] } : it)));
    }
    // With the window closed the result waits behind a notice instead of opening over other work.
    const count = Object.keys(result?.triage ?? {}).length;
    setNotice({ text: run.error ? 'Triage failed.' : run.cancelled ? 'Triage was cancelled.' : `Triage finished: ${count} ${count === 1 ? 'mail' : 'mails'}.`, action: { label: 'Show result', run: () => { setTriageOpen(true); setNotice(null); } } });
  }, [run, patchLists]);

  const triageNow = async () => {
    const s = settings.data?.settings;
    if (!s?.skipDialog || run?.finished) { setTriageOpen(true); return; }
    try { setRun(await startTriage(provider!, rowsInScope(items, s.scope), s.scope, undefined, account)); }
    catch (err) { setError((err as Error).message); }
  };
  const triageSummary = (() => {
    const s = settings.data?.settings;
    if (!s) return 'Sort the inbox by priority and category';
    return `${{ untriaged: 'Mail not triaged yet', unread: 'Unread mail', all: 'All loaded mail' }[s.scope]} · labels ${s.applyLabels ? 'on' : 'off'} · archive ${s.autoArchive ? 'automatic' : 'asks first'}${s.instructions ? ' · your instructions' : ''}`;
  })();

  const openConversation = (c: Conversation) => { setOpenKey(c.key); };
  const step = useCallback((by: number) => {
    const index = visible.findIndex((c) => c.key === openKey);
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + by))];
    if (next) setOpenKey(next.key);
  }, [visible, openKey]);

  useEffect(() => {
    if (!provider) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || triageOpen) return;
      const current = visible.find((c) => c.key === openKey);
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'c') { e.preventDefault(); setCompose(composeFor('new')); }
      else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Escape') { if (compose) return; setOpenKey(null); }
      else if (!current) return;
      else if (e.key === 'e') void act(current.ids, 'archive');
      else if (e.key === '#') void act(current.ids, 'trash');
      else if (e.key === 'u') { void act(current.ids.slice(0, 1), 'unread'); setOpenKey(null); }
      else if (e.key === 's') void act(current.ids.slice(0, 1), current.starred ? 'unstar' : 'star');
      else if (e.key === 'x') setChecked((s) => { const next = new Set(s); if (next.has(current.key)) next.delete(current.key); else next.add(current.key); return next; });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [provider, visible, openKey, step, act, compose, triageOpen]);

  const changeFolder = (next: EmailFolder) => { setFolder(next); setOpenKey(null); setChecked(new Set()); setFilter('all'); };
  const checkedIds = visible.filter((c) => checked.has(c.key)).flatMap((c) => c.ids);
  const filters: Array<[string, string]> = [['all', 'All'], ['unread', 'Unread']];
  const priorityFilter = ['high', 'normal', 'low'].includes(filter) ? filter : '';

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background font-sans">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant/50 bg-surface px-3 py-2">
        <h1 className="mr-1 text-base font-semibold text-on-surface">Email</h1>
        <select aria-label="Mailbox" value={selection} onChange={(e) => { setPicked(e.target.value); setOpenKey(null); setChecked(new Set()); setManage(false); }} className={`${field} w-auto max-w-56`}>
          {!selection && <option value="">{settled ? 'No mailbox connected' : 'Loading mailboxes…'}</option>}
          {oauth.length > 1 && <option value="all">All inboxes</option>}
          {oauth.map((m) => <option key={m.key} value={m.key}>{providerLabel(m.provider)}{m.address ? ` — ${m.address}` : ''}</option>)}
          {imap.data?.map((a) => <option key={a.id} value={a.id}>{a.label} — {a.address}</option>)}
        </select>
        {provider && (
          <form role="search" className="relative min-w-40 flex-1" onSubmit={(e) => { e.preventDefault(); setQ(search.trim()); setOpenKey(null); }}>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant" />
            <input ref={searchRef} aria-label="Search mail" placeholder="Search mail" value={search} onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setQ(''); }} className={`${field} pl-8 pr-8`} />
            {search && <button type="button" aria-label="Clear search" onClick={() => { setSearch(''); setQ(''); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-on-surface-variant hover:text-on-surface"><X className="h-3.5 w-3.5" /></button>}
          </form>
        )}
        {!provider && <span className="flex-1" />}
        {provider && <button className={btnPrimary} onClick={() => setCompose(composeFor('new'))}><PenSquare className="h-4 w-4" /> Compose</button>}
        {provider && !all && folder === 'inbox' && (
          <div className="inline-flex">
            <button className={`${btn} rounded-r-none`} onClick={triageNow} title={triageSummary}>
              {running ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : <Sparkles className="h-4 w-4 text-accent" />}
              {running ? `Triaging ${run!.done}/${run!.total}` : 'Triage inbox'}
            </button>
            <button className={`${btn} -ml-px rounded-l-none px-1.5`} aria-label="Triage settings" title="Triage settings" onClick={() => setTriageOpen(true)}><ChevronDown className="h-4 w-4" /></button>
          </div>
        )}
        {provider && <button className={btnGhost} aria-label="Refresh" title="Refresh" disabled={list.isFetching} onClick={() => { fresh.current = true; void list.refetch().finally(() => { fresh.current = false; }); }}><RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} /></button>}
        {mailOn && <button className={btnGhost} aria-label="Manage mailboxes" title="Manage mailboxes" aria-pressed={manage} onClick={() => setManage(!manage)}><Settings2 className="h-4 w-4" /></button>}
      </div>

      {(error || notice) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant/40 bg-surface px-3 py-1.5 text-sm">
          {error && <p role="alert" className="text-error">{error} <button onClick={() => setError('')} className="ml-1 underline">Dismiss</button></p>}
          {notice && <p role="status" className="text-on-surface">{notice.text} {notice.action && <button onClick={notice.action.run} className="ml-1 font-medium text-primary underline">{notice.action.label}</button>} <button onClick={() => setNotice(null)} className="ml-1 text-on-surface-variant underline">Dismiss</button></p>}
        </div>
      )}

      {manage ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6"><MailboxManager /></div>
      ) : imapAccount ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6"><MailboxInbox key={imapAccount.id} account={imapAccount} /></div>
      ) : !provider ? (
        settled ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-on-surface-variant">
            <Mail className="h-10 w-10 text-outline-variant" />
            <p className="text-on-surface">No mailbox connected.</p>
            <p className="text-sm">Connect Google or Microsoft 365 in <a href="/settings?tab=integrations" className="text-primary underline">Settings → Integrations</a>{mailOn ? <>, or add an IMAP mailbox with <button className="text-primary underline" onClick={() => setManage(true)}>Manage mailboxes</button></> : null}.</p>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 lg:grid-cols-[11rem_24rem_1fr]"><div className="hidden border-r border-outline-variant/40 lg:block" /><div className="border-r border-outline-variant/40 bg-surface"><ListSkeleton /></div><div className="hidden lg:block" /></div>
        )
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[11rem_minmax(20rem,26rem)_1fr]">
          {/* Folders */}
          <nav aria-label="Folders" className={`border-outline-variant/40 lg:border-r lg:p-2 ${open ? 'hidden lg:block' : ''}`}>
            <ul className="flex gap-1 overflow-x-auto px-2 py-1.5 lg:block lg:space-y-0.5 lg:p-0">
              {FOLDERS.map(({ id, label: name, icon: Icon }) => (
                <li key={id}>
                  <button aria-current={folder === id ? 'page' : undefined} onClick={() => changeFolder(id)} className={`flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${folder === id ? 'bg-primary-container font-medium text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'}`}>
                    <Icon className="h-4 w-4 shrink-0" /> <span className="flex-1 text-left">{name}</span>
                    {id === 'inbox' && !!unreadCount && <span className="text-xs tabular-nums" aria-label={`${unreadCount} unread`}>{unreadCount}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* List */}
          <section aria-label="Messages" className={`min-h-0 flex-col border-outline-variant/40 bg-surface lg:flex lg:border-r ${open ? 'hidden' : 'flex'}`}>
            <div className="flex min-h-10 flex-wrap items-center gap-1.5 border-b border-outline-variant/30 px-3 py-1.5">
              {checkedIds.length > 0 ? (
                <>
                  <span className="text-sm text-on-surface">{checked.size} selected</span>
                  <button className={btnGhost} onClick={() => act(checkedIds, folder === 'archive' ? 'unarchive' : folder === 'trash' ? 'untrash' : 'archive')}><Archive className="h-4 w-4" /> {folder === 'archive' || folder === 'trash' ? 'To inbox' : 'Archive'}</button>
                  {folder !== 'trash' && <button className={btnGhost} onClick={() => act(checkedIds, 'trash')}><Trash2 className="h-4 w-4" /> Trash</button>}
                  <button className={btnGhost} onClick={() => { void act(checkedIds, 'read'); setChecked(new Set()); }}><MailOpen className="h-4 w-4" /> Read</button>
                  <button className={btnGhost} onClick={() => { void act(checkedIds, 'unread'); setChecked(new Set()); }}>Unread</button>
                  <button className={`${btnGhost} ml-auto`} onClick={() => setChecked(new Set())}>Clear</button>
                </>
              ) : (
                <>
                  {filters.map(([key, text]) => (
                    <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)} className={`rounded-full border px-2.5 py-0.5 text-xs ${filter === key ? 'border-primary/50 bg-primary-container text-on-primary-container' : 'border-outline-variant/50 text-on-surface-variant hover:bg-surface-container-high'}`}>{text}</button>
                  ))}
                  {folder === 'inbox' && items.some((it) => it.triage) && (
                    <select aria-label="Priority filter" value={priorityFilter} onChange={(e) => setFilter(e.target.value || 'all')} className={`ml-auto rounded-full border bg-surface px-2 py-0.5 text-xs ${priorityFilter ? 'border-primary/50 text-on-surface' : 'border-outline-variant/50 text-on-surface-variant'}`}>
                      <option value="">Any priority</option>
                      <option value="high">High</option>
                      <option value="normal">Normal</option>
                      <option value="low">Low</option>
                    </select>
                  )}
                  {folder === 'inbox' && Object.keys(categoryCounts).length > 0 && (
                    <select aria-label="Category filter" value={filter.startsWith('cat:') ? filter : ''} onChange={(e) => setFilter(e.target.value || 'all')} className={`rounded-full border bg-surface px-2 py-0.5 text-xs ${filter.startsWith('cat:') ? 'border-accent/50 text-on-surface' : 'border-outline-variant/50 text-on-surface-variant'}`}>
                      <option value="">Any category</option>
                      {Object.entries(categoryCounts).sort(([a], [b]) => a.localeCompare(b)).map(([cat, n]) => <option key={cat} value={`cat:${cat}`}>{cat} ({n})</option>)}
                    </select>
                  )}
                </>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {list.isLoading && <ListSkeleton />}
              {list.error && <p role="alert" className="p-4 text-sm text-error">{(list.error as Error).message} <button className="underline" onClick={() => list.refetch()}>Try again</button></p>}
              {!list.isLoading && !list.error && visible.length === 0 && (
                <p className="p-8 text-center text-sm text-on-surface-variant">{q ? `Nothing found for "${q}".` : items.length > 0 ? 'No messages match this filter.' : folder === 'inbox' ? 'Your inbox is empty.' : 'Nothing here.'}</p>
              )}
              <ul className={`divide-y divide-outline-variant/30 ${list.isPlaceholderData ? 'opacity-60' : ''}`}>
                {visible.map((c) => {
                  const it = c.latest;
                  const isOpen = openKey === c.key;
                  const isChecked = checked.has(c.key);
                  const person = folder === 'sent' || folder === 'drafts' ? `To: ${it.to?.map(who).join(', ') || '(no recipient)'}` : who(it.from);
                  return (
                    <li key={c.key} className={`group relative flex gap-2.5 border-l-[3px] px-2.5 py-2.5 ${it.triage?.priority === 'high' ? 'border-l-error' : 'border-l-transparent'} ${isOpen ? 'bg-primary-container/50' : isChecked ? 'bg-surface-container-high' : 'hover:bg-surface-container-low'}`}>
                      <label className="relative mt-0.5 h-8 w-8 shrink-0 cursor-pointer">
                        <span aria-hidden className={`absolute inset-0 flex items-center justify-center rounded-full bg-surface-container-highest text-sm font-medium uppercase text-on-surface-variant group-hover:opacity-0 ${isChecked ? 'opacity-0' : ''}`}>{(who(it.from)[0] ?? '?')}</span>
                        <input type="checkbox" aria-label={`Select conversation: ${it.subject}`} checked={isChecked} onChange={() => setChecked((s) => { const next = new Set(s); if (next.has(c.key)) next.delete(c.key); else next.add(c.key); return next; })} className={`absolute inset-0 m-auto h-4 w-4 group-hover:opacity-100 focus:opacity-100 ${isChecked ? 'opacity-100' : 'opacity-0'}`} />
                      </label>
                      <button onClick={() => openConversation(c)} aria-current={isOpen ? 'true' : undefined} className="min-w-0 flex-1 text-left">
                        <span className="flex items-baseline gap-2">
                          {c.unread && <span aria-label="Unread" className="h-2 w-2 shrink-0 self-center rounded-full bg-primary" />}
                          <span className={`min-w-0 flex-1 truncate text-sm ${c.unread ? 'font-semibold text-on-surface' : 'text-on-surface'}`}>{person}{c.ids.length > 1 && <span className="ml-1.5 text-xs font-normal text-on-surface-variant">{c.ids.length}</span>}</span>
                          {all && <span className="shrink-0 self-center max-w-28 truncate rounded bg-surface-container-high px-1 text-[10px] text-on-surface-variant">{sameProviderTwice ? addressOf(it) ?? providerLabel(it.provider) : providerLabel(it.provider)}</span>}
                          {it.hasAttachments && <Paperclip aria-label="Has attachments" className="h-3.5 w-3.5 shrink-0 self-center text-on-surface-variant" />}
                          {c.starred && <Star aria-label="Starred" className="h-3.5 w-3.5 shrink-0 self-center fill-warning text-warning" />}
                          <time className={`shrink-0 text-xs ${c.unread ? 'font-medium text-on-surface' : 'text-on-surface-variant'}`}>{shortDate(it.receivedAt)}</time>
                        </span>
                        <span className={`block truncate text-sm ${c.unread ? 'font-medium text-on-surface' : 'text-on-surface-variant'}`}>{it.subject || '(no subject)'}</span>
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-xs text-on-surface-variant/80">{it.snippet}</span>
                          {it.triage?.category && <span className="shrink-0 rounded-full bg-accent-container px-1.5 py-0.5 text-[10px] text-on-surface-variant">{it.triage.category}</span>}
                          {it.triage && <span title={triageWhy(it.triage) || undefined} className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${priorityTone[it.triage.priority]}`}>{it.triage.priority}</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {list.hasNextPage && (
                <button onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage} className="flex w-full items-center justify-center gap-1.5 py-3 text-sm text-on-surface-variant hover:text-on-surface disabled:opacity-50">
                  {list.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Load more
                </button>
              )}
            </div>
          </section>

          {/* Reader */}
          <section aria-label="Reading pane" className={`min-h-0 lg:block ${open ? 'block' : 'hidden'}`}>
            {open ? (
              <EmailReader
                key={open.key}
                conversation={open}
                provider={open.latest.provider}
                account={open.latest.account}
                categories={categories}
                folder={folder}
                onBack={() => setOpenKey(null)}
                onAction={(ids, action) => void act(ids, action)}
                onCompose={(mode: ComposeMode, source: EmailMessage) => setCompose(composeFor(mode, source, addressOf(source)))}
                onLabel={label}
                onNotice={(text) => setNotice({ text })}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-sm text-on-surface-variant">
                <Mail className="h-8 w-8 text-outline-variant" />
                <p>Select a conversation to read it.</p>
                <p className="text-xs">j / k move · e archive · # trash · c compose · / search</p>
              </div>
            )}
          </section>
        </div>
      )}

      {compose && provider && (
        <EmailCompose
          key={`${compose.mode}:${compose.source?.id ?? 'new'}`}
          draft={compose}
          provider={compose.source?.provider ?? composeFrom?.provider ?? provider}
          account={compose.source ? compose.source.account : composeFrom ? composeFrom.account : account}
          accounts={compose.mode === 'new' && oauth.length > 1 ? oauth : undefined}
          onProvider={setComposeFrom}
          onChange={setCompose}
          onClose={() => setCompose(null)}
          onSent={(text) => { setCompose(null); setNotice({ text }); void client.invalidateQueries({ queryKey: ['email-list', scope], refetchType: folder === 'sent' || folder === 'drafts' ? 'active' : 'none' }); }}
        />
      )}

      {triageOpen && provider && (
        <TriageDialog
          provider={provider}
          account={account}
          items={items}
          run={run}
          onRun={(next) => { setRun(next); void settings.refetch(); }}
          onArchive={(ids) => act(ids, 'archive', true)}
          onUnarchive={async (ids) => { await act(ids, 'unarchive', true); await client.invalidateQueries({ queryKey: ['email-list', scope] }); }}
          onClose={() => { setTriageOpen(false); if (run?.finished) setRun(null); }}
        />
      )}
    </div>
  );
}
