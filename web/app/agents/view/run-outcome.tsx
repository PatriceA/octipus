'use client';

import { CheckCircle2, CircleAlert, FileText, XCircle } from 'lucide-react';
import { compact } from '@/components/chat/context-panel';
import { cn } from '@/lib/utils';
import type { RunOutcome } from '../../../../src/shared/agent-origin';
import { agentCompletionLabel } from '../../../../src/shared/agent-completion';

const CHECK_LABEL: Record<string, string> = {
  qa_verdict: 'QA verdict',
  schema_gate: 'Output schema',
  pre_verify: 'Pre-verify command',
  adhoc: 'Ad-hoc check',
  side_effect: 'Recorded side effects',
  audit_coverage: 'Audit coverage',
};

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const basename = (p: string) => p.split('/').pop() ?? p;
const heading = 'text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant';

/**
 * How a run ended and what it can show for it (docs/MISSION-CONTROL.md,
 * "Outcome and evidence"). A file counts as delivered only when a write tool
 * recorded it; one the answer names without such a record reads as missing.
 */
export function RunOutcomePanel({ outcome }: { outcome: RunOutcome }) {
  const missing = outcome.claims.filter((c) => !c.confirmed);
  const confirmed = outcome.claims.filter((c) => c.confirmed);
  const failedChecks = outcome.checks.filter((c) => !c.passed).length;
  const finished = outcome.status !== 'running' && outcome.status !== 'idle';
  const reason = agentCompletionLabel(outcome.completionReason);
  // Files a confirmed claim already lists are not repeated.
  const otherFiles = outcome.files.filter((f) => !confirmed.some((c) => f.path === c.path || basename(f.path) === basename(c.path)));
  return <section aria-label="Outcome and evidence" className="space-y-4 rounded-lg border border-outline-variant/60 bg-surface-container p-4 [grid-column:1/-1]">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className={heading}>Outcome and evidence</h2>
      <p className="font-mono text-xs text-on-surface-variant">
        {outcome.status}{reason ? ` · ${reason.toLowerCase()}` : ''}
        {outcome.durationMs !== null && ` · ${duration(outcome.durationMs)}`}
        {` · ${compact(outcome.totalTokens)} tokens`}
        {` · ${outcome.costUsd === null ? 'cost not recorded' : `$${outcome.costUsd.toFixed(outcome.costUsd < 0.1 ? 3 : 2)}`}`}
      </p>
    </div>

    {(missing.length > 0 || failedChecks > 0 || outcome.error) && <div role="alert" className="space-y-1 rounded-lg border border-warning/50 bg-warning-container/40 p-3 text-sm">
      {outcome.error && <p><span className="font-semibold">Error:</span> {outcome.error}</p>}
      {missing.length > 0 && <p>The answer says {missing.length === 1 ? 'a file was' : `${missing.length} files were`} saved with no write recorded:{' '}
        {missing.map((m) => <code key={m.path} className="mx-0.5 font-mono text-xs">{m.path}</code>)}</p>}
      {failedChecks > 0 && <p>{failedChecks} check{failedChecks === 1 ? '' : 's'} failed.</p>}
    </div>}

    <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
      <div className="space-y-2">
        <h3 className={heading}>Deliverables</h3>
        {outcome.claims.length === 0 && outcome.files.length === 0
          ? <p className="text-sm text-on-surface-variant">{finished ? 'No file written and none claimed.' : 'No file written yet.'}</p>
          : <ul aria-label="Deliverables" className="space-y-1 text-sm">
            {outcome.claims.map((c) => <li key={`claim-${c.path}`} className="flex items-start gap-2">
              {c.confirmed
                ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                : <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
              <span className="min-w-0 break-all font-mono text-xs">{c.path}</span>
              <span className={cn('ml-auto shrink-0 text-xs', c.confirmed ? 'text-primary' : 'text-warning')}>{c.confirmed ? 'write recorded' : 'missing'}</span>
            </li>)}
            {otherFiles.map((f) => <li key={`file-${f.path}`} className="flex items-start gap-2">
              <FileText aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-on-surface-variant" />
              <span className={cn('min-w-0 break-all font-mono text-xs', f.action === 'delete' && 'line-through')}>{f.path}</span>
              <span className="ml-auto shrink-0 text-xs text-on-surface-variant">{f.action}</span>
            </li>)}
          </ul>}
        {outcome.toolCalls.length > 0 && <p className="text-xs text-on-surface-variant">Tools: {outcome.toolCalls.slice(0, 8).map((t) => `${t.name} ×${t.count}`).join(' · ')}</p>}
      </div>

      <div className="space-y-2">
        <h3 className={heading}>Checks</h3>
        {outcome.checks.length === 0
          ? <p className="text-sm text-on-surface-variant">No check recorded for this run: its result is the model's word.</p>
          : <ul aria-label="Checks" className="space-y-1.5 text-sm">
            {outcome.checks.map((c, i) => <li key={`${c.kind}-${c.at}-${i}`} className="flex items-start gap-2">
              {c.passed ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-error" />}
              <span className="min-w-0">
                <span className="font-medium">{CHECK_LABEL[c.kind] ?? c.kind}</span>
                {c.stage && <span className="text-on-surface-variant"> · {c.stage}</span>}
                <span className={cn('ml-1 text-xs', c.passed ? 'text-primary' : 'text-error')}>{c.passed ? 'passed' : 'failed'}</span>
                {c.summary && <span className="block text-xs text-on-surface-variant">{c.summary}</span>}
              </span>
            </li>)}
          </ul>}
      </div>
    </div>

    {outcome.answer && <details className="rounded-lg border border-outline-variant/60">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Final answer</summary>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-outline-variant/40 p-3 font-mono text-xs">{outcome.answer}</pre>
      {outcome.answerClipped && <p className="px-3 pb-2 text-xs text-on-surface-variant">Showing the first 4,000 characters; the full answer is in the session.</p>}
    </details>}
  </section>;
}
