'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Play, Plus, RotateCcw, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { parseEvalLines } from '@/lib/recall-eval';
import type { NoteIndexEntry } from '@/app/notes/types';
import {
  type ContextHookEvent,
  type ContextHookKind,
  type ContextHooksResponse,
  type ContextHookStats,
  type ContextHookStatsHook,
  type ContextHookUse,
  type ContextHookView,
  NOTE_DEFAULTS,
  NOTES_INDEX_DEFAULTS,
  type Rate,
  RECALL_DEFAULTS,
  RECALL_PURPOSES,
  type RecallEvalResult,
  type RecallPurpose,
  type RecallSweepResult,
} from '../../../src/shared/context-hooks';

const EVENT_LABEL: Record<ContextHookEvent, string> = { turn_start: 'each message', worker_start: 'each agent started on a task' };
/** Where a group of agent starts comes from, for the per-event table. */
const EVENT_ROW_LABEL: Record<ContextHookEvent, string> = {
  turn_start: 'messages (root turns, plan runs, side questions)',
  worker_start: 'agents started on a task (specialists, swarm children, spawned and hook agents)',
};
const PURPOSE_LABEL: Record<RecallPurpose, string> = {
  note: 'notes',
  document: 'documents',
  knowledge_artifact: 'saved knowledge',
  image_description: 'image descriptions',
};
const KIND_LABEL: Record<ContextHookKind, string> = { recall: 'knowledge recall', note: 'context note', notes_index: 'notes index' };
const EVAL_KEY = 'octipus.recall.eval';
const MEMORY_MISSING = {
  background_model: 'no model is bound to the background topic, which extracts facts (Settings → Models)',
  embedding_model: 'no embedding model is set up, which stores them (Settings → Models)',
  extraction_off: 'memory extraction is switched off (setting memory.extractionCadence)',
} as const;
const SWEEP_REASON: Record<NonNullable<RecallSweepResult['reason']>, string> = {
  needs_both_kinds: 'No value recommended: add both questions your notes answer and questions they should not answer (=> -). With one kind only, the lowest or the highest value always wins.',
  embedding_failed: 'No value recommended: some questions could not be embedded, so the similarity bar was not applied to them. Check the embedding model (Settings → Models) and run it again.',
};

/** The settings each kind lets you change here, with their defaults and what they do. */
const FIELDS: Record<ContextHookKind, Array<{ key: string; fallback: number; hint: string }>> = {
  recall: [
    { key: 'minSimilarity', fallback: RECALL_DEFAULTS.minSimilarity, hint: 'Lowest cosine similarity a passage needs to be shown on similarity alone (0–1)' },
    { key: 'keywordCoverage', fallback: RECALL_DEFAULTS.keywordCoverage, hint: 'Share of the message\'s distinctive words a passage must contain (and at least two) to be shown on keywords (0–1)' },
    { key: 'maxGap', fallback: RECALL_DEFAULTS.maxGap, hint: 'A passage shown on similarity alone is dropped this far below the best one (0–1)' },
    { key: 'limit', fallback: RECALL_DEFAULTS.limit, hint: 'Most passages shown (1–10)' },
    { key: 'excerptChars', fallback: RECALL_DEFAULTS.excerptChars, hint: 'Most characters of each passage: a chunk this long or shorter is shown whole; a longer one shows the part with the most words of the message (100–3000)' },
    { key: 'tokenBudget', fallback: RECALL_DEFAULTS.tokenBudget, hint: 'Most tokens of the whole block (50–4000)' },
  ],
  note: [{ key: 'tokenBudget', fallback: NOTE_DEFAULTS.tokenBudget, hint: 'Most tokens of the note shown (50–4000)' }],
  notes_index: [
    { key: 'limit', fallback: NOTES_INDEX_DEFAULTS.limit, hint: 'Most note titles listed (1–50)' },
    { key: 'tokenBudget', fallback: NOTES_INDEX_DEFAULTS.tokenBudget, hint: 'Most tokens of the list (30–1000)' },
  ],
};

const pct = (r: Rate) => (r.of ? `${Math.round((r.n / r.of) * 100)}%` : '—');
const frac = (r: Rate) => `${r.n}/${r.of}`;
const inputClass = 'bg-surface-container border border-outline-variant/40 rounded px-2 py-1 text-on-surface';

function readStored(): string {
  try { return localStorage.getItem(EVAL_KEY) ?? ''; } catch { return ''; }
}

function Tile({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="bg-surface-container border border-outline-variant/60 rounded-xs p-4" title={hint}>
      <p className="text-2xl font-bold text-on-surface">{value}</p>
      <p className="text-xs text-on-surface-variant">{label}</p>
    </div>
  );
}

/** The user's notes, for a context note: picked, not typed. */
function useNotes() {
  return useQuery({ queryKey: ['notes', 'index'], queryFn: () => api.get<{ notes: NoteIndexEntry[] }>('/notes/index') });
}

/**
 * A native select of the user's notes by title (keyboard and screen readers
 * work as for any select). A slug that matches no note any more stays
 * selectable, marked, so the hook's current value is never hidden.
 */
function NotePicker({ value, onChange, id }: { value: string; onChange: (slug: string) => void; id: string }) {
  const notes = useNotes();
  if (notes.isLoading) return <Loader2 className="w-4 h-4 animate-spin" aria-label="Loading notes" />;
  if (notes.error) return <span className="text-xs text-error">Notes could not be loaded: {(notes.error as Error).message}</span>;
  const list = [...(notes.data?.notes ?? [])].sort((a, b) => a.title.localeCompare(b.title));
  if (list.length === 0 && !value) {
    return (
      <span className="text-xs text-on-surface-variant">
        No notes yet. <Link href="/notes" className="underline">Write one in Notes</Link>, then pick it here.
      </span>
    );
  }
  const known = list.some((n) => n.slug === value);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} max-w-64`}>
      {!value && <option value="">Choose a note…</option>}
      {value && !known && <option value={value}>{value} (no such note)</option>}
      {list.map((n) => <option key={n.id} value={n.slug}>{n.title}</option>)}
    </select>
  );
}

function HookRow({ hook }: { hook: ContextHookView }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (patch: Partial<ContextHookView>) => api.patch(`/context-hooks/${encodeURIComponent(hook.id)}`, patch),
    onSuccess: () => { setDraft({}); return qc.invalidateQueries({ queryKey: ['context-hooks'] }); },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/context-hooks/${encodeURIComponent(hook.id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['context-hooks'] }),
  });
  const toggleEvent = (e: ContextHookEvent) => {
    const events = hook.events.includes(e) ? hook.events.filter((x) => x !== e) : [...hook.events, e];
    save.mutate({ events });
  };
  const applyConfig = () => {
    const config: Record<string, unknown> = { ...hook.config };
    for (const [k, v] of Object.entries(draft)) {
      if (v.trim() === '') delete config[k];
      else config[k] = k === 'slug' ? v.trim() : Number(v);
    }
    save.mutate({ config });
  };
  const slug = draft.slug ?? (typeof hook.config.slug === 'string' ? hook.config.slug : '');
  // Recall's rows to search and the product manual: saved on change, as the events are.
  const purposes: RecallPurpose[] = Array.isArray(hook.config.purposes)
    ? RECALL_PURPOSES.filter((p) => (hook.config.purposes as unknown[]).includes(p))
    : [...RECALL_PURPOSES];
  const togglePurpose = (p: RecallPurpose) => {
    const next = purposes.includes(p) ? purposes.filter((x) => x !== p) : RECALL_PURPOSES.filter((x) => x === p || purposes.includes(x));
    save.mutate({ config: { ...hook.config, purposes: next } });
  };
  const productDocs = hook.config.includeProductDocs === true;

  return (
    <li className={`border border-outline-variant/60 rounded-xs p-3 ${hook.enabled ? '' : 'opacity-60'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-on-surface">{hook.name}</span>
            <span className="border px-1.5 rounded text-[11px] font-mono">{KIND_LABEL[hook.kind]}</span>
            {hook.builtin && <span className="border px-1.5 rounded text-[11px] font-mono opacity-70">built-in</span>}
          </div>
          {hook.description && <p className="text-xs text-on-surface-variant mt-1">{hook.description}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-1.5 text-sm cursor-pointer">
            <input type="checkbox" checked={hook.enabled} onChange={(e) => save.mutate({ enabled: e.target.checked })} />
            on
          </label>
          <button
            type="button"
            onClick={() => remove.mutate()}
            className="p-1 hover:bg-foreground/10 rounded"
            title={hook.builtin ? 'Reset to the default' : 'Delete'}
            aria-label={hook.builtin ? `Reset ${hook.name} to the default` : `Delete ${hook.name}`}
          >
            {hook.builtin ? <RotateCcw className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-2 text-xs">
        <span className="text-on-surface-variant">runs before</span>
        {(['turn_start', 'worker_start'] as ContextHookEvent[]).map((e) => (
          <label key={e} className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={hook.events.includes(e)} onChange={() => toggleEvent(e)} />
            {EVENT_LABEL[e]}
          </label>
        ))}
      </div>
      {hook.kind === 'recall' && (
        <div className="flex flex-wrap items-center gap-3 mt-2 text-xs">
          <span className="text-on-surface-variant" title="purposes: which knowledge-base rows recall searches (at least one)">searches</span>
          {RECALL_PURPOSES.map((p) => (
            <label key={p} className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={purposes.includes(p)}
                // The last one stays: recall needs something to search.
                disabled={purposes.length === 1 && purposes.includes(p)}
                onChange={() => togglePurpose(p)}
              />
              {PURPOSE_LABEL[p]}
            </label>
          ))}
          <label className="flex items-center gap-1 cursor-pointer" title="includeProductDocs: agents already search the manual for setup questions">
            <input type="checkbox" checked={productDocs} onChange={(e) => save.mutate({ config: { ...hook.config, includeProductDocs: e.target.checked } })} />
            Octipus manual
          </label>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2 mt-2">
        {hook.kind === 'note' && (
          <label htmlFor={`note-${hook.id}`} className="text-xs text-on-surface-variant flex flex-col gap-0.5">
            note
            <NotePicker id={`note-${hook.id}`} value={slug} onChange={(v) => setDraft({ ...draft, slug: v })} />
          </label>
        )}
        {FIELDS[hook.kind].map((f) => (
          <label key={f.key} className="text-xs text-on-surface-variant flex flex-col gap-0.5" title={f.hint}>
            {f.key}
            <input
              value={draft[f.key] ?? (hook.config[f.key] !== undefined ? String(hook.config[f.key]) : '')}
              placeholder={`${f.fallback} (default)`}
              inputMode="decimal"
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              className={`w-32 ${inputClass} font-mono`}
            />
          </label>
        ))}
        {Object.keys(draft).length > 0 && (
          <button type="button" onClick={applyConfig} className="px-3 py-1 text-xs bg-primary text-on-primary rounded-xs">Save</button>
        )}
      </div>
      {(save.error || remove.error) && (
        <p className="text-xs text-error mt-2">{((save.error || remove.error) as Error).message}</p>
      )}
    </li>
  );
}

function AddHook() {
  const qc = useQueryClient();
  const notes = useNotes();
  const [kind, setKind] = useState<ContextHookKind>('note');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const title = notes.data?.notes.find((n) => n.slug === slug)?.title;
  const add = useMutation({
    mutationFn: () => api.post('/context-hooks', {
      name: name || (kind === 'note' ? title ?? `Note ${slug}` : KIND_LABEL[kind]),
      kind,
      events: ['turn_start'],
      config: kind === 'note' ? { slug } : {},
    }),
    onSuccess: () => { setName(''); setSlug(''); return qc.invalidateQueries({ queryKey: ['context-hooks'] }); },
  });
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <label className="flex flex-col gap-0.5 text-xs text-on-surface-variant">
        kind
        <select value={kind} onChange={(e) => setKind(e.target.value as ContextHookKind)} className={inputClass}>
          <option value="note">context note (always shown)</option>
          <option value="recall">knowledge recall</option>
          <option value="notes_index">notes index</option>
        </select>
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-on-surface-variant">
        name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'note' ? title ?? '' : KIND_LABEL[kind]} className={inputClass} />
      </label>
      {kind === 'note' && (
        <label htmlFor="add-hook-note" className="flex flex-col gap-0.5 text-xs text-on-surface-variant">
          note
          <NotePicker id="add-hook-note" value={slug} onChange={setSlug} />
        </label>
      )}
      <button
        type="button"
        disabled={add.isPending || (kind === 'note' && !slug.trim())}
        onClick={() => add.mutate()}
        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-on-primary rounded-xs disabled:opacity-50"
      >
        <Plus className="w-3.5 h-3.5" /> Add hook
      </button>
      {add.error && <span className="text-xs text-error">{(add.error as Error).message}</span>}
    </div>
  );
}

function SweepTable({ sweep, recall }: { sweep: RecallSweepResult; recall: ContextHookView | undefined }) {
  const qc = useQueryClient();
  const current = typeof recall?.config.minSimilarity === 'number' ? recall.config.minSimilarity : RECALL_DEFAULTS.minSimilarity;
  const apply = useMutation({
    mutationFn: (minSimilarity: number) => {
      if (!recall) throw new Error('The Knowledge recall hook is not listed.');
      // The hook's other settings stay as the user left them.
      return api.patch(`/context-hooks/${encodeURIComponent(recall.id)}`, { config: { ...recall.config, minSimilarity } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['context-hooks'] }),
  });
  const rec = sweep.recommended;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-xs [&_th]:pr-3 [&_td]:pr-3">
          <thead className="text-on-surface-variant text-left">
            <tr><th className="py-1">minSimilarity</th><th>found the source</th><th>showed nothing when it should</th><th>mean reciprocal rank</th><th /></tr>
          </thead>
          <tbody>
            {sweep.rows.map((r) => (
              <tr key={r.minSimilarity} className={`border-t border-outline-variant/30 ${r.minSimilarity === rec ? 'bg-primary/10 font-medium' : ''}`}>
                <td className="py-1 font-mono">{r.minSimilarity.toFixed(2)}</td>
                <td>{pct(r.found)} <span className="opacity-60">({frac(r.found)})</span></td>
                <td>{pct(r.abstained)} <span className="opacity-60">({frac(r.abstained)})</span></td>
                <td>{r.mrr.toFixed(2)}</td>
                <td className="text-on-surface-variant">
                  {r.minSimilarity === rec && 'recommended'}
                  {r.minSimilarity === rec && r.minSimilarity === current && ' · '}
                  {r.minSimilarity === current && 'current'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-on-surface-variant">
        Each value is scored by how many answerable questions found their source plus how many questions that should find nothing got nothing (each as a share); a tie goes to the higher value.
        {' '}The other settings are the hook&apos;s: up to {sweep.config.limit} passages, keywordCoverage {sweep.config.keywordCoverage}, maxGap {sweep.config.maxGap}.
      </p>
      {rec === null && sweep.reason && <p className="text-xs text-warning">{SWEEP_REASON[sweep.reason]}</p>}
      {rec !== null && (
        rec === current
          ? <p className="text-xs text-on-surface-variant flex items-center gap-1"><Check className="w-3.5 h-3.5" /> The Knowledge recall hook already uses {rec}.</p>
          : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={apply.isPending || !recall}
                onClick={() => apply.mutate(rec)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-on-primary rounded-xs disabled:opacity-50"
              >
                {apply.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Use {rec} for Knowledge recall
              </button>
              <span className="text-xs text-on-surface-variant">now {current}</span>
            </div>
          )
      )}
      {apply.isSuccess && <p className="text-xs text-tertiary">Saved: Knowledge recall now uses minSimilarity {apply.variables}.</p>}
      {apply.error && <p className="text-xs text-error">{(apply.error as Error).message}</p>}
    </div>
  );
}

function EvalPanel({ recall }: { recall: ContextHookView | undefined }) {
  const [text, setText] = useState(readStored);
  const [minSimilarity, setMinSimilarity] = useState('');
  const keep = () => { try { localStorage.setItem(EVAL_KEY, text); } catch { /* the questions are not kept for next time; nothing else depends on it */ } };
  const run = useMutation({
    mutationFn: () => {
      keep();
      return api.post<RecallEvalResult>('/context-hooks/eval', {
        cases: parseEvalLines(text),
        ...(minSimilarity.trim() ? { minSimilarity: Number(minSimilarity) } : {}),
      });
    },
  });
  const sweep = useMutation({
    mutationFn: () => {
      keep();
      return api.post<RecallSweepResult>('/context-hooks/eval/sweep', { cases: parseEvalLines(text) });
    },
  });
  const cases = parseEvalLines(text);
  return (
    <section className="space-y-3">
      <h2 className="section-label">Test recall on your own knowledge</h2>
      <p className="text-xs text-on-surface-variant">
        One question per line, then <code>=&gt;</code> and what the answer is in: a note title, a file name or a phrase from it (several separated by <code>;</code>).
        End a line with <code>=&gt; -</code> for a question your notes should not answer. Searches only, no model call.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        aria-label="Eval questions"
        placeholder={'What do we charge for a website? => Pricing\nWho is our accountant? => Contacts; accountant\nWhat is the capital of France? => -'}
        className="w-full bg-surface-container border border-outline-variant/40 rounded-xs p-2 font-mono text-xs text-on-surface"
      />
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5 text-xs text-on-surface-variant">
          minSimilarity (blank: the hook&apos;s)
          <input value={minSimilarity} onChange={(e) => setMinSimilarity(e.target.value)} placeholder={String(RECALL_DEFAULTS.minSimilarity)} className={`w-28 ${inputClass} font-mono`} />
        </label>
        <button
          type="button"
          disabled={run.isPending || cases.length === 0}
          onClick={() => run.mutate()}
          className="flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-on-primary rounded-xs disabled:opacity-50"
        >
          {run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run {cases.length || ''}
        </button>
        <button
          type="button"
          disabled={sweep.isPending || cases.length === 0}
          onClick={() => sweep.mutate()}
          title="The same questions at minSimilarity 0.20 to 0.80, with the value that scores best"
          className="flex items-center gap-1 px-3 py-1.5 text-xs border border-outline-variant/60 text-on-surface rounded-xs disabled:opacity-50"
        >
          {sweep.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SlidersHorizontal className="w-3.5 h-3.5" />} Sweep thresholds
        </button>
      </div>
      {run.error && <p className="text-xs text-error">{(run.error as Error).message}</p>}
      {sweep.error && <p className="text-xs text-error">{(sweep.error as Error).message}</p>}
      {sweep.data && <SweepTable sweep={sweep.data} recall={recall} />}
      {run.data && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Tile value={pct(run.data.found)} label={`found the source (${frac(run.data.found)})`} />
            <Tile value={run.data.mrr.toFixed(2)} label="mean reciprocal rank" hint="1.00: the source was always the first passage" />
            <Tile value={pct(run.data.abstained)} label={`showed nothing when it should (${frac(run.data.abstained)})`} />
          </div>
          <p className="text-xs text-on-surface-variant">At minSimilarity {run.data.config.minSimilarity}, up to {run.data.config.limit} passages.</p>
          <ul className="space-y-1 text-xs">
            {run.data.cases.map((c, i) => (
              <li key={i} className={`border rounded-xs p-2 ${c.pass ? 'border-tertiary/40' : 'border-error/40'}`}>
                <div className="flex gap-2">
                  <span className={c.pass ? 'text-tertiary' : 'text-error'}>{c.pass ? 'pass' : 'miss'}</span>
                  <span className="text-on-surface">{c.question}</span>
                  {c.rank && <span className="opacity-60">rank {c.rank}</span>}
                </div>
                <div className="opacity-70 mt-0.5">
                  {c.hits.length ? c.hits.map((h) => `${h.title} (${h.score})`).join(' · ') : 'nothing injected'}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** "similarity 12 · coverage 3 · identifier 1", the rules a hook's shown passages qualified under. */
function qualifiedText(h: ContextHookStatsHook): string {
  const parts = (['similarity', 'coverage', 'identifier'] as const).filter((q) => h.qualified[q] > 0).map((q) => `${q} ${h.qualified[q]}`);
  return parts.length ? parts.join(' · ') : '—';
}

function UseCells({ u }: { u: ContextHookUse }) {
  return (
    <>
      <td>{u.turns}</td>
      <td>{pct(u.injected)}</td>
      <td>{pct(u.searched)}</td>
      <td title={frac(u.cited)}>{pct(u.cited)}</td>
      <td title={frac(u.used)}>{pct(u.used)}</td>
    </>
  );
}

const USE_HEADERS = ['turns', 'given passages', 'searched by tool', 'named a passage', 'used a passage'];

export default function RecallPage() {
  const [days, setDays] = useState(30);
  const hooks = useQuery({ queryKey: ['context-hooks'], queryFn: () => api.get<ContextHooksResponse>('/context-hooks') });
  const stats = useQuery({ queryKey: ['context-hooks', 'stats', days], queryFn: () => api.get<ContextHookStats>(`/context-hooks/stats?days=${days}`) });
  const s = stats.data;
  const recallHook = hooks.data?.hooks.find((h) => h.builtin === 'knowledge-recall');

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-8">
      <PageHeader
        title="recall"
        description="what Octipus puts in front of every agent before it starts — your knowledge base and notes, without the agent having to think of searching them — and how agents use it"
      />

      {hooks.data && !hooks.data.enabled && (
        <div className="text-sm text-warning border border-warning/40 rounded-xs px-3 py-2">
          Context hooks are switched off on this install (setting <code>contextHooks.enabled</code>). Nothing below runs until an admin turns them on.
        </div>
      )}
      {s && s.memory.missing.length > 0 && (
        <div className="text-sm text-warning border border-warning/40 rounded-xs px-3 py-2">
          Long-term memory is not being filled ({s.memory.facts} facts stored): {s.memory.missing.map((m) => MEMORY_MISSING[m]).join('; ')}.
          Agents get a memory block every turn, but it stays empty until this is fixed.
        </div>
      )}
      {s?.calibration.map((w) => (
        <div key={w.id} role="status" className="text-sm text-warning border border-warning/40 rounded-xs px-3 py-2">
          {w.message}
        </div>
      ))}

      <section className="space-y-3">
        <h2 className="section-label">Hooks</h2>
        {hooks.isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
        {hooks.error && <p className="text-sm text-error">{(hooks.error as Error).message}</p>}
        <ul className="space-y-2">
          {hooks.data?.hooks.map((h) => <HookRow key={h.id} hook={h} />)}
        </ul>
        <AddHook />
        {hooks.data && <p className="text-xs text-on-surface-variant">All hooks of one turn share {hooks.data.maxTokens} tokens. A blank setting takes the default shown in it.</p>}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="section-label">How agents used it</h2>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period" className={`${inputClass} text-xs`}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
        {stats.isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
        {stats.error && <p className="text-sm text-error">{(stats.error as Error).message}</p>}
        {s && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Tile value={String(s.turns)} label="agent starts" />
              <Tile value={pct(s.cited)} label={`answers naming a recalled passage (${frac(s.cited)})`}
                hint="Of the finished turns where recall showed passages: the answer named one by its title" />
              <Tile value={pct(s.used)} label={`answers using a recalled passage (${frac(s.used)})`}
                hint="Of the finished turns where recall showed passages: the answer repeats a number, code or uncommon word from one that the question did not hold" />
              <Tile value={pct(s.searched)} label={`KB or notes searched by a tool call (${frac(s.searched)})`}
                hint="By the agent, or for a message by the agent or a specialist it spawned" />
              <Tile
                value={pct(s.searchedAfterAbstain)}
                label={`searched after recall found nothing (${frac(s.searchedAfterAbstain)})`}
                hint="High: recall is missing things the agent then found itself. Lower minSimilarity, or run the threshold sweep below."
              />
            </div>

            {s.byEvent.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs [&_th]:pr-3 [&_td]:pr-3">
                  <thead className="text-on-surface-variant text-left">
                    <tr><th className="py-1">agent starts</th>{USE_HEADERS.map((h) => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {s.byEvent.map((e) => (
                      <tr key={e.event} className="border-t border-outline-variant/30">
                        <td className="py-1">{EVENT_ROW_LABEL[e.event]}</td>
                        <UseCells u={e} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {s.byModel.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs [&_th]:pr-3 [&_td]:pr-3">
                  <thead className="text-on-surface-variant text-left">
                    <tr><th className="py-1">model</th>{USE_HEADERS.map((h) => <th key={h}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {s.byModel.map((m) => (
                      <tr key={`${m.model}|${m.cli}`} className="border-t border-outline-variant/30">
                        <td className="py-1 font-mono">{m.model}{m.cli ? ' (CLI)' : ''}</td>
                        <UseCells u={m} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {s.byHook.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs [&_th]:pr-3 [&_td]:pr-3">
                  <thead className="text-on-surface-variant text-left align-bottom">
                    <tr>
                      <th className="py-1">hook</th><th>runs</th><th>injected</th><th>found nothing</th><th>skipped</th><th>errors</th>
                      <th title="Recall could not embed the message and matched on keywords alone">keywords only</th>
                      <th title="Left out: the hooks before it had spent the turn's shared budget">over shared budget</th>
                      <th title="Left out: raising the session's protection level for it failed">not committed</th>
                      <th title="The rules the shown passages qualified under">shown on</th>
                      <th>avg tokens</th><th>avg ms</th>
                      <th title="Mean best similarity of runs that showed a passage on similarity">avg top match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byHook.map((h) => (
                      <tr key={h.id} className="border-t border-outline-variant/30">
                        <td className="py-1">{h.hook}</td><td>{h.runs}</td><td>{h.injected}</td><td>{h.abstained}</td><td>{h.skipped}</td>
                        <td className={h.errors ? 'text-error' : ''}>{h.errors}</td>
                        <td className={h.degraded ? 'text-warning' : ''}>{h.degraded}</td>
                        <td>{h.budgetSpent}</td>
                        <td className={h.commitFailed ? 'text-error' : ''}>{h.commitFailed}</td>
                        <td className="whitespace-nowrap">{h.kind === 'recall' ? qualifiedText(h) : '—'}</td>
                        <td>{h.avgTokens}</td><td>{h.avgLatencyMs}</td>
                        <td>{h.avgTopScore ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {s.recent.length > 0 && (
              <details>
                <summary className="text-xs cursor-pointer text-on-surface-variant">Last {s.recent.length} agent starts</summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {s.recent.map((r) => (
                    <li key={r.id} className="border border-outline-variant/40 rounded-xs p-2">
                      <div className="flex flex-wrap gap-2 font-mono opacity-80">
                        <span>{new Date(r.createdAt).toLocaleString()}</span>
                        <span>{r.role ?? r.event}</span>
                        {r.model && <span>{r.model}{r.cli ? ' (CLI)' : ''}</span>}
                        <span>{r.tokens} tok</span>
                        {r.knowledgeToolCalls !== null && <span>KB reads {r.knowledgeToolCalls} · note reads {r.notesToolCalls}</span>}
                        {r.citedItems !== null && <span>named {r.citedItems}</span>}
                        {r.usedItems !== null && <span>used {r.usedItems}</span>}
                      </div>
                      {r.hooks.map((h) => (
                        <div key={h.hook} className="mt-0.5">
                          {h.hook}: <span className={h.status === 'error' ? 'text-error' : ''}>{h.status}{h.reason ? ` (${h.reason})` : ''}</span>
                          {h.degraded && <span className="text-warning"> · keywords only</span>}
                          {h.titles.length > 0 && <span className="opacity-70"> — {h.titles.join(' · ')}</span>}
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {s.sampled && <p className="text-xs text-on-surface-variant">More agent starts than counted: these numbers cover the newest {s.turns}.</p>}
            {s.turns === 0 && <p className="text-xs text-on-surface-variant">Nothing measured yet: numbers appear after your next messages.</p>}
          </>
        )}
      </section>

      <EvalPanel recall={recallHook} />
    </div>
  );
}
