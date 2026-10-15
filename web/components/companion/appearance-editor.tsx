'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { COMPANION_COLORS, COMPANION_FORMS, type CompanionAppearance, DEFAULT_COMPANION_APPEARANCE } from '../../../src/shared/companion';
import { CompanionAvatar, type CompanionState } from './companion-avatar';

const formNames = { pebble: 'Pebble', ribbon: 'Ribbon', ink: 'Inky' };
const states: Array<{ state: CompanionState; label: string }> = [
  { state: 'idle', label: 'Looking around' }, { state: 'listening', label: 'Listening' },
  { state: 'working', label: 'Working' }, { state: 'waiting', label: 'Waiting' },
];

/** Draft locally; only Save changes the account's appearance. */
export function AppearanceEditor({ saved = DEFAULT_COMPANION_APPEARANCE, name, onSaved }: {
  saved?: CompanionAppearance; name: string; onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(saved);
  const [previousSaved, setPreviousSaved] = useState(saved);
  const [state, setState] = useState<CompanionState>('idle');
  const [paused, setPaused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  // A reset or account update replaces the draft while preserving preview controls.
  if (previousSaved.form !== saved.form || previousSaved.color !== saved.color) {
    setPreviousSaved(saved);
    setDraft(saved);
  }
  const changed = draft.form !== saved.form || draft.color !== saved.color;

  async function save() {
    setSaving(true);
    setError(null);
    setNotice('');
    try {
      await api.put('/persona/appearance', draft);
      await onSaved();
      setNotice('Appearance saved.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xs term-frame p-5" aria-labelledby="companion-appearance-title">
      <h2 id="companion-appearance-title" className="mb-2 section-label">Your companion’s look</h2>
      <p className="text-xs text-on-surface-variant">A little more you. Choose a shape and color for {name}.</p>
      <div className="my-5 flex flex-col items-center gap-3 rounded-lg bg-surface-container-low p-4" data-testid="appearance-preview">
        <CompanionAvatar appearance={draft} size={160} state={state} animated={!paused} />
        <span className="text-sm font-medium">{name}</span>
        <div className="flex flex-wrap justify-center gap-2" aria-label="Preview activity">
          {states.map(item => (
            <button key={item.state} type="button" aria-pressed={state === item.state} onClick={() => setState(item.state)}
              className={cn('rounded-xs border px-2 py-1 text-xs', state === item.state ? 'border-primary text-primary' : 'border-outline-variant text-on-surface-variant')}>
              {item.label}
            </button>
          ))}
          <button type="button" onClick={() => setPaused(v => !v)} className="px-2 py-1 text-xs underline">
            {paused ? 'Resume preview motion' : 'Pause preview motion'}
          </button>
        </div>
      </div>
      <fieldset disabled={saving} className="mb-5">
        <legend className="mb-2 text-xs text-on-surface-variant">Shape</legend>
        <div className="grid grid-cols-3 gap-3">
          {COMPANION_FORMS.map(form => (
            <label key={form} className={cn('flex cursor-pointer flex-col items-center rounded-lg border p-2', draft.form === form ? 'border-primary bg-primary-container/20' : 'border-outline-variant')}>
              <CompanionAvatar appearance={{ ...draft, form }} size={64} />
              <span className="flex items-center gap-2 text-xs">
                <input type="radio" name="companion-form" value={form} checked={draft.form === form}
                  onChange={() => { setDraft({ ...draft, form }); setNotice(''); }} />
                {formNames[form]}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={saving}>
        <legend className="mb-2 text-xs text-on-surface-variant">Color</legend>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(COMPANION_COLORS) as Array<CompanionAppearance['color']>).map(color => (
            <label key={color} className={cn('flex cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-xs', draft.color === color ? 'border-primary' : 'border-outline-variant')}>
              <input type="radio" name="companion-color" value={color} checked={draft.color === color}
                onChange={() => { setDraft({ ...draft, color }); setNotice(''); }} />
              <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ background: COMPANION_COLORS[color].hex }} />
              {COMPANION_COLORS[color].label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" disabled={saving || !changed} onClick={() => void save()}
          className="rounded-xs bg-primary px-3 py-2 text-sm text-on-primary disabled:opacity-40">
          {saving ? 'Saving…' : 'Save appearance'}
        </button>
        {changed && <button type="button" disabled={saving} onClick={() => { setDraft(saved); setError(null); }} className="text-xs underline">Discard changes</button>}
        <span role="status" className="text-xs text-on-surface-variant">{notice || (changed ? 'Preview · not saved yet' : 'Saved to your companion')}</span>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-error">Could not save appearance: {error}</p>}
      <p className="mt-3 text-xs text-on-surface-variant">Used in your chats and new shared-room replies. Earlier room replies keep their original look. Reduced-motion preferences are respected.</p>
    </section>
  );
}
