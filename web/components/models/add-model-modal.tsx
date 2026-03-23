'use client';

import { useState, useEffect } from 'react';
import { Cpu, CheckCircle, X, Plus, RefreshCw, Pencil } from 'lucide-react';
import { api } from '@/lib/api';
import {
  type LiteLLMModel,
  AVAILABLE_TOPICS,
  mapLiteLLMProvider,
  PROVIDER_LABELS,
  PROVIDER_DEFAULTS,
} from '@/lib/types/models';

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
      supportsTools: true, supportsStreaming: true, disableThinking: false,
      topics: [], priority: 50, costPerInputToken: 0, costPerOutputToken: 0,
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
                  onChange={(e) => setFormData({ ...formData, provider: e.target.value })}
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white"
                >
                  {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Model ID *</label>
                <input
                  type="text"
                  value={formData.modelId}
                  onChange={(e) => setFormData({ ...formData, modelId: e.target.value })}
                  placeholder={isCli ? 'cli/claude-code' : 'e.g., gpt-4o'}
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white font-mono text-sm"
                />
              </div>
            </div>

            {!isCli && (
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Endpoint URL</label>
                <input
                  type="text"
                  value={formData.endpoint}
                  onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                  placeholder={connectionType === 'litellm' ? 'Uses LiteLLM proxy (auto)' : 'e.g., http://localhost:11434'}
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-white font-mono text-sm"
                />
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
              <div className="flex flex-wrap gap-2">
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
                      className={`px-3 py-1.5 rounded-lg text-sm cursor-pointer transition-colors ${
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
