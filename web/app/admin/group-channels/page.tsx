'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { GroupChannelModeForm } from '@/components/group-channel-mode-form';
import { SpendBudgetMeter } from '@/components/spend-budget-meter';
import { api } from '@/lib/api';
import type { SpendBudgetView, SpendPeriod } from '@/lib/spend-budgets';
import type { GroupChannelSummary } from '../../../../src/shared/types';

/** A channel as this page lists it: with its spend budget, when it has one. */
type AdminGroupChannel = GroupChannelSummary & { budgets?: SpendBudgetView[] };

interface BudgetDraft {
  period: SpendPeriod;
  limitUsd: string;
  warnPct: string;
}

const inputClass = 'bg-surface-container-high border border-outline-variant rounded-md py-1 px-2 text-on-surface text-sm';
const iconBtn = 'p-1 rounded text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface cursor-pointer disabled:opacity-50';

/**
 * Admin → Group channels.
 *
 * Every shared chat a linked member enrolled Octipus into. Owners enrol from
 * inside the channel; admins do not approve, but can revoke. A channel whose
 * owner is deactivated is paused until a member types `@Octipus join`.
 *
 * A channel can have a spend budget: it counts every member's spend there and
 * pauses the bot in the channel at the limit. It is filed under the channel's
 * owner, who is notified (PUT /api/admin/spend-budgets, scope group_channel).
 */
export default function AdminGroupChannelsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'group-channels'],
    queryFn: () => api.get<{ groupChannels: AdminGroupChannel[] }>('/admin/group-channels'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'group-channels'] });
  const removeMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/group-channels/${id}`),
    onSuccess: refresh,
  });
  const groups = data?.groupChannels ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="section-label">group channels</h2>
        <p className="mt-1 text-xs text-on-surface-variant">
          Shared chats where Octipus answers members who mention it. Each turn runs as the member who asked.
          Revoking makes the bot go quiet in that channel. A spend budget caps what a channel costs, whoever asks.
          Listen and proactive modes post unprompted only while unprompted posts are allowed under Settings
          (<code>groupChannels.unpromptedEnabled</code>).
        </p>
      </div>

      {isLoading ? (
        <div className="p-8 text-center text-on-surface-variant">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="p-8 text-center text-on-surface-variant border border-outline-variant/40 rounded-xs border-dashed">
          <p aria-hidden className="text-[16px] text-outline mb-1">[ ]</p>
          <p className="text-[12px]">no group channels enrolled</p>
        </div>
      ) : (
        <ul className="term-frame rounded-xs divide-y divide-outline-variant/10">
          {groups.map((g) => (
            <li key={g.id} className="px-4 py-2 space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-on-surface-variant w-14 shrink-0">{g.channelType}</span>
                <span className="text-on-surface break-all flex-1 min-w-0">
                  {g.label ?? g.channelId}
                  {g.label && <span className="text-on-surface-variant"> · {g.channelId}</span>}
                </span>
                <span className="text-xs text-on-surface-variant">
                  enrolled by {g.ownerName}
                  {!g.ownerActive && <span className="text-warning"> · paused (owner deactivated)</span>}
                  {(g.feedback.up > 0 || g.feedback.down > 0) && (
                    <span title="Reactions on the bot's replies"> · ✅ {g.feedback.up} ❌ {g.feedback.down}</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Revoke ${g.label ?? g.channelId} (enrolled by ${g.ownerName})? The bot will stay quiet there.`)) {
                      removeMutation.mutate(g.id);
                    }
                  }}
                  title="Revoke enrolment"
                  aria-label={`Revoke ${g.label ?? g.channelId}`}
                  className="text-on-surface-variant/60 hover:text-error cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="pl-[4.25rem]">
                <GroupChannelModeForm group={g} endpoint={`/admin/group-channels/${g.id}`} onSaved={refresh} />
              </div>
              <ChannelBudget group={g} onChange={refresh} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The channel's spend budget: its meter, or a way to set one. */
function ChannelBudget({ group, onChange }: { group: AdminGroupChannel; onChange: () => void }) {
  const [draft, setDraft] = useState<BudgetDraft | null>(null);
  const name = group.label ?? group.channelId;
  const save = useMutation({
    mutationFn: (d: BudgetDraft) => api.put('/admin/spend-budgets', {
      userId: group.ownerUserId,
      scopeKind: 'group_channel',
      scopeRef: group.id,
      period: d.period,
      limitUsd: Number(d.limitUsd),
      warnRatio: Number(d.warnPct) / 100,
    }),
    onSuccess: () => { setDraft(null); onChange(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/spend-budgets/${id}`),
    onSuccess: onChange,
  });

  if (draft) {
    const limit = Number(draft.limitUsd);
    const warn = Number(draft.warnPct);
    const invalid = !(limit > 0) ? 'Limit must be a positive dollar amount.'
      : !(warn > 0 && warn <= 100) ? 'Warn % must be between 1 and 100.' : null;
    return (
      <form
        className="flex flex-wrap items-center gap-2 pl-[4.25rem]"
        aria-label={`Spend budget for ${name}`}
        onSubmit={(e) => { e.preventDefault(); if (!invalid) save.mutate(draft); }}
      >
        <select aria-label="Period" value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value as SpendPeriod })} className={inputClass}>
          <option value="day">per UTC day</option>
          <option value="month">per UTC month</option>
        </select>
        <input aria-label="Limit in USD" inputMode="decimal" placeholder="limit $" value={draft.limitUsd} onChange={(e) => setDraft({ ...draft, limitUsd: e.target.value })} className={`${inputClass} w-24`} />
        <input aria-label="Warn at %" inputMode="numeric" value={draft.warnPct} onChange={(e) => setDraft({ ...draft, warnPct: e.target.value })} className={`${inputClass} w-16`} />
        <span className="text-xs text-on-surface-variant">% warns</span>
        <button type="submit" disabled={!!invalid || save.isPending} className="px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50">Save</button>
        <button type="button" onClick={() => setDraft(null)} className="px-2 py-1 rounded-xs border border-outline-variant text-xs cursor-pointer">Cancel</button>
        {(invalid ?? save.error?.message) && <span className="w-full text-xs text-error">! {invalid ?? save.error?.message}</span>}
      </form>
    );
  }

  const budgets = group.budgets ?? [];
  if (budgets.length === 0) {
    return (
      <div className="flex items-center gap-2 pl-[4.25rem] text-xs text-on-surface-variant">
        no spend budget
        <button
          type="button"
          onClick={() => setDraft({ period: 'month', limitUsd: '', warnPct: '80' })}
          className="flex items-center gap-1 text-primary hover:underline cursor-pointer"
          aria-label={`Set a spend budget for ${name}`}
        >
          <Plus className="w-3 h-3" /> set budget
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2 pl-[4.25rem]">
      {budgets.map((b) => (
        <SpendBudgetMeter
          key={b.id}
          budget={b}
          actions={(
            <>
              <button
                type="button"
                className={iconBtn}
                aria-label={`Edit the spend budget for ${name}`}
                onClick={() => setDraft({ period: b.period, limitUsd: String(b.limitUsd), warnPct: String(Math.round(b.warnRatio * 100)) })}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                className={iconBtn}
                aria-label={`Remove the spend budget for ${name}`}
                disabled={remove.isPending}
                onClick={() => { if (confirm(`Remove the spend budget for ${name}?`)) remove.mutate(b.id); }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        />
      ))}
    </div>
  );
}
