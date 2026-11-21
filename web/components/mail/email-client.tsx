'use client';

import { type InfiniteData, keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, AlertTriangle, Archive, ChevronDown, FileText, Inbox, Loader2, Mail, MailOpen, Paperclip, PenSquare, RefreshCw, Search, Send, Settings2, Sparkles, Star, Trash2, X } from 'lucide-react';
import { SnoozedPane } from './email-snooze';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useModuleOn } from '@/lib/modules';
import { useWorkspace, useWorkspaceAccess, useWorkspaceId } from '@/lib/workspace-context';
import type { EmailAccountsResponse, EmailBatchAction, EmailListResponse } from '../../../src/shared/email';
import type { MailAccountView } from '../../../src/shared/mail';
import { type ComposeDraft, type ComposeMode, composeFor, EmailCompose } from './email-compose';
import { EmailReader } from './email-reader';
import { btn, btnGhost, btnPrimary, type Conversation, conversations, type EmailMessage, type EmailTriage, field, type InboxItem, ListSkeleton, type MailboxCursors, mergeMailboxPages, priorityTone, shortDate, triageWhy, who } from './email-shared';
import { canDo, changeMessages, type ClientFolder, imapMailboxOf, keyOf, labelPath, listPage, type Mailbox, mailboxBody, oauthMailbox, syncMailbox } from './mailboxes';
import { EmailIndexSetting } from './email-index-setting';
import { MailboxManager, mailAccountsKey } from './mailbox-manager';
import { rowsInScope, startTriage, TriageDialog, type TriageRun, type TriageSettings } from './triage-dialog';

const FOLDER_INFO: Record<ClientFolder, { label: string; icon: typeof Inbox }> = {
  inbox: { label: 'Inbox', icon: Inbox },
  starred: { label: 'Starred', icon: Star },
  sent: { label: 'Sent', icon: Send },
  drafts: { label: 'Drafts', icon: FileText },
  archive: { label: 'Archive', icon: Archive },
  trash: { label: 'Trash', icon: Trash2 },
  failed: { label: 'Failed sends', icon: AlertTriangle },
};
const FOLDER_ORDER: readonly ClientFolder[] = ['inbox', 'starred', 'sent', 'drafts', 'failed', 'archive', 'trash'];
/** What undoes a move, for the notice's Undo. */
const INVERSE: Partial<Record<EmailBatchAction, EmailBatchAction>> = { archive: 'unarchive', trash: 'untrash', unarchive: 'archive', untrash: 'trash' };
const MOVED_TEXT: Partial<Record<EmailBatchAction, string>> = { archive: 'archived', trash: 'moved to trash', unarchive: 'moved to the inbox', untrash: 'moved to the inbox' };

/** A list page; a merged one also says how far each mailbox has been read. */
type ListPage = EmailListResponse & { cursors?: MailboxCursors };
type ListData = InfiniteData<ListPage, string | undefined>;
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * The mail window. `imapOnly`: the Mailboxes page (`/mail`), for installs
 * with the Mail module but without the Email & calendar module: only IMAP /
 * POP3 mailboxes, and no AI help or triage unless that module is on too.
 */
export function EmailClient({ imapOnly = false }: { imapOnly?: boolean }) {
  const { activeWorkspace, isLoading } = useWorkspace();
  const workspace = useWorkspaceId();
  if (!isLoading && activeWorkspace?.kind === 'remote') return <p className="p-6 text-on-surface-variant">Mailboxes on another install are not available here. Select a local workspace to read mail.</p>;
  // The frame renders at once; the lists inside it show placeholders until their data arrives.
  return <Client key={workspace ?? 'personal'} imapOnly={imapOnly} />;
}

function Client({ imapOnly }: { imapOnly: boolean }) {
  const workspace = useWorkspaceId();
  const access = useWorkspaceAccess();
  const client = useQueryClient();
  const mailOn = useModuleOn('mail');
  // The AI help and triage are the Email & calendar module's.
  const ai = useModuleOn('inbox');
  const accounts = useQuery({ queryKey: ['email-accounts'], enabled: !imapOnly, queryFn: () => api.get<EmailAccountsResponse>('/email/accounts'), staleTime: 5 * 60_000 });
  const imap = useQuery({ queryKey: mailAccountsKey(workspace), enabled: mailOn || imapOnly, queryFn: () => api.get<MailAccountView[]>('/mail/accounts') });
  const [picked, setPicked] = useState('');
  const [manage, setManage] = useState(false);

  // Every mailbox the page can show: Google / Microsoft first, then the IMAP / POP3 mailboxes of this workspace.
  const boxes = useMemo<Mailbox[]>(() => [
    ...(imapOnly ? [] : (accounts.data?.accounts ?? []).map((a) => oauthMailbox(a.provider, a.address, a.isDefault !== false))),
    ...(imap.data ?? []).map((a) => imapMailboxOf(a, access.canWrite)),
  ], [imapOnly, accounts.data, imap.data, access.canWrite]);
  // The picker's value: "all", a provider, or an IMAP account's id.
  const valueOf = (box: Mailbox) => box.account?.id ?? box.key;
  const selection = picked || (boxes[0] ? valueOf(boxes[0]) : '');
  // "All inboxes" reads every mailbox as one list.
  const all = selection === 'all' && boxes.length > 1;
  const inView = useMemo(() => (all ? boxes : boxes.filter((b) => valueOf(b) === selection)), [all, boxes, selection]);
  const primary: Mailbox | undefined = inView[0];
  const boxOf = useCallback((key: string) => boxes.find((b) => b.key === key), [boxes]);
  const scope = all ? 'all' : primary?.key ?? null;
  const settled = (imapOnly || !accounts.isLoading) && (!(mailOn || imapOnly) || !imap.isLoading);
  const folders = useMemo(() => FOLDER_ORDER.filter((f) => inView.some((b) => b.folders.includes(f))), [inView]);
  const moves = inView.some((b) => b.moves);

  const [folder, setFolder] = useState<ClientFolder>('inbox');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [composeFrom, setComposeFrom] = useState<Mailbox | null>(null);
  const [notice, setNotice] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const [error, setError] = useState('');
  const [triageOpen, setTriageOpen] = useState(false);
  const [run, setRun] = useState<TriageRun | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fresh = useRef(false);

  const listKey = useMemo(() => ['email-list', scope, folder, q, filter === 'unread'] as const, [scope, folder, q, filter]);
  const list = useInfiniteQuery({
    queryKey: listKey,
    enabled: inView.length > 0,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<ListPage> => {
      // One page per mailbox. With several, the page token carries each mailbox's own token.
      const tokens: Partial<Record<string, string>> = !pageParam ? {} : all ? JSON.parse(pageParam) : { [inView[0].key]: pageParam };
      const pages = await Promise.all(inView.filter((b) => b.folders.includes(folder) && (!pageParam || tokens[b.key])).map(async (b) => {
        const res = await listPage(b, { folder, q, unread: filter === 'unread', pageToken: tokens[b.key], fresh: fresh.current });
        return [b.key, res] as const;
      }));
      if (!all) return pages[0]?.[1] ?? { provider: null, items: [] };
      const next = Object.fromEntries(pages.filter(([, res]) => res.nextPageToken).map(([key, res]) => [key, res.nextPageToken]));
      const cursors: MailboxCursors = Object.fromEntries(pages.map(([key, res]) => [key, { oldest: res.items.map((it) => it.receivedAt).filter(Boolean).sort()[0], more: !!res.nextPageToken }]));
      const counts = pages.map(([, res]) => res.unreadCount).filter((n): n is number => typeof n === 'number');
      return {
        provider: null,
        items: pages.flatMap(([, res]) => res.items),
        cursors,
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
  const categoriesQuery = useQuery({ queryKey: ['email-categories'], enabled: ai && inView.length > 0, queryFn: () => api.get<{ categories: Record<string, string> }>('/email/categories'), staleTime: 5 * 60_000 });
  const categories = useMemo(() => Object.keys(categoriesQuery.data?.categories ?? {}), [categoriesQuery.data]);
  const settings = useQuery({ queryKey: ['email-triage-settings'], enabled: ai && inView.length > 0, queryFn: () => api.get<{ settings: TriageSettings; saved: boolean }>('/email/triage/settings') });

  const items = useMemo(() => {
    const pages = list.data?.pages ?? [];
    // Several mailboxes: one date order over every page loaded, held at the oldest mail a mailbox with more has shown.
    if (all) return mergeMailboxPages(pages);
    const seen = new Set<string>();
    return pages.flatMap((p) => p.items).filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  }, [list.data, all]);
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
  const openBox = open ? boxOf(keyOf(open.latest)) : undefined;
  const unreadCount = folder === 'inbox' ? list.data?.pages[0]?.unreadCount : undefined;
  // Sync trouble of the IMAP mailboxes on screen: an empty list should not look like an empty mailbox.
  const syncErrors = inView.filter((b) => b.account?.lastError).map((b) => `${b.short}: ${b.account!.lastError}`);

  const patchLists = useCallback((change: (items: InboxItem[]) => InboxItem[]) => {
    client.setQueriesData<ListData>({ queryKey: ['email-list', scope] }, (data) => (data ? { ...data, pages: data.pages.map((p) => ({ ...p, items: change(p.items) })) } : data));
  }, [client, scope]);

  /** One mailbox action on some messages: shown at once, then sent; a failure reloads the truth. */
  const apply = useCallback(async (ids: string[], action: EmailBatchAction): Promise<boolean> => {
    // Each message is changed in the mailbox it lives in, if that mailbox can.
    const owner = new Map(items.map((it) => [it.id, keyOf(it)]));
    const groups = new Map<Mailbox, string[]>();
    for (const id of ids) {
      const box = boxOf(owner.get(id) ?? primary?.key ?? 'google');
      if (box && canDo(box, action)) groups.set(box, [...(groups.get(box) ?? []), id]);
    }
    const doing = [...groups.values()].flat();
    if (doing.length === 0) return false;
    const hit = new Set(doing);
    const moved = action in MOVED_TEXT;
    if (moved) {
      patchLists((rows) => rows.filter((it) => !hit.has(it.id)));
      setChecked(new Set());
      setOpenKey((key) => (key && conversations(items).find((c) => c.key === key)?.ids.some((id) => hit.has(id)) ? null : key));
    } else if (action === 'read' || action === 'unread') patchLists((rows) => rows.map((it) => (hit.has(it.id) ? { ...it, unread: action === 'unread' } : it)));
    else patchLists((rows) => rows.map((it) => (hit.has(it.id) ? { ...it, starred: action === 'star' } : it)));
    try {
      let failed = 0;
      for (const [box, own] of groups) failed += await changeMessages(box, own, action);
      if (failed) throw new Error(`${failed} of ${doing.length} could not be changed.`);
      // Other folders now hold these messages: they reload when next shown.
      if (moved) void client.invalidateQueries({ queryKey: ['email-list', scope], refetchType: 'none' });
      return true;
    } catch (err) {
      setError((err as Error).message);
      void client.invalidateQueries({ queryKey: ['email-list', scope] });
      return false;
    }
  }, [items, boxOf, primary, patchLists, client, scope]);

  /** `apply`, and for a move a notice that can undo it. */
  const act = useCallback(async (ids: string[], action: EmailBatchAction, quiet = false) => {
    const ok = await apply(ids, action);
    if (!ok || quiet || !(action in MOVED_TEXT)) return;
    const inverse = INVERSE[action];
    const undo = inverse ? { action: { label: 'Undo', run: () => { setNotice(null); void apply(ids, inverse).then(() => client.invalidateQueries({ queryKey: ['email-list', scope] })); } } } : {};
    setNotice({ text: `${ids.length === 1 ? 'Conversation' : `${ids.length} messages`} ${MOVED_TEXT[action]}.`, ...undo });
  }, [apply, client, scope]);

  const label = async (message: EmailMessage, value: { priority: EmailTriage['priority']; category: string }) => {
    const box = boxOf(keyOf(message));
    if (!box) return;
    try {
      await api.put(labelPath(box, message.id), { ...value, ...(box.kind === 'oauth' ? { item: { from: message.from, subject: message.subject, snippet: message.snippet } } : {}) });
      const ids = new Set(open?.ids ?? [message.id]);
      patchLists((rows) => rows.map((it) => (ids.has(it.id) ? { ...it, triage: { ...value, source: 'owner' } } : it)));
    } catch (err) { setError((err as Error).message); }
  };

  // A run in flight is followed until it ends, with the window open or not.
  const running = !!run && !run.finished;
  useEffect(() => {
    if (!ai || !primary) return;
    let stop = false;
    api.get<{ run: TriageRun | null }>('/email/triage/run').then((res) => { if (!stop && res.run && !res.run.finished) setRun(res.run); }).catch(() => {});
    return () => { stop = true; };
  }, [ai, primary]);
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

  const triageKeys = inView.map((b) => b.key);
  const triageNow = async () => {
    const s = settings.data?.settings;
    if (!s?.skipDialog || run?.finished) { setTriageOpen(true); return; }
    try { setRun(await startTriage(triageKeys, rowsInScope(items, s.scope), s.scope)); }
    catch (err) { setError((err as Error).message); }
  };
  const triageSummary = (() => {
    const s = settings.data?.settings;
    if (!s) return 'Sort the inbox by priority and category';
    return `${{ untriaged: 'Mail not triaged yet', unread: 'Unread mail', all: 'All loaded mail' }[s.scope]} · labels ${s.applyLabels ? 'on' : 'off'} · archive ${s.autoArchive ? 'automatic' : 'asks first'}${s.instructions ? ' · your instructions' : ''}${s.auto ? ' · new mail automatically' : ''}`;
  })();

  // Who sends a new message: the selected mailbox, else the first that can.
  const senders = boxes.filter((b) => b.canSend);
  const composeBox = compose?.source ? boxOf(keyOf(compose.source)) : composeFrom ?? (primary?.canSend ? primary : senders[0]);
  const newMessage = () => { setComposeFrom(null); setCompose(composeFor('new')); };

  const openConversation = (c: Conversation) => { setOpenKey(c.key); };
  const step = useCallback((by: number) => {
    const index = visible.findIndex((c) => c.key === openKey);
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + by))];
    if (next) setOpenKey(next.key);
  }, [visible, openKey]);

  useEffect(() => {
    if (!primary) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || triageOpen) return;
      const current = visible.find((c) => c.key === openKey);
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'c') { if (senders.length) { e.preventDefault(); newMessage(); } }
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
  }, [primary, visible, openKey, step, act, compose, triageOpen, senders.length]);

  // Snoozed is Octipus's own list (core/email/snooze.ts), not a mailbox folder.
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const snoozeConversation = async (c: Conversation, ids: string[], until: Date) => {
    const box = boxOf(keyOf(c.latest));
    if (!box || box.kind !== 'oauth') return;
    try {
      const res = await api.post<{ snoozed?: { id: string; messageIds: string[] }; warning?: string; error?: string }>('/email/snooze', {
        ids, wakeAt: until.toISOString(), ...mailboxBody(box), ...(c.latest.threadId ? { threadId: c.latest.threadId } : {}),
        from: c.latest.from, subject: c.latest.subject, snippet: c.latest.snippet,
      });
      if (res.error || !res.snoozed) throw new Error(res.error ?? 'Could not snooze the conversation.');
      // Some messages could not be moved: those stay in the list (the server says how many); reload to be exact.
      const gone = new Set(res.warning ? [] : [...ids, ...c.ids]);
      if (res.warning) void client.invalidateQueries({ queryKey: ['email-list', scope] });
      patchLists((rows) => rows.filter((it) => !gone.has(it.id)));
      setOpenKey(null);
      void client.invalidateQueries({ queryKey: ['email-snoozed'] });
      const id = res.snoozed.id;
      setNotice({ text: `${res.warning ? `${res.warning} ` : ''}Snoozed until ${until.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}.`, action: { label: 'Undo', run: () => {
        setNotice(null);
        void api.post(`/email/snoozed/${encodeURIComponent(id)}/unsnooze`, {})
          .then(() => client.invalidateQueries({ queryKey: ['email-list', scope] }), (err: unknown) => setError((err as Error).message));
      } } });
    } catch (err) { setError((err as Error).message); }
  };

  // Refresh: an IMAP mailbox fetches its new mail now (editors); the lists are read again past the server's memory.
  const refresh = async () => {
    try {
      const synced = (await Promise.all(inView.map((b) => syncMailbox(b)))).filter((n): n is string => !!n);
      if (synced.length) setNotice({ text: synced.join(' ') });
      if (inView.some((b) => b.kind === 'imap')) void client.invalidateQueries({ queryKey: mailAccountsKey(workspace) });
    } catch (err) { setError((err as Error).message); }
    fresh.current = true;
    void list.refetch().finally(() => { fresh.current = false; });
  };

  const changeFolder = (next: ClientFolder) => { setFolder(next); setSnoozedOpen(false); setOpenKey(null); setChecked(new Set()); setFilter('all'); };
  const pick = (value: string) => {
    setPicked(value); setOpenKey(null); setChecked(new Set()); setManage(false); setSnoozedOpen(false);
    const nextBoxes = value === 'all' ? boxes : boxes.filter((b) => valueOf(b) === value);
    if (!nextBoxes.some((b) => b.folders.includes(folder))) setFolder('inbox');
  };
  // Snooze is Google / Microsoft only: the IMAP backend changes nothing on its server.
  const sameProviderTwice = new Set(boxes.filter((b) => b.kind === 'oauth').map((b) => b.provider)).size < boxes.filter((b) => b.kind === 'oauth').length;
  const snoozeKeys = inView.filter((b) => b.kind === 'oauth').map((b) => b.key);
  const checkedIds = visible.filter((c) => checked.has(c.key)).flatMap((c) => c.ids);
  const filters: Array<[string, string]> = [['all', 'All'], ['unread', 'Unread']];
  const priorityFilter = ['high', 'normal', 'low'].includes(filter) ? filter : '';
  const triageable = ai && folder === 'inbox';
  const showBadges = all;

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background font-sans">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant/50 bg-surface px-3 py-2">
        <h1 className="mr-1 text-base font-semibold text-on-surface">{imapOnly ? 'Mail' : 'Email'}</h1>
        <select aria-label="Mailbox" value={selection} onChange={(e) => pick(e.target.value)} className={`${field} w-auto max-w-56`}>
          {!selection && <option value="">{settled ? 'No mailbox connected' : 'Loading mailboxes…'}</option>}
          {boxes.length > 1 && <option value="all">All inboxes</option>}
          {boxes.map((b) => <option key={b.key} value={valueOf(b)}>{b.label}</option>)}
        </select>
        {primary && (
          <form role="search" className="relative min-w-40 flex-1" onSubmit={(e) => { e.preventDefault(); setQ(search.trim()); setOpenKey(null); }}>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant" />
            <input ref={searchRef} aria-label="Search mail" placeholder="Search mail" value={search} onChange={(e) => { setSearch(e.target.value); if (!e.target.value) setQ(''); }} className={`${field} pl-8 pr-8`} />
            {search && <button type="button" aria-label="Clear search" onClick={() => { setSearch(''); setQ(''); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-on-surface-variant hover:text-on-surface"><X className="h-3.5 w-3.5" /></button>}
          </form>
        )}
        {!primary && <span className="flex-1" />}
        {primary && senders.length > 0 && <button className={btnPrimary} onClick={newMessage}><PenSquare className="h-4 w-4" /> Compose</button>}
        {primary && triageable && (
          <div className="inline-flex">
            <button className={`${btn} rounded-r-none`} onClick={triageNow} title={triageSummary}>
              {running ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : <Sparkles className="h-4 w-4 text-accent" />}
              {running ? `Triaging ${run!.done}/${run!.total}` : 'Triage inbox'}
            </button>
            <button className={`${btn} -ml-px rounded-l-none px-1.5`} aria-label="Triage settings" title="Triage settings" onClick={() => setTriageOpen(true)}><ChevronDown className="h-4 w-4" /></button>
          </div>
        )}
        {primary && <button className={btnGhost} aria-label="Refresh" title={inView.some((b) => b.kind === 'imap' && b.canWrite) ? 'Fetch new mail now' : 'Refresh'} disabled={list.isFetching} onClick={refresh}><RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} /></button>}
        {(mailOn || imapOnly || boxes.some((b) => b.kind === 'oauth')) && <button className={btnGhost} aria-label="Manage mailboxes" title="Mailbox settings" aria-pressed={manage} onClick={() => setManage(!manage)}><Settings2 className="h-4 w-4" /></button>}
      </div>

      {(error || notice || (syncErrors.length > 0 && !manage)) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant/40 bg-surface px-3 py-1.5 text-sm">
          {error && <p role="alert" className="text-error">{error} <button onClick={() => setError('')} className="ml-1 underline">Dismiss</button></p>}
          {!manage && syncErrors.map((text) => <p key={text} className="text-error">Last sync failed — {text}</p>)}
          {notice && <p role="status" className="text-on-surface">{notice.text} {notice.action && <button onClick={notice.action.run} className="ml-1 font-medium text-primary underline">{notice.action.label}</button>} <button onClick={() => setNotice(null)} className="ml-1 text-on-surface-variant underline">Dismiss</button></p>}
        </div>
      )}

      {manage ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {boxes.some((b) => b.kind === 'oauth') && <EmailIndexSetting />}
          {(mailOn || imapOnly) && <MailboxManager />}
        </div>
      ) : !primary ? (
        settled ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-on-surface-variant">
            <Mail className="h-10 w-10 text-outline-variant" />
            <p className="text-on-surface">No mailbox connected.</p>
            <p className="text-sm">
              {!imapOnly && <>Connect Google or Microsoft 365 in <a href="/settings?tab=integrations" className="text-primary underline">Settings → Integrations</a>{mailOn ? ', or add' : ''}</>}
              {(mailOn || imapOnly) && <>{imapOnly ? 'Add' : ''} an IMAP or POP3 mailbox with <button className="text-primary underline" onClick={() => setManage(true)}>Manage mailboxes</button></>}.
            </p>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 lg:grid-cols-[11rem_24rem_1fr]"><div className="hidden border-r border-outline-variant/40 lg:block" /><div className="border-r border-outline-variant/40 bg-surface"><ListSkeleton /></div><div className="hidden lg:block" /></div>
        )
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[11rem_minmax(20rem,26rem)_1fr]">
          {/* Folders */}
          <nav aria-label="Folders" className={`border-outline-variant/40 lg:border-r lg:p-2 ${open ? 'hidden lg:block' : ''}`}>
            <ul className="flex gap-1 overflow-x-auto px-2 py-1.5 lg:block lg:space-y-0.5 lg:p-0">
              {folders.map((id) => {
                const { label: name, icon: Icon } = FOLDER_INFO[id];
                return (
                  <li key={id}>
                    <button aria-current={folder === id && !snoozedOpen ? 'page' : undefined} onClick={() => changeFolder(id)} className={`flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${folder === id && !snoozedOpen ? 'bg-primary-container font-medium text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'}`}>
                      <Icon className="h-4 w-4 shrink-0" /> <span className="flex-1 text-left">{name}</span>
                      {id === 'inbox' && !!unreadCount && <span className="text-xs tabular-nums" aria-label={`${unreadCount} unread`}>{unreadCount}</span>}
                    </button>
                  </li>
                );
              })}
              {snoozeKeys.length > 0 && (
                <li>
                <button aria-current={snoozedOpen ? 'page' : undefined} onClick={() => { setSnoozedOpen(true); setOpenKey(null); setChecked(new Set()); }} className={`flex w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${snoozedOpen ? 'bg-primary-container font-medium text-on-primary-container' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'}`}>
                  <AlarmClock className="h-4 w-4 shrink-0" /> <span className="flex-1 text-left">Snoozed</span>
                </button>
              </li>
              )}
            </ul>
          </nav>

          {snoozedOpen && snoozeKeys.length > 0 ? <SnoozedPane keys={snoozeKeys} onUnsnoozed={(text) => { setNotice({ text }); void client.invalidateQueries({ queryKey: ['email-list', scope] }); }} /> : <>
          {/* List */}
          <section aria-label="Messages" className={`min-h-0 flex-col border-outline-variant/40 bg-surface lg:flex lg:border-r ${open ? 'hidden' : 'flex'}`}>
            <div className="flex min-h-10 flex-wrap items-center gap-1.5 border-b border-outline-variant/30 px-3 py-1.5">
              {checkedIds.length > 0 ? (
                <>
                  <span className="text-sm text-on-surface">{checked.size} selected</span>
                  {moves && <button className={btnGhost} onClick={() => act(checkedIds, folder === 'archive' ? 'unarchive' : folder === 'trash' ? 'untrash' : 'archive')}><Archive className="h-4 w-4" /> {folder === 'archive' || folder === 'trash' ? 'To inbox' : 'Archive'}</button>}
                  {moves && folder !== 'trash' && <button className={btnGhost} onClick={() => act(checkedIds, 'trash')}><Trash2 className="h-4 w-4" /> Trash</button>}
                  {inView.some((b) => b.canWrite) && <button className={btnGhost} onClick={() => { void act(checkedIds, 'read'); setChecked(new Set()); }}><MailOpen className="h-4 w-4" /> Read</button>}
                  {inView.some((b) => b.canWrite) && <button className={btnGhost} onClick={() => { void act(checkedIds, 'unread'); setChecked(new Set()); }}>Unread</button>}
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
                <p className="p-8 text-center text-sm text-on-surface-variant">{q ? `Nothing found for "${q}".` : items.length > 0 ? 'No messages match this filter.' : folder === 'inbox' ? (inView.some((b) => b.kind === 'imap') ? 'No mail here yet. New mail is fetched every few minutes; Refresh fetches it now.' : 'Your inbox is empty.') : 'Nothing here.'}</p>
              )}
              <ul className={`divide-y divide-outline-variant/30 ${list.isPlaceholderData ? 'opacity-60' : ''}`}>
                {visible.map((c) => {
                  const it = c.latest;
                  const isOpen = openKey === c.key;
                  const isChecked = checked.has(c.key);
                  const outgoing = folder === 'sent' || folder === 'drafts' || folder === 'failed';
                  const person = outgoing ? `To: ${it.to?.map(who).join(', ') || '(no recipient)'}` : who(it.from);
                  const box = showBadges ? boxOf(keyOf(it)) : undefined;
                  // Two accounts of one provider: the address says which; otherwise the mailbox's short name.
                  const badge = box ? (box.kind === 'oauth' && sameProviderTwice ? box.address ?? box.short : box.short) : undefined;
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
                          {badge && <span className="shrink-0 self-center rounded bg-surface-container-high px-1 text-[10px] text-on-surface-variant">{badge}</span>}
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
            {open && openBox ? (
              <EmailReader
                key={open.key}
                conversation={open}
                mailbox={openBox}
                ai={ai}
                categories={categories}
                folder={folder}
                onBack={() => setOpenKey(null)}
                onAction={(ids, action) => void act(ids, action)}
                onCompose={(mode: ComposeMode, source: EmailMessage) => setCompose(composeFor(mode, source, openBox.address))}
                onLabel={label}
                onNotice={(text) => setNotice({ text })}
                onDeleted={() => { setOpenKey(null); void client.invalidateQueries({ queryKey: ['email-list', scope] }); }}
                onSnooze={snoozeConversation}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-sm text-on-surface-variant">
                <Mail className="h-8 w-8 text-outline-variant" />
                <p>Select a conversation to read it.</p>
                <p className="text-xs">j / k move{moves ? ' · e archive · # trash' : ''}{senders.length ? ' · c compose' : ''} · / search</p>
              </div>
            )}
          </section>
          </>}
        </div>
      )}

      {compose && composeBox && (
        <EmailCompose
          key={`${compose.mode}:${compose.source?.id ?? 'new'}`}
          draft={compose}
          mailbox={composeBox}
          ai={ai}
          senders={compose.mode === 'new' ? senders : undefined}
          onMailbox={setComposeFrom}
          onChange={(update) => setCompose((d) => (d ? update(d) : d))}
          onClose={() => setCompose(null)}
          onSent={(text) => { setCompose(null); setNotice({ text }); void client.invalidateQueries({ queryKey: ['email-list', scope], refetchType: folder === 'inbox' ? 'none' : 'active' }); }}
        />
      )}

      {triageOpen && primary && (
        <TriageDialog
          mailboxes={triageKeys}
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
