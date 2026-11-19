'use client';

import { CheckCircle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { SettingItem } from '../setting-field';
import { Busy, inputCls, quietBtn } from './ui';

/**
 * One voice setting each, with a plain label: the Voice page's own controls
 * over `PUT /settings/<key>` (the generic settings list shows raw keys).
 */

/** Read a setting's stored value out of the `voice` category of `GET /settings`. */
export function settingValue(items: SettingItem[], key: string): unknown {
  return items.find((item) => item.key === key)?.value;
}

export interface SettingSaver {
  save: (key: string, value: unknown) => void;
  /** The key being saved, and the one just saved. */
  saving: string | null;
  saved: string | null;
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-on-surface">{label}</span>
      {children}
      {hint && <p className="text-xs text-on-surface-variant">{hint}</p>}
    </div>
  );
}

function SavedMark({ settingKey, saver }: { settingKey: string; saver: SettingSaver }) {
  if (saver.saving === settingKey) return <Busy on />;
  if (saver.saved === settingKey) return <span className="inline-flex items-center gap-1 text-xs text-tertiary" role="status"><CheckCircle className="w-3 h-3" aria-hidden /> Saved</span>;
  return null;
}

/** A line of text, saved with its button. `toValue` turns what was typed into what is stored. */
export function TextSetting({ settingKey, label, hint, value, placeholder, saver, toValue = (text) => text.trim() }: {
  settingKey: string; label: string; hint?: ReactNode; value: string; placeholder?: string; saver: SettingSaver; toValue?: (text: string) => unknown;
}) {
  const [draft, setDraft] = useState(value);
  // The stored value changed (a save, a refetch): the field follows it.
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    setDraft(value);
  }
  const dirty = draft !== value;
  return (
    <Row label={label} hint={hint}>
      <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (dirty) saver.save(settingKey, toValue(draft)); }}>
        <input className={inputCls} aria-label={label} value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit" className={quietBtn} disabled={!dirty || saver.saving === settingKey}>Save</button>
        <SavedMark settingKey={settingKey} saver={saver} />
      </form>
    </Row>
  );
}

/** Several lines of text, saved with its button. Empty is stored as empty. */
export function TextAreaSetting({ settingKey, label, hint, value, placeholder, saver, rows = 4, maxLength }: {
  settingKey: string; label: string; hint?: ReactNode; value: string; placeholder?: string; saver: SettingSaver; rows?: number; maxLength?: number;
}) {
  const [draft, setDraft] = useState(value);
  // The stored value changed (a save, a refetch): the field follows it.
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    setDraft(value);
  }
  const dirty = draft !== value;
  return (
    <Row label={label} hint={hint}>
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); if (dirty) saver.save(settingKey, draft.trim()); }}>
        <textarea className={inputCls} aria-label={label} rows={rows} maxLength={maxLength} value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} />
        <div className="flex items-center gap-2">
          <button type="submit" className={quietBtn} disabled={!dirty || saver.saving === settingKey}>Save</button>
          <SavedMark settingKey={settingKey} saver={saver} />
        </div>
      </form>
    </Row>
  );
}

/** A choice, saved when it is made. */
export function SelectSetting({ settingKey, label, hint, value, options, saver }: {
  settingKey: string; label: string; hint?: ReactNode; value: string; options: Array<{ value: string; label: string }>; saver: SettingSaver;
}) {
  return (
    <Row label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <select className={inputCls} aria-label={label} value={value} disabled={saver.saving === settingKey} onChange={(event) => saver.save(settingKey, event.target.value)}>
          {/* A stored value this page does not know is shown as it is, not replaced. */}
          {!options.some((option) => option.value === value) && <option value={value}>{value}</option>}
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <SavedMark settingKey={settingKey} saver={saver} />
      </div>
    </Row>
  );
}

/** On or off, saved when it is flipped. */
export function ToggleSetting({ settingKey, label, hint, checked, saver }: {
  settingKey: string; label: string; hint?: ReactNode; checked: boolean; saver: SettingSaver;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-1">
        <span className="block text-xs font-medium text-on-surface">{label}</span>
        {hint && <p className="text-xs text-on-surface-variant">{hint}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <SavedMark settingKey={settingKey} saver={saver} />
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={saver.saving === settingKey}
          onClick={() => saver.save(settingKey, !checked)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-[#484847]'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-on-surface transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
    </div>
  );
}
