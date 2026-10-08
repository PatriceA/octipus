'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { FilesBrowser, LeaveButton } from '@/components/spaces/remote-space';
import { api } from '@/lib/api';
import { type RemoteSpace, remoteFilesSource, remotePath, remoteSpacesKey } from '@/lib/remote-spaces';
import { useWorkspace } from '@/lib/workspace-context';

/**
 * The selected space on another install (docs/plans/federation-spec.md
 * §8.3, §9): its host and role, read live from the host; its files
 * (read-only, F-D8); whether my agent answers when addressed there; and
 * leaving it.
 */
export default function RemoteSpacePage() {
  const { activeWorkspace } = useWorkspace();
  if (activeWorkspace?.kind !== 'remote') {
    return (
      <div className="p-8 font-mono text-[13px] text-on-surface-variant" data-testid="remote-space-none">
        Pick a space on another install in the workspace picker, or join one there.
      </div>
    );
  }
  return <RemoteSpaceView key={activeWorkspace.id} remote={activeWorkspace} />;
}

function RemoteSpaceView({ remote }: { remote: RemoteSpace }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['remote-space', remote.id],
    queryFn: () => api.get<{ remoteSpace: RemoteSpace; info: Record<string, unknown> | null; refreshError?: string }>(remotePath(remote.id)),
  });
  const [error, setError] = useState<string | null>(null);
  const current = detail.data?.remoteSpace ?? remote;
  const files = useMemo(() => remoteFilesSource(remote.id), [remote.id]);

  const toggleAgent = async () => {
    try {
      await api.patch(remotePath(remote.id), { agentAnswersWhenAddressed: !current.agentAnswersWhenAddressed });
      await qc.invalidateQueries({ queryKey: ['remote-space', remote.id] });
      await qc.invalidateQueries({ queryKey: remoteSpacesKey });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="max-w-4xl space-y-6 font-mono" data-testid="remote-space">
      <div className="space-y-1">
        <h1 className="text-[15px] text-on-surface flex items-center gap-2">
          {current.spaceName}
          <span className="text-[11px] text-outline-variant" title={`Hosted by another install: ${current.hostFingerprint}`}>{current.hostBadge}</span>
        </h1>
        <p className="text-[12px] text-on-surface-variant">
          hosted at <span className="text-on-surface">{new URL(current.hostUrl.replace(/^ws/, 'http')).host}</span> · fingerprint{' '}
          <span className="text-on-surface break-all">{current.hostFingerprint}</span>
        </p>
        <p className="text-[12px] text-on-surface-variant">
          you are <span className="text-on-surface">{current.memberHandle}</span> there, as {current.role} ·{' '}
          <span className={current.link === 'up' ? 'text-tertiary' : 'text-warning'}>{current.link === 'up' ? 'connected' : 'not connected'}</span>
        </p>
        {detail.data?.refreshError && <p className="text-[11px] text-warning">The host could not be reached: {detail.data.refreshError}</p>}
        {detail.error && <p role="alert" className="text-[11px] text-error">! {(detail.error as Error).message}</p>}
      </div>

      <section className="space-y-2">
        <h2 className="section-label">my agent here</h2>
        <label className="flex items-start gap-2 text-[12px] text-on-surface cursor-pointer">
          <input type="checkbox" checked={current.agentAnswersWhenAddressed} onChange={() => void toggleAgent()} data-testid="agent-answers-toggle" />
          <span>
            Let my agent answer when addressed in a room I opened it for.
            <span className="block text-[11px] text-on-surface-variant">
              Off by default. Your agent runs here, on your models and at your cost; it posts only after you approved a post
              in that conversation, and every time once it read your private data.
            </span>
          </span>
        </label>
        {error && <p role="alert" className="text-[11px] text-error">! {error}</p>}
      </section>

      <section className="space-y-2">
        <h2 className="section-label">files</h2>
        <FilesBrowser source={files} />
      </section>

      <section className="space-y-2">
        <h2 className="section-label">leave</h2>
        <LeaveButton remote={current} />
      </section>
    </div>
  );
}
