'use client';

import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { api } from '@/lib/api';

interface TopicLite {
  value: string;
  label?: string;
  primaryModel: string | null;
}
interface ModelLite {
  name: string;
  isDefault: boolean;
  isEnabled: boolean;
}

/**
 * "Which model actually answers you" readout for the Models/Topics pages.
 *
 * Mirrors `ModelSelector.selectForRootAgent` (src/core/agent/model-selector.ts).
 * There is no single answer any more, and that is the point: the request is
 * classified to a LANE before the turn starts, so a coding brief and a lookup
 * are answered by different models on purpose. This note used to name one model
 * and read the `chat` lane to find it — a lane that no longer exists, so it
 * reported "unbound" forever and pointed at the default model regardless of
 * what the user had actually bound.
 *
 * Order, as the selector has it: a per-session `/model` override, then the
 * routed lane, then the default model when that lane is unbound.
 *
 * Uses the same react-query keys as the host pages, so it costs no extra
 * requests where those queries already run.
 */

/** The lanes a request can be routed to, in the order they are worth reading. */
const ROUTED_LANES: ReadonlyArray<{ value: string; answers: string }> = [
  { value: 'build', answers: 'implementation, debugging, architecture' },
  { value: 'verify', answers: 'review and QA — deliberately a different model' },
  { value: 'everyday', answers: 'chat, lookups, classification, drafting' },
  { value: 'research', answers: 'investigation and deep research' },
];

export function RootModelNote() {
  const { data: topicsData } = useQuery({
    queryKey: ['topics-config'],
    queryFn: () => api.get<{ topics: TopicLite[] }>('/topics'),
  });
  const { data: modelsData } = useQuery({
    queryKey: ['models'],
    queryFn: () => api.get<{ models: ModelLite[] }>('/models'),
  });

  if (!topicsData || !modelsData) return null;

  // `?? []` because a 200 whose body lacks the array is not hypothetical — an
  // older backend, a partial deploy, or a proxy returning `{}` all produce it,
  // and this note is a decoration on the Models page. Reading `.find` off the
  // missing array threw during render, which the error boundary turned into a
  // full-page "This page couldn't load" — an auxiliary widget taking down the
  // page it merely annotates.
  const topics = topicsData.topics ?? [];
  const defaultModel = (modelsData.models ?? []).find((m) => m.isDefault)?.name ?? null;
  const lanes = ROUTED_LANES.map((lane) => ({
    ...lane,
    model: topics.find((t) => t.value === lane.value)?.primaryModel ?? null,
  }));
  const unbound = lanes.filter((l) => !l.model);
  const distinct = new Set(lanes.map((l) => l.model).filter(Boolean));

  return (
    <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4">
      <div className="flex items-start gap-2">
        <Bot className="w-4 h-4 text-primary mt-0.5 shrink-0" />
        <div className="min-w-0 text-xs text-on-surface-variant space-y-1">
          <p className="text-sm font-medium text-on-surface">Which model answers you</p>
          <p>
            It depends on what you ask. Each request is routed to a lane before the turn starts,
            so implementation and a lookup are answered by different models on purpose. A
            per-session <span className="font-mono">/model</span> override wins over all of it.
          </p>
          <ul className="space-y-0.5 pt-1">
            {lanes.map((lane) => (
              <li key={lane.value} className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-mono text-primary">{lane.value}</span>
                <span className="text-outline">{lane.answers}</span>
                <span className="font-mono">
                  {lane.model ?? (defaultModel ? `→ ${defaultModel} (unbound, falls back)` : '→ nothing bound')}
                </span>
              </li>
            ))}
          </ul>
          {distinct.size === 1 && (
            <p className="pt-1">
              Every lane runs the same model, so routing currently changes nothing but the log line.
              Bind a stronger model to <span className="font-mono">build</span> — and a different one
              to <span className="font-mono">verify</span> — for the split to do anything.
            </p>
          )}
          {unbound.length > 0 && !defaultModel && (
            <p className="text-error">
              {unbound.map((l) => l.value).join(', ')} unbound and no default model — a request
              routed there has nothing to run on.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
