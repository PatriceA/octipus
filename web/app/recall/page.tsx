'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { parseEvalLines } from '@/lib/recall-eval';

type HookEvent = 'turn_start' | 'worker_start';
type HookKind = 'recall' | 'note' | 'notes_index';

interface Hook {
  id: string;
  builtin: string | null;
  name: string;
  kind: HookKind;
  events: HookEvent[];
  config: Record<string, unknown>;
  enabled: boolean;
  description: string | null;
}

interface HooksResponse { enabled: boolean; maxTokens: number; hooks: Hook[] }

interface Rate { n: number; of: number }

interface Stats {
  days: number;
  turns: number;
  byHook: Array<{ hook: string; kind: string; runs: number; injected: number; abstained: number; skipped: number; errors: number; avgTokens: number; avgLatencyMs: number; avgTopScore: number | null }>;
  searched: Rate;
  searchedAfterInjection: Rate;
  searchedAfterAbstain: Rate;
  cited: Rate;
  byModel: Array<{ model: string; cli: boolean | null; turns: number; injected: Rate; searched: Rate; cited: Rate }>;
  recent: Array<{
    id: string; event: string; role: string | null; model: string | null; cli: boolean | null; tokens: number; latencyMs: number;
    knowledgeToolCalls: number | null; notesToolCalls: number | null; citedItems: number | null; outcome: string | null; createdAt: string;
    hooks: Array<{ hook: string; status: string; reason?: string; titles: string[]; tokens: number }>;
  }>;
  memory: { facts: number; missing: Array<'background_model' | 'embedding_model' | 'extraction_off'> };
}

interface EvalResult {
  config: { limit: number; minSimilarity: number };
  cases: Array<{ question: string; expect: string[]; hits: Array<{ title: string; sourceId: string; score: number }>; rank: number | null; pass: boolean }>;
  found: Rate;
  mrr: number;
  abstained: Rate;
}

const EVENT_LABEL: Record<HookEvent, string> = { turn_start: 'each message', worker_start: 'each specialist' };
const KIND_LABEL: Record<HookKind, string> = { recall: 'knowledge recall', note: 'context note', notes_index: 'notes index' };
const EVAL_KEY = 'octipus.recall.eval';
const MEMORY_MISSING = {
  background_model: 'no model is bound to the background topic, which extracts facts (Settings → Models)',
  embedding_model: 'no embedding model is set up, which stores them (Settings → Models)',
  extraction_off: 'memory extraction is switched off (setting memory.extractionCadence)',
} as const;

const pct = (r: Rate) => (r.of ? `${Math.round((r.n / r.of) * 100)}%` : '—');
const frac = (r: Rate) => `${r.n}/${r.of}`;

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

function HookRow({ hook }: { hook: Hook }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (patch: Partial<Hook>) => api.patch(`/context-hooks/${encodeURIComponent(hook.id)}`, patch),
    onSuccess: () => { setDraft({}); return qc.invalidateQueries({ queryKey: ['context-hooks'] }); },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/context-hooks/${encodeURIComponent(hook.id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['context-hooks'] }),
  });
  const fields = hook.kind === 'recall' ? ['minSimilarity', 'limit', 'tokenBudget'] : hook.kind === 'note' ? ['slug', 'tokenBudget'] : ['limit', 'tokenBudget'];
  const toggleEvent = (e: HookEvent) => {
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
          >
            {hook.builtin ? <RotateCcw className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-2 text-xs">
        <span className="text-on-surface-variant">runs before</span>
        {(['turn_start', 'worker_start'] as HookEvent[]).map((e) => (
          <label key={e} className="flex items-center gap-1 cursor-pointer">
            <input type="checkbox" checked={hook.events.includes(e)} onChange={() => toggleEvent(e)} />
            {EVENT_LABEL[e]}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2 mt-2">
        {fields.map((f) => (
          <label key={f} className="text-xs text-on-surface-variant flex flex-col gap-0.5">
            {f}
            <input
              value={draft[f] ?? (hook.config[f] !== undefined ? String(hook.config[f]) : '')}
              placeholder="default"
              onChange={(e) => setDraft({ ...draft, [f]: e.target.value })}
              className="w-28 bg-surface-container border border-outline-variant/40 rounded px-2 py-1 font-mono text-on-surface"
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
  const [kind, setKind] = useState<HookKind>('note');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const add = useMutation({
    mutationFn: () => api.post('/context-hooks', {
      name: name || (kind === 'note' ? `Note ${slug}` : KIND_LABEL[kind]),
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
        <select value={kind} onChange={(e) => setKind(e.target.value as HookKind)} className="bg-surface-container border border-outline-variant/40 rounded px-2 py-1 text-on-surface">
          <option value="note">context note (always shown)</option>
          <option value="recall">knowledge recall</option>
          <option value="notes_index">notes index</option>
        </select>
      </label>
      <label className="flex flex-col gap-0.5 text-xs text-on-surface-variant">
        name
        <input value={name} onChange={(e) => setName(e.target.value)} className="bg-surface-container border border-outline-variant/40 rounded px-2 py-1 text-on-surface" />
      </label>
      {kind === 'note' && (
        <label className="flex flex-col gap-0.5 text-xs text-on-surface-variant">
          note slug
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="about-me" className="bg-surface-container border border-outline-variant/40 rounded px-2 py-1 font-mono text-on-surface" />
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

function EvalPanel() {
  const [text, setText] = useState(readStored);
  const [minSimilarity, setMinSimilarity] = useState('');
  const run = useMutation({
    mutationFn: () => {
      try { localStorage.setItem(EVAL_KEY, text); } catch { /* not kept */ }
      return api.post<EvalResult>('/context-hooks/eval', {
        cases: parseEvalLines(text),
        ...(minSimilarity.trim() ? { minSimilarity: Number(minSimilarity) } : {}),
      });
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
        placeholder={'What do we charge for a website? => Pricing\nWho is our accountant? => Contacts; accountant\nWhat is the capital of France? => -'}
        className="w-full bg-surface-container border border-outline-variant/40 rounded-xs p-2 font-mono text-xs text-on-surface"
      />
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5 text-xs text-on-surface-variant">
          minSimilarity (blank: the hook&apos;s)
          <input value={minSimilarity} onChange={(e) => setMinSimilarity(e.target.value)} placeholder="0.45" className="w-28 bg-surface-container border border-outline-variant/40 rounded px-2 py-1 font-mono text-on-surface" />
        </label>
        <button
          type="button"
          disabled={run.isPending || cases.length === 0}
          onClick={() => run.mutate()}
          className="flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-on-primary rounded-xs disabled:opacity-50"
        >
          {run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run {cases.length || ''}
        </button>
      </div>
      {run.error && <p className="text-xs text-error">{(run.error as Error).message}</p>}
      {run.data && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-3">
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

export default function RecallPage() {
  const [days, setDays] = useState(30);
  const hooks = useQuery({ queryKey: ['context-hooks'], queryFn: () => api.get<HooksResponse>('/context-hooks') });
  const stats = useQuery({ queryKey: ['context-hooks', 'stats', days], queryFn: () => api.get<Stats>(`/context-hooks/stats?days=${days}`) });
  const s = stats.data;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
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

      <section className="space-y-3">
        <h2 className="section-label">Hooks</h2>
        {hooks.isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
        {hooks.error && <p className="text-sm text-error">{(hooks.error as Error).message}</p>}
        <ul className="space-y-2">
          {hooks.data?.hooks.map((h) => <HookRow key={h.id} hook={h} />)}
        </ul>
        <AddHook />
        {hooks.data && <p className="text-xs text-on-surface-variant">All hooks of one turn share {hooks.data.maxTokens} tokens.</p>}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="section-label">How agents used it</h2>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-surface-container border border-outline-variant/40 rounded px-2 py-1 text-xs text-on-surface">
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
        {stats.error && <p className="text-sm text-error">{(stats.error as Error).message}</p>}
        {s && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Tile value={String(s.turns)} label="agent starts" />
              <Tile value={pct(s.cited)} label={`answers naming an injected source (${frac(s.cited)})`} />
              <Tile value={pct(s.searched)} label={`searched the KB or notes themselves (${frac(s.searched)})`} />
              <Tile
                value={pct(s.searchedAfterAbstain)}
                label={`searched after recall found nothing (${frac(s.searchedAfterAbstain)})`}
                hint="High: recall is missing things the agent then found itself. Lower minSimilarity, or test with the eval below."
              />
            </div>

            {s.byModel.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-on-surface-variant text-left">
                  <tr><th className="py-1">model</th><th>turns</th><th>given passages</th><th>searched itself</th><th>named a source</th></tr>
                </thead>
                <tbody>
                  {s.byModel.map((m) => (
                    <tr key={`${m.model}|${m.cli}`} className="border-t border-outline-variant/30">
                      <td className="py-1 font-mono">{m.model}{m.cli ? ' (CLI)' : ''}</td>
                      <td>{m.turns}</td>
                      <td>{pct(m.injected)}</td>
                      <td>{pct(m.searched)}</td>
                      <td>{pct(m.cited)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {s.byHook.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-on-surface-variant text-left">
                  <tr><th className="py-1">hook</th><th>runs</th><th>injected</th><th>found nothing</th><th>skipped</th><th>errors</th><th>avg tokens</th><th>avg ms</th><th>avg top match</th></tr>
                </thead>
                <tbody>
                  {s.byHook.map((h) => (
                    <tr key={h.hook} className="border-t border-outline-variant/30">
                      <td className="py-1">{h.hook}</td><td>{h.runs}</td><td>{h.injected}</td><td>{h.abstained}</td><td>{h.skipped}</td>
                      <td className={h.errors ? 'text-error' : ''}>{h.errors}</td><td>{h.avgTokens}</td><td>{h.avgLatencyMs}</td>
                      <td>{h.avgTopScore ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                      </div>
                      {r.hooks.map((h) => (
                        <div key={h.hook} className="mt-0.5">
                          {h.hook}: <span className={h.status === 'error' ? 'text-error' : ''}>{h.status}{h.reason ? ` (${h.reason})` : ''}</span>
                          {h.titles.length > 0 && <span className="opacity-70"> — {h.titles.join(' · ')}</span>}
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {s.turns === 0 && <p className="text-xs text-on-surface-variant">Nothing measured yet: numbers appear after your next messages.</p>}
          </>
        )}
      </section>

      <EvalPanel />
    </div>
  );
}
