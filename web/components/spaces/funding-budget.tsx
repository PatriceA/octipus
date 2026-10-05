'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { AgentFundingMode, Space } from '@/lib/workspace-context';
import type { PersonalModelsResponse, SpaceBudgetStatus } from '../../../src/shared/types';

const inputClass = 'px-2 py-1 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface focus:outline-none focus:border-primary';
const buttonClass = 'inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-xs border border-outline-variant/60 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high disabled:opacity-50 cursor-pointer';
const primaryClass = 'inline-flex items-center gap-1.5 px-2.5 py-1 text-[12px] rounded-xs bg-primary text-on-primary hover:bg-primary-dim disabled:opacity-50 cursor-pointer';

const MODES: Array<{ value: AgentFundingMode; label: string; hint: string }> = [
  { value: 'own', label: 'own', hint: 'each member pays for their own turns; nothing runs unprompted' },
  { value: 'unattended', label: 'unattended', hint: 'members pay for their own turns; the sponsor pays for unprompted work (listen rooms)' },
  { value: 'sponsored', label: 'sponsored', hint: 'the sponsor pays for every agent run here, each member under the per-member cap' },
];

/** One line saying who pays, for the page header. */
export function fundingSummary(space: Space, sponsorName: string | null): string {
  if (space.funding === 'own') return "each member's agent runs are their own";
  const who = space.sponsorUserId ? (sponsorName ?? 'a sponsor') : 'no sponsor yet';
  return space.funding === 'sponsored' ? `agent runs paid by ${who}` : `unprompted work paid by ${who}`;
}

/**
 * Space settings → Funding (coworking spec §9.1): who pays for the agent.
 * Owners pick the mode; an owner names themselves the sponsor (nobody is
 * made to pay by someone else) and, as the sponsor, picks which of their own
 * models sponsored turns may run on. Members see the settings read-only.
 */
export function FundingSection({ space, userId, sponsorName, onChanged, onError }: {
  space: Space;
  userId: string | undefined;
  sponsorName: string | null;
  onChanged: () => Promise<void>;
  onError: (e: Error) => void;
}) {
  const isOwner = space.role === 'owner';
  const editable = isOwner && !space.archivedAt;
  const iAmSponsor = !!userId && space.sponsorUserId === userId;
  const modelsQ = useQuery({
    queryKey: ['me', 'models'],
    queryFn: () => api.get<PersonalModelsResponse>('/me/models'),
    enabled: iAmSponsor && editable,
  });
  const save = useMutation({
    mutationFn: (body: { mode?: AgentFundingMode; sponsor?: 'me' | null; sponsorModels?: string[] }) => api.put(`/spaces/${space.id}/funding`, body),
    onSuccess: onChanged,
    onError,
  });
  const toggleModel = (name: string) => {
    const next = space.sponsorModels.includes(name) ? space.sponsorModels.filter((m) => m !== name) : [...space.sponsorModels, name];
    save.mutate({ sponsorModels: next });
  };

  return (
    <section aria-label="Funding" className="space-y-2">
      <h2 className="section-label">funding</h2>
      <div className="term-frame rounded-xs p-3 space-y-3 text-[12px]">
        <label className="flex flex-wrap items-center gap-2">
          <span className="text-on-surface-variant w-24">who pays</span>
          {editable ? (
            <select
              aria-label="Agent funding"
              value={space.funding}
              disabled={save.isPending}
              onChange={(e) => save.mutate({ mode: e.target.value as AgentFundingMode })}
              className={inputClass}
            >
              {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          ) : (
            <span className="text-on-surface" data-testid="space-funding">{space.funding}</span>
          )}
          <span className="text-outline-variant">{MODES.find((m) => m.value === space.funding)?.hint}</span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-on-surface-variant w-24">sponsor</span>
          <span className="text-on-surface" data-testid="space-sponsor">{space.sponsorUserId ? (sponsorName ?? space.sponsorUserId) : 'none'}</span>
          {editable && !iAmSponsor && (
            <button type="button" onClick={() => save.mutate({ sponsor: 'me' })} disabled={save.isPending} className={buttonClass}>
              sponsor this space
            </button>
          )}
          {editable && space.sponsorUserId && (
            <button
              type="button"
              onClick={() => window.confirm('Remove the sponsor? Sponsored work stops until an owner sponsors the space again.') && save.mutate({ sponsor: null })}
              disabled={save.isPending}
              className={buttonClass}
            >
              {iAmSponsor ? 'stop sponsoring' : 'remove sponsor'}
            </button>
          )}
        </div>
        {space.funding !== 'own' && !space.sponsorUserId && (
          <p className="text-error" data-testid="funding-no-sponsor">
            no sponsor: {space.funding === 'sponsored' ? 'agent runs here' : 'unprompted work'} cannot start until an owner sponsors the space.
          </p>
        )}
        {space.sponsorUserId && (
          <div className="space-y-1">
            <span className="text-on-surface-variant">sponsor models</span>
            {iAmSponsor && editable ? (
              (modelsQ.data?.models ?? []).length === 0 ? (
                <p className="text-outline-variant">you have no models of your own; sponsored turns run on the install's models.</p>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {(modelsQ.data?.models ?? []).map((m) => (
                    <label key={m.name} className="inline-flex items-center gap-1.5 text-on-surface">
                      <input
                        type="checkbox"
                        aria-label={`Sponsor model ${m.label ?? m.slug}`}
                        checked={space.sponsorModels.includes(m.name)}
                        disabled={save.isPending}
                        onChange={() => toggleModel(m.name)}
                      />
                      {m.label ?? m.slug} <span className="text-outline-variant">{m.modelId}</span>
                    </label>
                  ))}
                </div>
              )
            ) : (
              <p className="text-on-surface" data-testid="sponsor-models">
                {space.sponsorModels.length === 0 ? "the install's models" : `${space.sponsorModels.length} of the sponsor's own models`}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Space settings → Budget (§9.2): the space's cap on what the sponsor pays,
 * and the per-member cap, each per day or month. Members see the spend (the
 * member cap with their own share); owners set and remove the caps.
 */
export function BudgetSection({ space, onError }: { space: Space; onError: (e: Error) => void }) {
  const qc = useQueryClient();
  const isOwner = space.role === 'owner' && !space.archivedAt;
  const budgetQ = useQuery({
    queryKey: ['space', space.id, 'budget'],
    queryFn: () => api.get<{ budgets: SpaceBudgetStatus[] }>(`/spaces/${space.id}/budget`),
  });
  const save = useMutation({
    mutationFn: (body: { kind: SpaceBudgetStatus['scopeKind']; period: SpaceBudgetStatus['period']; limitUsd: number | null }) =>
      api.put<{ budgets: SpaceBudgetStatus[] }>(`/spaces/${space.id}/budget`, body),
    onSuccess: (data) => qc.setQueryData(['space', space.id, 'budget'], data),
    onError,
  });
  const budgets = budgetQ.data?.budgets ?? [];

  return (
    <section aria-label="Budget" className="space-y-2">
      <h2 className="section-label">budget</h2>
      <div className="term-frame rounded-xs divide-y divide-outline-variant/20 text-[12px]" data-testid="space-budgets">
        {budgets.length === 0 && <p className="px-3 py-3 text-on-surface-variant">no space budget: sponsored work is not capped.</p>}
        {budgets.map((b) => (
          <div key={b.id} className="flex flex-wrap items-center gap-3 px-3 py-2" data-testid="space-budget">
            <span className="text-on-surface w-44">{b.scopeKind === 'space' ? 'whole space' : 'each member (your share)'} / {b.period}</span>
            <span className={b.state === 'paused' ? 'text-error' : b.state === 'warned' ? 'text-tertiary' : 'text-on-surface-variant'}>
              ${b.spentUsd.toFixed(2)} of ${b.limitUsd.toFixed(2)} · {b.state}
            </span>
            <span className="flex-1" />
            {isOwner && (
              <button type="button" onClick={() => save.mutate({ kind: b.scopeKind, period: b.period, limitUsd: null })} disabled={save.isPending} className={buttonClass}>
                remove
              </button>
            )}
          </div>
        ))}
      </div>
      {isOwner && <BudgetForm saving={save.isPending} onSave={(v) => save.mutate(v)} />}
    </section>
  );
}

function BudgetForm({ saving, onSave }: { saving: boolean; onSave: (v: { kind: SpaceBudgetStatus['scopeKind']; period: SpaceBudgetStatus['period']; limitUsd: number }) => void }) {
  const [kind, setKind] = useState<SpaceBudgetStatus['scopeKind']>('space');
  const [period, setPeriod] = useState<SpaceBudgetStatus['period']>('month');
  const [limit, setLimit] = useState('');
  const value = Number(limit);
  const valid = limit.trim() !== '' && Number.isFinite(value) && value > 0;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-outline-variant">
        cap
        <select aria-label="Budget kind" value={kind} onChange={(e) => setKind(e.target.value as SpaceBudgetStatus['scopeKind'])} className={inputClass}>
          <option value="space">whole space</option>
          <option value="space_member">each member</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-outline-variant">
        per
        <select aria-label="Budget period" value={period} onChange={(e) => setPeriod(e.target.value as SpaceBudgetStatus['period'])} className={inputClass}>
          <option value="day">day</option>
          <option value="month">month</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-outline-variant">
        usd
        <input aria-label="Budget limit" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} className={`${inputClass} w-24`} />
      </label>
      <button type="button" disabled={saving || !valid} onClick={() => { onSave({ kind, period, limitUsd: value }); setLimit(''); }} className={primaryClass}>
        <Check className="w-3.5 h-3.5" /> set budget
      </button>
    </div>
  );
}
