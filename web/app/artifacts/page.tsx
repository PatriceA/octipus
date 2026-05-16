'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';

interface Artifact {
  id: string;
  slug: string;
  title: string;
  type: string;
  visibility: string;
  updatedAt: string;
  embedUrl: string;
  outerUrl: string;
}

interface HostMeta {
  mode:
    | { mode: 'subdomain'; host: string; proto: string }
    | { mode: 'path-prefix'; pathPrefix: string };
}

export default function ArtifactsPage() {
  const qc = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['artifacts'],
    queryFn: () => api.get<{ artifacts: Artifact[] }>('/artifacts'),
  });
  const meta = useQuery({
    queryKey: ['artifacts', '_meta'],
    queryFn: () => api.get<HostMeta>('/artifacts/_meta'),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/artifacts/${id}`),
    onSuccess: () => {
      setConfirmId(null);
      qc.invalidateQueries({ queryKey: ['artifacts'] });
    },
  });

  if (list.isLoading) return <div className="p-6">Loading…</div>;
  if (list.error) return <div className="p-6 text-error">Failed to load artifacts</div>;

  const items = list.data?.artifacts ?? [];
  const mode = meta.data?.mode;

  return (
    <div className="p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Live Artifacts</h1>
          {mode && (
            <p className="mt-1 text-xs text-on-surface-variant">
              {mode.mode === 'subdomain'
                ? `Hosting at ${mode.proto}://${mode.host}/a/<slug>`
                : `Hosting locally at ${mode.pathPrefix}/a/<slug> — set artifacts.host in Settings → Configuration → Live Artifacts to use a subdomain.`}
            </p>
          )}
        </div>
        <Link
          href="/artifacts/new"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-on-surface hover:bg-primary"
        >
          New artifact
        </Link>
      </header>

      {items.length === 0 ? (
        <p className="text-on-surface-variant">
          No artifacts yet — create one or have an agent build one with the{' '}
          <code className="rounded bg-surface-container px-1">create_live_artifact</code> tool.
        </p>
      ) : (
        <ul className="divide-y divide-[#262626] rounded-md border border-[#262626]">
          {items.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-3 p-4 hover:bg-surface-container"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href={`/artifacts/${a.id}`}
                  className="text-base font-medium hover:underline"
                >
                  {a.title}
                </Link>
                <div className="mt-1 text-xs text-on-surface-variant">
                  {a.type} · {a.visibility} · /{a.slug}
                </div>
              </div>
              <span className="text-xs text-on-surface-variant">
                {new Date(a.updatedAt).toLocaleString()}
              </span>
              <a
                href={a.outerUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                title="Open hosted page"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
              {confirmId === a.id ? (
                <span className="flex items-center gap-2 text-xs">
                  <span className="text-error">Delete?</span>
                  <button
                    onClick={() => del.mutate(a.id)}
                    className="rounded bg-red-600 px-2 py-1 text-on-surface hover:bg-error"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmId(null)}
                    className="rounded border border-[#262626] px-2 py-1 hover:bg-surface-container-high"
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmId(a.id)}
                  className="rounded p-1 text-on-surface-variant hover:bg-red-900/30 hover:text-error"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
