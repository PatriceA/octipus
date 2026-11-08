import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  PROMPT_CATEGORIES,
  PROMPT_CATEGORY_INFO,
  type PromptCategory,
  type PromptSectionWithText,
  type PromptTier,
  type SessionContextResponse,
  tokensByCategory,
} from '../../../src/shared/prompt-composition';

/** One fixed colour per category, from the Deep Sea tokens; never reused for two. */
const CATEGORY_COLOR: Record<PromptCategory, string> = {
  guardrails: 'bg-accent-dim',
  role: 'bg-primary',
  delegation: 'bg-primary-dim',
  workspace: 'bg-tertiary',
  tools: 'bg-secondary',
  skills: 'bg-warning',
  turn: 'bg-accent',
  conversation: 'bg-outline',
  other: 'bg-secondary-dim',
};

const TIER_LABEL: Record<PromptTier, string> = {
  static: 'cached prefix',
  tools: 'sent every request',
  volatile: 'this turn',
  history: 'history',
};

function compact(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n.toLocaleString('en-US');
}

function isContextResponse(value: unknown): value is SessionContextResponse {
  const v = value as Partial<SessionContextResponse> | null;
  return !!v && Array.isArray(v.turns) && (v.latest === null || (typeof v.latest === 'object' && Array.isArray(v.latest?.sections)));
}

interface Props {
  sessionId: string | null;
  running: boolean;
  onCompact: () => void;
}

/**
 * What the root agent's latest request was made of, by category
 * (docs/CONTEXT-INSPECTOR.md). Sizes are estimates and labelled as such; the
 * provider's own input count is shown beside them, not instead of them.
 */
export default function ContextPanel({ sessionId, running, onCompact }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<PromptCategory | null>(null);
  const [reading, setReading] = useState<PromptSectionWithText | null>(null);
  const { data, isError, isFetching, errorUpdatedAt, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['session-context', sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const response = await api.get<unknown>(`/sessions/${encodeURIComponent(sessionId!)}/context`);
      if (!isContextResponse(response)) throw new Error('The server returned context data this version of the app cannot read.');
      return response;
    },
    // A turn measures its request when it starts: poll while one runs.
    refetchInterval: running ? 4000 : 30000,
    retry: false,
  });
  // The turn that just ended may have started after the last poll.
  useEffect(() => { if (!running && sessionId) void refetch(); }, [running, sessionId, refetch]);

  const latest = data?.latest ?? null;
  const unavailable = isError || errorUpdatedAt > dataUpdatedAt;
  const contextWindow = latest?.contextWindow;
  const used = latest?.totals.tokens ?? 0;
  const byCategory = latest ? tokensByCategory(latest.sections) : {};
  const categories = PROMPT_CATEGORIES.filter((c) => (byCategory[c] ?? 0) > 0);
  // Bar scale: the model's window when known, else this request itself.
  const scale = contextWindow && contextWindow >= used ? contextWindow : used;
  const pct = contextWindow ? Math.round((used / contextWindow) * 100) : null;

  return <section className="context-panel border-t border-outline-variant/50 p-4 space-y-3" aria-label="Context">
    <button type="button" className="flex w-full items-start justify-between gap-3 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="min-w-0">
        <span className="block text-xs uppercase tracking-widest text-primary mb-1">Context</span>
        <span className="block text-sm font-semibold">
          {!sessionId ? 'What the model reads'
            : !data && !unavailable ? 'Loading context…'
            : !latest ? 'Not measured yet'
            : <>~{compact(used)}{contextWindow ? <> of {compact(contextWindow)} · {pct}% full</> : ' tokens'}</>}
        </span>
      </span>
      <span className="text-xs text-primary shrink-0">{open ? 'Collapse' : 'Open'}</span>
    </button>

    {latest && <CompositionBar sections={latest.sections} scale={scale} selected={selected} onSelect={(c) => { setOpen(true); setSelected(c === selected ? null : c); }} />}

    {unavailable && <div role="status" className="text-xs text-warning">
      Context update unavailable{latest ? '; showing the last measurement' : ''}.
      <button type="button" className="ml-1 inline-flex items-center gap-1 underline disabled:opacity-60" disabled={isFetching} onClick={() => void refetch()}><RefreshCw size={12} />Retry</button>
    </div>}

    {open && <>
      {!sessionId && <p className="text-sm text-on-surface-variant">Send a message to see what Octipus puts in front of the model, and how much room each part takes.</p>}
      {sessionId && data && !latest && <p className="text-sm text-on-surface-variant">No turn of this session has been measured yet. Measurement starts with the next message (direct replies and CLI models are not measured).</p>}

      {latest && <>
        <p className="text-xs text-on-surface-variant">
          Estimated as characters ÷ 4 when the latest turn started.
          {data?.usage && <> The provider counted <span className="font-mono text-on-surface">{data.usage.inputTokens.toLocaleString('en-US')}</span> input tokens for that request{data.usage.cachedInputTokens > 0 && <>, <span className="font-mono text-on-surface">{data.usage.cachedInputTokens.toLocaleString('en-US')}</span> from cache</>}.</>}
          {!contextWindow && ' The model\'s context window is not known, so the bar shows shares of the request.'}
        </p>

        <ul className="rounded-lg border border-outline-variant/60 divide-y divide-outline-variant/40 overflow-hidden">
          {categories.map((c) => {
            const tokens = byCategory[c] ?? 0;
            const isOpen = selected === c;
            const sections = latest.sections.filter((s) => s.category === c);
            return <li key={c}>
              <button type="button" aria-expanded={isOpen} onClick={() => setSelected(isOpen ? null : c)}
                className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-sm min-h-11', isOpen ? 'bg-primary-container/50' : 'hover:bg-surface-container')}>
                <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0 rounded-xs', CATEGORY_COLOR[c])} />
                <span className="min-w-0 flex-1 truncate font-medium">{PROMPT_CATEGORY_INFO[c].label}</span>
                <span className="font-mono text-xs">{compact(tokens)}</span>
                <span className="w-9 text-right font-mono text-xs text-on-surface-variant">{used ? Math.round((tokens / used) * 100) : 0}%</span>
              </button>
              {isOpen && <div className="px-3 pb-3 space-y-2 bg-primary-container/20">
                <p className="pt-2 text-xs text-on-surface-variant">{PROMPT_CATEGORY_INFO[c].description}</p>
                <ul className="space-y-1.5">
                  {sections.map((s, i) => <li key={`${s.label}-${i}`} className="text-xs">
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 break-words">
                        <span className="text-on-surface">{s.label}</span>
                        {s.count !== undefined && <span className="text-on-surface-variant"> · {s.count}</span>}
                        {s.status && <span className="ml-1 rounded-xs border border-warning/60 px-1 text-[10px] text-warning">{s.status === 'capped' ? 'at cap' : 'truncated'}</span>}
                      </span>
                      <span className="font-mono">{compact(s.tokens)}</span>
                    </div>
                    <div className="flex items-start gap-2 text-on-surface-variant">
                      <span className="min-w-0 flex-1 break-words">{TIER_LABEL[s.tier]}{s.note && <> · {s.note}</>}</span>
                      {latest.textAvailable && s.text !== undefined && <button type="button" className="shrink-0 text-primary underline" onClick={() => setReading(s)}>Read</button>}
                    </div>
                  </li>)}
                </ul>
                {!latest.textAvailable && <p className="text-xs text-on-surface-variant">Text is kept in memory for the latest turn only; it shows again after the next message.</p>}
              </div>}
            </li>;
          })}
        </ul>

        {data && data.turns.length > 1 && <GrowthChart turns={data.turns} />}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={running} onClick={onCompact} className="rounded-lg border border-outline-variant px-3 py-2 text-sm text-primary disabled:opacity-50">Compact conversation</button>
          <span className="text-xs text-on-surface-variant">{running ? 'Available when the turn ends.' : 'Summarises older messages to free room.'}</span>
        </div>
      </>}
    </>}

    <Modal open={!!reading} onClose={() => setReading(null)} title={reading ? `${reading.label} · ~${compact(reading.tokens)} tokens` : undefined} maxWidth="lg">
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-xs text-on-surface">{reading?.text}</pre>
    </Modal>
  </section>;
}

function CompositionBar({ sections, scale, selected, onSelect }: {
  sections: PromptSectionWithText[];
  scale: number;
  selected: PromptCategory | null;
  onSelect: (c: PromptCategory) => void;
}) {
  const byCategory = tokensByCategory(sections);
  const used = Object.values(byCategory).reduce((n, t) => n + (t ?? 0), 0);
  if (!scale) return null;
  return <div className="flex h-3 w-full gap-px overflow-hidden rounded-xs bg-surface-container-highest" role="group" aria-label="Context by category">
    {PROMPT_CATEGORIES.filter((c) => (byCategory[c] ?? 0) > 0).map((c) => {
      const tokens = byCategory[c] ?? 0;
      return <button key={c} type="button" onClick={() => onSelect(c)}
        aria-label={`${PROMPT_CATEGORY_INFO[c].label}: ~${compact(tokens)} tokens`}
        title={`${PROMPT_CATEGORY_INFO[c].label}: ~${compact(tokens)} tokens`}
        style={{ width: `${Math.max((tokens / scale) * 100, 0.8)}%` }}
        className={cn('h-full shrink-0 cursor-pointer', CATEGORY_COLOR[c], selected && selected !== c && 'opacity-40')} />;
    })}
    {used < scale && <span aria-hidden className="flex-1" />}
  </div>;
}

function GrowthChart({ turns }: { turns: SessionContextResponse['turns'] }) {
  const max = Math.max(...turns.map((t) => t.totals.tokens), 1);
  const height = 56;
  const tiers: Array<{ key: 'prefixTokens' | 'turnTokens' | 'historyTokens'; color: string; label: string }> = [
    { key: 'historyTokens', color: 'bg-outline', label: 'history' },
    { key: 'turnTokens', color: 'bg-accent', label: 'this turn' },
    { key: 'prefixTokens', color: 'bg-primary', label: 'prefix + tools' },
  ];
  return <figure className="space-y-1.5">
    <figcaption className="flex items-baseline justify-between text-xs">
      <span className="font-medium">Growth by turn</span>
      <span className="font-mono text-on-surface-variant">max ~{compact(max)}</span>
    </figcaption>
    <div className="flex items-end gap-0.5 rounded-xs bg-background/50 px-1 pt-1" style={{ height: height + 4 }} role="img"
      aria-label={`Context size of the last ${turns.length} measured turns, from ~${compact(turns[0].totals.tokens)} to ~${compact(turns[turns.length - 1].totals.tokens)} tokens`}>
      {turns.map((t, i) => <div key={t.messageId} className="flex flex-1 flex-col justify-end" title={`Turn ${i + 1}: ~${compact(t.totals.tokens)} tokens`}>
        {tiers.map((tier) => <span key={tier.key} className={cn('block w-full', tier.color, i < turns.length - 1 && 'opacity-70')}
          style={{ height: `${(t.totals[tier.key] / max) * height}px` }} />)}
      </div>)}
    </div>
    <div className="flex flex-wrap gap-x-3 text-[11px] text-on-surface-variant">
      {tiers.slice().reverse().map((tier) => <span key={tier.key} className="inline-flex items-center gap-1"><span aria-hidden className={cn('h-2 w-2 rounded-xs', tier.color)} />{tier.label}</span>)}
    </div>
  </figure>;
}
