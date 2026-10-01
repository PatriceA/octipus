'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { SpendBudgetMeter } from '@/components/spend-budget-meter';
import { Portal } from '@/components/ui/portal';
import { api } from '@/lib/api';
import {
  fmtUsd, MY_BUDGETS_KEY, type SpendBudgetView, type SpendPeriod, type SpendScopeKind,
} from '@/lib/spend-budgets';

/**
 * Admin: dollar spend budgets for one user — next to the token / rate quotas.
 *
 * A budget caps USD spend (SUM of cost_log) per UTC day or month, for all of
 * the user's agents, one agent role, or one workspace. At the warn ratio the
 * user is notified; at 100% every agent run is refused until the period rolls
 * over, the limit is raised, or the pause is cleared.
 *
 * API: GET/PUT/DELETE /api/admin/spend-budgets, POST …/:id/resume,
 * GET /api/roles, GET /api/admin/users/:id/workspaces.
 */

export interface BudgetUser {
  userId: string;
  username: string;
}

interface Workspace { id: string; name: string; slug: string; isDefault: boolean }
interface Role { role: string; description?: string }

interface Draft {
  scopeKind: SpendScopeKind;
  scopeRef: string;
  period: SpendPeriod;
  limitUsd: string;
  warnPct: string;
}

const EMPTY: Draft = { scopeKind: 'user', scopeRef: '', period: 'month', limitUsd: '', warnPct: '80' };

const inputClass = 'w-full bg-surface-container-high border border-outline-variant rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary';
const iconBtn = 'p-1.5 rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface cursor-pointer disabled:opacity-50';

export function SpendBudgetsSection({
  users, userId, onUserChange,
}: {
  users: BudgetUser[];
  userId: string | null;
  onUserChange: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ draft: Draft; existing: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = users.find((u) => u.userId === userId) ?? null;

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'spend-budgets', userId],
    queryFn: () => api.get<{ statuses?: SpendBudgetView[] }>(`/admin/spend-budgets?userId=${userId}`),
    enabled: !!userId,
    refetchInterval: 30_000,
  });
  const budgets = data?.statuses ?? [];

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'spend-budgets'] });
    // The admin may be editing their own budgets: refresh the banner too.
    void queryClient.invalidateQueries({ queryKey: MY_BUDGETS_KEY });
  };
  const onError = (err: Error) => setError(err.message);

  const save = useMutation({
    mutationFn: (d: Draft) => api.put('/admin/spend-budgets', {
      userId,
      scopeKind: d.scopeKind,
      scopeRef: d.scopeKind === 'user' ? null : d.scopeRef,
      period: d.period,
      limitUsd: Number(d.limitUsd),
      warnRatio: Number(d.warnPct) / 100,
    }),
    onSuccess: () => { setEditing(null); setError(null); refresh(); },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/spend-budgets/${id}`),
    onSuccess: () => { setConfirmDelete(null); setError(null); refresh(); },
    onError,
  });
  const resume = useMutation({
    mutationFn: (id: string) => api.post(`/admin/spend-budgets/${id}/resume`),
    onSuccess: () => { setError(null); refresh(); },
    onError,
  });

  const openEdit = (b: SpendBudgetView) => setEditing({
    existing: true,
    draft: {
      scopeKind: b.scopeKind,
      scopeRef: b.scopeRef ?? '',
      period: b.period,
      limitUsd: String(b.limitUsd),
      warnPct: String(Math.round(b.warnRatio * 100)),
    },
  });

  return (
    <section className="space-y-3" id="spend-budgets" data-testid="spend-budgets-section">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="section-label">spend budgets</h2>
        <span className="text-xs text-on-surface-variant">
          (USD caps per UTC day or month — warn at a ratio, pause every agent run at 100%)
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label htmlFor="budget-user" className="text-xs uppercase tracking-wide text-on-surface-variant font-bold">User</label>
        <select
          id="budget-user"
          value={userId ?? ''}
          onChange={(e) => { onUserChange(e.target.value); setError(null); setConfirmDelete(null); }}
          className="bg-surface-container-high border border-outline-variant rounded-md py-1.5 px-2 text-on-surface text-sm"
        >
          <option value="" disabled>pick a user…</option>
          {users.map((u) => <option key={u.userId} value={u.userId}>{u.username}</option>)}
        </select>
        {user && (
          <button
            type="button"
            onClick={() => { setEditing({ existing: false, draft: EMPTY }); setError(null); }}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-primary text-on-primary rounded-xs text-sm font-medium hover:bg-primary-dim cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> Add budget
          </button>
        )}
      </div>

      {error && (
        <div className="p-2 bg-error-container/40 border border-error/60 rounded-xs text-sm text-error">! {error}</div>
      )}

      <div className="term-frame rounded-xs divide-y divide-outline-variant/20">
        {!user ? (
          <p className="px-4 py-3 text-sm text-on-surface-variant">Pick a user to see and set their spend budgets.</p>
        ) : isLoading ? (
          <p className="px-4 py-3 text-sm text-on-surface-variant">Loading…</p>
        ) : budgets.length === 0 ? (
          <p className="px-4 py-3 text-sm text-on-surface-variant">
            No spend budget for {user.username} — their agents are not capped by cost.
          </p>
        ) : budgets.map((b) => (
          <div key={b.id} className="px-4 py-3 space-y-2">
            <SpendBudgetMeter
              budget={b}
              actions={(
                <>
                  {b.state === 'paused' && (
                    <button
                      type="button"
                      onClick={() => resume.mutate(b.id)}
                      disabled={resume.isPending}
                      className="flex items-center gap-1 px-2 py-1 rounded-xs border border-primary/50 text-primary text-xs hover:bg-primary-container/40 cursor-pointer disabled:opacity-50"
                      title="Clear the pause"
                    >
                      <Play className="w-3 h-3" /> Resume
                    </button>
                  )}
                  <button type="button" onClick={() => { openEdit(b); setError(null); }} className={iconBtn} title="Edit budget" aria-label="Edit budget">
                    <Pencil className="w-4 h-4" />
                  </button>
                  {confirmDelete === b.id ? (
                    <>
                      <button
                        type="button"
                        onClick={() => remove.mutate(b.id)}
                        disabled={remove.isPending}
                        className="px-2 py-1 rounded-xs border border-error/60 text-error text-xs hover:bg-error-container/40 cursor-pointer disabled:opacity-50"
                      >
                        Confirm delete
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(null)} className={iconBtn} aria-label="Cancel delete">
                        <X className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(b.id)} className={iconBtn} title="Delete budget" aria-label="Delete budget">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </>
              )}
            />
            {b.state === 'paused' && (
              <p className="text-[11px] text-on-surface-variant" data-testid="resume-hint">
                {b.spentUsd >= b.limitUsd ? (
                  <span className="text-warning">
                    Spend ({fmtUsd(b.spentUsd)}) is still at or over the limit ({fmtUsd(b.limitUsd)}): Resume alone
                    will pause again on the next agent run. Raise the limit (Edit) instead — saving clears the pause.
                  </span>
                ) : (
                  <>Resume clears the pause. It only helps once spend is under the limit or the limit has been raised;
                    otherwise the next agent run pauses it again.</>
                )}
                {b.pausedAt && <> Paused since {new Date(b.pausedAt).toLocaleString()}.</>}
              </p>
            )}
          </div>
        ))}
      </div>

      {editing && userId && user && (
        <BudgetModal
          userId={userId}
          username={user.username}
          initial={editing.draft}
          existing={editing.existing}
          onClose={() => setEditing(null)}
          onSave={(d) => save.mutate(d)}
          isSaving={save.isPending}
          error={save.error?.message ?? null}
        />
      )}
    </section>
  );
}

function BudgetModal({
  userId, username, initial, existing, onClose, onSave, isSaving, error,
}: {
  userId: string;
  username: string;
  initial: Draft;
  existing: boolean;
  onClose: () => void;
  onSave: (d: Draft) => void;
  isSaving: boolean;
  error: string | null;
}) {
  const [d, setD] = useState<Draft>(initial);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ roles?: Role[] }>('/roles'),
    enabled: d.scopeKind === 'role',
  });
  const workspaces = useQuery({
    queryKey: ['admin', 'user-workspaces', userId],
    queryFn: () => api.get<{ workspaces?: Workspace[] }>(`/admin/users/${userId}/workspaces`),
    enabled: d.scopeKind === 'workspace',
  });

  const limit = Number(d.limitUsd);
  const warn = Number(d.warnPct);
  const invalid =
    !(limit > 0) ? 'Limit must be a positive dollar amount.'
    : !(warn > 0 && warn <= 100) ? 'Warn % must be between 1 and 100.'
    : d.scopeKind !== 'user' && !d.scopeRef ? `Pick a ${d.scopeKind}.`
    : null;

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div className="term-frame rounded-xs p-6 max-w-md w-full space-y-4 border-primary/40 animate-enter" role="dialog" aria-label="Spend budget">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-[13px] text-on-surface font-mono">
                <span aria-hidden className="text-primary font-bold">&gt; </span>
                {existing ? 'edit' : 'new'} spend budget — {username}
              </h3>
              <p className="text-sm text-on-surface-variant mt-1">
                {existing
                  ? 'Saving clears any warning or pause; the new limit is checked on the next agent run.'
                  : 'One budget per scope and period. Saving an existing one replaces it.'}
              </p>
            </div>
            <button type="button" onClick={onClose} className="p-1 rounded text-on-surface-variant hover:text-on-surface cursor-pointer" aria-label="Close">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="space-y-3">
            <Labeled label="Scope" htmlFor="budget-scope">
              <select
                id="budget-scope"
                value={d.scopeKind}
                disabled={existing}
                onChange={(e) => setD((x) => ({ ...x, scopeKind: e.target.value as SpendScopeKind, scopeRef: '' }))}
                className={inputClass}
              >
                <option value="user">All of the user&apos;s agents</option>
                <option value="role">One agent role</option>
                <option value="workspace">One workspace</option>
                {/* Set on Admin → Group channels; shown here for the channel's owner. */}
                {existing && d.scopeKind === 'group_channel' && <option value="group_channel">One group channel</option>}
              </select>
            </Labeled>

            {d.scopeKind === 'role' && (
              <Labeled label="Role" htmlFor="budget-role">
                <select id="budget-role" value={d.scopeRef} disabled={existing} onChange={(e) => set('scopeRef', e.target.value)} className={inputClass}>
                  <option value="" disabled>{roles.isLoading ? 'loading roles…' : 'pick a role…'}</option>
                  {existing && d.scopeRef && !roles.data?.roles?.some((r) => r.role === d.scopeRef) && (
                    <option value={d.scopeRef}>{d.scopeRef}</option>
                  )}
                  {(roles.data?.roles ?? []).map((r) => <option key={r.role} value={r.role}>{r.role}</option>)}
                </select>
              </Labeled>
            )}

            {d.scopeKind === 'workspace' && (
              <Labeled label="Workspace" htmlFor="budget-workspace">
                <select id="budget-workspace" value={d.scopeRef} disabled={existing} onChange={(e) => set('scopeRef', e.target.value)} className={inputClass}>
                  <option value="" disabled>{workspaces.isLoading ? 'loading workspaces…' : 'pick a workspace…'}</option>
                  {existing && d.scopeRef && !workspaces.data?.workspaces?.some((w) => w.id === d.scopeRef) && (
                    <option value={d.scopeRef}>{d.scopeRef}</option>
                  )}
                  {(workspaces.data?.workspaces ?? []).map((w) => (
                    <option key={w.id} value={w.id}>{w.name}{w.isDefault ? ' (default)' : ''}</option>
                  ))}
                </select>
              </Labeled>
            )}

            <Labeled label="Period" htmlFor="budget-period">
              <select id="budget-period" value={d.period} disabled={existing} onChange={(e) => set('period', e.target.value as SpendPeriod)} className={inputClass}>
                <option value="day">Per UTC day</option>
                <option value="month">Per UTC month</option>
              </select>
            </Labeled>

            <div className="grid grid-cols-2 gap-3">
              <Labeled label="Limit (USD)" htmlFor="budget-limit">
                <input
                  id="budget-limit"
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  value={d.limitUsd}
                  onChange={(e) => set('limitUsd', e.target.value)}
                  placeholder="e.g. 25"
                  className={inputClass}
                />
              </Labeled>
              <Labeled label="Warn at %" htmlFor="budget-warn">
                <input
                  id="budget-warn"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  value={d.warnPct}
                  onChange={(e) => set('warnPct', e.target.value)}
                  className={inputClass}
                />
              </Labeled>
            </div>
            {existing && (
              <p className="text-[11px] text-on-surface-variant">
                Scope and period identify the budget; to change them, add a new budget and delete this one.
              </p>
            )}
          </div>

          {(error || (invalid && d.limitUsd !== '')) && (
            <div className="p-2 bg-error-container/40 border border-error/60 rounded-xs text-sm text-error">! {error ?? invalid}</div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-3 py-2 bg-surface-container-high text-on-surface-variant rounded-lg text-sm hover:text-on-surface cursor-pointer">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave(d)}
              disabled={isSaving || !!invalid}
              className="px-3 py-2 bg-primary text-on-primary rounded-xs text-sm font-medium hover:bg-primary-dim disabled:opacity-50 cursor-pointer"
            >
              {isSaving ? 'Saving…' : 'Save budget'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function Labeled({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-xs uppercase tracking-wide text-on-surface-variant font-bold mb-1">{label}</label>
      {children}
    </div>
  );
}
