'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { GroupChannelSummary } from '../../src/shared/types';

const inputClass = 'bg-surface-container-high border border-outline-variant rounded-md py-1 px-2 text-on-surface text-sm';

const MODES: Array<{ value: GroupChannelSummary['mode']; label: string }> = [
  { value: 'mention', label: 'mention — answers when addressed' },
  { value: 'listen', label: 'listen — offers help with unanswered questions' },
  { value: 'proactive', label: 'proactive — may answer unasked' },
];

interface Draft {
  mode: GroupChannelSummary['mode'];
  quietStart: string;
  quietEnd: string;
  timezone: string;
  perDay: string;
  minutes: string;
}

const hour = (v: string) => (v.trim() === '' ? null : Number(v));

/**
 * A group channel's mode, quiet hours and rate limit for unprompted posts.
 * `endpoint` is `/me/group-channels/:id` for the owner, `/admin/group-channels/:id`
 * for an admin. Unprompted posts also need the operator's global switch
 * (`groupChannels.unpromptedEnabled`).
 */
export function GroupChannelModeForm({ group, endpoint, onSaved }: { group: GroupChannelSummary; endpoint: string; onSaved: () => void }) {
  const initial: Draft = {
    mode: group.mode,
    quietStart: group.quietHoursStart === null ? '' : String(group.quietHoursStart),
    quietEnd: group.quietHoursEnd === null ? '' : String(group.quietHoursEnd),
    timezone: group.timezone,
    perDay: String(group.maxUnpromptedPerDay),
    minutes: String(group.minMinutesBetween),
  };
  const [draft, setDraft] = useState<Draft>(initial);
  const [error, setError] = useState<string | null>(null);
  const name = group.label ?? group.channelId;

  const save = useMutation({
    mutationFn: (d: Draft) => api.patch(endpoint, {
      mode: d.mode,
      quietHoursStart: hour(d.quietStart),
      quietHoursEnd: hour(d.quietEnd),
      timezone: d.timezone.trim(),
      maxUnpromptedPerDay: Number(d.perDay),
      minMinutesBetween: Number(d.minutes),
    }),
    onSuccess: () => { setError(null); onSaved(); },
    onError: (err: Error) => setError(err.message),
  });

  const qs = hour(draft.quietStart);
  const qe = hour(draft.quietEnd);
  const isHour = (h: number | null) => h === null || (Number.isInteger(h) && h >= 0 && h <= 23);
  const perDay = Number(draft.perDay);
  const minutes = Number(draft.minutes);
  const invalid = !isHour(qs) || !isHour(qe) ? 'Quiet hours are whole hours, 0–23.'
    : (qs === null) !== (qe === null) ? 'Set both quiet-hour bounds, or neither.'
      : !(Number.isInteger(perDay) && perDay >= 1 && perDay <= 48) ? 'Posts per day: 1–48.'
        : !(Number.isInteger(minutes) && minutes >= 10 && minutes <= 1440) ? 'Minutes between posts: 10–1440.'
          : !draft.timezone.trim() ? 'Time zone is required.' : null;
  const unprompted = draft.mode !== 'mention';
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      aria-label={`Mode for ${name}`}
      onSubmit={(e) => { e.preventDefault(); if (!invalid) save.mutate(draft); }}
    >
      <select aria-label="Mode" value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as Draft['mode'] })} className={inputClass}>
        {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
      {unprompted && (
        <>
          <span className="text-xs text-on-surface-variant">quiet</span>
          <input aria-label="Quiet hours start" inputMode="numeric" placeholder="from" value={draft.quietStart} onChange={(e) => setDraft({ ...draft, quietStart: e.target.value })} className={`${inputClass} w-14`} />
          <input aria-label="Quiet hours end" inputMode="numeric" placeholder="to" value={draft.quietEnd} onChange={(e) => setDraft({ ...draft, quietEnd: e.target.value })} className={`${inputClass} w-14`} />
          <input aria-label="Time zone" value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} className={`${inputClass} w-36`} />
          <input aria-label="Unprompted posts per day" inputMode="numeric" value={draft.perDay} onChange={(e) => setDraft({ ...draft, perDay: e.target.value })} className={`${inputClass} w-14`} />
          <span className="text-xs text-on-surface-variant">/ day, ≥</span>
          <input aria-label="Minutes between unprompted posts" inputMode="numeric" value={draft.minutes} onChange={(e) => setDraft({ ...draft, minutes: e.target.value })} className={`${inputClass} w-16`} />
          <span className="text-xs text-on-surface-variant">min apart</span>
        </>
      )}
      {dirty && (
        <button type="submit" disabled={!!invalid || save.isPending} className="px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50">
          Save
        </button>
      )}
      {(invalid && dirty) && <span className="text-xs text-error w-full">{invalid}</span>}
      {error && <span className="text-xs text-error w-full">! {error}</span>}
    </form>
  );
}
