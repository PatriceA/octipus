'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Cpu, CheckCircle, X, Plus, RefreshCw, Pencil, AlertCircle, Loader2, Search } from 'lucide-react';
import { api } from '@/lib/api';
import {
  type LiteLLMModel,
  AVAILABLE_TOPICS,
  mapLiteLLMProvider,
  PROVIDER_LABELS,
  PROVIDER_DEFAULTS,
} from '@/lib/types/models';

interface AvailableModel {
  id: string;
  label: string;
  parameterSize?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  costPerInputToken?: number;
  costPerOutputToken?: number;
  supportsVision?: boolean;
  supportsTools?: boolean;
}

export interface AddModelModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (model: Record<string, unknown>) => Promise<void>;
  loading: boolean;
}

export function AddModelModal({ isOpen, onClose, onAdd, loading }: AddModelModalProps) {
  type Step = 'choose-source' | 'litellm-pick' | 'configure';
  type ConnectionType = 'litellm' | 'direct';

  const [step, setStep] = useState<Step>('choose-source');
  const [connectionType, setConnectionType] = useState<ConnectionType>('litellm');
  const [litellmModels, setLitellmModels] = useState<LiteLLMModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [litellmError, setLitellmError] = useState('');

  const [formData, setFormData] = useState({
    name: '',
    provider: 'ollama',
    modelId: '',
    endpoint: '',
    contextWindow: 4096,
    maxTokens: 4096,
    supportsVision: false,
    supportsTools: true,
    supportsStreaming: true,
    disableThinking: false,
    topics: [] as string[],
    priority: 50,
    costPerInputToken: 0,
    costPerOutputToken: 0,
  });
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // Available models for the selected provider
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null);
  const [providerError, setProviderError] = useState('');
  const [loadingAvailable, setLoadingAvailable] = useState(false);

  // Track which proxy providers (litellm, openrouter) are configured
  const [configuredProviders, setConfiguredProviders] = useState<Set<string>>(new Set());

  // OpenRouter live search state
  const [orSearchQuery, setOrSearchQuery] = useState('');
  const [orSearchResults, setOrSearchResults] = useState<AvailableModel[]>([]);
  const [orSearchLoading, setOrSearchLoading] = useState(false);
  const [orSearchTotal, setOrSearchTotal] = useState(0);
  const orDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchOpenRouter = useCallback(async (query: string) => {
    setOrSearchLoading(true);
    try {
      const qs = query ? `?q=${encodeURIComponent(query)}&limit=20` : '?limit=20';
      const data = await api.get<{
        configured: boolean;
        models?: AvailableModel[];
        total?: number;
        error?: string;
      }>(`/models/providers/openrouter/search${qs}`);
      if (data.configured === false) {
        setProviderConfigured(false);
        setProviderError(data.error || 'OpenRouter not configured');
        setOrSearchResults([]);
      } else {
        setProviderConfigured(true);
        setOrSearchResults(data.models || []);
        setOrSearchTotal(data.total || 0);
      }
    } catch (err) {
      setProviderError((err as Error).message);
      setOrSearchResults([]);
    }
    setOrSearchLoading(false);
  }, []);

  // Reset state when modal opens and check provider availability
  useEffect(() => {
    if (isOpen) {
      setStep('choose-source');
      setConnectionType('litellm');
      setError('');
      setTestResult(null);
      setAvailableModels([]);
      setProviderConfigured(null);
      setProviderError('');
      setOrSearchQuery('');
      setOrSearchResults([]);
      setOrSearchTotal(0);
      // Check which providers are configured
      (async () => {
        const configured = new Set<string>();
        // Always include providers that don't need configuration
        configured.add('ollama');
        configured.add('cli');
        configured.add('custom');
        try {
          const settings = await api.get<{ settings: Record<string, Array<{ key: string; value: unknown }>> }>('/settings');
          const all = Object.values(settings?.settings || {}).flat();
          for (const s of all) {
            if (s.key === 'litellm.proxyUrl' && s.value && String(s.value).trim()) configured.add('litellm');
            if (s.key === 'openrouter.apiKey' && s.value && String(s.value) !== '' && String(s.value) !== '••••••••') configured.add('openrouter');
          }
          // Check vault-based providers by testing their health
          const providerChecks = ['openai', 'anthropic', 'deepseek', 'gemini', 'openrouter'] as const;
          const healthResults = await Promise.allSettled(
            providerChecks.map(p => api.get<{ configured?: boolean }>(`/models/providers/${p}/available`))
          );
          providerChecks.forEach((p, i) => {
            const result = healthResults[i];
            if (result.status === 'fulfilled' && result.value?.configured) {
              configured.add(p);
            }
          });
        } catch { /* ignore — show all providers as fallback */ }
        setConfiguredProviders(configured);
      })();
    }
  }, [isOpen]);

  // Fetch available models when provider changes (direct connection only)
  const fetchAvailableModels = useCallback(async (provider: string, endpoint?: string) => {
    if (!provider || provider === 'cli' || provider === 'litellm') {
      setAvailableModels([]);
      setProviderConfigured(null);
      return;
    }

    // OpenRouter: use live search instead of static list
    if (provider === 'openrouter') {
      setAvailableModels([]);
      setOrSearchQuery('');
      setOrSearchResults([]);
      searchOpenRouter('');
      return;
    }

    setLoadingAvailable(true);
    setProviderError('');
    setAvailableModels([]);
    setProviderConfigured(null);
    try {
      const qs = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
      const data = await api.get<{ configured: boolean; models?: AvailableModel[]; error?: string; source?: string }>(
        `/models/providers/${provider}/available${qs}`
      );
      if (data.configured === false) {
        setProviderConfigured(false);
        setProviderError(data.error || `${provider} is not configured`);
      } else {
        setProviderConfigured(true);
        setAvailableModels(data.models || []);
      }
    } catch (err) {
      setProviderConfigured(false);
      setProviderError((err as Error).message);
    }
    setLoadingAvailable(false);
  }, [searchOpenRouter]);

  if (!isOpen) return null;

  const fetchLiteLLMModels = () => {
    setLitellmError('');
    setLoadingModels(true);
    api.get<{ models?: LiteLLMModel[]; error?: string }>('/models/providers/litellm/models')
      .then(data => {
        if (data.error) {
          setLitellmError(data.error);
        } else {
          setLitellmModels(data.models || []);
        }
      })
      .catch(() => setLitellmError('Cannot reach LiteLLM proxy'))
      .finally(() => setLoadingModels(false));
  };

  // Group models by provider
  const groupedModels = litellmModels.reduce<Record<string, LiteLLMModel[]>>((acc, m) => {
    const provider = mapLiteLLMProvider(m.provider);
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push(m);
    return acc;
  }, {});

  const handleChooseLiteLLM = () => {
    setConnectionType('litellm');
    fetchLiteLLMModels();
    setStep('litellm-pick');
  };

  const handleChooseDirect = () => {
    setConnectionType('direct');
    setFormData({
      name: '', provider: 'ollama', modelId: '', endpoint: '',
      contextWindow: 4096, maxTokens: 4096, supportsVision: false,
      supportsTools: true, supportsStreaming: true, disableThinking: false,
      topics: [], priority: 50, costPerInputToken: 0, costPerOutputToken: 0,
    });
    setError('');
    setTestResult(null);
    setStep('configure');
    fetchAvailableModels('ollama');
  };

  const handleSelectModel = (model: LiteLLMModel) => {
    // Models from LiteLLM list are routed through LiteLLM proxy — provider is 'litellm'
    const underlyingProvider = mapLiteLLMProvider(model.provider);
    const defaults = PROVIDER_DEFAULTS[underlyingProvider] || {};
    setFormData({
      name: model.id,
      provider: 'litellm',
      modelId: model.id,
      endpoint: '',
      contextWindow: defaults.contextWindow || 4096,
      maxTokens: defaults.maxTokens || 4096,
      supportsVision: defaults.supportsVision || false,
      supportsTools: defaults.supportsTools ?? true,
      supportsStreaming: true,
      disableThinking: false,
      topics: [],
      priority: 50,
      costPerInputToken: 0,
      costPerOutputToken: 0,
    });
    setError('');
    setTestResult(null);
    setStep('configure');
  };

  const handleTest = async () => {
    if (!formData.modelId.trim()) {
      setError('Model ID is required to test');
      return;
    }
    setTesting(true);
    setTestResult(null);
    setError('');
    try {
      const result = await api.post<{ success: boolean; message?: string; error?: string }>('/models/test', {
        provider: formData.provider,
        modelId: formData.modelId,
        endpoint: formData.endpoint || undefined,
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!formData.name.trim()) { setError('Name is required'); return; }
    if (!formData.modelId.trim()) { setError('Model ID is required'); return; }

    try {
      // Custom provider: route through ollama provider with API key ref
      const isCustom = formData.provider === 'custom';
      const effectiveProvider = isCustom ? 'ollama' : formData.provider;

      await onAdd({
        name: formData.name,
        provider: effectiveProvider,
        modelId: formData.modelId,
        endpoint: formData.endpoint || undefined,
        apiKeyRef: isCustom ? 'custom_api_key' : undefined,
        contextWindow: formData.contextWindow,
        maxTokens: formData.maxTokens,
        supportsVision: formData.supportsVision,
        supportsTools: formData.supportsTools,
        supportsStreaming: formData.supportsStreaming,
        topics: formData.topics.length > 0 ? formData.topics : undefined,
        priority: formData.priority,
        costPerInputToken: formData.costPerInputToken,
        costPerOutputToken: formData.costPerOutputToken,
        metadata: formData.disableThinking ? { extraBody: { think: false } } : undefined,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const isCli = formData.provider === 'cli';
  const backStep = step === 'litellm-pick' ? 'choose-source' : step === 'configure' ? (connectionType === 'litellm' ? 'litellm-pick' : 'choose-source') : null;
  const stepTitle = step === 'choose-source' ? 'Add Model' : step === 'litellm-pick' ? 'Select from LiteLLM' : 'Configure Model';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-surface-container rounded-[1rem] shadow-xl border border-outline-variant/10 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/10">
          <div className="flex items-center gap-2">
            {backStep && (
              <button onClick={() => setStep(backStep)} className="p-1 hover:bg-surface-container-high rounded text-on-surface-variant cursor-pointer">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              </button>
            )}
            <h2 className="text-lg font-semibold text-white">{stepTitle}</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-surface-container-high rounded cursor-pointer">
            <X className="w-5 h-5 text-on-surface-variant" />
          </button>
        </div>

        {/* Step 1: Choose connection type */}
        {step === 'choose-source' && (
          <div className="p-4 space-y-3">
            <p className="text-sm text-on-surface-variant mb-2">
              How should this model be connected?
            </p>

            {configuredProviders.has('litellm') && (
              <button
                type="button"
                onClick={handleChooseLiteLLM}
                className="w-full text-left p-4 border border-outline-variant/10 rounded-lg hover:border-primary/30 hover:bg-primary/5 transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <Cpu className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <div className="font-medium text-white">LiteLLM Proxy</div>
                    <div className="text-xs text-on-surface-variant">
                      Select from models configured in your LiteLLM proxy. Includes Ollama, OpenAI, Anthropic, and other providers.
                    </div>
                  </div>
                </div>
              </button>
            )}

            <button
              type="button"
              onClick={handleChooseDirect}
              className="w-full text-left p-4 border border-outline-variant/10 rounded-lg hover:border-outline-variant/30 hover:bg-surface-container-high transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center shrink-0">
                  <Pencil className="w-5 h-5 text-on-surface-variant" />
                </div>
                <div>
                  <div className="font-medium text-white">Manual / Direct</div>
                  <div className="text-xs text-on-surface-variant">
                    Configure a model directly via Ollama, OpenAI, Anthropic, OpenRouter, or any OpenAI-compatible endpoint.
                  </div>
                </div>
              </div>
            </button>
          </div>
        )}

        {/* Step 2: LiteLLM model picker */}
        {step === 'litellm-pick' && (
          <div className="p-4">
            {loadingModels ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="w-5 h-5 animate-spin text-on-surface-variant" />
                <span className="ml-2 text-sm text-on-surface-variant">Loading models from LiteLLM...</span>
              </div>
            ) : litellmError ? (
              <div className="space-y-3">
                <div className="px-3 py-2 bg-error/10 text-error text-sm rounded">
                  {litellmError}
                </div>
                <p className="text-sm text-on-surface-variant">
                  Make sure your LiteLLM proxy is running and configured.
                </p>
              </div>
            ) : Object.keys(groupedModels).length === 0 ? (
              <div className="text-center py-8 text-on-surface-variant">
                <Cpu className="w-8 h-8 mx-auto mb-2 text-outline-variant" />
                <p className="text-sm">No models found in LiteLLM</p>
                <p className="text-xs text-on-surface-variant mt-1">Add models to your LiteLLM config.yaml and restart the proxy.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {Object.entries(groupedModels).map(([provider, models]) => (
                  <div key={provider}>
                    <h3 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest mb-2">
                      {PROVIDER_LABELS[provider] || provider}
                    </h3>
                    <div className="space-y-1">
                      {models.map(m => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleSelectModel(m)}
                          className="w-full text-left px-3 py-2 rounded-lg hover:bg-surface-container-high flex items-center justify-between group/item transition-colors"
                        >
                          <span className="font-mono text-sm text-white">{m.id}</span>
                          <Plus className="w-4 h-4 text-on-surface-variant opacity-0 group-hover/item:opacity-100 transition-opacity" />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 3: Configure model details */}
        {step === 'configure' && (
          <form onSubmit={handleSubmit} className="p-4 space-y-4">
            {/* Connection type badge */}
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                connectionType === 'litellm'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-surface-container-high text-on-surface-variant'
              }`}>
                {connectionType === 'litellm' ? 'via LiteLLM Proxy' : 'Direct Connection'}
              </span>
            </div>

            <div>
              <label className="block text-sm font-medium text-on-surface-variant mb-1">Display Name *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., GPT-4 Turbo"
                className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Provider</label>
                <select
                  value={formData.provider}
                  onChange={(e) => {
                    const p = e.target.value;
                    setFormData({ ...formData, provider: p, modelId: '' });
                    setTestResult(null);
                    setOrSearchQuery('');
                    setOrSearchResults([]);
                    setOrSearchTotal(0);
                    if (connectionType === 'direct') fetchAvailableModels(p);
                  }}
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white"
                >
                  {Object.entries(PROVIDER_LABELS)
                    .sort(([a], [b]) => {
                      const aConf = configuredProviders.has(a) ? 0 : 1;
                      const bConf = configuredProviders.has(b) ? 0 : 1;
                      return aConf - bConf;
                    })
                    .map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}{configuredProviders.size > 0 && !configuredProviders.has(value) ? ' (not configured)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Model ID *</label>
                {connectionType === 'direct' && !isCli && formData.provider !== 'openrouter' && availableModels.length > 0 ? (
                  <select
                    value={formData.modelId}
                    onChange={(e) => {
                      const modelId = e.target.value;
                      const selected = availableModels.find(m => m.id === modelId);
                      setFormData({
                        ...formData,
                        modelId,
                        name: selected?.label || modelId,
                        contextWindow: selected?.contextWindow || formData.contextWindow,
                        maxTokens: selected?.maxOutputTokens || formData.maxTokens,
                        supportsVision: selected?.supportsVision ?? formData.supportsVision,
                        supportsTools: selected?.supportsTools ?? formData.supportsTools,
                        costPerInputToken: selected?.costPerInputToken ?? formData.costPerInputToken,
                        costPerOutputToken: selected?.costPerOutputToken ?? formData.costPerOutputToken,
                      });
                    }}
                    className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white font-mono text-sm"
                  >
                    <option value="">Select a model...</option>
                    {availableModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}{m.parameterSize ? ` (${m.parameterSize})` : ''}
                      </option>
                    ))}
                  </select>
                ) : connectionType === 'direct' && formData.provider === 'openrouter' ? (
                  <input
                    type="text"
                    value={formData.modelId}
                    readOnly
                    placeholder="Search below to select..."
                    className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white font-mono text-sm"
                  />
                ) : (
                  <input
                    type="text"
                    value={formData.modelId}
                    onChange={(e) => setFormData({ ...formData, modelId: e.target.value })}
                    placeholder={isCli ? 'cli/claude-code' : 'e.g., gpt-4o'}
                    className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white font-mono text-sm"
                  />
                )}
                {loadingAvailable && (
                  <p className="text-xs text-on-surface-variant mt-1 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Loading models...
                  </p>
                )}
              </div>
            </div>

            {/* OpenRouter live model search */}
            {connectionType === 'direct' && formData.provider === 'openrouter' && (
              <div className="border border-outline-variant/10 rounded-lg overflow-hidden">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
                  <input
                    type="text"
                    value={orSearchQuery}
                    onChange={(e) => {
                      const val = e.target.value;
                      setOrSearchQuery(val);
                      if (orDebounceRef.current) clearTimeout(orDebounceRef.current);
                      orDebounceRef.current = setTimeout(() => searchOpenRouter(val), 300);
                    }}
                    placeholder="Search OpenRouter models (e.g., claude, gpt, llama)..."
                    className="w-full pl-9 pr-3 py-2.5 bg-surface-container-high text-white text-sm border-b border-outline-variant/10 focus:outline-none focus:border-primary/30"
                  />
                  {orSearchLoading && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-on-surface-variant" />
                  )}
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {orSearchResults.length > 0 ? (
                    orSearchResults.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setFormData({
                            ...formData,
                            modelId: m.id,
                            name: m.label || m.id,
                            contextWindow: m.contextWindow || formData.contextWindow,
                            maxTokens: m.maxOutputTokens || formData.maxTokens,
                            supportsVision: m.supportsVision ?? formData.supportsVision,
                            supportsTools: m.supportsTools ?? formData.supportsTools,
                            costPerInputToken: m.costPerInputToken ?? formData.costPerInputToken,
                            costPerOutputToken: m.costPerOutputToken ?? formData.costPerOutputToken,
                          });
                        }}
                        className={`w-full text-left px-3 py-2 hover:bg-surface-container-highest transition-colors flex items-center justify-between group/or ${
                          formData.modelId === m.id ? 'bg-primary/5 border-l-2 border-primary' : ''
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-sm text-white truncate">{m.id}</div>
                          <div className="text-xs text-on-surface-variant flex items-center gap-2 mt-0.5">
                            {m.contextWindow ? <span>{(m.contextWindow / 1000).toFixed(0)}k ctx</span> : null}
                            {m.costPerInputToken ? <span>${m.costPerInputToken.toFixed(2)}/${m.costPerOutputToken?.toFixed(2)}</span> : null}
                            {m.supportsVision && <span className="text-primary/70">vision</span>}
                          </div>
                        </div>
                        {formData.modelId === m.id ? (
                          <CheckCircle className="w-4 h-4 text-primary shrink-0" />
                        ) : (
                          <Plus className="w-4 h-4 text-on-surface-variant opacity-0 group-hover/or:opacity-100 transition-opacity shrink-0" />
                        )}
                      </button>
                    ))
                  ) : !orSearchLoading ? (
                    <div className="px-3 py-4 text-center text-sm text-on-surface-variant">
                      {providerConfigured === false ? providerError : orSearchQuery ? 'No models found' : 'Loading models...'}
                    </div>
                  ) : null}
                </div>
                {orSearchTotal > 20 && (
                  <div className="px-3 py-1.5 text-xs text-on-surface-variant border-t border-outline-variant/10 bg-surface-container">
                    Showing 20 of {orSearchTotal} results
                  </div>
                )}
              </div>
            )}

            {/* Provider not configured warning */}
            {connectionType === 'direct' && providerConfigured === false && providerError && (
              <div className="flex items-start gap-2 px-3 py-2 bg-error/10 text-error text-sm rounded-lg">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{providerError}</span>
              </div>
            )}

            {connectionType === 'direct' && formData.provider === 'custom' && (
              <p className="text-xs text-on-surface-variant bg-surface-container-high px-3 py-2 rounded-lg">
                Custom providers use the OpenAI-compatible API format (/v1/chat/completions). Set the API key on the <strong>Secrets</strong> page under &quot;Custom Provider&quot;.
              </p>
            )}

            {!isCli && (connectionType === 'litellm' || formData.provider === 'ollama' || formData.provider === 'custom') && (
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Endpoint URL {formData.provider === 'custom' ? '*' : ''}</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={formData.endpoint}
                    onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                    placeholder={connectionType === 'litellm' ? 'Uses LiteLLM proxy (auto)' : formData.provider === 'custom' ? 'e.g., https://api.provider.com' : 'e.g., http://192.168.1.100:11434'}
                    className="flex-1 px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white font-mono text-sm"
                  />
                  {connectionType === 'direct' && (formData.provider === 'ollama' || formData.provider === 'custom') && formData.endpoint && (
                    <button
                      type="button"
                      onClick={() => fetchAvailableModels('ollama', formData.endpoint)}  /* custom uses same Ollama-compat endpoint */
                      className="px-3 py-2 border border-outline-variant/10 rounded-lg hover:bg-surface-container-high text-on-surface-variant text-sm flex items-center gap-1 cursor-pointer"
                      title="Reload models from this endpoint"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Context Window</label>
                <input
                  type="number"
                  value={formData.contextWindow}
                  onChange={(e) => setFormData({ ...formData, contextWindow: parseInt(e.target.value) || 4096 })}
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Max Output Tokens</label>
                <input
                  type="number"
                  value={formData.maxTokens}
                  onChange={(e) => setFormData({ ...formData, maxTokens: parseInt(e.target.value) || 4096 })}
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white"
                />
                <p className="text-xs text-on-surface-variant mt-0.5">Max tokens per response (check model docs)</p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-on-surface-variant mb-1">Topics</label>
              <p className="text-xs text-on-surface-variant mb-2">Select which orchestrator roles can use this model</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 w-full">
                {AVAILABLE_TOPICS.map((topic) => {
                  const selected = formData.topics.includes(topic.value);
                  return (
                    <button
                      key={topic.value}
                      type="button"
                      onClick={() => setFormData({
                        ...formData,
                        topics: selected
                          ? formData.topics.filter(t => t !== topic.value)
                          : [...formData.topics, topic.value],
                      })}
                      className={`px-2 py-1 rounded-lg text-xs cursor-pointer transition-colors ${
                        selected
                          ? 'bg-primary/10 text-primary ring-1 ring-primary/30'
                          : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'
                      }`}
                      title={topic.description}
                    >
                      {topic.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {!isCli && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-on-surface-variant mb-1">Cost/1M Input Tokens</label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.costPerInputToken}
                    onChange={(e) => setFormData({ ...formData, costPerInputToken: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-on-surface-variant mb-1">Cost/1M Output Tokens</label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.costPerOutputToken}
                    onChange={(e) => setFormData({ ...formData, costPerOutputToken: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white"
                  />
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={formData.supportsVision} onChange={(e) => setFormData({ ...formData, supportsVision: e.target.checked })} className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary" />
                <span className="text-sm text-on-surface-variant">Vision</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={formData.supportsTools} onChange={(e) => setFormData({ ...formData, supportsTools: e.target.checked })} className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary" />
                <span className="text-sm text-on-surface-variant">Tools</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={formData.supportsStreaming} onChange={(e) => setFormData({ ...formData, supportsStreaming: e.target.checked })} className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary" />
                <span className="text-sm text-on-surface-variant">Streaming</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer" title="Disable reasoning/thinking tokens (e.g. for Qwen3, DeepSeek). Sends think:false to Ollama.">
                <input type="checkbox" checked={formData.disableThinking} onChange={(e) => setFormData({ ...formData, disableThinking: e.target.checked })} className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary" />
                <span className="text-sm text-on-surface-variant">Disable Thinking</span>
              </label>
            </div>

            {/* Test Connection */}
            {formData.modelId && (
              <div className="border border-outline-variant/10 rounded-lg p-3">
                <div className="text-xs text-on-surface-variant mb-2">
                  Tests via {connectionType === 'litellm' ? 'LiteLLM proxy' : (formData.provider === 'ollama' ? 'Ollama directly' : 'LiteLLM proxy')}
                </div>
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing}
                  className="w-full px-3 py-2 border border-outline-variant/10 text-on-surface-variant rounded-lg hover:bg-surface-container-high disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
                >
                  {testing ? (
                    <><RefreshCw className="w-4 h-4 animate-spin" />Testing connection...</>
                  ) : (
                    <><CheckCircle className="w-4 h-4" />Test Connection</>
                  )}
                </button>
                {testResult && (
                  <div className={`mt-2 px-3 py-2 rounded text-sm ${
                    testResult.success
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : 'bg-error/10 text-error'
                  }`}>
                    {testResult.success ? testResult.message : testResult.error}
                  </div>
                )}
              </div>
            )}

            {error && (
              <p className="text-sm text-error bg-error/10 px-3 py-2 rounded">{error}</p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2 border border-outline-variant/10 text-on-surface-variant rounded-full hover:bg-surface-container-high"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 px-4 py-2 bg-gradient-to-r from-primary to-primary-container text-on-primary cursor-pointer rounded-full hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
              >
                <Plus className="w-4 h-4" />
                {loading ? 'Adding...' : 'Add Model'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
