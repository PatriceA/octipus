'use client';

import { Check, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Priority = 'low' | 'normal' | 'high';
interface Clef { priority: Priority; priorityConfidence: number; category: string; categoryConfidence: number }
interface ReviewItem {
  messageId: string; from: string; subject: string; snippet: string;
  clef: Clef | null;
  label: { priority: Priority; category: string; source: 'user' | 'model'; model: string | null } | null;
  disagreement: boolean;
}
interface Fit { threshold: number; labelled: number; accepted: number; accuracy: number | null; fitted: boolean }
interface Progress { total: number; labelled: number; decided: number; model: string; done: boolean; error?: string }
interface Review {
  items: ReviewItem[]; pending: number; progress: Progress | null;
  stats: { labelledByOwner: number; labelledByModel: number; fit: { priority: Fit; category: Fit } };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function fitText(name: string, f: Fit): string {
  if (f.threshold > 1) return `${name}: never accepted — no threshold reaches 90% on ${f.labelled} labels`;
  const how = f.fitted ? `fitted on ${f.labelled} labels` : `default, ${f.labelled} labels so far`;
  return `${name}: accepts ≥ ${f.threshold.toFixed(2)} (${how}; ${f.accepted} accepted${f.accuracy === null ? '' : `, ${pct(f.accuracy)} right`})`;
}

/**
 * Mails the decision model was unsure of, or where it and the reference model
 * disagree. The owner's label wins from then on and calibrates the model.
 */
export function TriageReview({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Review | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [limit, setLimit] = useState(300);
  const [picks, setPicks] = useState<Record<string, { priority: Priority; category: string }>>({});
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setData(await api.get<Review>('/email/triage/review')); } catch (err) { setError((err as Error).message); }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load once on open
    load();
    api.get<{ categories: Record<string, string> }>('/email/categories').then((r) => setCategories(Object.keys(r.categories))).catch(() => {});
    api.get<{ models: Array<{ name: string; provider: string; isEnabled: boolean }> }>('/models')
      .then((r) => setModels(r.models.filter((m) => m.isEnabled && m.provider !== 'cli').map((m) => m.name)))
      .catch(() => {});
  }, [load]);

  const running = data?.progress && !data.progress.done;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [running, load]);

  const pick = (it: ReviewItem) => picks[it.messageId] ?? (it.label ? { priority: it.label.priority, category: it.label.category } : it.clef ? { priority: it.clef.priority, category: it.clef.category } : { priority: 'normal' as Priority, category: 'other' });
  const setPick = (it: ReviewItem, p: Partial<{ priority: Priority; category: string }>) => setPicks((x) => ({ ...x, [it.messageId]: { ...pick(it), ...p } }));

  const save = async (it: ReviewItem) => {
    setSaving(it.messageId);
    try {
      await api.put(`/email/triage/label/${encodeURIComponent(it.messageId)}`, pick(it));
      setData((d) => d && { ...d, pending: d.pending - 1, items: d.items.filter((x) => x.messageId !== it.messageId) });
    } catch (err) { setError((err as Error).message); } finally { setSaving(''); }
  };

  const startBacklog = async () => {
    setError('');
    try {
      await api.post('/email/triage/backlog', { model, limit });
      await load();
    } catch (err) { setError((err as Error).message); }
  };

  const p = data?.progress;
  return (
    <div className="rounded-xs border border-outline-variant/10 bg-surface p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-on-surface">Triage review {data && <span className="text-on-surface-variant">— {data.pending} waiting</span>}</p>
        <button onClick={onClose} aria-label="Close review" className="text-on-surface-variant hover:text-on-surface"><X className="w-4 h-4" /></button>
      </div>
      {error && <p className="text-sm text-error">{error}</p>}
      {data && (
        <div className="text-xs text-on-surface-variant space-y-0.5">
          <p>Labels: {data.stats.labelledByOwner} yours · {data.stats.labelledByModel} by a model</p>
          <p>{fitText('Priority', data.stats.fit.priority)}</p>
          <p>{fitText('Category', data.stats.fit.category)}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm border-t border-outline-variant/10 pt-3">
        <span className="text-on-surface-variant text-xs">Label the inbox with</span>
        <select aria-label="Reference model" value={model} onChange={(e) => setModel(e.target.value)} className="rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-sm text-on-surface">
          <option value="">pick a model…</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <input aria-label="Number of mails" type="number" min={1} max={2000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="w-20 rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-sm text-on-surface" />
        <span className="text-on-surface-variant text-xs">mails</span>
        <button onClick={startBacklog} disabled={!model || !!running || limit < 1} className="px-3 py-1.5 text-sm border border-outline-variant/20 rounded-full hover:bg-surface-container-high text-on-surface disabled:opacity-50">Start</button>
        {p && (
          <span className="text-xs text-on-surface-variant inline-flex items-center gap-1.5">
            {running && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {p.error ? <span className="text-error">failed: {p.error}</span> : `${p.model}: ${p.labelled}/${p.total} labelled · ${p.decided}/${p.total} through the decision model${p.done ? ' · done' : ''}`}
          </span>
        )}
      </div>

      <div className="space-y-2">
        {data?.items.map((it) => {
          const cur = pick(it);
          return (
            <div key={it.messageId} className="rounded-xs border border-outline-variant/10 px-3 py-2 space-y-1.5">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-xs text-on-surface-variant truncate max-w-48">{it.from}</span>
                <span className="text-sm text-on-surface truncate">{it.subject}</span>
                {it.disagreement && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-error/10 text-error shrink-0">disagree</span>}
              </div>
              <p className="text-xs text-on-surface-variant line-clamp-2">{it.snippet}</p>
              <p className="text-[11px] text-on-surface-variant">
                {it.clef && <>decision model: {it.clef.priority} ({pct(it.clef.priorityConfidence)}) / {it.clef.category} ({pct(it.clef.categoryConfidence)})</>}
                {it.label && <> · {it.label.model ?? 'model'}: {it.label.priority} / {it.label.category}</>}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {(['low', 'normal', 'high'] as const).map((pr) => (
                  <button key={pr} onClick={() => setPick(it, { priority: pr })} aria-pressed={cur.priority === pr}
                    className={`text-xs px-2.5 py-1 rounded-full border ${cur.priority === pr ? 'border-primary/40 bg-primary-container/30 text-on-surface' : 'border-outline-variant/20 text-on-surface-variant hover:bg-surface-container-high'}`}>
                    {pr}
                  </button>
                ))}
                <select aria-label="Category" value={cur.category} onChange={(e) => setPick(it, { category: e.target.value })} className="rounded-xs border border-outline-variant/20 bg-surface px-2 py-1 text-xs text-on-surface">
                  {(categories.includes(cur.category) ? categories : [cur.category, ...categories]).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <button onClick={() => save(it)} disabled={saving === it.messageId} className="ml-auto px-3 py-1 text-xs bg-linear-to-r from-primary to-primary-container text-on-primary rounded-full hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" /> Confirm
                </button>
              </div>
            </div>
          );
        })}
        {data && data.items.length === 0 && <p className="text-sm text-on-surface-variant">Nothing to review.</p>}
      </div>
    </div>
  );
}
