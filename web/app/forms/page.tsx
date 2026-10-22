'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { CARD, ErrorText, FieldInputs, type FieldValues, fromFieldValues, PRIMARY, problemsOf, toFieldValues } from '@/components/business/common';
import { api } from '@/lib/api';
import type { PublicFormView } from '../../../src/shared/business';

/**
 * `/forms/:token`: a public form (docs/RECORDS.md → Forms). No sign-in: the
 * link is the credential. It shows the form's title, intro and fields, and
 * nothing of the workspace behind it.
 */
export default function PublicFormPage() {
  const { token = '' } = useParams<{ token: string }>();
  const form = useQuery({
    queryKey: ['public-form', token],
    queryFn: () => api.get<PublicFormView>(`/forms/${encodeURIComponent(token)}`),
    retry: false,
  });
  const [values, setValues] = useState<FieldValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (form.isLoading) {
    return <main className="min-h-screen flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" /></main>;
  }
  if (form.error || !form.data) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <p className="text-on-surface-variant">This form is not available. The link may have expired or been withdrawn.</p>
      </main>
    );
  }
  const f = form.data;
  const current = values ?? toFieldValues(f.fields);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = Object.fromEntries(Object.entries(fromFieldValues(f.fields, current)).filter(([, v]) => v !== null));
      await api.post(`/forms/${encodeURIComponent(token)}`, { data });
      setDone(true);
    } catch (err) {
      setError(problemsOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex justify-center p-6 font-sans">
      <div className={`${CARD} w-full max-w-lg p-6 h-fit`}>
        <h1 className="text-xl font-semibold text-on-surface">{f.title}</h1>
        {f.intro && <p className="text-sm text-on-surface-variant mt-2 whitespace-pre-line">{f.intro}</p>}
        {done ? (
          <p className="flex items-center gap-2 text-sm text-on-surface mt-6"><CheckCircle2 className="w-5 h-5 text-tertiary" />Thank you — your answers have been sent.</p>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <FieldInputs fields={f.fields} values={current} onChange={setValues} disabled={busy} />
            <ErrorText error={error} />
            <button type="submit" className={PRIMARY} disabled={busy}>Send</button>
          </form>
        )}
      </div>
    </main>
  );
}
