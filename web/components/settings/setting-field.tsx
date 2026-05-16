'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RotateCcw,
  Save,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface SettingItem {
  key: string;
  value: unknown;
  valueType: string;
  description: string;
  defaultValue: unknown;
  isSecret: boolean;
  category: string;
}

/** Hook for saving/resetting settings via API */
export function useSettingActions() {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState('');

  const handleSave = useCallback(async (key: string, value: unknown) => {
    setSaving(key);
    setError('');
    try {
      await api.put(`/settings/${encodeURIComponent(key)}`, { value });
      setSaved(key);
      setTimeout(() => setSaved(null), 2000);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) {
      setError(`Failed to save ${key}: ${(err as Error).message}`);
    }
    setSaving(null);
  }, [queryClient]);

  const handleReset = useCallback(async (key: string) => {
    setSaving(key);
    setError('');
    try {
      await api.post(`/settings/${encodeURIComponent(key)}/reset`);
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) {
      setError(`Failed to reset ${key}: ${(err as Error).message}`);
    }
    setSaving(null);
  }, [queryClient]);

  return { saving, saved, error, handleSave, handleReset };
}

/** Renders a single setting field with appropriate input type */
export function SettingField({
  setting,
  value,
  onChange,
  onSave,
  onReset,
  isSaving,
  isSaved,
}: {
  setting: SettingItem;
  value: unknown;
  onChange: (value: unknown) => void;
  onSave: () => void;
  onReset: () => void;
  isSaving: boolean;
  isSaved: boolean;
}) {
  const [showSecret, setShowSecret] = useState(false);
  const shortKey = setting.key.split('.').pop() || setting.key;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onSave();
  };

  const inputClasses = 'w-full bg-surface-container-high border-none rounded-md py-3 px-4 text-on-surface text-sm focus:ring-1 focus:ring-primary';

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg hover:bg-surface-container-high transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <label className="text-xs font-bold text-on-surface-variant uppercase">{shortKey}</label>
          {setting.isSecret && (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-900/30 text-warning">
              secret
            </span>
          )}
        </div>
        <p className="text-xs text-on-surface-variant mb-2">{setting.description}</p>

        {setting.valueType === 'boolean' ? (
          <button
            onClick={() => { onChange(!(value as boolean)); setTimeout(onSave, 0); }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              value ? 'bg-primary' : 'bg-[#484847]'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-on-surface transition-transform ${
              value ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        ) : setting.isSecret ? (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showSecret ? 'text' : 'password'}
                value={String(value || '')}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Enter ${shortKey}...`}
                className={inputClasses}
              />
              <button
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"
              >
                {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        ) : setting.valueType === 'number' ? (
          <input
            type="number"
            value={String(value ?? '')}
            onChange={(e) => onChange(Number(e.target.value))}
            onKeyDown={handleKeyDown}
            className={inputClasses}
          />
        ) : setting.valueType === 'string_array' ? (
          <input
            type="text"
            value={Array.isArray(value) ? (value as string[]).join(', ') : String(value || '')}
            onChange={(e) => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            onKeyDown={handleKeyDown}
            placeholder="value1, value2, ..."
            className={inputClasses}
          />
        ) : (
          <input
            type="text"
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className={inputClasses}
          />
        )}
      </div>

      <div className="flex items-center gap-1 pt-7 shrink-0">
        {setting.valueType !== 'boolean' && (
          <button
            onClick={onSave}
            disabled={isSaving}
            className="p-1.5 text-on-surface-variant hover:text-primary disabled:opacity-50"
            title="Save"
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : isSaved ? (
              <CheckCircle className="w-3.5 h-3.5 text-tertiary" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        <button
          onClick={onReset}
          disabled={isSaving}
          className="p-1.5 text-on-surface-variant hover:text-warning disabled:opacity-50"
          title="Reset to default"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Renders a group of settings with local value state */
export function SettingsGroup({
  settings,
  onSave,
  onReset,
  saving,
  saved,
}: {
  settings: SettingItem[];
  onSave: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
  saving: string | null;
  saved: string | null;
}) {
  const [localValues, setLocalValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const initial: Record<string, unknown> = {};
    for (const s of settings) {
      initial[s.key] = s.value;
    }
    setLocalValues(initial);
  }, [settings]);

  const getLocalValue = (key: string) => localValues[key] ?? '';
  const setLocalValue = (key: string, value: unknown) => {
    setLocalValues(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="space-y-1">
      {settings.map((setting) => (
        <SettingField
          key={setting.key}
          setting={setting}
          value={getLocalValue(setting.key)}
          onChange={(val) => setLocalValue(setting.key, val)}
          onSave={() => onSave(setting.key, localValues[setting.key])}
          onReset={() => onReset(setting.key)}
          isSaving={saving === setting.key}
          isSaved={saved === setting.key}
        />
      ))}
    </div>
  );
}

/** Banner that redirects secret management to the Secrets page */
export function SecretsRedirectBanner() {
  return (
    <Link
      href="/secrets"
      className="flex items-center gap-2 p-3 text-sm bg-amber-900/20 border border-amber-800/30 rounded-lg hover:bg-amber-900/30 transition-colors"
    >
      <KeyRound className="w-4 h-4 text-warning shrink-0" />
      <span className="text-warning">
        API keys and secrets are managed in <span className="font-medium underline">Secrets & Credentials</span>
      </span>
    </Link>
  );
}
