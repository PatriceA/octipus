'use client';

import { useState, useEffect, useCallback } from 'react';
import { Cpu, CheckCircle, XCircle, AlertCircle, X, Plus, Trash2, Star, Terminal, RefreshCw, Pencil } from 'lucide-react';
import { api } from '@/lib/api';

interface Model {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  endpoint?: string;
  isEnabled: boolean;
  isDefault: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsStreaming: boolean;
  contextWindow: number;
  maxTokens: number;
  topics: string[];
  priority: number;
  costPerInputToken: number;
  costPerOutputToken: number;
  metadata?: {
    description?: string;
    cliAgent?: {
      permissionMode?: string;
      allowedTools?: string[];
      maxBudgetUsd?: number;
      mcpConfigPath?: string;
      extraArgs?: string[];
    };
  };
  health?: 'healthy' | 'unhealthy' | 'unknown';
}

interface CLITool {
  name: string;
  available: boolean;
  modelPatterns: string[];
  quota: {
    provider: string;
    hasQuota: boolean;
    exhausted: boolean;
    resetsAt?: string;
  } | null;
}


function HealthBadge({ health }: { health?: Model['health'] }) {
  const config = {
    healthy: { color: 'text-green-500', icon: CheckCircle, label: 'Healthy' },
    unhealthy: { color: 'text-red-500', icon: XCircle, label: 'Unhealthy' },
    unknown: { color: 'text-gray-500', icon: AlertCircle, label: 'Unknown' },
  };
  const { color, icon: Icon, label } = config[health || 'unknown'];

  return (
    <span className={`inline-flex items-center gap-1 ${color}`}>
      <Icon className="w-4 h-4" />
      <span className="text-sm">{label}</span>
    </span>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const colors: Record<string, string> = {
    ollama: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    openai: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    anthropic: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
    gemini: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
    deepseek: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
    cli: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
    openrouter: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    custom: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300',
  };

  return (
    <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${colors[provider] || colors.custom}`}>
      {provider}
    </span>
  );
}

interface LiteLLMModel {
  id: string;
  provider: string;
  litellmModel: string;
}

/** Map LiteLLM provider prefix to our internal provider name */
function mapLiteLLMProvider(provider: string): string {
  const map: Record<string, string> = {
    ollama: 'ollama',
    openai: 'openai',
    anthropic: 'anthropic',
    deepseek: 'deepseek',
    gemini: 'gemini',
  };
  return map[provider] || provider;
}

/** Provider display labels */
const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama (Local)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  gemini: 'Google Gemini',
  cli: 'CLI (Subscription)',
  custom: 'Custom',
};

/** Default model capabilities by provider */
const PROVIDER_DEFAULTS: Record<string, { contextWindow: number; maxTokens: number; supportsVision: boolean; supportsTools: boolean }> = {
  ollama: { contextWindow: 8192, maxTokens: 4096, supportsVision: false, supportsTools: true },
  openai: { contextWindow: 128000, maxTokens: 16384, supportsVision: true, supportsTools: true },
  anthropic: { contextWindow: 200000, maxTokens: 8192, supportsVision: true, supportsTools: true },
  deepseek: { contextWindow: 128000, maxTokens: 8192, supportsVision: false, supportsTools: true },
  gemini: { contextWindow: 1000000, maxTokens: 8192, supportsVision: true, supportsTools: true },
};

function AddModelModal({
  isOpen,
  onClose,
  onAdd,
  loading,
}: {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (model: Record<string, unknown>) => Promise<void>;
  loading: boolean;
}) {
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
    topics: '',
    priority: 50,
    costPerInputToken: 0,
    costPerOutputToken: 0,
  });
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message?: string; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setStep('choose-source');
      setConnectionType('litellm');
      setError('');
      setTestResult(null);
    }
  }, [isOpen]);

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
      supportsTools: true, supportsStreaming: true,
      topics: '', priority: 50, costPerInputToken: 0, costPerOutputToken: 0,
    });
    setError('');
    setTestResult(null);
    setStep('configure');
  };

  const handleSelectModel = (model: LiteLLMModel) => {
    const provider = mapLiteLLMProvider(model.provider);
    const defaults = PROVIDER_DEFAULTS[provider] || {};
    setFormData({
      name: model.id,
      provider,
      modelId: model.id,
      endpoint: '',
      contextWindow: defaults.contextWindow || 4096,
      maxTokens: defaults.maxTokens || 4096,
      supportsVision: defaults.supportsVision || false,
      supportsTools: defaults.supportsTools ?? true,
      supportsStreaming: true,
      topics: '',
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
      await onAdd({
        name: formData.name,
        provider: formData.provider,
        modelId: formData.modelId,
        endpoint: formData.endpoint || undefined,
        contextWindow: formData.contextWindow,
        maxTokens: formData.maxTokens,
        supportsVision: formData.supportsVision,
        supportsTools: formData.supportsTools,
        supportsStreaming: formData.supportsStreaming,
        topics: formData.topics ? formData.topics.split(',').map(t => t.trim()).filter(Boolean) : undefined,
        priority: formData.priority,
        costPerInputToken: formData.costPerInputToken,
        costPerOutputToken: formData.costPerOutputToken,
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
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            {backStep && (
              <button onClick={() => setStep(backStep)} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-500 cursor-pointer">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              </button>
            )}
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{stepTitle}</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded cursor-pointer">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Step 1: Choose connection type */}
        {step === 'choose-source' && (
          <div className="p-4 space-y-3">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
              How should this model be connected?
            </p>

            <button
              type="button"
              onClick={handleChooseLiteLLM}
              className="w-full text-left p-4 border border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-400 hover:bg-blue-50/50 dark:hover:border-blue-500 dark:hover:bg-blue-900/10 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                  <Cpu className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">LiteLLM Proxy</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Select from models configured in your LiteLLM proxy. Includes Ollama, OpenAI, Anthropic, and other providers.
                  </div>
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={handleChooseDirect}
              className="w-full text-left p-4 border border-gray-200 dark:border-gray-600 rounded-lg hover:border-gray-400 hover:bg-gray-50 dark:hover:border-gray-500 dark:hover:bg-gray-700/50 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center shrink-0">
                  <Pencil className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </div>
                <div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">Manual / Direct</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Enter model details manually. For models not in LiteLLM, custom endpoints, or CLI subscription tools.
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
                <RefreshCw className="w-5 h-5 animate-spin text-gray-500" />
                <span className="ml-2 text-sm text-gray-500">Loading models from LiteLLM...</span>
              </div>
            ) : litellmError ? (
              <div className="space-y-3">
                <div className="px-3 py-2 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm rounded">
                  {litellmError}
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Make sure your LiteLLM proxy is running and configured.
                </p>
              </div>
            ) : Object.keys(groupedModels).length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <Cpu className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                <p className="text-sm">No models found in LiteLLM</p>
                <p className="text-xs text-gray-500 mt-1">Add models to your LiteLLM config.yaml and restart the proxy.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {Object.entries(groupedModels).map(([provider, models]) => (
                  <div key={provider}>
                    <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                      {PROVIDER_LABELS[provider] || provider}
                    </h3>
                    <div className="space-y-1">
                      {models.map(m => (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleSelectModel(m)}
                          className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between group/item transition-colors"
                        >
                          <span className="font-mono text-sm text-gray-900 dark:text-gray-100">{m.id}</span>
                          <Plus className="w-4 h-4 text-gray-500 opacity-0 group-hover/item:opacity-100 transition-opacity" />
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
                  ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
              }`}>
                {connectionType === 'litellm' ? 'via LiteLLM Proxy' : 'Direct Connection'}
              </span>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Display Name *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., GPT-4 Turbo"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Provider</label>
                <select
                  value={formData.provider}
                  onChange={(e) => setFormData({ ...formData, provider: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                >
                  {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model ID *</label>
                <input
                  type="text"
                  value={formData.modelId}
                  onChange={(e) => setFormData({ ...formData, modelId: e.target.value })}
                  placeholder={isCli ? 'cli/claude-code' : 'e.g., gpt-4o'}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-sm"
                />
              </div>
            </div>

            {!isCli && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Endpoint URL</label>
                <input
                  type="text"
                  value={formData.endpoint}
                  onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                  placeholder={connectionType === 'litellm' ? 'Uses LiteLLM proxy (auto)' : 'e.g., http://localhost:11434'}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-sm"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Context Window</label>
                <input
                  type="number"
                  value={formData.contextWindow}
                  onChange={(e) => setFormData({ ...formData, contextWindow: parseInt(e.target.value) || 4096 })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Max Tokens</label>
                <input
                  type="number"
                  value={formData.maxTokens}
                  onChange={(e) => setFormData({ ...formData, maxTokens: parseInt(e.target.value) || 4096 })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Priority</label>
                <input
                  type="number"
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Topics</label>
                <input
                  type="text"
                  value={formData.topics}
                  onChange={(e) => setFormData({ ...formData, topics: e.target.value })}
                  placeholder="coding, analysis, chat"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm"
                />
              </div>
            </div>

            {!isCli && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cost/1M Input Tokens</label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.costPerInputToken}
                    onChange={(e) => setFormData({ ...formData, costPerInputToken: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cost/1M Output Tokens</label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.costPerOutputToken}
                    onChange={(e) => setFormData({ ...formData, costPerOutputToken: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={formData.supportsVision} onChange={(e) => setFormData({ ...formData, supportsVision: e.target.checked })} className="w-4 h-4 rounded" />
                <span className="text-sm text-gray-700 dark:text-gray-300">Vision</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={formData.supportsTools} onChange={(e) => setFormData({ ...formData, supportsTools: e.target.checked })} className="w-4 h-4 rounded" />
                <span className="text-sm text-gray-700 dark:text-gray-300">Tools</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={formData.supportsStreaming} onChange={(e) => setFormData({ ...formData, supportsStreaming: e.target.checked })} className="w-4 h-4 rounded" />
                <span className="text-sm text-gray-700 dark:text-gray-300">Streaming</span>
              </label>
            </div>

            {/* Test Connection */}
            {formData.modelId && (
              <div className="border border-gray-200 dark:border-gray-600 rounded-lg p-3">
                <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  Tests via {connectionType === 'litellm' ? 'LiteLLM proxy' : (formData.provider === 'ollama' ? 'Ollama directly' : 'LiteLLM proxy')}
                </div>
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
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
                      ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                      : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
                  }`}>
                    {testResult.success ? testResult.message : testResult.error}
                  </div>
                )}
              </div>
            )}

            {error && (
              <p className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded">{error}</p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2"
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

function EditModelModal({
  model,
  onClose,
  onSave,
  loading,
}: {
  model: Model;
  onClose: () => void;
  onSave: (name: string, data: Record<string, unknown>) => Promise<void>;
  loading: boolean;
}) {
  const cliAgent = model.metadata?.cliAgent || {};
  const [formData, setFormData] = useState({
    endpoint: model.endpoint || '',
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    topics: (model.topics || []).join(', '),
    priority: model.priority,
    supportsVision: model.supportsVision,
    supportsTools: model.supportsTools,
    supportsStreaming: model.supportsStreaming,
    costPerInputToken: model.costPerInputToken,
    costPerOutputToken: model.costPerOutputToken,
    // CLI agent settings
    cliPermissionMode: cliAgent.permissionMode || '',
    cliAllowedTools: (cliAgent.allowedTools || []).join(', '),
    cliMaxBudgetUsd: cliAgent.maxBudgetUsd ?? '',
    cliMcpConfigPath: cliAgent.mcpConfigPath || '',
    cliExtraArgs: (cliAgent.extraArgs || []).join(' '),
  });
  const [error, setError] = useState('');

  const isCli = model.provider === 'cli';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const payload: Record<string, unknown> = {
        endpoint: formData.endpoint || undefined,
        contextWindow: formData.contextWindow,
        maxTokens: formData.maxTokens,
        topics: formData.topics ? formData.topics.split(',').map(t => t.trim()).filter(Boolean) : [],
        priority: formData.priority,
        supportsVision: formData.supportsVision,
        supportsTools: formData.supportsTools,
        supportsStreaming: formData.supportsStreaming,
        costPerInputToken: formData.costPerInputToken,
        costPerOutputToken: formData.costPerOutputToken,
      };

      // Include CLI agent settings in metadata
      if (isCli) {
        const cliAgentConfig: Record<string, unknown> = {};
        if (formData.cliPermissionMode) cliAgentConfig.permissionMode = formData.cliPermissionMode;
        if (formData.cliAllowedTools.trim()) {
          cliAgentConfig.allowedTools = formData.cliAllowedTools.split(',').map(t => t.trim()).filter(Boolean);
        }
        if (formData.cliMaxBudgetUsd !== '') {
          cliAgentConfig.maxBudgetUsd = Number(formData.cliMaxBudgetUsd);
        }
        if (formData.cliMcpConfigPath) cliAgentConfig.mcpConfigPath = formData.cliMcpConfigPath;
        if (formData.cliExtraArgs.trim()) {
          cliAgentConfig.extraArgs = formData.cliExtraArgs.split(/\s+/).filter(Boolean);
        }

        payload.metadata = {
          ...model.metadata,
          cliAgent: Object.keys(cliAgentConfig).length > 0 ? cliAgentConfig : undefined,
        };
      }

      await onSave(model.name, payload);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Edit Model</h2>
            <p className="text-sm text-gray-500">{model.name} <span className="font-mono text-xs">({model.provider}/{model.modelId})</span></p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded cursor-pointer">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {model.provider !== 'cli' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Endpoint URL</label>
              <input
                type="text"
                value={formData.endpoint}
                onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                placeholder="Leave empty for default"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-sm"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Context Window</label>
              <input
                type="number"
                value={formData.contextWindow}
                onChange={(e) => setFormData({ ...formData, contextWindow: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Max Tokens</label>
              <input
                type="number"
                value={formData.maxTokens}
                onChange={(e) => setFormData({ ...formData, maxTokens: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Priority</label>
              <input
                type="number"
                value={formData.priority}
                onChange={(e) => setFormData({ ...formData, priority: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Topics</label>
              <input
                type="text"
                value={formData.topics}
                onChange={(e) => setFormData({ ...formData, topics: e.target.value })}
                placeholder="coding, analysis, chat"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm"
              />
            </div>
          </div>

          {model.provider !== 'cli' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cost/1M Input Tokens</label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.costPerInputToken}
                  onChange={(e) => setFormData({ ...formData, costPerInputToken: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cost/1M Output Tokens</label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.costPerOutputToken}
                  onChange={(e) => setFormData({ ...formData, costPerOutputToken: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.supportsVision}
                onChange={(e) => setFormData({ ...formData, supportsVision: e.target.checked })}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">Vision</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.supportsTools}
                onChange={(e) => setFormData({ ...formData, supportsTools: e.target.checked })}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">Tools</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.supportsStreaming}
                onChange={(e) => setFormData({ ...formData, supportsStreaming: e.target.checked })}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">Streaming</span>
            </label>
          </div>

          {/* CLI Agent Settings */}
          {isCli && (
            <div className="border border-violet-200 dark:border-violet-800 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <Terminal className="w-4 h-4 text-violet-600" />
                <h3 className="text-sm font-semibold text-violet-900 dark:text-violet-300">CLI Agent Settings</h3>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                CLI models run as autonomous sub-agents with their own tools and agent loop.
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Permission Mode</label>
                <select
                  value={formData.cliPermissionMode}
                  onChange={(e) => setFormData({ ...formData, cliPermissionMode: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm"
                >
                  <option value="">Default</option>
                  <option value="bypassPermissions">Bypass Permissions (Claude)</option>
                  <option value="yolo">YOLO (Gemini)</option>
                  <option value="plan">Plan Only</option>
                  <option value="acceptEdits">Accept Edits (Claude)</option>
                  <option value="auto_edit">Auto Edit (Gemini)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Max Budget (USD per invocation)
                </label>
                <input
                  type="number"
                  step="0.10"
                  min="0"
                  value={formData.cliMaxBudgetUsd}
                  onChange={(e) => setFormData({ ...formData, cliMaxBudgetUsd: e.target.value })}
                  placeholder="No limit"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Claude Code only. Leave empty for no limit.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">MCP Config Path</label>
                <input
                  type="text"
                  value={formData.cliMcpConfigPath}
                  onChange={(e) => setFormData({ ...formData, cliMcpConfigPath: e.target.value })}
                  placeholder="/path/to/mcp-config.json"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Allowed Tools</label>
                <input
                  type="text"
                  value={formData.cliAllowedTools}
                  onChange={(e) => setFormData({ ...formData, cliAllowedTools: e.target.value })}
                  placeholder="Bash, Read, Edit, WebSearch"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm"
                />
                <p className="text-xs text-gray-500 mt-1">Claude Code only. Comma-separated. Empty = all tools.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Extra CLI Arguments</label>
                <input
                  type="text"
                  value={formData.cliExtraArgs}
                  onChange={(e) => setFormData({ ...formData, cliExtraArgs: e.target.value })}
                  placeholder="--no-session-persistence --max-turns 10"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 font-mono text-sm"
                />
              </div>
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CLIStatusPanel({ tools, registeredModels, onAdd }: {
  tools: CLITool[];
  registeredModels: Model[];
  onAdd: (model: Record<string, unknown>) => Promise<void>;
}) {
  if (tools.length === 0) return null;

  const [adding, setAdding] = useState<string | null>(null);

  const isRegistered = (tool: CLITool) =>
    registeredModels.some(m => m.provider === 'cli' && tool.modelPatterns.includes(m.modelId));

  const handleQuickAdd = async (tool: CLITool) => {
    setAdding(tool.name);
    try {
      await onAdd({
        name: tool.modelPatterns[0],
        provider: 'cli',
        modelId: tool.modelPatterns[0],
        maxTokens: 16384,
        contextWindow: 200000,
        supportsVision: false,
        supportsTools: false,
        supportsStreaming: false,
        topics: ['coding', 'analysis'],
        priority: 80,
        costPerInputToken: 0,
        costPerOutputToken: 0,
      });
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ring-gray-200/60 dark:ring-gray-700/60 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Terminal className="w-5 h-5 text-violet-600" />
        <h2 className="font-semibold text-gray-900 dark:text-gray-100">Detected CLI Tools</h2>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        These CLI subscription tools were detected on your system. Add them to use as models.
      </p>
      <div className="space-y-2">
        {tools.map(tool => {
          const registered = isRegistered(tool);
          return (
            <div key={tool.name} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${
                  !tool.available ? 'bg-gray-400' : registered ? 'bg-green-500' : 'bg-yellow-500'
                }`} />
                <span className="text-gray-900 dark:text-gray-100">{tool.name}</span>
                {!tool.available && (
                  <span className="text-xs text-gray-500">(not installed)</span>
                )}
                {tool.available && !registered && (
                  <span className="text-xs text-yellow-600 dark:text-yellow-400">(detected, not registered)</span>
                )}
                {tool.available && registered && (
                  <span className="text-xs text-green-600 dark:text-green-400">(active)</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {tool.quota && registered && (
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    tool.quota.exhausted
                      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                      : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                  }`}>
                    {tool.quota.exhausted ? 'Quota Exhausted' : 'Quota OK'}
                  </span>
                )}
                {tool.available && !registered && (
                  <button
                    onClick={() => handleQuickAdd(tool)}
                    disabled={adding === tool.name}
                    className="text-xs px-2 py-1 bg-violet-600 text-white rounded hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1"
                  >
                    <Plus className="w-3 h-3" />
                    {adding === tool.name ? 'Adding...' : 'Add'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ModelsPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [cliTools, setCLITools] = useState<CLITool[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchModels = useCallback(async () => {
    try {
      const data = await api.get<{ models: Model[] }>('/models');
      setModels(data.models || []);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCLIStatus = useCallback(async () => {
    try {
      const data = await api.get<{ tools: CLITool[] }>('/models/cli/status');
      setCLITools(data.tools || []);
    } catch {
      // CLI status is optional, don't show error
    }
  }, []);

  useEffect(() => {
    fetchModels();
    fetchCLIStatus();
  }, [fetchModels, fetchCLIStatus]);

  const handleAddModel = async (modelData: Record<string, unknown>) => {
    setActionLoading(true);
    try {
      await api.post('/models', modelData);
      await fetchModels();
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteModel = async (name: string) => {
    if (!confirm(`Delete model "${name}"?`)) return;

    setActionLoading(true);
    try {
      await api.delete(`/models/${encodeURIComponent(name)}`);
      await fetchModels();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveModel = async (name: string, data: Record<string, unknown>) => {
    setActionLoading(true);
    try {
      await api.patch(`/models/${encodeURIComponent(name)}`, data);
      await fetchModels();
    } finally {
      setActionLoading(false);
    }
  };

  const handleSetDefault = async (name: string) => {
    setActionLoading(true);
    try {
      await api.post(`/models/${encodeURIComponent(name)}/default`);
      await fetchModels();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleEnabled = async (model: Model) => {
    try {
      await api.patch(`/models/${encodeURIComponent(model.name)}`, {
        isEnabled: !model.isEnabled,
      });
      await fetchModels();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
            <Cpu className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Models</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Configure LLM models, providers, and CLI tools</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { fetchModels(); fetchCLIStatus(); }}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsModalOpen(true)}
            className="px-4 py-2 bg-primary-600 text-white cursor-pointer rounded-lg hover:bg-primary-700 flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add Model
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-red-700 dark:text-red-300 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">dismiss</button>
        </div>
      )}

      <CLIStatusPanel tools={cliTools} registeredModels={models} onAdd={handleAddModel} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {models.length === 0 ? (
          <div className="col-span-full text-center py-8 text-gray-500">
            <Cpu className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p>No models configured</p>
            <p className="text-sm mt-1">Click "Add Model" to configure your first model</p>
          </div>
        ) : (
          models.map((model) => (
            <div
              key={model.id}
              className={`bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ${
                model.isEnabled
                  ? 'ring-gray-200/60 dark:ring-gray-700/60'
                  : 'ring-gray-200/60 dark:ring-gray-700/60 opacity-60'
              } p-4 relative group`}
            >
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {!model.isDefault && (
                  <button
                    onClick={() => handleSetDefault(model.name)}
                    className="p-1.5 text-gray-500 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded cursor-pointer"
                    title="Set as default"
                  >
                    <Star className="w-4 h-4" />
                  </button>
                )}
                <button
                  onClick={() => setEditingModel(model)}
                  className="p-1.5 text-gray-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded cursor-pointer"
                  title="Edit model"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleToggleEnabled(model)}
                  className="p-1.5 text-gray-500 hover:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20 rounded cursor-pointer"
                  title={model.isEnabled ? 'Disable' : 'Enable'}
                >
                  {model.isEnabled ? (
                    <CheckCircle className="w-4 h-4" />
                  ) : (
                    <XCircle className="w-4 h-4" />
                  )}
                </button>
                <button
                  onClick={() => handleDeleteModel(model.name)}
                  className="p-1.5 text-gray-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded cursor-pointer"
                  title="Delete model"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="mb-3 pr-20">
                <div className="flex items-center gap-2">
                  {model.provider === 'cli' ? (
                    <Terminal className="w-5 h-5 text-violet-600" />
                  ) : (
                    <Cpu className="w-5 h-5 text-blue-600" />
                  )}
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100">{model.name}</h3>
                  {model.isDefault && (
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-800 text-xs rounded-full flex items-center gap-1 shrink-0">
                      <Star className="w-3 h-3" /> Default
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Provider</span>
                  <ProviderBadge provider={model.provider} />
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Model ID</span>
                  <span className="text-gray-900 dark:text-gray-100 font-mono text-xs">{model.modelId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Context</span>
                  <span className="text-gray-900 dark:text-gray-100">{(model.contextWindow / 1000).toFixed(0)}k</span>
                </div>
                {model.costPerInputToken > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Cost (in/out)</span>
                    <span className="text-gray-900 dark:text-gray-100 text-xs">
                      ${model.costPerInputToken}/${model.costPerOutputToken} /1M
                    </span>
                  </div>
                )}
                {model.provider === 'cli' && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Cost</span>
                    <span className="text-green-600 dark:text-green-400 text-xs font-medium">Free (subscription)</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-500">Priority</span>
                  <span className="text-gray-900 dark:text-gray-100">{model.priority}</span>
                </div>
              </div>

              <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 flex flex-wrap gap-1.5">
                {model.supportsVision && (
                  <span className="px-2 py-0.5 bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300 text-xs rounded">Vision</span>
                )}
                {model.supportsTools && (
                  <span className="px-2 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 text-xs rounded">Tools</span>
                )}
                {model.supportsStreaming && (
                  <span className="px-2 py-0.5 bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 text-xs rounded">Stream</span>
                )}
                {model.provider === 'cli' && (
                  <span className="px-2 py-0.5 bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300 text-xs rounded">Sub-Agent</span>
                )}
              </div>

              {model.topics && model.topics.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {model.topics.map((topic) => (
                    <span key={topic} className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs rounded">
                      {topic}
                    </span>
                  ))}
                </div>
              )}

              {model.metadata?.description && (
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{model.metadata.description}</p>
              )}
            </div>
          ))
        )}
      </div>

      <AddModelModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAdd={handleAddModel}
        loading={actionLoading}
      />

      {editingModel && (
        <EditModelModal
          model={editingModel}
          onClose={() => setEditingModel(null)}
          onSave={handleSaveModel}
          loading={actionLoading}
        />
      )}
    </div>
  );
}
