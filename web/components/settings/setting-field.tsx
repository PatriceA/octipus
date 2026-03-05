'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  CheckCircle,
  Save,
  RotateCcw,
  Eye,
  EyeOff,
  KeyRound,
} from 'lucide-react';
import Link from 'next/link';
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

  const inputClasses = 'w-full px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{shortKey}</label>
          {setting.isSecret && (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              secret
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-2">{setting.description}</p>

        {setting.valueType === 'boolean' ? (
          <button
            onClick={() => { onChange(!(value as boolean)); setTimeout(onSave, 0); }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              value ? 'bg-primary-600' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
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
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
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
            className="p-1.5 text-gray-400 hover:text-primary-600 disabled:opacity-50"
            title="Save"
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : isSaved ? (
              <CheckCircle className="w-3.5 h-3.5 text-green-500" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
          </button>
        )}
        <button
          onClick={onReset}
          disabled={isSaving}
          className="p-1.5 text-gray-400 hover:text-amber-600 disabled:opacity-50"
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
      className="flex items-center gap-2 p-3 text-sm bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg hover:bg-amber-100/80 dark:hover:bg-amber-900/30 transition-colors"
    >
      <KeyRound className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
      <span className="text-amber-800 dark:text-amber-300">
        API keys and secrets are managed in <span className="font-medium underline">Secrets & Credentials</span>
      </span>
    </Link>
  );
}
