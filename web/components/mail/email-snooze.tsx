'use client';

import { useQuery } from '@tanstack/react-query';
import { AlarmClock, AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { btn, btnGhost, btnPrimary, type EmailAddress, type EmailProvider, field, ListSkeleton, providerLabel, who } from './email-shared';

/** A snoozed conversation as GET /api/email/snoozed gives it (core/email/snooze.ts SnoozeView). */
export interface Snoozed {
  id: string;
  provider: EmailProvider;
  /** The account of the provider, when it is not the default one. */
  account?: string;
  messageIds: string[];
  threadId?: string;
  from: EmailAddress;
  subject: string;
  snippet: string;
  wakeAt: string;
  error?: string;
  retryAt?: string;
  gaveUp?: boolean;
}

const at = (base: Date, days: number, hour: number) => { const d = new Date(base); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };

/**
 * The ready-made snooze times from `now`, in the reader's own clock: later
 * today (three hours on, while that is still before 8 pm), tomorrow at 8, the
 * coming Saturday at 9, next Monday at 8. Pure.
 */
export function snoozeChoices(now: Date): Array<{ label: string; at: Date }> {
  const out: Array<{ label: string; at: Date }> = [];
  const later = new Date(now); later.setMinutes(0, 0, 0); later.setHours(later.getHours() + 3);
  if (later.getDate() === now.getDate() && later.getHours() <= 20) out.push({ label: 'Later today', at: later });
  out.push({ label: 'Tomorrow morning', at: at(now, 1, 8) });
  // Monday to Thursday: the coming Saturday. On Friday "tomorrow" already is Saturday.
  if (now.getDay() >= 1 && now.getDay() <= 4) out.push({ label: 'This weekend', at: at(now, 6 - now.getDay(), 9) });
  const toMonday = (1 - now.getDay() + 7) % 7 || 7;
  // On Sunday next Monday is tomorrow morning, already offered.
  if (toMonday > 1) out.push({ label: 'Next week', at: at(now, toMonday, 8) });
  return out;
}

const when = (d: Date) => d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const localInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** "Snooze": a menu of times, and a date and time of one's own. */
export function SnoozeButton({ onSnooze, disabled }: { onSnooze: (until: Date) => Promise<void>; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const pick = async (until: Date) => {
    setBusy(true);
    try { await onSnooze(until); setOpen(false); } finally { setBusy(false); }
  };
  // The menu's times are worked out when it opens, not on every render.
  const [openedAt, setOpenedAt] = useState<Date | null>(null);
  const customDate = custom ? new Date(custom) : null;
  const customOk = !!customDate && !!openedAt && Number.isFinite(+customDate) && +customDate > +openedAt + 60_000;
  return (
    <div ref={ref} className="relative">
      <button className={btnGhost} title="Snooze" aria-label="Snooze" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => { const now = new Date(); setOpenedAt(now); setOpen(!open); setCustom(localInput(at(now, 1, 8))); }}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlarmClock className="h-4 w-4" />}
      </button>
      {open && (
        <div role="menu" aria-label="Snooze until" className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-outline-variant bg-surface-container p-1 shadow-xl">
          <p className="px-2.5 py-1.5 text-xs text-on-surface-variant">Back in the inbox, unread, at:</p>
          {openedAt && snoozeChoices(openedAt).map((choice) => (
            <button key={choice.label} role="menuitem" disabled={busy} onClick={() => pick(choice.at)} className="flex w-full items-baseline justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm text-on-surface hover:bg-surface-container-high disabled:opacity-50">
              <span>{choice.label}</span><span className="text-xs text-on-surface-variant">{when(choice.at)}</span>
            </button>
          ))}
          <div className="mt-1 space-y-1.5 border-t border-outline-variant/50 px-2.5 py-2">
            <label className="block text-xs text-on-surface-variant">Pick date and time
              <input type="datetime-local" aria-label="Snooze until date and time" value={custom} onChange={(e) => setCustom(e.target.value)} className={`${field} mt-1`} />
            </label>
            <button className={`${btnPrimary} w-full justify-center`} disabled={busy || !customOk} onClick={() => customDate && pick(customDate)}>Snooze</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The Snoozed folder: what is out of the inbox and when it comes back. */
/**
 * The snoozed conversations of the mailboxes on screen. `keys` are the page's
 * mailbox keys (core: `provider` for a default account, `provider:<address>`
 * for a further one); every snooze of the user is read once and sorted out here.
 */
export function SnoozedPane({ keys, onUnsnoozed }: { keys: string[]; onUnsnoozed: (text: string) => void }) {
  const list = useQuery({
    queryKey: ['email-snoozed'],
    queryFn: () => api.get<{ snoozed: Snoozed[] }>('/email/snoozed'),
    refetchInterval: 60_000,
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const unsnooze = async (item: Snoozed) => {
    setBusy(item.id); setError('');
    try {
      await api.post(`/email/snoozed/${encodeURIComponent(item.id)}/unsnooze`, {});
      await list.refetch();
      onUnsnoozed(`"${item.subject || '(no subject)'}" is back in the inbox.`);
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  const dismiss = async (item: Snoozed) => {
    setBusy(item.id); setError('');
    try {
      await api.post(`/email/snoozed/${encodeURIComponent(item.id)}/dismiss`, {});
      await list.refetch();
      onUnsnoozed(`"${item.subject || '(no subject)'}" stays in the archive.`);
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };
  const rows = (list.data?.snoozed ?? []).filter((s) => keys.includes(s.account ? `${s.provider}:${s.account}` : s.provider));
  return (
    <section aria-label="Snoozed" className="flex min-h-0 flex-col bg-surface lg:col-span-2">
      <div className="flex min-h-10 items-center border-b border-outline-variant/30 px-3 py-1.5 text-sm text-on-surface-variant">
        Snoozed conversations come back to the inbox, unread, at the time shown.
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isLoading && <ListSkeleton rows={4} />}
        {(error || list.error) && <p role="alert" className="p-4 text-sm text-error">{error || (list.error as Error).message}</p>}
        {!list.isLoading && !list.error && rows.length === 0 && <p className="p-8 text-center text-sm text-on-surface-variant">Nothing is snoozed.</p>}
        <ul className="divide-y divide-outline-variant/30">
          {rows.map((item) => (
            <li key={item.id} className="flex items-start gap-3 px-3 py-2.5">
              <AlarmClock className="mt-1 h-4 w-4 shrink-0 text-on-surface-variant" />
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-on-surface">{who(item.from)}{item.messageIds.length > 1 && <span className="ml-1.5 text-xs text-on-surface-variant">{item.messageIds.length}</span>}</span>
                  {keys.length > 1 && <span className="max-w-28 shrink-0 truncate rounded bg-surface-container-high px-1 text-[10px] text-on-surface-variant">{item.account ?? providerLabel(item.provider)}</span>}
                  <span className="shrink-0 text-xs text-on-surface-variant">Back {when(new Date(item.wakeAt))}</span>
                </p>
                <p className="truncate text-sm text-on-surface-variant">{item.subject || '(no subject)'}</p>
                <p className="truncate text-xs text-on-surface-variant/80">{item.snippet}</p>
                {item.error && (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-error">
                    <AlertTriangle className="h-3.5 w-3.5" /> Could not bring it back: {item.error}{item.gaveUp ? ' No more automatic tries: bring it back by hand, or leave it in the archive.' : item.retryAt ? ` Trying again ${when(new Date(item.retryAt))}.` : ''}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <button className={btn} disabled={busy === item.id} onClick={() => unsnooze(item)}>{busy === item.id && <Loader2 className="h-4 w-4 animate-spin" />} {item.gaveUp ? 'Try again' : 'Unsnooze'}</button>
                {item.gaveUp && <button className="text-xs text-on-surface-variant underline hover:text-on-surface" disabled={busy === item.id} onClick={() => dismiss(item)}>Leave in archive</button>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
