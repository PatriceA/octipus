'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { providerLabel } from './email-shared';
import type { EmailProvider } from '../../../src/shared/email';

interface IndexStatus {
  enabled: boolean;
  mailboxes: Array<{ provider: EmailProvider; status: 'building' | 'ready' | 'stale' | 'error'; messages: number; coveredFrom: string | null; lastSyncAt: string | null; lastError: string | null }>;
}

const STATUS_TEXT: Record<IndexStatus['mailboxes'][number]['status'], string> = {
  building: 'reading the last 90 days…',
  ready: 'up to date',
  stale: 'not synced lately; lists are read from the provider',
  error: 'the last sync failed; lists are read from the provider',
};

/**
 * The owner's switch for the local index of Gmail / Outlook headers
 * (src/core/email/mail-index.ts, docs/MAIL.md): what it keeps, and how far
 * each mailbox's index is.
 */
export function EmailIndexSetting() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ['email-index'], queryFn: () => api.get<IndexStatus>('/email/index'), refetchInterval: 15_000 });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.put<IndexStatus>('/email/index', { enabled }),
    onSuccess: (data) => {
      client.setQueryData(['email-index'], data);
      void client.invalidateQueries({ queryKey: ['email-list'] });
    },
  });
  const enabled = status.data?.enabled ?? true;
  return (
    <section aria-label="Local mail index" className="mb-6 max-w-2xl space-y-2 rounded-lg border border-outline-variant/50 bg-surface p-4 text-sm">
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={enabled} disabled={!status.data || toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} />
        <span>
          <span className="font-medium text-on-surface">Keep a local index of Gmail and Outlook headers</span>
          <span className="block text-on-surface-variant">
            Lists, search and the unread count open at once instead of asking the provider each time. Stored on this server: sender, recipients,
            subject, date, folders and flags, and the provider&apos;s short preview of the last 90 days. Never the body or attachments.
            Turning it off deletes the index at once.
          </span>
        </span>
      </label>
      {status.error && <p role="alert" className="text-error">{(status.error as Error).message}</p>}
      {toggle.error && <p role="alert" className="text-error">{(toggle.error as Error).message}</p>}
      {enabled && status.data && status.data.mailboxes.length > 0 && (
        <ul className="ml-6 space-y-0.5 text-xs text-on-surface-variant">
          {status.data.mailboxes.map((m) => (
            <li key={m.provider}>
              {providerLabel(m.provider)}: {STATUS_TEXT[m.status]} · {m.messages} {m.messages === 1 ? 'message' : 'messages'}
              {m.lastSyncAt ? ` · synced ${new Date(m.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
              {m.lastError ? ` · ${m.lastError}` : ''}
            </li>
          ))}
        </ul>
      )}
      {enabled && status.data && status.data.mailboxes.length === 0 && (
        <p className="ml-6 text-xs text-on-surface-variant">Nothing indexed yet: a mailbox is read the next time you open it.</p>
      )}
    </section>
  );
}
