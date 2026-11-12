'use client';

import { RoleAgentsPanel } from '@/components/tasks/work-board';
import { HeartPulse, Loader2, Mail } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { usePageOn } from '@/lib/modules';
import { api } from '@/lib/api';

interface HeartbeatMe {
  enabled: boolean;
  intervalMinutes: number | null;
  watchEmail: boolean;
  watchEmailSince: string | null;
  server: {
    enabled: boolean;
    intervalMinutes: number;
    quietHoursStart: number;
    quietHoursEnd: number;
    quietHoursTimezone: string;
    maxRunsPerDay: number;
    probeEmail: boolean;
  };
  mailbox: 'google' | 'microsoft' | null;
  standingInstructions: boolean;
  recentEmail: Array<{ provider: string; messageId: string; outcome: string | null; note: string | null; taskId: string | null; handledAt: string | null }>;
}

const OUTCOME_LABEL: Record<string, string> = {
  no_action: 'No action needed',
  task: 'Added to your tasks',
  notified: 'Told you',
  drafted: 'Reply draft saved',
  replied: 'Replied',
  archived: 'Archived',
  other: 'Other',
};

const INTERVALS = [5, 10, 15, 30, 60, 120, 240];

/**
 * The caller's own heartbeat: the periodic check-in that looks at due tasks,
 * notifications, meetings, failing pull requests and (when watched) new mail,
 * and only starts an agent when one of them has something.
 */
export function HeartbeatTab() {
  const [data, setData] = useState<HeartbeatMe | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { user } = useAuth();
  const inboxOn = usePageOn()('/email');

  const load = useCallback(async () => {
    try {
      setData(await api.get<HeartbeatMe>('/heartbeat/me'));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial read; load sets state from the server
    load();
  }, [load]);

  const save = async (patch: Partial<Pick<HeartbeatMe, 'enabled' | 'intervalMinutes' | 'watchEmail'>>) => {
    setSaving(true);
    try {
      const res = await api.put<{ error?: string }>('/heartbeat/me', patch);
      if (res?.error) setError(res.error);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return error
      ? <p className="text-sm text-error">{error}</p>
      : <div className="flex items-center justify-center py-12 text-on-surface-variant"><Loader2 className="w-5 h-5 animate-spin mr-2" />Loading...</div>;
  }

  const { server } = data;
  const interval = data.intervalMinutes ?? server.intervalMinutes;
  const quiet = server.quietHoursStart === server.quietHoursEnd
    ? 'no quiet hours'
    : `quiet ${String(server.quietHoursStart).padStart(2, '0')}:00–${String(server.quietHoursEnd).padStart(2, '0')}:00 ${server.quietHoursTimezone}`;

  return (
    <div className="space-y-6" data-testid="heartbeat-settings">
      <div>
        <h2 className="text-lg font-extrabold tracking-tighter text-on-surface flex items-center gap-2">
          <HeartPulse className="w-5 h-5 text-primary" /> Heartbeat
        </h2>
        <p className="text-sm text-on-surface-variant mt-1">
          A background check, without a chat or AI call. Octipus checks pending tasks, important unread notifications,
          upcoming meetings, failing pull requests and optional new email. New findings appear in notifications.
          Ready tasks assigned to a role start that role’s worker; paused role settings are respected.
        </p>
      </div>

      {!server.enabled && (
        <div role="note" className="bg-error/10 border border-error/20 rounded-xs px-3 py-2 text-xs text-on-surface">
          <p>The heartbeat is switched off on this server, so your enabled preference cannot run yet.</p>
          {user?.isAdmin ? <p>Turn on Run my heartbeat below to enable checks. This also enables the server heartbeat service.</p> : <p>An admin needs to enable heartbeat on this server.</p>}
          {data.enabled && <button type="button" disabled={saving} onClick={() => void save({ enabled: false })} className="mt-2 text-primary underline">Turn off saved personal heartbeat</button>}
        </div>
      )}
      {error && <p className="text-sm text-error">{error}</p>}

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={data.enabled && server.enabled}
          disabled={saving || (!server.enabled && !user?.isAdmin)}
          onChange={(e) => save({ enabled: e.target.checked })}
          className="w-4 h-4 rounded accent-primary mt-0.5"
          aria-label="Run my heartbeat"
        />
        <div>
          <span className="text-on-surface">Run my heartbeat</span>
          <p className="text-xs text-on-surface-variant mt-0.5">
            At most {server.maxRunsPerDay} updates or task runs a day, {quiet}. Background checks use no model tokens.
          </p>
        </div>
      </label>

      <label className="flex items-center gap-3 text-sm text-on-surface pl-7">
        Check every
        <select
          value={data.intervalMinutes ?? ''}
          disabled={saving}
          onChange={(e) => save({ intervalMinutes: e.target.value ? Number(e.target.value) : null })}
          className="rounded-xs border border-outline-variant/30 bg-surface px-2 py-1 text-sm"
          aria-label="Check interval"
        >
          <option value="">{server.intervalMinutes} minutes (server default)</option>
          {INTERVALS.filter((m) => m !== server.intervalMinutes).map((m) => (
            <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>
          ))}
        </select>
      </label>

      {/* The inbox watch is the `inbox` module's (docs/MODULES.md). */}
      {inboxOn && (
      <div className="border-t border-outline-variant/20 pt-4 space-y-3">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={data.watchEmail}
            disabled={saving || !data.mailbox || !server.probeEmail}
            onChange={(e) => save({ watchEmail: e.target.checked })}
            className="w-4 h-4 rounded accent-primary mt-0.5"
            aria-label="Watch my inbox"
          />
          <div>
            <span className="text-on-surface flex items-center gap-1.5"><Mail className="w-4 h-4" /> Watch my inbox</span>
            <p className="text-xs text-on-surface-variant mt-0.5">
              Check for new email every {interval} minutes and notify you without starting an agent. This watch does not
              create tasks or drafts, send mail, or mark mail read. Newsletters and social mail are skipped; mail from
              before you turn this on is never looked at.
            </p>
            {!data.mailbox && <p className="text-xs text-error mt-1">Connect Google or Microsoft 365 under Integrations first.</p>}
            {!server.probeEmail && <p className="text-xs text-error mt-1">The inbox watch is switched off on this server (heartbeat.probeEmail).</p>}
            {data.watchEmail && data.watchEmailSince && (
              <p className="text-xs text-on-surface-variant mt-1">Watching mail received since {new Date(data.watchEmailSince).toLocaleString()}.</p>
            )}
          </div>
        </label>

        {data.recentEmail.length > 0 && (
          <div className="pl-7">
            <p className="text-xs uppercase tracking-wide text-on-surface-variant mb-1">What the agent did with recent mail</p>
            <ul className="space-y-1 text-xs">
              {data.recentEmail.map((r) => (
                <li key={`${r.provider}:${r.messageId}`} className="flex gap-2">
                  <span className="text-on-surface-variant w-36 shrink-0">{r.handledAt ? new Date(r.handledAt).toLocaleString() : ''}</span>
                  <span className="text-on-surface">{OUTCOME_LABEL[r.outcome ?? ''] ?? r.outcome}</span>
                  {r.note && <span className="text-on-surface-variant truncate">— {r.note}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      )}

      <RoleAgentsPanel refreshKey={`${data.enabled}:${server.enabled}`} controls onChanged={load} />

      <div className="border-t border-outline-variant/20 pt-4 text-xs text-on-surface-variant space-y-1">
        <p>
          <span className="text-on-surface">Standing instructions:</span>{' '}
          {data.standingInstructions
            ? 'your note with the slug "heartbeat" guides workers when there is actual task work.'
            : 'none yet. Write a note with the slug "heartbeat" (who you are, what counts as urgent, what the agent may do on its own) and pin it.'}
        </p>
        <p>
          Assign a to-do to a role on the <a href="/tasks" className="underline text-primary">tasks page</a>, and the personal heartbeat picks it up. Configure a role here to override that behavior or pause it.
        </p>
      </div>
    </div>
  );
}
