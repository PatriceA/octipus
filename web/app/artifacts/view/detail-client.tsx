'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useWorkspaceId } from '@/lib/workspace-context';
import { AGENT_REFRESH_INTERVAL_CHOICES, type AgentRefreshView } from '../../../../src/shared/artifacts';

interface Artifact {
  id: string;
  slug: string;
  title: string;
  type: string;
  visibility: string;
  workspaceId: string;
  currentVersionId: string | null;
  embedUrl: string;
  outerUrl: string;
  appUrl?: string;
  shareUrl?: string;
}
interface DataSource {
  id: string;
  name: string;
  kind: string;
  refreshSeconds: number;
  lastStatus: string;
  lastError: string | null;
  lastRunAt: string | null;
}
interface Version {
  id: string;
  changeSummary: string;
  createdAt: string;
}
interface ShareLink {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export default function ArtifactDetailPage() {
  const workspaceId = useWorkspaceId();
  const id = useSearchParams().get('id') ?? '';
  const router = useRouter();
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const detail = useQuery({
    queryKey: ['artifact', id, workspaceId],
    queryFn: () => api.get<{ artifact: Artifact }>(`/artifacts/${id}`),
  });
  const sources = useQuery({
    queryKey: ['artifact', id, 'sources', workspaceId],
    queryFn: () => api.get<{ sources: DataSource[] }>(`/artifacts/${id}/data-sources`),
  });
  const versions = useQuery({
    queryKey: ['artifact', id, 'versions', workspaceId],
    queryFn: () => api.get<{ versions: Version[] }>(`/artifacts/${id}/versions`),
  });
  const links = useQuery({
    queryKey: ['artifact', id, 'links', workspaceId],
    queryFn: () => api.get<{ links: ShareLink[] }>(`/artifacts/${id}/share-links`),
  });

  const refresh = useMutation({
    mutationFn: () => api.post(`/artifacts/${id}/refresh`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artifact', id, 'sources'] }),
  });
  const mintLink = useMutation({
    mutationFn: () => api.post<{ token: string; expiresAt: string }>(`/artifacts/${id}/share-links`, { ttlSeconds: 3600 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artifact', id, 'links'] }),
  });
  const restore = useMutation({
    mutationFn: (versionId: string) => api.post(`/artifacts/${id}/versions/${versionId}/restore`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['artifact', id] }),
  });
  const del = useMutation({
    mutationFn: () => api.delete(`/artifacts/${id}`),
    onSuccess: () => router.push('/artifacts'),
  });

  if (detail.isLoading) return <div className="p-6">Loading…</div>;
  const a = detail.data?.artifact;
  if (!a) return <div className="p-6 text-error">Not found</div>;

  // Always load via the same-origin path-prefix mount so the user's session
  // cookie travels with the request — `workspace` / `private` visibilities
  // need auth, and a cross-origin iframe to the artifacts subdomain drops
  // the cookie. next.config.mjs proxies /__artifacts__/* to the API server.
  const embedSrc = `/__artifacts__/a/${encodeURIComponent(a.slug)}/embed`;
  const openHref = a.shareUrl ?? a.outerUrl;

  return (
    <div className="grid grid-cols-[1fr_320px] gap-6 p-6">
      <main>
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold"><span className="text-outline text-sm">~/artifacts/ </span>{a.title}</h1>
            <div className="text-xs text-on-surface-variant">
              {a.type} · {a.visibility} · /{a.slug}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={openHref}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-[#262626] px-3 py-1 text-sm hover:bg-surface-container-high"
            >
              Open
            </a>
            <button
              onClick={() => refresh.mutate()}
              className="rounded-xs bg-primary px-3 py-1 text-sm text-on-primary hover:bg-primary-dim"
            >
              {refresh.isPending ? 'Refreshing…' : 'Refresh now'}
            </button>
            {confirmDelete ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="text-error">Delete?</span>
                <button
                  onClick={() => del.mutate()}
                  disabled={del.isPending}
                  className="rounded-xs border border-error/50 bg-error-container/60 px-2 py-1 text-error hover:bg-error-container"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="rounded border border-[#262626] px-2 py-1 hover:bg-surface-container-high"
                >
                  No
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="rounded border border-error/40 px-3 py-1 text-sm text-error hover:bg-error-container/60"
              >
                Delete
              </button>
            )}
          </div>
        </header>

        <iframe
          sandbox="allow-scripts"
          src={embedSrc}
          className="h-[80vh] w-full rounded-md border border-[#262626]"
        />
      </main>

      <aside className="space-y-6">
        <Section title="Data sources">
          {sources.data?.sources.length === 0 ? (
            <p className="text-xs text-on-surface-variant">No sources attached.</p>
          ) : (
            <ul className="space-y-2">
              {sources.data?.sources.map((s) => (
                <li key={s.id} className="rounded border border-[#262626] p-2 text-xs">
                  <div className="font-medium">
                    {s.name} <span className="text-on-surface-variant">({s.kind})</span>
                  </div>
                  <div className="text-on-surface-variant">
                    refresh {s.refreshSeconds}s · {s.lastStatus}
                  </div>
                  {s.lastError && <div className="mt-1 text-error">{s.lastError}</div>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <AgentRefreshSection id={id} workspaceId={workspaceId} />

        <Section title="Versions">
          <ul className="space-y-1 text-xs">
            {versions.data?.versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between">
                <span className="truncate">{v.changeSummary || '(no summary)'}</span>
                <button
                  onClick={() => restore.mutate(v.id)}
                  className="text-primary hover:underline"
                >
                  restore
                </button>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Share links">
          <button
            onClick={() => mintLink.mutate()}
            className="mb-2 rounded bg-surface-container px-3 py-1 text-xs hover:bg-surface-container-high"
          >
            Mint share link
          </button>
          {mintLink.data && (
            <div className="break-all rounded bg-warning-container/60 p-2 text-[10px] text-warning">
              token: {mintLink.data.token}
            </div>
          )}
          <ul className="mt-2 space-y-1 text-xs">
            {links.data?.links.map((l) => (
              <li key={l.id} className="text-on-surface-variant">
                expires {new Date(l.expiresAt).toLocaleString()}
                {l.revokedAt && <span className="text-error"> (revoked)</span>}
              </li>
            ))}
          </ul>
        </Section>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-on-surface-variant">{title}</h2>
      {children}
    </section>
  );
}

const INTERVAL_LABELS: Record<number, string> = {
  60: 'Every hour',
  360: 'Every 6 hours',
  1440: 'Every day',
  10080: 'Every week',
};

/**
 * Agent refresh (docs/ARTIFACTS.md#agent-refresh): the owner's instruction,
 * schedule, a "Refresh with agent" button and the last attempt. Hidden for
 * anyone but the owner (the API answers 403).
 */
function AgentRefreshSection({ id, workspaceId }: { id: string; workspaceId: string | null }) {
  const qc = useQueryClient();
  const key = ['artifact', id, 'agent-refresh', workspaceId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ refresh: AgentRefreshView | null }>(`/artifacts/${id}/agent-refresh`),
    retry: false,
    refetchInterval: (q) => (q.state.data?.refresh?.running ? 3000 : false),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { instruction?: string; intervalMinutes?: number | null }) =>
      api.put<{ refresh: AgentRefreshView | null }>(`/artifacts/${id}/agent-refresh`, body),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      setDraft(null);
    },
  });
  const run = useMutation({
    mutationFn: () => api.post(`/artifacts/${id}/agent-refresh/run`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ['artifact', id] });
    },
  });

  if (query.isError) return null;
  const r = query.data?.refresh ?? null;
  const instruction = draft ?? r?.instruction ?? '';
  const failure = run.error instanceof Error ? run.error.message : null;
  const saveError = save.error instanceof Error ? save.error.message : null;

  return (
    <Section title="Agent refresh">
      <p className="mb-2 text-xs text-on-surface-variant">
        An agent re-runs this instruction as you, on your budget, and replaces the page when it succeeds.
      </p>
      {r?.instructionSetBy === 'agent' && draft === null && (
        <div className="mb-2 rounded bg-warning-container/60 p-2 text-xs text-warning">
          Set by agent — review before enabling. Saving it marks it as yours.
        </div>
      )}
      <textarea
        value={instruction}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        placeholder="What should the agent look up and put on the page?"
        className="w-full rounded border border-[#262626] bg-surface-container p-2 text-xs"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => save.mutate({ instruction })}
          disabled={draft === null || !instruction.trim() || save.isPending}
          className="rounded bg-surface-container px-3 py-1 text-xs hover:bg-surface-container-high disabled:opacity-50"
        >
          Save
        </button>
        <select
          value={r?.intervalMinutes ?? ''}
          disabled={!r || save.isPending}
          onChange={(e) => save.mutate({ intervalMinutes: e.target.value ? Number(e.target.value) : null })}
          className="rounded border border-[#262626] bg-surface-container px-2 py-1 text-xs"
          aria-label="Refresh schedule"
        >
          <option value="">Manual only</option>
          {AGENT_REFRESH_INTERVAL_CHOICES.map((m) => (
            <option key={m} value={m}>{INTERVAL_LABELS[m] ?? `Every ${m} min`}</option>
          ))}
        </select>
      </div>
      <button
        onClick={() => run.mutate()}
        disabled={!r || r.running || run.isPending || draft !== null}
        className="mt-2 rounded-xs bg-primary px-3 py-1 text-xs text-on-primary hover:bg-primary-dim disabled:opacity-50"
      >
        {r?.running ? 'Refreshing…' : 'Refresh with agent'}
      </button>
      {saveError && <div className="mt-1 text-xs text-error">{saveError}</div>}
      {failure && <div className="mt-1 text-xs text-error">{failure}</div>}
      {r && <AgentRefreshStatus r={r} />}
    </Section>
  );
}

function AgentRefreshStatus({ r }: { r: AgentRefreshView }) {
  const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
  return (
    <div className="mt-2 space-y-1 text-xs text-on-surface-variant">
      <div>Last refreshed: {at(r.lastSuccessAt)}</div>
      {r.lastOutcome && r.lastOutcome !== 'success' && (
        <div className="text-error">
          Last attempt {r.lastOutcome === 'refused' ? 'refused' : 'failed'} ({at(r.lastAttemptAt)}): {r.lastError}
        </div>
      )}
      {r.intervalMinutes !== null && r.nextRunAt && <div>Next run: {at(r.nextRunAt)}</div>}
      {r.scheduleDisabledReason && (
        <div className="rounded bg-warning-container/60 p-2 text-warning">Schedule off: {r.scheduleDisabledReason}</div>
      )}
    </div>
  );
}
