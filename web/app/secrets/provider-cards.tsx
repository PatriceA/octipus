'use client';

import { useState, useEffect } from 'react';
import { CheckCircle, Loader2, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { PROVIDER_KEY_GROUPS, ALL_VAULT_KEYS } from '@/lib/vault-config';

interface ProviderCardsProps {
  statuses: Record<string, boolean>;
  onStatusChange: () => void;
}

export function ProviderCards({ statuses, onStatusChange }: ProviderCardsProps) {
  return (
    <div>
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
        Provider API Keys
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Store API keys for direct provider access (bypasses LiteLLM).
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {PROVIDER_KEY_GROUPS[0].keys.map((key) => (
          <ProviderCard
            key={key.vaultName}
            label={key.label}
            vaultName={key.vaultName}
            testProvider={key.testProvider}
            placeholder={key.placeholder}
            isSaved={!!statuses[key.vaultName]}
            onStatusChange={onStatusChange}
          />
        ))}
      </div>
    </div>
  );
}

function ProviderCard({
  label,
  vaultName,
  testProvider,
  placeholder,
  isSaved,
  onStatusChange,
}: {
  label: string;
  vaultName: string;
  testProvider?: string;
  placeholder?: string;
  isSaved: boolean;
  onStatusChange: () => void;
}) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (feedback) {
      const t = setTimeout(() => setFeedback(null), 5000);
      return () => clearTimeout(t);
    }
  }, [feedback]);

  const handleSave = async () => {
    if (!value) return;
    setSaving(true);
    try {
      await api.post('/vault', {
        name: vaultName,
        value,
        credentialType: 'api_key',
        description: `${label} API Key`,
        tags: ['provider'],
        systemLevel: true,
      });
      setValue('');
      onStatusChange();
      setFeedback({ type: 'success', message: 'Saved' });
    } catch (err) {
      setFeedback({ type: 'error', message: `Failed: ${(err as Error).message}` });
    }
    setSaving(false);
  };

  const handleTest = async () => {
    if (!testProvider) return;
    setTesting(true);
    try {
      const known = await api.get<{ models: string[] }>(`/models/providers/${testProvider}/known`);
      const modelId = known.models?.[0];
      if (modelId) {
        const result = await api.post<{ success: boolean; message?: string; error?: string }>('/models/test', {
          provider: testProvider,
          modelId,
        });
        setFeedback(result.success
          ? { type: 'success', message: result.message || 'Connected' }
          : { type: 'error', message: result.error || 'Failed' }
        );
      }
    } catch (err) {
      setFeedback({ type: 'error', message: `Test failed: ${(err as Error).message}` });
    }
    setTesting(false);
  };

  return (
    <div className="p-4 bg-white dark:bg-gray-800/90 rounded-xl ring-1 ring-gray-200/60 dark:ring-gray-700/60">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
            <span className="text-sm font-bold text-primary-700 dark:text-primary-400">
              {label[0]}
            </span>
          </div>
          <span className="font-medium text-sm text-gray-900 dark:text-gray-100">{label}</span>
        </div>
        <span
          className={`w-2.5 h-2.5 rounded-full transition-colors ${
            isSaved ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
          }`}
          title={isSaved ? 'Configured' : 'Not configured'}
        />
      </div>

      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={isSaved ? 'Saved (enter new to replace)' : placeholder || 'Enter API key...'}
          className="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-200 placeholder-gray-500 dark:placeholder-gray-500 focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400"
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
        />
        <button
          onClick={handleSave}
          disabled={!value || saving}
          className="px-3 py-2 text-xs font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save'}
        </button>
      </div>

      <div className="flex items-center justify-between mt-2 min-h-[24px]">
        {feedback ? (
          <div className={`flex items-center gap-1 text-xs ${
            feedback.type === 'success' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}>
            {feedback.type === 'success'
              ? <CheckCircle className="w-3 h-3" />
              : <AlertCircle className="w-3 h-3" />
            }
            <span className="truncate max-w-[200px]">{feedback.message}</span>
          </div>
        ) : <div />}

        {isSaved && testProvider && (
          <button
            onClick={handleTest}
            disabled={testing}
            className="text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-primary-600 dark:hover:text-primary-400 disabled:opacity-50 cursor-pointer"
          >
            {testing ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Test connection'}
          </button>
        )}
      </div>
    </div>
  );
}
