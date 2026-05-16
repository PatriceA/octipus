'use client';

import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const inputClass =
  'w-full px-3 py-2 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary transition-colors';
const labelClass = 'block text-[10px] uppercase tracking-wider text-outline-variant mb-1';
const testButtonClass =
  'px-2.5 py-2 text-[11px] bg-surface-container-low border border-outline-variant/60 rounded-xs hover:bg-surface-container hover:border-outline text-on-surface-variant hover:text-on-surface whitespace-nowrap cursor-pointer transition-colors';

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

/** Collapsible provider section — TUI accordion. */
function ProviderSection({ title, description, children, defaultOpen = false }: {
  title: string; description: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-outline-variant/60 rounded-xs overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-surface-container-low hover:bg-surface-container transition-colors text-left cursor-pointer"
      >
        <div>
          <div className="text-[13px] text-on-surface flex items-center gap-1.5">
            <span className="text-outline-variant" aria-hidden>{open ? '▾' : '▸'}</span>
            {title}
          </div>
          <div className="text-[11px] text-on-surface-variant pl-4">{description}</div>
        </div>
      </button>
      {open && (
        <div className="px-3 py-3 space-y-3 border-t border-outline-variant/60 bg-surface-container/30">
          {children}
        </div>
      )}
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
    setTestResults(prev => ({ ...prev, [provider]: { success: false, message: 'testing…' } }));
    try {
      if (provider === 'litellm') {
        const res = await api.get<{ healthy: boolean; models?: string[] }>('/health/litellm');
        if (res.healthy) {
          setTestResults(prev => ({ ...prev, litellm: { success: true, message: `connected${res.models?.length ? ` (${res.models.length} models)` : ''}` } }));
          if (res.models?.length) setAvailableModels(res.models);
        } else {
          setTestResults(prev => ({ ...prev, litellm: { success: false, message: 'connection failed' } }));
        }
      } else if (provider === 'ollama') {
        const url = ollamaUrl || 'http://localhost:11434';
        const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null);
        const count = res?.models?.length || 0;
        setTestResults(prev => ({ ...prev, ollama: count > 0 ? { success: true, message: `connected (${count} models)` } : { success: false, message: 'no models found or unreachable' } }));
      } else if (provider === 'openrouter') {
        const res = await api.get<{ configured?: boolean; error?: string }>('/models/providers/openrouter/available');
        setTestResults(prev => ({ ...prev, openrouter: res?.configured ? { success: true, message: 'api key valid' } : { success: false, message: res?.error || 'not configured' } }));
      }
    } catch {
      setTestResults(prev => ({ ...prev, [provider]: { success: false, message: 'connection failed' } }));
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
      <div
        className={cn(
          'flex items-center gap-1 text-[11px] mt-1',
          result.success ? 'text-tertiary' : 'text-error',
        )}
      >
        {result.success ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
        {result.message}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[14px] text-on-surface flex items-center gap-2">
          <span className="text-primary" aria-hidden>❯</span>
          llm providers
        </h2>
        <p className="text-[12px] text-on-surface-variant mt-1">
          configure the providers you have. skip any you don&apos;t use.
        </p>
      </div>

      <ProviderSection title="ollama (local)" description="run open-source models locally" defaultOpen>
        <div>
          <label className={labelClass}>ollama url</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder="http://localhost:11434"
              className={inputClass}
            />
            <button onClick={() => testConnection('ollama')} className={testButtonClass}>test</button>
          </div>
          <TestBadge provider="ollama" />
        </div>
      </ProviderSection>

      <ProviderSection title="openrouter" description="200+ models via one api key (openrouter.ai)">
        <div>
          <label className={labelClass}>api key</label>
          <div className="flex gap-2">
            <input
              type="password"
              value={openrouterApiKey}
              onChange={(e) => setOpenrouterApiKey(e.target.value)}
              placeholder="sk-or-..."
              className={inputClass}
            />
            <button onClick={() => testConnection('openrouter')} className={testButtonClass}>test</button>
          </div>
          <TestBadge provider="openrouter" />
          <p className="text-[11px] text-outline mt-1">
            get a key at <span className="text-primary">openrouter.ai/keys</span>
          </p>
        </div>
      </ProviderSection>

      <ProviderSection title="litellm proxy" description="unified proxy for multiple providers (optional)">
        <div>
          <label className={labelClass}>proxy url</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={litellmUrl}
              onChange={(e) => setLitellmUrl(e.target.value)}
              placeholder="http://localhost:4000"
              className={inputClass}
            />
            <button onClick={() => testConnection('litellm')} className={testButtonClass}>test</button>
          </div>
          <TestBadge provider="litellm" />
        </div>
        <div>
          <label className={labelClass}>api key (optional)</label>
          <input
            type="password"
            value={litellmApiKey}
            onChange={(e) => setLitellmApiKey(e.target.value)}
            placeholder="sk-..."
            className={inputClass}
          />
        </div>
      </ProviderSection>

      <button
        onClick={saveLLMSettings}
        disabled={saving}
        className="w-full px-3 py-1.5 text-[12px] bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : '❯ save provider settings'}
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
      <div>
        <h2 className="text-[14px] text-on-surface flex items-center gap-2">
          <span className="text-primary" aria-hidden>❯</span>
          default model
        </h2>
        <p className="text-[12px] text-on-surface-variant mt-1">
          pick or type the default model. add more on the models page later.
        </p>
      </div>

      <div>
        <label className={labelClass}>model id</label>
        <input
          type="text"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          placeholder="e.g. qwen3:14b, gpt-4o"
          className={inputClass}
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
        className="text-[11px] text-primary hover:underline cursor-pointer"
      >
        ↻ refresh available models
      </button>

      {availableModels.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-outline-variant mb-2 flex items-center gap-1.5">
            <span>▸</span><span>available models</span>
          </p>
          <div className="flex flex-wrap gap-1">
            {availableModels.slice(0, 10).map((m) => (
              <button
                key={m}
                onClick={() => setDefaultModel(m)}
                className={cn(
                  'px-2 py-1 text-[11px] rounded-xs border transition-colors cursor-pointer',
                  defaultModel === m
                    ? 'bg-primary-container/40 border-primary text-primary'
                    : 'border-outline-variant/60 text-on-surface-variant hover:border-outline hover:text-on-surface',
                )}
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
