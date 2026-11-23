'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Eye, GitMerge, Layers, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import DiffView from '@/components/chat/diff-view';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { computeLineDiff } from '../../../../src/shared/diff';
import type { ConsolidationReport } from '../../../../src/shared/learning';
import type { SkillProposalView as SkillProposal } from '../../../../src/shared/skill-proposals';

const KIND_TITLE: Record<SkillProposal['kind'], string> = {
  skill: 'Approving creates a reusable skill',
  expert: 'Approving creates a custom expert',
  patch: 'Approving replaces one passage of an existing learned skill',
};

interface ProposalList {
  proposals: SkillProposal[];
  candidateCount: number;
}

const BADGE = 'px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-mono leading-none border rounded-xs whitespace-nowrap';
const SMALL_BUTTON = 'flex items-center gap-1.5 px-2.5 py-1 border rounded-xs text-xs disabled:opacity-50 cursor-pointer disabled:cursor-default';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "seen 3× in 2 sessions"; nothing for a single sighting. */
function seenText(p: SkillProposal): string | null {
  if (p.exemplarCount < 2) return null;
  return `seen ${p.exemplarCount}× in ${plural(p.sessionCount, 'session')}`;
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The consolidation report as one plain sentence. */
function reportSentence(r: ConsolidationReport): string {
  const parts: string[] = [];
  if (r.merged > 0) parts.push(`merged ${plural(r.merged, 'proposal')}`);
  if (r.expired > 0) parts.push(`removed ${plural(r.expired, 'unseen candidate')}`);
  if (r.promoted > 0) parts.push(`showed ${plural(r.promoted, 'candidate')} that had recurred`);
  if (r.notesMerged > 0) parts.push(`merged ${plural(r.notesMerged, 'duplicate lesson note')}`);
  if (r.notesArchived > 0) parts.push(`archived ${plural(r.notesArchived, 'unused lesson note')}`);
  if (parts.length === 0) return 'Nothing to consolidate.';
  const text = joinClauses(parts);
  const degraded = r.degraded > 0
    ? `; ${r.degraded === 1 ? '1 merge was' : `${r.degraded} merges were`} only counted, not rewritten, because the model was unavailable`
    : '';
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${degraded}.`;
}

export default function SkillProposalsPage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [candidatesOpen, setCandidatesOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['skill-proposals'],
    queryFn: () => api.get<ProposalList>('/skills/proposals'),
    refetchInterval: 60_000,
  });
  const candidates = useQuery({
    queryKey: ['skill-proposals', 'candidates'],
    queryFn: async () => {
      const res = await api.get<ProposalList>('/skills/proposals?include=candidates');
      return res.proposals.filter((p) => p.status === 'candidate');
    },
    enabled: candidatesOpen,
  });

  const proposals = data?.proposals ?? [];
  const candidateCount = data?.candidateCount ?? 0;
  const selectedIds = proposals.filter((p) => selected.has(p.id)).map((p) => p.id);
  const allSelected = proposals.length > 0 && selectedIds.length === proposals.length;
  const mergeable = proposals.filter((p) => p.kind !== 'patch');

  /** Runs one action: one request in flight per key, errors in the error box, then a refetch. */
  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['skill-proposals'] });
    }
  }

  const approve = (p: SkillProposal) => run(p.id, async () => { await api.post(`/skills/proposals/${p.id}/approve`, {}); });
  const reject = (p: SkillProposal) => run(p.id, async () => { await api.post(`/skills/proposals/${p.id}/reject`, {}); });
  const surface = (p: SkillProposal) => run(p.id, async () => { await api.post(`/skills/proposals/${p.id}/surface`, {}); });
  const merge = (p: SkillProposal, intoId: string) => run(p.id, async () => {
    await api.post(`/skills/proposals/${p.id}/merge`, { intoId });
    setMergeTargets((prev) => {
      const next = { ...prev };
      delete next[p.id];
      return next;
    });
  });
  const rejectSelected = () => run('bulk', async () => {
    await api.post<{ rejected: string[]; notFound: string[] }>('/skills/proposals/bulk-reject', { ids: selectedIds });
    setSelected(new Set());
  });
  const consolidate = () => run('consolidate', async () => {
    setReport(null);
    const res = await api.post<ConsolidationReport>('/skills/proposals/consolidate', {});
    setReport(reportSentence(res));
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-background text-on-surface p-6">
      <div className="max-w-5xl mx-auto">
        <PageHeader
          title="skills/proposals"
          description="Skills and patches drafted from your sessions and from distill_skill. Suggestions on the same topic are merged into one. The → badge shows what approving does; nothing activates until you approve."
        />

        {error && (
          <div role="alert" className="bg-error-container/40 border border-error/40 text-error rounded-xs p-3 mb-4 text-sm">
            {error}
          </div>
        )}

        {report && (
          <div role="status" className="flex items-start justify-between gap-3 term-frame rounded-xs p-3 mb-4 text-sm text-on-surface-variant">
            <span>{report}</span>
            <button type="button" aria-label="Dismiss report" onClick={() => setReport(null)} className="text-on-surface-variant hover:text-on-surface cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 mb-3 text-xs">
          <label className="flex items-center gap-2 text-on-surface-variant cursor-pointer">
            <input
              type="checkbox"
              aria-label="Select all proposals"
              checked={allSelected}
              disabled={proposals.length === 0}
              onChange={() => setSelected(allSelected ? new Set() : new Set(proposals.map((p) => p.id)))}
            />
            select all
          </label>
          <button
            type="button"
            onClick={rejectSelected}
            disabled={selectedIds.length === 0 || busy === 'bulk'}
            className={cn(SMALL_BUTTON, 'bg-error-container/40 hover:bg-error-container border-error/40 text-error')}
          >
            {busy === 'bulk' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
            Reject selected ({selectedIds.length})
          </button>
          <button
            type="button"
            onClick={consolidate}
            disabled={busy === 'consolidate'}
            title="Merge proposals on the same topic, drop candidates that were never seen again, and show candidates that recurred"
            className={cn(SMALL_BUTTON, 'ml-auto bg-surface-container-high hover:bg-surface-container-highest border-outline-variant/30 text-on-surface')}
          >
            {busy === 'consolidate' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
            Consolidate now
          </button>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-on-surface-variant">
            <Loader2 className="w-4 h-4 animate-spin" /> loading proposals…
          </div>
        )}

        {!isLoading && proposals.length === 0 && (
          <div className="text-center py-12 text-on-surface-variant term-frame rounded-xs animate-enter">
            <p aria-hidden className="text-2xl text-outline-variant mb-3">[ ]</p>
            <div>no pending proposals. one appears when the same lesson shows up in a second session, or when you correct the agent.</div>
          </div>
        )}

        <div className="space-y-3 stagger">
          {proposals.map((p) => {
            const seen = seenText(p);
            const others = mergeable.filter((o) => o.id !== p.id);
            const target = mergeTargets[p.id] ?? '';
            return (
              <article
                key={p.id}
                aria-label={p.name}
                className={cn(
                  'term-frame rounded-xs p-4 border-l-2 border-l-accent/50',
                  busy === p.id && 'glow-accent border-primary/40',
                )}
              >
                <div className="flex items-start justify-between gap-4">
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.name}`}
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                    className="mt-2 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="font-medium text-lg break-words min-w-0">{p.name}</div>
                      <span className={cn(BADGE, 'border-accent/40 bg-accent-container/40 text-accent')}>ai proposed</span>
                      <span className={cn(BADGE, 'border-outline-variant/30 bg-surface-container-high text-on-surface-variant')} title={KIND_TITLE[p.kind]}>
                        → {p.kind}
                      </span>
                      {p.signal === 'correction' && (
                        <span className={cn(BADGE, 'border-primary/40 bg-primary/10 text-primary')} title="Drafted from a correction you made in a session">
                          from your correction
                        </span>
                      )}
                      {busy === p.id && <span aria-hidden className="dot dot-live bg-primary text-primary shrink-0" />}
                    </div>
                    <div className="text-sm text-on-surface-variant mb-2">{p.description}</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-on-surface-variant">
                      {seen && <span>{seen}</span>}
                      <span>last seen {new Date(p.lastExemplarAt).toLocaleDateString()}</span>
                      {p.similarSkill && (
                        <Link
                          href="/skills"
                          className="text-primary hover:underline"
                          title="An existing skill covers similar ground: check it before approving"
                        >
                          similar to skill {p.similarSkill.name} ({Math.round(p.similarSkill.similarity * 100)}%)
                        </Link>
                      )}
                      {p.sourceRef && <span className="break-all" title="Where this proposal was first drafted from; later sightings are counted in seen N×">first drafted from: {p.sourceRef}</span>}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => approve(p)}
                      disabled={busy === p.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-tertiary-container/60 hover:bg-tertiary-container border border-tertiary/40 text-tertiary rounded-xs text-sm disabled:opacity-50 cursor-pointer"
                    >
                      <Check className="w-4 h-4" /> Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => reject(p)}
                      disabled={busy === p.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-error-container/40 hover:bg-error-container border border-error/40 text-error rounded-xs text-sm disabled:opacity-50 cursor-pointer"
                    >
                      <X className="w-4 h-4" /> Reject
                    </button>
                  </div>
                </div>
                {p.kind === 'patch' && (
                  <div className="mt-3">
                    {p.stale || p.currentContent == null ? (
                      <>
                        <div className="text-xs text-error mb-1">
                          The skill changed since this patch was proposed (or is gone): approving will be refused. Reject it. The proposed passage:
                        </div>
                        <DiffView patch={computeLineDiff(p.patchOldText ?? '', p.patchNewText ?? '').patch} className="text-xs" />
                      </>
                    ) : (
                      <>
                        <div className="text-xs text-on-surface-variant mb-1">Proposed change, in the skill as it reads now:</div>
                        <DiffView patch={computeLineDiff(p.currentContent, p.draftPromptTemplate, { context: 3 }).patch} className="text-xs" />
                      </>
                    )}
                  </div>
                )}
                {p.kind !== 'patch' && p.previousDraft != null && (
                  <details className="mt-3">
                    <summary className="text-xs text-on-surface-variant cursor-pointer hover:text-on-surface">
                      Updated by a merge: what changed in the draft
                    </summary>
                    <DiffView patch={computeLineDiff(p.previousDraft, p.draftPromptTemplate, { context: 3 }).patch} className="mt-2 text-xs" />
                  </details>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <details>
                    <summary className="text-xs text-on-surface-variant cursor-pointer hover:text-on-surface">{p.kind === 'patch' ? 'Skill after the patch' : 'Draft prompt template'}</summary>
                    <pre className="mt-2 p-2 bg-surface-container-low rounded-xs text-xs text-on-surface-variant whitespace-pre-wrap overflow-x-auto">
                      {p.draftPromptTemplate}
                    </pre>
                  </details>
                  {p.kind !== 'patch' && others.length > 0 && (
                    <div className="flex items-center gap-2 text-xs ml-auto">
                      <select
                        aria-label={`Merge ${p.name} into`}
                        value={target}
                        onChange={(e) => setMergeTargets((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        disabled={busy === p.id}
                        className="max-w-56 px-2 py-1 bg-surface-container border border-outline-variant/30 rounded-xs text-xs text-on-surface"
                      >
                        <option value="">Merge into…</option>
                        {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                      <button
                        type="button"
                        onClick={() => merge(p, target)}
                        disabled={!target || busy === p.id}
                        className={cn(SMALL_BUTTON, 'bg-surface-container-high hover:bg-surface-container-highest border-outline-variant/30 text-on-surface')}
                      >
                        <GitMerge className="w-3.5 h-3.5" /> Merge
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {(candidateCount > 0 || candidatesOpen) && (
          <details
            className="mt-6 term-frame rounded-xs p-4"
            open={candidatesOpen}
            onToggle={(e) => setCandidatesOpen(e.currentTarget.open)}
          >
            <summary className="text-sm text-on-surface-variant cursor-pointer hover:text-on-surface">
              Not shown yet ({candidateCount})
            </summary>
            <p className="mt-2 text-xs text-on-surface-variant">
              These have not been seen in a second session yet, or are waiting for room under the daily or list limit. Each appears above on its own when that changes.
            </p>
            {candidates.isLoading && (
              <div className="mt-3 flex items-center gap-2 text-xs text-on-surface-variant">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> loading candidates…
              </div>
            )}
            {candidates.isError && <div className="mt-3 text-xs text-error">{candidates.error.message}</div>}
            {candidates.data?.length === 0 && <div className="mt-3 text-xs text-on-surface-variant">no candidates.</div>}
            <ul className="mt-3 divide-y divide-outline-variant/20">
              {candidates.data?.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-4 py-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium break-words">{c.name}</span>
                      <span className={cn(BADGE, 'border-outline-variant/30 bg-surface-container-high text-on-surface-variant')} title={KIND_TITLE[c.kind]}>
                        → {c.kind}
                      </span>
                    </div>
                    <div className="text-xs text-on-surface-variant">{c.description}</div>
                    <div className="text-xs text-on-surface-variant">last seen {new Date(c.lastExemplarAt).toLocaleDateString()}</div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => surface(c)}
                      disabled={busy === c.id}
                      className={cn(SMALL_BUTTON, 'bg-surface-container-high hover:bg-surface-container-highest border-outline-variant/30 text-on-surface')}
                    >
                      <Eye className="w-3.5 h-3.5" /> Show now
                    </button>
                    <button
                      type="button"
                      onClick={() => reject(c)}
                      disabled={busy === c.id}
                      className={cn(SMALL_BUTTON, 'bg-error-container/40 hover:bg-error-container border-error/40 text-error')}
                    >
                      <X className="w-3.5 h-3.5" /> Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
