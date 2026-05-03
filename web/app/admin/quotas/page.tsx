'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, Pencil, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

/**
 * Admin: per-user quotas — Phase 3c-1.
 *
 * Reads /api/admin/quotas (one row per user with effective limits +
 * current usage), shows a table, opens a per-user editor on click.
 *
 * The editor accepts:
 *   - blank → no change
 *   - a positive integer → set as override
 *   - clicking "Reset" → clear that override (revert to global default)
 *
 * No enforcement is in place yet — Phase 3c-2 wires the gates at the
 * agent worker / rate-limiter / API request layers. This screen ships
 * the visibility + management UI so operators can act before the
 * enforcement code lands.
 */

type Effective = {
  maxConcurrentAgents: number;
  maxTokensPerDay: number;
  maxApiCallsPerMinute: number;
  overrides: {
    maxConcurrentAgents: boolean;
    maxTokensPerDay: boolean;
    maxApiCallsPerMinute: boolean;
  };
};

type Usage = {
  concurrentAgents: number;
  tokensToday: number;
  apiCallsLastMinute: number;
};

interface QuotaRow {
  userId: string;
  username: string;
  isAdmin: boolean;
  isActive: boolean;
  quota: Effective;
  usage: Usage;
}

function fmt(n: number): string {
  if (n >= Number.MAX_SAFE_INTEGER) return '∞';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function pct(current: number, max: number): number {
  if (max <= 0 || max === Number.MAX_SAFE_INTEGER) return 0;
  return Math.min(100, Math.round((current / max) * 100));
}

function MeterCell({ current, max, ovrd }: { current: number; max: number; ovrd: boolean }) {
  const p = pct(current, max);
  const tone = p >= 90 ? 'bg-red-600' : p >= 70 ? 'bg-yellow-500' : 'bg-primary';
  return (
    <div className="space-y-1">
      <div className="text-xs text-on-surface-variant tabular-nums">
        <span className="text-white">{fmt(current)}</span>
        <span className="mx-1">/</span>
        <span>{fmt(max)}</span>
        {ovrd && <span className="ml-1 text-primary" title="Per-user override">*</span>}
      </div>
      <div className="h-1 w-full bg-[#262626] rounded">
        <div className={`h-1 rounded ${tone}`} style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

export default function AdminQuotasPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<QuotaRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'quotas'],
    queryFn: () => api.get<{ quotas: QuotaRow[] }>('/admin/quotas'),
    refetchInterval: 10_000, // usage figures move; refresh periodically
  });

  const patchMutation = useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: Record<string, unknown> }) =>
      api.patch(`/admin/quotas/${userId}`, body),
    onSuccess: () => {
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['admin', 'quotas'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const resetAllMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/admin/quotas/${userId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'quotas'] }),
  });

  const rows = data?.quotas ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Gauge className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-extrabold tracking-tighter text-white">Quotas</h2>
        <span className="text-xs text-on-surface-variant">
          (* indicates a per-user override; everything else inherits the global default)
        </span>
      </div>

      {error && (
        <div className="p-2 bg-error-dim/10 border border-error-dim/20 rounded text-sm text-error">{error}</div>
      )}

      <div className="overflow-x-auto bg-[#1a1a1a] rounded-lg">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-on-surface-variant">
            <tr className="border-b border-outline-variant/10">
              <th className="text-left px-4 py-2 font-medium">User</th>
              <th className="text-left px-4 py-2 font-medium">Concurrent agents</th>
              <th className="text-left px-4 py-2 font-medium">Tokens today</th>
              <th className="text-left px-4 py-2 font-medium">API calls/min</th>
              <th className="text-right px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={5} className="px-4 py-3 text-on-surface-variant">Loading…</td></tr>
            )}
            {!isLoading && rows.map((r) => (
              <tr key={r.userId} className="border-b border-outline-variant/5 last:border-0">
                <td className="px-4 py-3">
                  <div className="text-white font-medium">{r.username}</div>
                  <div className="text-xs text-on-surface-variant">{r.userId.slice(0, 8)}…</div>
                </td>
                <td className="px-4 py-3 min-w-[160px]">
                  <MeterCell
                    current={r.usage.concurrentAgents}
                    max={r.quota.maxConcurrentAgents}
                    ovrd={r.quota.overrides.maxConcurrentAgents}
                  />
                </td>
                <td className="px-4 py-3 min-w-[160px]">
                  <MeterCell
                    current={r.usage.tokensToday}
                    max={r.quota.maxTokensPerDay}
                    ovrd={r.quota.overrides.maxTokensPerDay}
                  />
                </td>
                <td className="px-4 py-3 min-w-[160px]">
                  <MeterCell
                    current={r.usage.apiCallsLastMinute}
                    max={r.quota.maxApiCallsPerMinute}
                    ovrd={r.quota.overrides.maxApiCallsPerMinute}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => { setEditing(r); setError(null); }}
                    className="p-2 rounded text-on-surface-variant hover:bg-[#262626] hover:text-white cursor-pointer"
                    title="Edit overrides"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  {(r.quota.overrides.maxConcurrentAgents ||
                    r.quota.overrides.maxTokensPerDay ||
                    r.quota.overrides.maxApiCallsPerMinute) && (
                    <button
                      type="button"
                      onClick={() => resetAllMutation.mutate(r.userId)}
                      className="p-2 rounded text-on-surface-variant hover:bg-[#262626] hover:text-white cursor-pointer"
                      title="Clear all overrides for this user"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditModal
          row={editing}
          onClose={() => setEditing(null)}
          onSave={(patch) => patchMutation.mutate({ userId: editing.userId, body: patch })}
          isSaving={patchMutation.isPending}
        />
      )}
    </div>
  );
}

function EditModal({
  row, onClose, onSave, isSaving,
}: {
  row: QuotaRow;
  onClose: () => void;
  onSave: (patch: Record<string, number | null>) => void;
  isSaving: boolean;
}) {
  const initial = (n: number, ovrd: boolean): string =>
    ovrd ? String(n) : '';
  const [concurrent, setConcurrent] = useState(initial(row.quota.maxConcurrentAgents, row.quota.overrides.maxConcurrentAgents));
  const [tokens, setTokens] = useState(initial(row.quota.maxTokensPerDay, row.quota.overrides.maxTokensPerDay));
  const [apiPm, setApiPm] = useState(initial(row.quota.maxApiCallsPerMinute, row.quota.overrides.maxApiCallsPerMinute));

  // Each row toggles between three states: "no change" (leave override
  // alone), "set to N" (positive integer), and "clear" (revert to
  // global). The UI represents "no change" as the field being equal
  // to the value at modal-open time; "clear" is an explicit button.
  const handleSave = () => {
    const patch: Record<string, number | null> = {};
    const parseField = (raw: string, ovrd: boolean, current: number, key: string) => {
      const trimmed = raw.trim();
      if (trimmed === '' && !ovrd) return; // never had override + still empty → unchanged
      if (trimmed === '' && ovrd) { patch[key] = null; return; } // had override, now empty → clear
      const n = parseInt(trimmed, 10);
      if (!Number.isFinite(n) || n < 1) return; // ignore invalid
      if (ovrd && n === current) return; // unchanged
      patch[key] = n;
    };
    parseField(concurrent, row.quota.overrides.maxConcurrentAgents, row.quota.maxConcurrentAgents, 'maxConcurrentAgents');
    parseField(tokens, row.quota.overrides.maxTokensPerDay, row.quota.maxTokensPerDay, 'maxTokensPerDay');
    parseField(apiPm, row.quota.overrides.maxApiCallsPerMinute, row.quota.maxApiCallsPerMinute, 'maxApiCallsPerMinute');
    if (Object.keys(patch).length === 0) { onClose(); return; }
    onSave(patch);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-[#1a1a1a] rounded-2xl p-6 max-w-md w-full space-y-4 border border-primary/20">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-extrabold tracking-tighter text-white">Quotas — {row.username}</h3>
            <p className="text-sm text-on-surface-variant mt-1">
              Leave a field blank to inherit the global default. Set a positive integer to override.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-on-surface-variant hover:text-white cursor-pointer"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="Max concurrent agents" value={concurrent} onChange={setConcurrent} />
          <Field label="Max tokens per day" value={tokens} onChange={setTokens} />
          <Field label="Max API calls per minute" value={apiPm} onChange={setApiPm} />
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 bg-[#262626] text-on-surface-variant rounded-lg text-sm hover:text-white cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="px-3 py-2 bg-primary text-[#0e0e0e] rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wide text-on-surface-variant font-bold mb-1">{label}</label>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
        placeholder="(inherit default)"
        className="w-full bg-[#262626] border-none rounded-md py-2 px-3 text-white text-sm focus:ring-1 focus:ring-primary"
      />
    </div>
  );
}
