'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface SkillProposal {
  id: string;
  userId: string;
  fingerprint: string;
  name: string;
  description: string;
  draftPromptTemplate: string;
  exemplarCount: number;
  lastExemplarAt: string;
  kind?: 'skill' | 'expert';
  sourceRef?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'promoted';
  createdAt: string;
}

export default function SkillProposalsPage() {
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['skill-proposals'],
    queryFn: async () => {
      const res = await api.get<{ proposals: SkillProposal[] }>('/skills/proposals');
      return res.proposals;
    },
    refetchInterval: 60_000,
  });

  async function approve(p: SkillProposal) {
    setBusyId(p.id);
    setError(null);
    try {
      await api.post(`/skills/proposals/${p.id}/approve`, {});
      qc.invalidateQueries({ queryKey: ['skill-proposals'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function reject(p: SkillProposal) {
    setBusyId(p.id);
    setError(null);
    try {
      await api.post(`/skills/proposals/${p.id}/reject`, {});
      qc.invalidateQueries({ queryKey: ['skill-proposals'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="min-h-screen bg-background text-on-surface p-6">
      <div className="max-w-5xl mx-auto">
        <PageHeader
          title="skills/proposals"
          description="Suggestions from recurring interaction patterns and distilled skills (skill_distill). The → badge shows whether approving creates a skill or an expert. Nothing activates until you approve."
        />

        {error && (
          <div className="bg-error-container/40 border border-error/40 text-error rounded-xs p-3 mb-4 text-sm">
            {error}
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-on-surface-variant">
            <Loader2 className="w-4 h-4 animate-spin" /> loading proposals…
          </div>
        )}

        {!isLoading && (!data || data.length === 0) && (
          <div className="text-center py-12 text-on-surface-variant term-frame rounded-xs animate-enter">
            <p aria-hidden className="text-2xl text-outline-variant mb-3">[ ]</p>
            <div>no pending proposals. keep working — the detector watches for recurring patterns.</div>
          </div>
        )}

        <div className="space-y-3 stagger">
          {data?.map((p) => (
            <div
              key={p.id}
              className={cn(
                'term-frame rounded-xs p-4 border-l-2 border-l-accent/50',
                busyId === p.id && 'glow-accent border-primary/40',
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-medium text-lg">{p.name}</div>
                    <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-mono leading-none border border-accent/40 bg-accent-container/40 text-accent rounded-xs">
                      ai proposed
                    </span>
                    <span
                      className="px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-mono leading-none border border-outline-variant/30 bg-surface-container-high text-on-surface-variant rounded-xs"
                      title={p.kind === 'skill' ? 'Approving creates a reusable skill' : 'Approving creates a custom expert'}
                    >
                      → {p.kind ?? 'expert'}
                    </span>
                    {busyId === p.id && (
                      <span aria-hidden className="dot dot-live bg-primary text-primary shrink-0" />
                    )}
                  </div>
                  <div className="text-sm text-on-surface-variant mb-2">{p.description}</div>
                  <div className="flex gap-4 text-xs text-on-surface-variant">
                    <span>{p.exemplarCount} exemplars</span>
                    <span>last seen {new Date(p.lastExemplarAt).toLocaleDateString()}</span>
                    {p.sourceRef && <span title="Where this was distilled from">source: {p.sourceRef}</span>}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => approve(p)}
                    disabled={busyId === p.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-tertiary-container/60 hover:bg-tertiary-container border border-tertiary/40 text-tertiary rounded-xs text-sm disabled:opacity-50 cursor-pointer"
                  >
                    <Check className="w-4 h-4" /> Approve
                  </button>
                  <button
                    onClick={() => reject(p)}
                    disabled={busyId === p.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-error-container/40 hover:bg-error-container border border-error/40 text-error rounded-xs text-sm disabled:opacity-50 cursor-pointer"
                  >
                    <X className="w-4 h-4" /> Reject
                  </button>
                </div>
              </div>
              <details className="mt-3">
                <summary className="text-xs text-on-surface-variant cursor-pointer hover:text-on-surface">Draft prompt template</summary>
                <pre className="mt-2 p-2 bg-surface-container-low rounded-xs text-xs text-on-surface-variant whitespace-pre-wrap overflow-x-auto">
                  {p.draftPromptTemplate}
                </pre>
              </details>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
