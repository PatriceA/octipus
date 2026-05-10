'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';

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
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const detail = useQuery({
    queryKey: ['artifact', id],
    queryFn: () => api.get<{ artifact: Artifact }>(`/artifacts/${id}`),
  });
  const sources = useQuery({
    queryKey: ['artifact', id, 'sources'],
    queryFn: () => api.get<{ sources: DataSource[] }>(`/artifacts/${id}/data-sources`),
  });
  const versions = useQuery({
    queryKey: ['artifact', id, 'versions'],
    queryFn: () => api.get<{ versions: Version[] }>(`/artifacts/${id}/versions`),
  });
  const links = useQuery({
    queryKey: ['artifact', id, 'links'],
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
  if (!a) return <div className="p-6 text-red-400">Not found</div>;

  // Use the API-supplied embed URL — respects subdomain vs path-prefix.
  const embedSrc = a.embedUrl;

  return (
    <div className="grid grid-cols-[1fr_320px] gap-6 p-6">
      <main>
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{a.title}</h1>
            <div className="text-xs text-on-surface-variant">
              {a.type} · {a.visibility} · /{a.slug}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={a.outerUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-[#262626] px-3 py-1 text-sm hover:bg-[#262626]"
            >
              Open
            </a>
            <button
              onClick={() => refresh.mutate()}
              className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500"
            >
              {refresh.isPending ? 'Refreshing…' : 'Refresh now'}
            </button>
            {confirmDelete ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="text-red-400">Delete?</span>
                <button
                  onClick={() => del.mutate()}
                  disabled={del.isPending}
                  className="rounded bg-red-600 px-2 py-1 text-white hover:bg-red-500"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="rounded border border-[#262626] px-2 py-1 hover:bg-[#262626]"
                >
                  No
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="rounded border border-red-900 px-3 py-1 text-sm text-red-400 hover:bg-red-900/20"
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
                  {s.lastError && <div className="mt-1 text-red-400">{s.lastError}</div>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Versions">
          <ul className="space-y-1 text-xs">
            {versions.data?.versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between">
                <span className="truncate">{v.changeSummary || '(no summary)'}</span>
                <button
                  onClick={() => restore.mutate(v.id)}
                  className="text-blue-400 hover:underline"
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
            className="mb-2 rounded bg-[#1a1a1a] px-3 py-1 text-xs hover:bg-[#262626]"
          >
            Mint share link
          </button>
          {mintLink.data && (
            <div className="break-all rounded bg-yellow-900/20 p-2 text-[10px] text-yellow-300">
              token: {mintLink.data.token}
            </div>
          )}
          <ul className="mt-2 space-y-1 text-xs">
            {links.data?.links.map((l) => (
              <li key={l.id} className="text-on-surface-variant">
                expires {new Date(l.expiresAt).toLocaleString()}
                {l.revokedAt && <span className="text-red-400"> (revoked)</span>}
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
