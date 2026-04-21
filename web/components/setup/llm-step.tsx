'use client';

import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

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
  openrouterApiKey: string;
  setOpenrouterApiKey: (v: string) => void;
  availableModels: string[];
  setAvailableModels: (v: string[]) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  setError: (v: string) => void;
}

/** Collapsible provider section */
function ProviderSection({ title, description, children, defaultOpen = false }: {
  title: string; description: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-200 dark:border-gray-600 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left"
      >
        <div>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{description}</div>
        </div>
        <span className="text-gray-400 text-sm">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="px-4 py-3 space-y-3 border-t border-gray-200 dark:border-gray-600">{children}</div>}
    </div>
  );
}

export function LLMProviderStep({
  litellmUrl,
  setLitellmUrl,
  litellmApiKey,
  setLitellmApiKey,
  ollamaUrl,
  setOllamaUrl,
  openrouterApiKey,
  setOpenrouterApiKey,
  setAvailableModels,
  saving,
  setSaving,
  setError,
}: LLMProviderStepProps) {
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

  const testConnection = async (provider: string) => {
    setTestResults(prev => ({ ...prev, [provider]: { success: false, message: 'Testing...' } }));
    try {
      if (provider === 'litellm') {
        const res = await api.get<{ healthy: boolean; models?: string[] }>('/health/litellm');
        if (res.healthy) {
          setTestResults(prev => ({ ...prev, litellm: { success: true, message: `Connected${res.models?.length ? ` (${res.models.length} models)` : ''}` } }));
          if (res.models?.length) setAvailableModels(res.models);
        } else {
          setTestResults(prev => ({ ...prev, litellm: { success: false, message: 'Connection failed' } }));
        }
      } else if (provider === 'ollama') {
        const url = ollamaUrl || 'http://localhost:11434';
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null);
        const count = res?.models?.length || 0;
        setTestResults(prev => ({ ...prev, ollama: count > 0 ? { success: true, message: `Connected (${count} models)` } : { success: false, message: 'No models found or unreachable' } }));
      } else if (provider === 'openrouter') {
        const res = await api.get<{ configured?: boolean; error?: string }>('/models/providers/openrouter/available');
        setTestResults(prev => ({ ...prev, openrouter: res?.configured ? { success: true, message: 'API key valid' } : { success: false, message: res?.error || 'Not configured' } }));
      }
    } catch {
      setTestResults(prev => ({ ...prev, [provider]: { success: false, message: 'Connection failed' } }));
    }
  };

  const saveLLMSettings = async () => {
    setSaving(true);
    setError('');
    try {
      const settings: Record<string, unknown> = {};
      if (ollamaUrl) settings['ollama.url'] = ollamaUrl;
      if (litellmUrl) settings['litellm.proxyUrl'] = litellmUrl;
      if (Object.keys(settings).length > 0) {
        await api.put('/settings/batch', { settings });
      }
      // Save secrets individually
      if (litellmApiKey) {
        await api.put(`/settings/${encodeURIComponent('litellm.apiKey')}`, { value: litellmApiKey });
      }
      if (openrouterApiKey) {
        await api.put(`/settings/${encodeURIComponent('openrouter.apiKey')}`, { value: openrouterApiKey });
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  const TestBadge = ({ provider }: { provider: string }) => {
    const result = testResults[provider];
    if (!result) return null;
    return (
      <div className={`flex items-center gap-1 text-xs mt-1 ${result.success ? 'text-green-600' : 'text-red-500'}`}>
        {result.success ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
        {result.message}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">LLM Providers</h2>
      <p className="text-sm text-gray-500">Configure the providers you have. Skip any you don&apos;t use.</p>

      <ProviderSection title="Ollama (Local)" description="Run open-source models locally" defaultOpen>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Ollama URL</label>
          <div className="flex gap-2">
            <input type="text" value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} placeholder="http://localhost:11434" className={inputClasses} />
            <button onClick={() => testConnection('ollama')} className="px-3 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 whitespace-nowrap">Test</button>
          </div>
          <TestBadge provider="ollama" />
        </div>
      </ProviderSection>

      <ProviderSection title="OpenRouter" description="Access 200+ models via one API key (openrouter.ai)">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">API Key</label>
          <div className="flex gap-2">
            <input type="password" value={openrouterApiKey} onChange={(e) => setOpenrouterApiKey(e.target.value)} placeholder="sk-or-..." className={inputClasses} />
            <button onClick={() => testConnection('openrouter')} className="px-3 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 whitespace-nowrap">Test</button>
          </div>
          <TestBadge provider="openrouter" />
          <p className="text-xs text-gray-400 mt-1">Get a key at <span className="text-primary-400">openrouter.ai/keys</span></p>
        </div>
      </ProviderSection>

      <ProviderSection title="LiteLLM Proxy" description="Unified proxy for multiple providers (optional)">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Proxy URL</label>
          <div className="flex gap-2">
            <input type="text" value={litellmUrl} onChange={(e) => setLitellmUrl(e.target.value)} placeholder="http://localhost:4000" className={inputClasses} />
            <button onClick={() => testConnection('litellm')} className="px-3 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 whitespace-nowrap">Test</button>
          </div>
          <TestBadge provider="litellm" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">API Key (optional)</label>
          <input type="password" value={litellmApiKey} onChange={(e) => setLitellmApiKey(e.target.value)} placeholder="sk-..." className={inputClasses} />
        </div>
      </ProviderSection>

      <button
        onClick={saveLLMSettings}
        disabled={saving}
        className="w-full px-4 py-2 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900 disabled:opacity-50"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Save Provider Settings'}
      </button>
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
