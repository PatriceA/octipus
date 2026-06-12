'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Loader2, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';

interface MemoryRow {
  id: string;
  factType: string;
  agentScope: string | null;
  content: string;
  confidence: number;
  supersededBy: string | null;
  validUntil: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemoryListResponse {
  memories: MemoryRow[];
  total: number;
  includeHistory: boolean;
}

const FACT_TYPES = ['preference', 'profile', 'relationship', 'skill_observation', 'workflow_note'] as const;

export default function MemoryPage() {
  const qc = useQueryClient();
  const [includeHistory, setIncludeHistory] = useState(false);
  const [factType, setFactType] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const list = useQuery<MemoryListResponse>({
    queryKey: ['memory', { includeHistory, factType }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (includeHistory) params.set('includeHistory', 'true');
      if (factType) params.set('factType', factType);
      const qs = params.toString();
      return api.get<MemoryListResponse>(`/memory${qs ? `?${qs}` : ''}`);
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/memory/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }),
  });

  const chain = useQuery({
    queryKey: ['memory-chain', expandedId],
    queryFn: () => expandedId ? api.get<{ chain: MemoryRow[] }>(`/memory/${expandedId}/chain`) : null,
    enabled: !!expandedId,
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        title="memory"
        description="long-term facts extracted from your conversations — soft-delete (set valid_until) keeps the audit trail intact for the llm judge's future add/update decisions"
      />

      <div className="flex gap-3 items-center mb-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeHistory}
            onChange={(e) => setIncludeHistory(e.target.checked)}
          />
          Show superseded rows
        </label>
        <select
          value={factType}
          onChange={(e) => setFactType(e.target.value)}
          className="bg-transparent border px-2 py-1 rounded font-mono text-xs"
        >
          <option value="">all fact types</option>
          {FACT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {list.isFetching && <Loader2 className="w-4 h-4 animate-spin" />}
      </div>

      {list.error && (
        <div className="border border-error/40 bg-error-container/40 text-error p-3 rounded-xs mb-4 text-sm">
          Failed to load memories: {(list.error as Error).message}
        </div>
      )}

      {list.data && list.data.memories.length === 0 && (
        <div className="border border-dashed border-outline-variant p-6 rounded-xs text-center font-mono">
          <span aria-hidden className="block text-lg text-outline mb-2">[--]</span>
          <p className="text-[12px] text-on-surface-variant">
            no memories yet — extracted automatically after each turn (when an embedding + extractor
            model is configured) or written explicitly by an agent via the <code>remember_this</code> tool
          </p>
        </div>
      )}

      <ul className="space-y-2 stagger">
        {list.data?.memories.map((m) => {
          const isExpired = m.validUntil && new Date(m.validUntil) < new Date();
          const isSuperseded = !!m.supersededBy;
          const inactive = isExpired || isSuperseded;
          return (
            <li
              key={m.id}
              className={`border rounded p-3 ${inactive ? 'opacity-50' : ''}`}
            >
              <div className="flex justify-between items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap gap-2 text-xs font-mono mb-1">
                    <span className="border px-1.5 rounded">{m.factType}</span>
                    {m.agentScope && <span className="border px-1.5 rounded opacity-70">scope: {m.agentScope}</span>}
                    {m.confidence < 0.9 && (
                      <span className="border px-1.5 rounded opacity-70">p≈{m.confidence.toFixed(2)}</span>
                    )}
                    {isSuperseded && <span className="border border-warning/60 px-1.5 rounded-xs text-warning">superseded</span>}
                    {isExpired && <span className="border border-error/60 px-1.5 rounded-xs text-error">expired</span>}
                    <span className="opacity-50">
                      {m.accessCount} reads · {new Date(m.updatedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="text-sm">{m.content}</div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expandedId === m.id ? null : m.id)}
                    className="p-1 hover:bg-foreground/10 rounded"
                    title="Show supersession chain"
                  >
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${expandedId === m.id ? 'rotate-180' : ''}`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm('Soft-delete this memory? It stays in the audit log.')) {
                        del.mutate(m.id);
                      }
                    }}
                    disabled={inactive || del.isPending}
                    className="p-1 hover:bg-foreground/10 rounded disabled:opacity-30"
                    title={inactive ? 'Already inactive' : 'Delete'}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {expandedId === m.id && chain.data && (
                <div className="mt-3 pl-4 border-l-2 border-foreground/20 text-xs space-y-1">
                  <div className="section-label">update chain (oldest → newest)</div>
                  {chain.data.chain.slice().reverse().map((row, i) => (
                    <div key={row.id} className="flex gap-2">
                      <span className="opacity-50 font-mono">v{i + 1}</span>
                      <span className="font-mono opacity-70">{new Date(row.createdAt).toLocaleDateString()}</span>
                      <span>{row.content}</span>
                    </div>
                  ))}
                  {chain.isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {del.error && (
        <div className="fixed bottom-4 right-4 border border-error/40 bg-error-container/80 text-error glow-err p-3 rounded-xs flex items-center gap-2 text-sm animate-slide-up">
          Delete failed: {(del.error as Error).message}
          <button type="button" onClick={() => del.reset()}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
