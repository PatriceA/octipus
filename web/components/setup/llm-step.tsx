'use client';

import { Loader2, CheckCircle, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { useState } from 'react';

const inputClasses =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-primary-500';

// --- LLM Provider Step ---

export interface LLMProviderStepProps {
  litellmUrl: string;
  setLitellmUrl: (v: string) => void;
  litellmApiKey: string;
  setLitellmApiKey: (v: string) => void;
  ollamaUrl: string;
  setOllamaUrl: (v: string) => void;
  availableModels: string[];
  setAvailableModels: (v: string[]) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  setError: (v: string) => void;
}

export function LLMProviderStep({
  litellmUrl,
  setLitellmUrl,
  litellmApiKey,
  setLitellmApiKey,
  ollamaUrl,
  setOllamaUrl,
  setAvailableModels,
  saving,
  setSaving,
  setError,
}: LLMProviderStepProps) {
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const testLLMConnection = async () => {
    setTestResult(null);
    try {
      const res = await api.get<{ healthy: boolean; models?: string[] }>('/health/litellm');
      if (res.healthy) {
        setTestResult({ success: true, message: 'Connected successfully!' });
        if (res.models?.length) {
          setAvailableModels(res.models);
        }
      } else {
        setTestResult({ success: false, message: 'Connection failed' });
      }
    } catch {
      setTestResult({ success: false, message: 'Could not reach LiteLLM. Make sure the service is running.' });
    }
  };

  const saveLLMSettings = async () => {
    setSaving(true);
    setError('');
    try {
      const settings: Record<string, unknown> = {
        'litellm.proxyUrl': litellmUrl,
        'ollama.url': ollamaUrl,
      };
      await api.put('/settings/batch', { settings });

      if (litellmApiKey) {
        await api.put(`/settings/${encodeURIComponent('litellm.apiKey')}`, { value: litellmApiKey });
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">LLM Provider</h2>
      <p className="text-sm text-gray-500">Configure your LLM proxy or Ollama instance.</p>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">LiteLLM URL</label>
        <input
          type="text"
          value={litellmUrl}
          onChange={(e) => setLitellmUrl(e.target.value)}
          placeholder="http://localhost:4000"
          className={inputClasses}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">LiteLLM API Key (optional)</label>
        <input
          type="password"
          value={litellmApiKey}
          onChange={(e) => setLitellmApiKey(e.target.value)}
          placeholder="sk-..."
          className={inputClasses}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Ollama URL</label>
        <input
          type="text"
          value={ollamaUrl}
          onChange={(e) => setOllamaUrl(e.target.value)}
          placeholder="http://localhost:11434"
          className={inputClasses}
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={testLLMConnection}
          className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
        >
          Test Connection
        </button>
        <button
          onClick={saveLLMSettings}
          disabled={saving}
          className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
        </button>
      </div>

      {testResult && (
        <div className={`flex items-center gap-2 text-sm ${testResult.success ? 'text-green-600' : 'text-red-600'}`}>
          {testResult.success ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {testResult.message}
        </div>
      )}
    </div>
  );
}

// --- Default Model Step ---

export interface DefaultModelStepProps {
  defaultModel: string;
  setDefaultModel: (v: string) => void;
  availableModels: string[];
  setAvailableModels: (v: string[]) => void;
}

export function DefaultModelStep({
  defaultModel,
  setDefaultModel,
  availableModels,
  setAvailableModels,
}: DefaultModelStepProps) {
  const fetchModels = async () => {
    try {
      const res = await api.get<{ models: { modelId: string; name: string }[] }>('/models');
      if (res.models?.length) {
        setAvailableModels(res.models.map((m) => m.modelId));
      }
    } catch {
      // Models may not be configured yet
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Default Model</h2>
      <p className="text-sm text-gray-500">
        Select or enter the default model. You can add more models later in the Models page.
      </p>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model ID</label>
        <input
          type="text"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          placeholder="e.g. qwen3:14b, gpt-4o"
          className={inputClasses}
          list="model-suggestions"
        />
        {availableModels.length > 0 && (
          <datalist id="model-suggestions">
            {availableModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        )}
      </div>

      <button
        onClick={fetchModels}
        className="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400"
      >
        Refresh available models
      </button>

      {availableModels.length > 0 && (
        <div>
          <p className="text-xs text-gray-500 mb-2">Available models:</p>
          <div className="flex flex-wrap gap-1">
            {availableModels.slice(0, 10).map((m) => (
              <button
                key={m}
                onClick={() => setDefaultModel(m)}
                className={`px-2 py-1 text-xs rounded-lg border transition-colors ${
                  defaultModel === m
                    ? 'bg-primary-50 border-primary-300 text-primary-700 dark:bg-primary-950/40 dark:border-primary-700 dark:text-primary-300'
                    : 'border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
