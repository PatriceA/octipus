'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lightbulb, Loader2, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

interface SkillProposal {
  id: string;
  userId: string;
  fingerprint: string;
  name: string;
  description: string;
  draftPromptTemplate: string;
  exemplarCount: number;
  lastExemplarAt: string;
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
    <div className="min-h-screen bg-[#0a0a0a] text-gray-200 p-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-2">
          <Sparkles className="w-6 h-6 text-warning" />
          <h1 className="text-2xl font-semibold">Skill Proposals</h1>
        </div>
        <p className="text-sm text-gray-400 mb-6">
          Auto-extension suggestions from recurring interaction patterns. Nothing activates until you approve.
        </p>

        {error && (
          <div className="bg-red-900/20 border border-red-800 text-error rounded-md p-3 mb-4 text-sm">
            {error}
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading proposals…
          </div>
        )}

        {!isLoading && (!data || data.length === 0) && (
          <div className="text-center py-12 text-gray-500 border border-gray-800 rounded-lg">
            <Lightbulb className="w-10 h-10 mx-auto mb-3 text-gray-600" />
            <div>No pending proposals. Keep working — the detector watches for recurring patterns.</div>
          </div>
        )}

        <div className="space-y-3">
          {data?.map((p) => (
            <div key={p.id} className="border border-gray-800 rounded-lg p-4 bg-gray-900/40">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-lg">{p.name}</div>
                  <div className="text-sm text-gray-400 mb-2">{p.description}</div>
                  <div className="flex gap-4 text-xs text-gray-500">
                    <span>{p.exemplarCount} exemplars</span>
                    <span>last seen {new Date(p.lastExemplarAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => approve(p)}
                    disabled={busyId === p.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-900/30 hover:bg-green-900/50 text-tertiary rounded-md text-sm disabled:opacity-50"
                  >
                    <Check className="w-4 h-4" /> Approve
                  </button>
                  <button
                    onClick={() => reject(p)}
                    disabled={busyId === p.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-red-900/20 hover:bg-red-900/40 text-error rounded-md text-sm disabled:opacity-50"
                  >
                    <X className="w-4 h-4" /> Reject
                  </button>
                </div>
              </div>
              <details className="mt-3">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">Draft prompt template</summary>
                <pre className="mt-2 p-2 bg-black/40 rounded text-xs text-gray-300 whitespace-pre-wrap overflow-x-auto">
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
