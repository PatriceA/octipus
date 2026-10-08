'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Globe, Link2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { LeaveButton } from '@/components/spaces/remote-space';
import { api } from '@/lib/api';
import { type RemoteSpace, remotePath, remoteSpacesKey, useRemoteSpaces } from '@/lib/remote-spaces';
import { cn } from '@/lib/utils';

/**
 * Settings → Spaces on other installs (docs/plans/federation-spec.md §10):
 * the spaces I joined on other installs — their host and fingerprint, my
 * role and handle there, whether the link is up, whether my agent answers
 * when addressed — and the leaves still waiting for a host that was not
 * reachable (sent again every time the link opens).
 */
export function RemoteSpacesTab() {
  const qc = useQueryClient();
  const list = useRemoteSpaces();
  const [error, setError] = useState<string | null>(null);
  const toggle = async (rs: RemoteSpace) => {
    try {
      await api.patch(remotePath(rs.id), { agentAnswersWhenAddressed: !rs.agentAnswersWhenAddressed });
      await qc.invalidateQueries({ queryKey: remoteSpacesKey });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const rows = list.data?.remoteSpaces ?? [];
  const pending = list.data?.pendingLeaves ?? [];

  return (
    <div className="space-y-5 font-mono" data-testid="settings-remote-spaces">
      <div className="space-y-1">
        <h2 className="section-label">spaces on other installs</h2>
        <p className="text-[12px] text-on-surface-variant leading-relaxed">
          Spaces hosted on another Octipus that you joined from here. Their content stays on the host; this install
          keeps only the pointer below. Your agent works in them on your models, and only in the conversations you open
          for it.
        </p>
        <Link href="/spaces/join-remote" className="inline-flex items-center gap-1.5 text-[12px] text-primary hover:underline">
          <Link2 className="w-3.5 h-3.5" /> join a space on another install
        </Link>
      </div>
      {error && <p role="alert" className="text-[12px] text-error">! {error}</p>}
      {list.error && <p role="alert" className="text-[12px] text-error">! {(list.error as Error).message}</p>}
      {list.isLoading && <p className="text-[12px] text-on-surface-variant">loading…</p>}
      {!list.isLoading && rows.length === 0 && <p className="text-[12px] text-on-surface-variant">You have not joined a space on another install.</p>}
      <ul className="space-y-3">
        {rows.map((rs) => (
          <li key={rs.id} className="term-frame rounded-xs p-3 space-y-2 text-[12px]" data-testid="settings-remote-space">
            <div className="flex flex-wrap items-center gap-2">
              <Globe className="w-3.5 h-3.5 text-on-surface-variant" />
              <span className="text-on-surface">{rs.spaceName}</span>
              <span className="text-outline-variant">{rs.hostBadge}</span>
              <span className="text-on-surface-variant">{rs.role} as {rs.memberHandle}</span>
              <span className={cn('ml-auto', rs.link === 'up' ? 'text-tertiary' : 'text-on-surface-variant')}>{rs.link === 'up' ? 'connected' : 'not connected'}</span>
            </div>
            <p className="text-[11px] text-on-surface-variant break-all">host fingerprint {rs.hostFingerprint} · joined {new Date(rs.joinedAt).toLocaleDateString()}</p>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={rs.agentAnswersWhenAddressed} onChange={() => void toggle(rs)} />
              let my agent answer when addressed there (off by default)
            </label>
            <LeaveButton remote={rs} onLeft={() => void qc.invalidateQueries({ queryKey: remoteSpacesKey })} />
          </li>
        ))}
      </ul>
      {pending.length > 0 && (
        <div className="space-y-1" data-testid="settings-pending-leaves">
          <h3 className="section-label">leaves waiting for their host</h3>
          <ul className="text-[12px] text-on-surface-variant space-y-0.5">
            {pending.map((rs) => (
              <li key={rs.id}>{rs.spaceName} {rs.hostBadge} · left {rs.leftAt ? new Date(rs.leftAt).toLocaleString() : ''} · sent again when the link opens</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
