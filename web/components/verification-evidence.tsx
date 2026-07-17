'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

/**
 * One recorded completion check. Mirrors the backend
 * `verification_evidence` row shape (src/db/schema/verification-evidence.ts).
 */
interface EvidenceRecord {
  id: string;
  sessionId: string;
  pipelineId?: string | null;
  stage?: string | null;
  nodeId?: string | null;
  kind: 'qa_verdict' | 'schema_gate' | 'pre_verify' | 'adhoc';
  passed: boolean;
  confidence?: string | null;
  detail?: Record<string, unknown> | null;
  createdAt: string;
}

interface VerificationResponse {
  sessionId: string;
  verified: boolean;
  evidence: EvidenceRecord[];
}

/** Human labels for the ledger `kind` discriminator. */
const KIND_LABEL: Record<EvidenceRecord['kind'], string> = {
  qa_verdict: 'qa verdict',
  schema_gate: 'schema gate',
  pre_verify: 'pre-verify',
  adhoc: 'ad-hoc',
};

/**
 * Read-only panel showing the verification evidence ledger for one session:
 * the QA verdicts, schema gates and pre-verify commands that gate a task's
 * completion. Keyed by the agent's `sessionId`. Renders nothing until the
 * fetch resolves; hides itself entirely when a session has no evidence (most
 * agents never run a completion check), so it doesn't add noise to the page.
 */
export function VerificationEvidence({ sessionId }: { sessionId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['verification', sessionId],
    queryFn: async () => {
      try {
        return await api.get<VerificationResponse>(`/verification/${sessionId}`);
      } catch {
        return null;
      }
    },
    enabled: !!sessionId,
    refetchInterval: 5000,
  });

  // Nothing to show: still loading, no session, or a session that never ran a
  // completion check. Stay invisible rather than render an empty shell.
  if (isLoading || !data || data.evidence.length === 0) return null;

  return (
    <div className="bg-surface-container rounded-xs border border-outline-variant/10">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-outline-variant/10">
        <h2 className="section-label">
          verification
          <span className="ml-2 normal-case tracking-normal font-normal">
            {data.evidence.length} {data.evidence.length === 1 ? 'check' : 'checks'}
          </span>
        </h2>
        <div className="ml-auto">
          {data.verified ? (
            <StatusBadge variant="success" dot>verified</StatusBadge>
          ) : (
            <StatusBadge variant="danger" dot>unverified</StatusBadge>
          )}
        </div>
      </div>
      <ul className="divide-y divide-outline-variant/10">
        {data.evidence.map((e) => (
          <EvidenceRow key={e.id} evidence={e} />
        ))}
      </ul>
    </div>
  );
}

function EvidenceRow({ evidence: e }: { evidence: EvidenceRecord }) {
  // Pull a short human-readable summary out of the check-specific detail blob
  // when one is present; different kinds carry different shapes.
  const summary = detailSummary(e.detail);

  return (
    <li className="flex items-start gap-3 px-4 py-2.5 font-mono text-[12px]">
      {e.passed ? (
        <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-tertiary" aria-hidden />
      ) : (
        <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-error" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-on-surface">{KIND_LABEL[e.kind]}</span>
          {e.stage && <span className="text-on-surface-variant">· {e.stage}</span>}
          {e.confidence && (
            <span className="text-outline">· {e.confidence} confidence</span>
          )}
        </div>
        {summary && (
          <p className="text-[11px] text-on-surface-variant truncate mt-0.5" title={summary}>
            {summary}
          </p>
        )}
      </div>
      <span className="shrink-0 text-[10px] text-outline whitespace-nowrap mt-0.5">
        {new Date(e.createdAt).toLocaleTimeString()}
      </span>
    </li>
  );
}

/**
 * Best-effort one-line summary of a check's `detail` payload. The blob shape
 * depends on `kind` — {issues,feedback} for QA verdicts, {schemaErrors} for
 * gates, {command,exitCode,outputExcerpt} for pre-verify — so probe for the
 * common fields and fall back to nothing rather than dumping raw JSON.
 */
function detailSummary(detail?: Record<string, unknown> | null): string | null {
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;

  if (typeof d.feedback === 'string' && d.feedback.trim()) return d.feedback.trim();
  if (Array.isArray(d.issues) && d.issues.length > 0) {
    return d.issues.map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).join('; ');
  }
  if (Array.isArray(d.schemaErrors) && d.schemaErrors.length > 0) {
    return d.schemaErrors.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join('; ');
  }
  if (typeof d.command === 'string') {
    const exit = typeof d.exitCode === 'number' ? ` (exit ${d.exitCode})` : '';
    return `${d.command}${exit}`;
  }
  if (typeof d.outputExcerpt === 'string' && d.outputExcerpt.trim()) {
    return d.outputExcerpt.trim();
  }
  return null;
}
