'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';

const TYPES = ['dashboard', 'news', 'rss', 'table', 'html'] as const;

export default function NewArtifactPage() {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('dashboard');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.post<{ artifact: { id: string } }>('/artifacts', {
        slug,
        title,
        type,
      });
      router.push(`/artifacts/${res.artifact.id}`);
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">New Live Artifact</h1>
      <div className="space-y-4">
        <Field label="Slug">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="w-full rounded border border-[#262626] bg-transparent p-2 font-mono"
            placeholder="my-dashboard"
          />
        </Field>
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded border border-[#262626] bg-transparent p-2"
          />
        </Field>
        <Field label="Type">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
            className="w-full rounded border border-[#262626] bg-transparent p-2"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        {error && <div className="rounded bg-red-900/30 p-3 text-sm text-red-300">{error}</div>}
        <button
          disabled={!slug || !title || submitting}
          onClick={submit}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-on-surface hover:bg-blue-500 disabled:opacity-50"
        >
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm text-on-surface-variant">{label}</span>
      {children}
    </label>
  );
}
