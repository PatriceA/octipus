import { useState } from 'react';
import type { CliModelOption } from '../../../src/shared/cli-capabilities';

/** The same catalog picker for global CLI settings and session overrides. */
export function CliModelPicker({
  value, onChange, models, label,
  defaultLabel = 'Use vendor default', disabled = false, commitCustomOnBlur = false, className,
}: {
  value: string;
  onChange: (value: string) => void;
  models: readonly CliModelOption[];
  label: string;
  defaultLabel?: string;
  disabled?: boolean;
  commitCustomOnBlur?: boolean;
  className?: string;
}) {
  const [custom, setCustom] = useState<string | null>(null);
  const options = Array.from(new Map(models.map(model => [model.id, model])).values());
  const missing = value && !options.some(model => model.id === value);
  return (
    <div className="space-y-1">
      <select
        aria-label={label}
        value={custom !== null ? '__custom__' : value}
        disabled={disabled}
        className={className}
        onChange={event => {
          if (event.target.value === '__custom__') setCustom(value);
          else {
            setCustom(null);
            onChange(event.target.value);
          }
        }}
      >
        <option value="">{defaultLabel}</option>
        {missing && <option value={value}>{value} · current selection (not in catalog)</option>}
        {options.map(model => (
          <option key={model.id} value={model.id}>
            {model.label}{model.tier ? ` · ${model.tier}` : ''}
          </option>
        ))}
        <option value="__custom__">Enter a custom model ID…</option>
      </select>
      {custom !== null && (
        <input
          aria-label={`Custom ${label}`}
          value={custom}
          disabled={disabled}
          maxLength={200}
          onChange={event => {
            setCustom(event.target.value);
            if (!commitCustomOnBlur) onChange(event.target.value);
          }}
          onBlur={event => {
            if (commitCustomOnBlur && event.target.value !== value) onChange(event.target.value);
          }}
          placeholder="Exact model ID"
          className={className}
        />
      )}
    </div>
  );
}
