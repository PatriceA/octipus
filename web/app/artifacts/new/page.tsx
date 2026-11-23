'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { SlugConflict } from '../../../../src/shared/artifacts';

const TYPES = ['dashboard', 'news', 'rss', 'table', 'html'] as const;

export default function NewArtifactPage() {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('dashboard');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SlugConflict | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    setConflict(null);
    try {
      const res = await api.post<{ artifact: { id: string } }>('/artifacts', {
        slug,
        title,
        type,
      });
      router.push(`/artifacts/view?id=${res.artifact.id}`);
    } catch (e) {
      const body = e instanceof ApiError && e.status === 409 ? e.body : null;
      if (body && (body.code === 'slug_taken' || body.code === 'public_slug_taken')) {
        setConflict(body as unknown as SlugConflict);
      } else {
        setError((e as Error).message);
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-base font-semibold lowercase"><span className="text-outline">octi:</span><span className="text-on-surface">~/artifacts/new</span><span className="text-primary font-bold"> $</span><span aria-hidden className="term-caret" /></h1>
      <div className="space-y-4">
        <Field label="Slug">
          <input
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setConflict(null);
            }}
            aria-invalid={conflict !== null}
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
        {conflict && (
          <div role="alert" className="rounded bg-error-container/60 p-3 text-sm text-error">
            <p>
              {conflict.code === 'slug_taken'
                ? <>The slug <code className="font-mono">{conflict.slug}</code> is already used by another artifact in this workspace.</>
                : <>The slug <code className="font-mono">{conflict.slug}</code> is already the public link of an artifact in another workspace.</>}
            </p>
            {conflict.suggestedSlug ? (
              <button
                type="button"
                onClick={() => {
                  setSlug(conflict.suggestedSlug as string);
                  setConflict(null);
                }}
                className="mt-2 rounded border border-error/50 px-2 py-1 text-on-surface hover:bg-error-container"
              >
                Use <span className="font-mono">{conflict.suggestedSlug}</span> instead
              </button>
            ) : (
              <p className="mt-1">Pick another slug.</p>
            )}
          </div>
        )}
        {error && <div className="rounded bg-error-container/60 p-3 text-sm text-error">{error}</div>}
        <button
          disabled={!slug || !title || submitting}
          onClick={submit}
          className="rounded-xs bg-primary px-4 py-2 text-sm text-on-primary hover:bg-primary-dim disabled:opacity-50"
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
