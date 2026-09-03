'use client';

import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { api } from '@/lib/api';

interface TopicLite {
  value: string;
  primaryModel: string | null;
}
interface ModelLite {
  name: string;
  isDefault: boolean;
  isEnabled: boolean;
}

/**
 * "Which model actually orchestrates" readout for the Models/Topics pages.
 *
 * Mirrors `ModelSelector.selectForOrchestration` (src/core/orchestrator/
 * model-selector.ts): a bound `chat` lane wins unconditionally; only when it
 * is unbound does the global default model apply. The default-model star on
 * the Models page silently loses to a chat binding — this note says so
 * explicitly instead of letting the user chase the wrong knob.
 *
 * Uses the same react-query keys as the host pages, so it costs no extra
 * requests where those queries already run.
 */
export function OrchestratorModelNote() {
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
  const chatModel = (topicsData.topics ?? []).find((t) => t.value === 'chat')?.primaryModel ?? null;
  const defaultModel = (modelsData.models ?? []).find((m) => m.isDefault)?.name ?? null;
  const effective = chatModel ?? defaultModel;
  const overridden = !!chatModel && !!defaultModel && chatModel !== defaultModel;

  return (
    <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4">
      <div className="flex items-start gap-2">
        <Bot className="w-4 h-4 text-primary mt-0.5 shrink-0" />
        <div className="min-w-0 text-xs text-on-surface-variant space-y-1">
          <p className="text-sm font-medium text-on-surface">Orchestrator model</p>
          <p>
            The orchestrator reads the <span className="font-mono">chat</span> lane binding first;
            only when that lane is unbound does the global default model apply
            (a per-session <span className="font-mono">/model</span> override still wins over both).
          </p>
          {effective ? (
            <p>
              Effective orchestrator model:{' '}
              <span className="font-mono text-primary">{effective}</span>{' '}
              {chatModel ? '(via chat lane binding)' : '(via default model — chat lane unbound)'}
            </p>
          ) : (
            <p className="text-error">
              No chat lane binding and no default model — the orchestrator has no model to run on.
            </p>
          )}
          {overridden && (
            <p className="text-warning">
              Default model <span className="font-mono">{defaultModel}</span> is overridden by the
              chat lane binding → <span className="font-mono">{chatModel}</span>. Rebind or clear
              the chat lane on the Topics page to change the orchestrator model.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
