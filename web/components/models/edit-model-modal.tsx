'use client';

import { Terminal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { validateScopedExtraArgs } from '../../../src/shared/cli-capabilities';
import { api } from '@/lib/api';
import { Portal } from '@/components/ui/portal';
import type { CLITool, Model } from '@/lib/types/models';

type CliKind = 'claude' | 'antigravity' | 'codex' | 'vibe' | 'glm' | 'kimi' | null;

function fallbackCliKind(modelId: string): CliKind {
  const id = modelId.toLowerCase();
  if (id.includes('claude')) return 'claude';
  if (id.includes('antigravity') || id.includes('agy') || id.includes('gemini')) return 'antigravity';
  if (id.includes('codex')) return 'codex';
  if (id.includes('vibe')) return 'vibe';
  if (id.includes('glm') || id.includes('zai')) return 'glm';
  if (id.includes('kimi') || id.includes('moonshot')) return 'kimi';
  return null;
}

function toolMatchesModel(tool: CLITool, modelId: string): boolean {
  return tool.modelPatterns.some(pattern => modelId === pattern || modelId.startsWith(`${pattern}/`));
}

function cliKindForTool(tool: CLITool | undefined, modelId: string): CliKind {
  switch (tool?.modelProvider) {
    case 'anthropic': return 'claude';
    case 'google': return 'antigravity';
    case 'openai': return 'codex';
    case 'mistral': return 'vibe';
    case 'zai': return 'glm';
    case 'moonshot': return 'kimi';
    default: return fallbackCliKind(modelId);
  }
}

function normalizePermissionMode(mode: string | undefined, kind: CliKind): string {
  switch (mode) {
    case 'bypassPermissions':
    case 'danger-full-access':
    case 'auto-approve':
    case 'yolo':
      return 'full';
    case 'acceptEdits':
    case 'accept-edits':
    case 'workspace-write':
    case 'auto_edit':
      return 'workspace';
    case 'auto':
      return kind === 'codex' ? 'workspace' : mode;
    case 'default':
    case 'read-only':
      return 'safe';
    default:
      return mode || '';
  }
}

interface DiscoveredModel { id: string; label: string; tier?: string }

const SHARED_PERMISSION_MODES = new Set(['safe', 'workspace', 'full', 'plan']);

export interface EditModelModalProps {
  model: Model;
  onClose: () => void;
  onSave: (name: string, data: Record<string, unknown>) => Promise<void>;
  loading: boolean;
}

export function EditModelModal({ model, onClose, onSave, loading }: EditModelModalProps) {
  const cliAgent = model.metadata?.cliAgent || {};
  const customProvider = model.metadata?.customProvider;
  const [formData, setFormData] = useState({
    endpoint: model.endpoint || '',
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    priority: model.priority,
    supportsVision: model.supportsVision,
    supportsTools: model.supportsTools,
    supportsStreaming: model.supportsStreaming,
    disableThinking: model.metadata?.extraBody?.think === false,
    // Stored as a raw count; the field edits in billions for readability.
    paramCountB: model.metadata?.paramCount ? String(model.metadata.paramCount / 1_000_000_000) : '',
    costPerInputToken: model.costPerInputToken,
    costPerOutputToken: model.costPerOutputToken,
    // CLI agent settings
    cliPermissionMode: normalizePermissionMode(cliAgent.permissionMode, fallbackCliKind(model.modelId)),
    cliInheritApiKeys: cliAgent.inheritApiKeys === true,
    cliAllowedTools: (cliAgent.allowedTools || []).join(', '),
    cliMaxBudgetUsd: cliAgent.maxBudgetUsd ?? '',
    cliExtraArgs: (cliAgent.extraArgs || []).join(' '),
    cliModel: cliAgent.model || '',
    // Custom provider settings
    customAuthType: (customProvider?.auth?.type || 'bearer') as 'bearer' | 'header' | 'query',
    customAuthHeaderName: customProvider?.auth?.headerName || '',
    customAuthParamName: customProvider?.auth?.paramName || '',
    customPathOverride: customProvider?.pathOverride || '',
    customApiKeyRef: model.apiKeyRef || '',
  });
  const [error, setError] = useState('');
  const [discoveredCliModels, setDiscoveredCliModels] = useState<DiscoveredModel[]>([]);
  const [cliTools, setCliTools] = useState<CLITool[]>([]);

  const isCli = model.provider === 'cli';
  const isCustomProvider = model.provider.startsWith('custom-');
  const cliTool = isCli ? cliTools.find(tool => toolMatchesModel(tool, model.modelId)) : undefined;
  const cliKind: CliKind = isCli ? cliKindForTool(cliTool, model.modelId) : null;
  // The CLI registry calls this backend "google"; model discovery uses the setup-provider id "gemini".
  const cliProvider = cliTool?.modelProvider === 'google' ? 'gemini' : cliTool?.modelProvider;
  const supportsPlanMode = cliKind !== null && cliKind !== 'codex';
  const supportsClaudeStyleLimits = cliKind === 'claude' || cliKind === 'vibe' || cliKind === 'glm' || cliKind === 'kimi';
  const supportsModelOverride = cliKind !== 'vibe';
  const supportsApiKeyInheritance = cliKind !== 'glm' && cliKind !== 'kimi';
  const preservedNativePermission = formData.cliPermissionMode && !SHARED_PERMISSION_MODES.has(formData.cliPermissionMode)
    ? formData.cliPermissionMode
    : null;

  useEffect(() => {
    if (!isCli) return;
    let cancelled = false;
    void api.get<{ tools?: CLITool[] }>('/models/cli/status')
      .then(res => {
        if (!cancelled && Array.isArray(res?.tools)) setCliTools(res.tools);
      })
      .catch(() => {
        // Fall back to the model-id detector when the registry is unavailable.
      });
    return () => { cancelled = true; };
  }, [isCli]);

  useEffect(() => {
    if (!isCli || !cliProvider || !supportsModelOverride) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ configured: boolean; models?: DiscoveredModel[] }>(
          `/models/providers/${cliProvider}/available`
        );
        if (!cancelled && res?.configured && Array.isArray(res.models)) {
          setDiscoveredCliModels(res.models);
        }
      } catch {
        // No API key configured for the underlying provider — picker stays as a free-text input.
      }
    })();
    return () => { cancelled = true; };
  }, [isCli, cliProvider, supportsModelOverride]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const payload: Record<string, unknown> = {
        endpoint: formData.endpoint || undefined,
        contextWindow: formData.contextWindow,
        maxTokens: formData.maxTokens,
        priority: formData.priority,
        supportsVision: formData.supportsVision,
        supportsTools: formData.supportsTools,
        supportsStreaming: formData.supportsStreaming,
        costPerInputToken: formData.costPerInputToken,
        costPerOutputToken: formData.costPerOutputToken,
      };

      // Include thinking and CLI agent settings in metadata
      if (formData.disableThinking || isCli || isCustomProvider) {
        const existingMeta = model.metadata || {};
        const extraBody = formData.disableThinking
          ? { ...(existingMeta.extraBody || {}), think: false }
          : (() => { const { think, ...rest } = (existingMeta.extraBody || {}); return Object.keys(rest).length ? rest : undefined; })();
        payload.metadata = { ...existingMeta, extraBody };
      }

      if (isCustomProvider) {
        const cp: Record<string, unknown> = {
          auth: {
            type: formData.customAuthType,
            ...(formData.customAuthType === 'header' && formData.customAuthHeaderName
              ? { headerName: formData.customAuthHeaderName }
              : {}),
            ...(formData.customAuthType === 'query' && formData.customAuthParamName
              ? { paramName: formData.customAuthParamName }
              : {}),
          },
        };
        if (formData.customPathOverride) cp.pathOverride = formData.customPathOverride;
        payload.metadata = {
          ...((payload.metadata as Record<string, unknown>) || model.metadata || {}),
          customProvider: cp,
        };
        payload.apiKeyRef = formData.customApiKeyRef || undefined;
      }

      if (isCli) {
        // Keep hidden legacy/forward-compatible settings (notably mcpConfigPath),
        // while replacing every setting this form actually manages.
        const cliAgentConfig: Record<string, unknown> = { ...cliAgent };
        delete cliAgentConfig.permissionMode;
        delete cliAgentConfig.extraArgs;
        if (supportsApiKeyInheritance) {
          delete cliAgentConfig.inheritApiKeys;
          cliAgentConfig.inheritApiKeys = formData.cliInheritApiKeys;
        }
        if (formData.cliPermissionMode) cliAgentConfig.permissionMode = formData.cliPermissionMode;
        if (supportsModelOverride) {
          delete cliAgentConfig.model;
          if (formData.cliModel.trim()) cliAgentConfig.model = formData.cliModel.trim();
        }
        if (supportsClaudeStyleLimits) {
          delete cliAgentConfig.allowedTools;
          delete cliAgentConfig.maxBudgetUsd;
          if (formData.cliAllowedTools.trim()) {
            cliAgentConfig.allowedTools = formData.cliAllowedTools.split(',').map(t => t.trim()).filter(Boolean);
          }
          if (formData.cliMaxBudgetUsd !== '') {
            cliAgentConfig.maxBudgetUsd = Number(formData.cliMaxBudgetUsd);
          }
        }
        if (formData.cliExtraArgs.trim()) {
          const extraArgs = formData.cliExtraArgs.split(/\s+/).filter(Boolean);
          // Same policy the managed run enforces at spawn (and the API at save).
          // Throws a user-facing message; handleSubmit's catch shows it.
          if (cliTool?.adapter) validateScopedExtraArgs(cliTool.adapter, extraArgs);
          cliAgentConfig.extraArgs = extraArgs;
        }

        payload.metadata = {
          ...model.metadata,
          cliAgent: Object.keys(cliAgentConfig).length > 0 ? cliAgentConfig : undefined,
        };
      }

      // Parameter count drives root agent auto-mode selection. Apply it last
      // so none of the provider-specific metadata branches above clobber it,
      // and only send metadata when there's something to persist.
      {
        const billions = Number.parseFloat(formData.paramCountB);
        const base = (payload.metadata as Record<string, unknown> | undefined)
          ?? { ...(model.metadata || {}) };
        if (formData.paramCountB.trim() !== '' && Number.isFinite(billions) && billions > 0) {
          base.paramCount = Math.round(billions * 1_000_000_000);
          payload.metadata = base;
        } else if ('paramCount' in base) {
          // Cleared the field → drop the override so auto-detect resumes.
          delete base.paramCount;
          payload.metadata = base;
        }
      }

      await onSave(model.name, payload);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Portal>
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="animate-enter bg-surface-container rounded-xs shadow-xl border border-outline-variant/10 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/10">
          <div>
            <h2 className="text-lg font-semibold text-on-surface">Edit Model</h2>
            <p className="text-sm text-on-surface-variant">{model.name} <span className="font-mono text-xs">({model.provider}/{model.modelId})</span></p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-surface-container-high rounded cursor-pointer">
            <X className="w-5 h-5 text-on-surface-variant" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {model.provider !== 'cli' && (
            <div>
              <label className="block text-sm font-medium text-on-surface-variant mb-1">Endpoint URL</label>
              <input
                type="text"
                value={formData.endpoint}
                onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                placeholder="Leave empty for default"
                className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface font-mono text-sm"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-on-surface-variant mb-1">Context Window</label>
              <input
                type="number"
                value={formData.contextWindow}
                onChange={(e) => setFormData({ ...formData, contextWindow: parseInt(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-on-surface-variant mb-1">Max Output Tokens</label>
              <input
                type="number"
                value={formData.maxTokens}
                onChange={(e) => setFormData({ ...formData, maxTokens: parseInt(e.target.value) || 0 })}
                title="Maximum tokens this model can generate per API call"
                className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface"
              />
              <p className="text-xs text-on-surface-variant mt-0.5">Bump higher if responses are getting truncated (e.g. thinking models burn tokens before replying).</p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-on-surface-variant mb-1">Parameter Count (billions)</label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={formData.paramCountB}
              onChange={(e) => setFormData({ ...formData, paramCountB: e.target.value })}
              placeholder="e.g. 128 for a 128B model"
              title="Used to auto-select the rootAgent mode when Root agent > Mode is 'auto'"
              className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface"
            />
            <p className="text-xs text-on-surface-variant mt-0.5">
              Drives the rootAgent mode (router/lite/full) when mode is <code className="bg-surface-container-high px-1 rounded">auto</code>.
              External model IDs without a size tag (e.g. <code className="bg-surface-container-high px-1 rounded">deepseek-v4-flash</code>) default to <strong>lite</strong> until set here. Leave empty to infer from the model ID.
            </p>
          </div>

          {model.provider !== 'cli' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Cost/1M Input Tokens</label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.costPerInputToken}
                  onChange={(e) => setFormData({ ...formData, costPerInputToken: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Cost/1M Output Tokens</label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.costPerOutputToken}
                  onChange={(e) => setFormData({ ...formData, costPerOutputToken: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface"
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
                className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary"
              />
              <span className="text-sm text-on-surface-variant">Vision</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.supportsTools}
                onChange={(e) => setFormData({ ...formData, supportsTools: e.target.checked })}
                className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary"
              />
              <span className="text-sm text-on-surface-variant">Tools</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.supportsStreaming}
                onChange={(e) => setFormData({ ...formData, supportsStreaming: e.target.checked })}
                className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary"
              />
              <span className="text-sm text-on-surface-variant">Streaming</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer" title="Disable reasoning/thinking tokens (e.g. for Qwen3, DeepSeek). Sends think:false to Ollama.">
              <input
                type="checkbox"
                checked={formData.disableThinking}
                onChange={(e) => setFormData({ ...formData, disableThinking: e.target.checked })}
                className="w-4 h-4 rounded border-outline-variant text-primary focus:ring-primary"
              />
              <span className="text-sm text-on-surface-variant">Disable Thinking</span>
            </label>
          </div>

          {/* Custom Provider Settings */}
          {isCustomProvider && (
            <div className="border border-outline-variant/20 rounded-lg p-4 space-y-3 bg-surface-container">
              <h3 className="text-sm font-semibold text-on-surface">
                {model.provider === 'custom-openai' ? 'OpenAI-compatible Settings'
                  : model.provider === 'custom-anthropic' ? 'Anthropic-compatible Settings'
                  : 'Gemini-compatible Settings'}
              </h3>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-on-surface-variant mb-1">Auth Scheme</label>
                  <select
                    value={formData.customAuthType}
                    onChange={(e) => setFormData({ ...formData, customAuthType: e.target.value as 'bearer' | 'header' | 'query' })}
                    className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface text-sm"
                  >
                    <option value="bearer">Bearer token</option>
                    <option value="header">Custom header</option>
                    <option value="query">Query parameter</option>
                  </select>
                </div>
                {formData.customAuthType === 'header' && (
                  <div>
                    <label className="block text-xs font-medium text-on-surface-variant mb-1">Header Name *</label>
                    <input
                      type="text"
                      value={formData.customAuthHeaderName}
                      onChange={(e) => setFormData({ ...formData, customAuthHeaderName: e.target.value })}
                      placeholder="x-api-key"
                      className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface font-mono text-sm"
                    />
                  </div>
                )}
                {formData.customAuthType === 'query' && (
                  <div>
                    <label className="block text-xs font-medium text-on-surface-variant mb-1">Query Param Name *</label>
                    <input
                      type="text"
                      value={formData.customAuthParamName}
                      onChange={(e) => setFormData({ ...formData, customAuthParamName: e.target.value })}
                      placeholder="key"
                      className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface font-mono text-sm"
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1">Path Override (optional)</label>
                <input
                  type="text"
                  value={formData.customPathOverride}
                  onChange={(e) => setFormData({ ...formData, customPathOverride: e.target.value })}
                  placeholder={
                    model.provider === 'custom-openai' ? '/v1/chat/completions (default)'
                    : model.provider === 'custom-anthropic' ? '/v1/messages (default)'
                    : '/v1beta/models/{model}:generateContent (default)'
                  }
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface font-mono text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-on-surface-variant mb-1">API Key Reference</label>
                <input
                  type="text"
                  value={formData.customApiKeyRef}
                  onChange={(e) => setFormData({ ...formData, customApiKeyRef: e.target.value })}
                  placeholder="vault entry name, or env:MY_API_KEY"
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface font-mono text-sm"
                />
                <p className="text-xs text-on-surface-variant mt-1">
                  Use <code className="bg-surface-container-high px-1 rounded">env:VAR_NAME</code> for an env var, or a vault entry name.
                </p>
              </div>
            </div>
          )}

          {/* CLI Agent Settings */}
          {isCli && (
            <div className="border border-accent/20 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <Terminal className="w-4 h-4 text-accent" />
                <h3 className="text-sm font-semibold text-accent">CLI Agent Settings</h3>
              </div>
              <p className="text-xs text-on-surface-variant">
                CLI models run as autonomous sub-agents with their own tools and agent loop.
              </p>
              <p className="text-xs text-on-surface-variant">
                {cliTool?.capabilities ?? 'Capabilities are shown once the CLI is detected on this server.'}
              </p>
              <p className="text-xs text-on-surface-variant">
                Octipus configures the scoped tool bridge for each run; no MCP config path is needed here.
              </p>

              {supportsModelOverride ? <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">
                  Model {cliTool ? `(${cliTool.name})` : cliKind ? `(${cliKind})` : ''}
                </label>
                <input
                  type="text"
                  list={cliKind ? `cli-models-${cliKind}` : undefined}
                  value={formData.cliModel}
                  onChange={(e) => setFormData({ ...formData, cliModel: e.target.value })}
                  placeholder="(vendor default)"
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface font-mono text-sm"
                />
                {discoveredCliModels.length > 0 && cliKind && (
                  <datalist id={`cli-models-${cliKind}`}>
                    {discoveredCliModels.map(m => (
                      <option key={m.id} value={m.id}>{m.label}{m.tier ? ` · ${m.tier}` : ''}</option>
                    ))}
                  </datalist>
                )}
                <p className="text-xs text-on-surface-variant mt-1">
                  Pass-through to the CLI binary. Leave empty to use the vendor default.
                </p>
              </div> : (
                <p className="text-xs text-on-surface-variant">
                  Vibe uses the active model from its own configuration.
                </p>
              )}

              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Permission Mode</label>
                <select
                  value={formData.cliPermissionMode}
                  onChange={(e) => setFormData({ ...formData, cliPermissionMode: e.target.value })}
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface text-sm"
                >
                  <option value="">Adapter default</option>
                  <option value="safe">Safe</option>
                  <option value="workspace">Workspace edits</option>
                  <option value="full">Full access</option>
                  {supportsPlanMode && <option value="plan">Plan only</option>}
                  {preservedNativePermission && (
                    <option value={preservedNativePermission} disabled>
                      Current native setting: {preservedNativePermission}
                    </option>
                  )}
                </select>
                <p className="text-xs text-on-surface-variant mt-1">
                  Octipus translates this level to the CLI&apos;s native permission controls.
                </p>
              </div>

              {supportsApiKeyInheritance ? (
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.cliInheritApiKeys}
                    onChange={(e) => setFormData({ ...formData, cliInheritApiKeys: e.target.checked })}
                    className="w-4 h-4 mt-0.5 rounded border-outline-variant text-primary focus:ring-primary"
                  />
                  <span className="text-sm text-on-surface-variant">
                    Pass server API keys to this CLI
                    <span className="block text-xs mt-0.5">
                      Off uses the CLI&apos;s existing login and configuration. Enabling this can use separately billed API credentials.
                    </span>
                  </span>
                </label>
              ) : (
                <p className="text-xs text-on-surface-variant">
                  This adapter uses its dedicated {cliKind === 'glm' ? 'z.ai' : 'Moonshot'} credential configured on the Octipus server; API-key inheritance does not apply.
                </p>
              )}

              {supportsClaudeStyleLimits && (
                <div>
                  <label className="block text-sm font-medium text-on-surface-variant mb-1">
                    Max Budget (USD per invocation)
                  </label>
                  <input
                    type="number"
                    step="0.10"
                    min="0"
                    value={formData.cliMaxBudgetUsd}
                    onChange={(e) => setFormData({ ...formData, cliMaxBudgetUsd: e.target.value })}
                    placeholder="No limit"
                    className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface text-sm"
                  />
                  <p className="text-xs text-on-surface-variant mt-1">Leave empty for no per-invocation price limit.</p>
                </div>
              )}

              {supportsClaudeStyleLimits && (
                <div>
                  <label className="block text-sm font-medium text-on-surface-variant mb-1">Allowed Tools</label>
                  <input
                    type="text"
                    value={formData.cliAllowedTools}
                    onChange={(e) => setFormData({ ...formData, cliAllowedTools: e.target.value })}
                    placeholder="Bash, Read, Edit, WebSearch"
                    className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface text-sm"
                  />
                  <p className="text-xs text-on-surface-variant mt-1">Comma-separated. Empty allows the CLI&apos;s default tools.</p>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-on-surface-variant mb-1">Extra CLI Arguments</label>
                <input
                  type="text"
                  value={formData.cliExtraArgs}
                  onChange={(e) => setFormData({ ...formData, cliExtraArgs: e.target.value })}
                  placeholder="Leave empty"
                  className="w-full px-3 py-2 border border-outline-variant/10 rounded-lg bg-surface-container-high text-on-surface font-mono text-sm"
                />
                <p className="text-xs text-on-surface-variant mt-1">
                  Only adapter-supported additive flags are accepted. Octipus manages model, permission, bridge, run-limit, and I/O flags.
                </p>
              </div>
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
              className="flex-1 px-4 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary cursor-pointer rounded-full hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
            >
              {loading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
    </Portal>
  );
}
