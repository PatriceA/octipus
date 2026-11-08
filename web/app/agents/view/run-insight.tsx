'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CATEGORY_COLOR, CompositionBar, TIER_LABEL, compact } from '@/components/chat/context-panel';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useWorkspaceId } from '@/lib/workspace-context';
import type { RunDetailResponse } from '../../../../src/shared/agent-origin';
import { PROMPT_CATEGORIES, PROMPT_CATEGORY_INFO, type PromptCategory, type PromptSectionWithText, tokensByCategory } from '../../../../src/shared/prompt-composition';

function isRunDetail(value: unknown): value is RunDetailResponse {
  const v = value as Partial<RunDetailResponse> | null;
  return !!v && typeof v.id === 'string' && Array.isArray(v.chain) && Array.isArray(v.children);
}

const runName = (r: { role: string; root: boolean }) => (r.root ? 'Octipus' : r.role);
const runHref = (id: string) => `/agents/view?id=${encodeURIComponent(id)}`;

/**
 * Why a run exists, where it sits in its tree and what its prompt held
 * (docs/MISSION-CONTROL.md, "Run detail"), from `GET /api/agents/:id/run`.
 */
export function RunInsight({ agentId }: { agentId: string }) {
  const workspaceId = useWorkspaceId();
  const [selected, setSelected] = useState<PromptCategory | null>(null);
  const [reading, setReading] = useState<PromptSectionWithText | null>(null);
  const { data, isError, isFetching, errorUpdatedAt, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['agent-run', agentId, workspaceId],
    enabled: !!agentId,
    queryFn: async () => {
      const response = await api.get<unknown>(`/agents/${encodeURIComponent(agentId)}/run`);
      if (!isRunDetail(response)) throw new Error('The server returned data this version of the app cannot read.');
      return response;
    },
    refetchInterval: 10_000,
    retry: false,
  });
  const unavailable = isError || errorUpdatedAt > dataUpdatedAt;

  if (!data) {
    return unavailable ? <div role="status" className="flex items-center gap-2 text-sm text-warning">
      Why this run exists could not be loaded.
      <button type="button" disabled={isFetching} onClick={() => void refetch()} className="inline-flex items-center gap-1 underline disabled:opacity-60"><RefreshCw size={14} />Retry</button>
    </div> : null;
  }

  const prompt = data.prompt;
  const byCategory = prompt ? tokensByCategory(prompt.sections) : {};
  const categories = PROMPT_CATEGORIES.filter((c) => (byCategory[c] ?? 0) > 0);
  const used = prompt?.totals.tokens ?? 0;
  const scale = prompt?.contextWindow && prompt.contextWindow >= used ? prompt.contextWindow : used;

  return <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
    <section aria-label="Why this run exists" className="space-y-3 rounded-lg border border-outline-variant/60 bg-surface-container p-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Why this run exists</h2>
      {data.chain.length === 0
        ? <p className="text-sm text-on-surface-variant">Started before origins were recorded: what started it is not known.</p>
        : <ol className="space-y-2">
          {data.chain.map((step, i) => <li key={`${step.kind}-${i}`} className="flex items-start gap-2 text-sm">
            <span aria-hidden className="mt-0.5 font-mono text-xs text-outline">{i === 0 ? '●' : '↳'}</span>
            <span className="min-w-0">
              <span className="mr-1.5 rounded-xs border border-outline-variant px-1 text-[10px] uppercase tracking-wider text-on-surface-variant">{step.kind}</span>
              {step.href ? <Link href={step.href} className="text-primary underline">{step.label}</Link> : <span className="font-medium">{step.label}</span>}
              {step.detail && <span className="text-on-surface-variant"> · {step.detail}</span>}
            </span>
          </li>)}
          <li className="flex items-start gap-2 text-sm">
            <span aria-hidden className="mt-0.5 font-mono text-xs text-primary">↳</span>
            <span><span className="font-semibold">{runName(data)}</span><span className="text-on-surface-variant"> · this run{data.sessionTitle ? ` — ${data.sessionTitle}` : ''}</span></span>
          </li>
        </ol>}

      <h2 className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Run tree</h2>
      <ul aria-label="Run tree" className="space-y-1 font-mono text-xs">
        {data.parent && <li><Link href={runHref(data.parent.id)} className="text-primary underline">{runName(data.parent)}</Link> <span className="text-on-surface-variant">parent</span></li>}
        <li className={cn(data.parent && 'pl-4')}><span className="font-semibold text-on-surface">{runName(data)}</span> <span className="text-on-surface-variant">{data.status} · this run</span></li>
        {data.children.map((c) => <li key={c.id} className={cn(data.parent ? 'pl-8' : 'pl-4')}>
          <Link href={runHref(c.id)} className="text-primary underline">{c.role}</Link> <span className="text-on-surface-variant">{c.status}{c.totalTokens ? ` · ${compact(c.totalTokens)} tokens` : ''}</span>
        </li>)}
        {!data.parent && data.children.length === 0 && <li className="text-on-surface-variant">No parent and no spawned workers.</li>}
      </ul>
    </section>

    <section aria-label="Prompt" className="space-y-3 rounded-lg border border-outline-variant/60 bg-surface-container p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Prompt</h2>
        {prompt && <span className="font-mono text-xs">~{compact(used)}{prompt.contextWindow ? ` of ${compact(prompt.contextWindow)}` : ' tokens'}</span>}
      </div>
      {!prompt
        ? <p className="text-sm text-on-surface-variant">This run's prompt was not measured (CLI models and runs from before the inspector are not).</p>
        : <>
          <CompositionBar sections={prompt.sections} scale={scale} selected={selected} onSelect={(c) => setSelected(c === selected ? null : c)} />
          <p className="text-xs text-on-surface-variant">Estimated as characters ÷ 4 when the run's first request was built.{!prompt.textAvailable && ' Sizes only: the text is kept in memory while the run is recent.'}</p>
          <ul className="divide-y divide-outline-variant/40 overflow-hidden rounded-lg border border-outline-variant/60">
            {categories.map((c) => {
              const tokens = byCategory[c] ?? 0;
              const isOpen = selected === c;
              return <li key={c}>
                <button type="button" aria-expanded={isOpen} onClick={() => setSelected(isOpen ? null : c)}
                  className={cn('flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm', isOpen ? 'bg-primary-container/50' : 'hover:bg-surface-container-high')}>
                  <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0 rounded-xs', CATEGORY_COLOR[c])} />
                  <span className="min-w-0 flex-1 truncate font-medium">{PROMPT_CATEGORY_INFO[c].label}</span>
                  <span className="font-mono text-xs">{compact(tokens)}</span>
                  <span className="w-9 text-right font-mono text-xs text-on-surface-variant">{used ? Math.round((tokens / used) * 100) : 0}%</span>
                </button>
                {isOpen && <ul className="space-y-1.5 bg-primary-container/20 px-3 py-2">
                  {prompt.sections.filter((s) => s.category === c).map((s, i) => <li key={`${s.label}-${i}`} className="flex items-start gap-2 text-xs">
                    <span className="min-w-0 flex-1 break-words">{s.label}<span className="text-on-surface-variant"> · {TIER_LABEL[s.tier]}{s.note ? ` · ${s.note}` : ''}</span></span>
                    <span className="font-mono">{compact(s.tokens)}</span>
                    {prompt.textAvailable && s.text !== undefined && <button type="button" className="shrink-0 text-primary underline" onClick={() => setReading(s)}>Read</button>}
                  </li>)}
                </ul>}
              </li>;
            })}
          </ul>
        </>}
    </section>

    <Modal open={!!reading} onClose={() => setReading(null)} title={reading ? `${reading.label} · ~${compact(reading.tokens)} tokens` : undefined} maxWidth="lg">
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-xs text-on-surface">{reading?.text}</pre>
    </Modal>
  </div>;
}
