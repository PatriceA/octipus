'use client';

import { ExternalLink, Info, Plus, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { CliModelPicker } from './cli-model-picker';
import { PROVIDER_DEFAULTS, type CLITool, type Model } from '@/lib/types/models';

export interface CLIStatusPanelProps {
  tools: CLITool[];
  registeredModels: Model[];
  onAdd: (model: Record<string, unknown>) => Promise<void>;
  onUpdate?: (id: string, patch: Record<string, unknown>) => Promise<void>;
}

interface DiscoveredModel {
  id: string;
  label: string;
  tier?: string;
}

export function CLIStatusPanel({ tools, registeredModels, onAdd, onUpdate }: CLIStatusPanelProps) {
  const [adding, setAdding] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<Record<string, DiscoveredModel[]>>({});

  // Fetch the curated model list for each CLI's underlying provider once on mount.
  useEffect(() => {
    const providersToLoad: string[] = Array.from(
      new Set(tools.filter(t => !t.models).map(t => t.modelProvider).filter((p): p is NonNullable<typeof p> => !!p))
    );
    providersToLoad.forEach(async (provider: string) => {
      try {
        const res = await api.get<{ configured: boolean; models?: DiscoveredModel[] }>(
          `/models/providers/${provider}/available`
        );
        if (res?.configured && Array.isArray(res.models)) {
          setDiscovered(prev => ({ ...prev, [provider]: res.models! }));
        }
      } catch {
        // Provider not configured — picker stays empty, user uses CLI default.
      }
    });
  }, [tools]);

  // Early return must come AFTER all hooks (rules-of-hooks).
  if (tools.length === 0) return null;

  const findRegistered = (tool: CLITool): Model | undefined =>
    registeredModels.find(m => m.provider === 'cli' && tool.modelPatterns.includes(m.modelId));

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
        // Muse Code: the model catalog's limits; images reach it via --image (verified).
        ...(tool.modelProvider === 'meta' ? { contextWindow: PROVIDER_DEFAULTS.meta.contextWindow, maxTokens: PROVIDER_DEFAULTS.meta.maxTokens, supportsVision: true } : {}),
        topics: ['coding', 'review'],
        priority: 80,
        costPerInputToken: 0,
        costPerOutputToken: 0,
      });
    } finally {
      setAdding(null);
    }
  };

  const handleModelChange = async (tool: CLITool, model: Model | undefined, value: string) => {
    if (!model || !onUpdate) return;
    const next = {
      metadata: {
        ...(model.metadata || {}),
        cliAgent: {
          ...((model.metadata?.cliAgent as Record<string, unknown>) || {}),
          model: value || undefined,
        },
      },
    };
    await onUpdate(model.id, next);
  };

  const billingBadge = (mode: string) => {
    const cls = mode === 'subscription'
      ? 'bg-tertiary-container/40 text-tertiary border border-tertiary/60'
      : mode === 'api-key'
        ? 'bg-warning-container/40 text-warning border border-warning/60'
        : 'bg-primary/10 text-primary';
    const label = mode === 'subscription' ? 'Subscription' : mode === 'api-key' ? 'API key' : 'Mixed';
    return <span className={`text-[10px] px-2 py-0.5 rounded ${cls}`}>{label}</span>;
  };

  return (
    <div className="bg-surface-container rounded-xs border border-outline-variant/10 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Terminal className="w-5 h-5 text-primary" />
        <h2 className="font-semibold text-on-surface">Detected CLI Tools</h2>
      </div>
      <p className="text-xs text-on-surface-variant mb-3">
        These vendor CLIs were detected on your system. Billing and quota are vendor-managed —
        provider permission, subscription coverage and extra charges are provider decisions. Octipus uses the CLI’s existing login/configuration.
        Quota badges show blocks recorded by Octipus, not live remaining subscription allowance.
        See <a className="underline" href="/docs/features/cli-providers/" target="_blank" rel="noreferrer">CLI Providers docs</a>.
      </p>
      <div className="space-y-3">
        {tools.map(tool => {
          const registered = findRegistered(tool);
          const provider = tool.modelProvider;
          const options = tool.models ?? (provider ? discovered[provider] || [] : []);
          const currentModel = (registered?.metadata?.cliAgent as { model?: string } | undefined)?.model || '';

          return (
            <div key={tool.name} className="space-y-2 border-b border-outline-variant/5 pb-3 last:border-0 last:pb-0">
              {tool.modelCatalogError && <p className="text-xs text-warning">{tool.modelCatalogError}</p>}
              {tool.planUsage && <div className="text-xs text-on-surface-variant">
                {tool.planUsage.error ? <span>{tool.planUsage.error}</span> : tool.planUsage.windows.map(window => (
                  <span key={window.label} className={`mr-3 ${window.usedPercent >= 100 ? 'text-error' : ''}`} title={window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString()}` : undefined}>
                    {window.label}: {Math.round(window.usedPercent)}% used
                  </span>
                ))}
              </div>}
              {tool.capabilities && <p className="text-xs text-on-surface-variant">{tool.capabilities}</p>}
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`dot shrink-0 ${
                    !tool.available ? 'dot-idle' : registered ? 'dot-ok' : 'dot-warn'
                  }`} />
                  <span className="text-on-surface truncate">{tool.name}</span>
                  {tool.billingInfo && billingBadge(tool.billingInfo.billingMode)}
                  {!tool.available && (
                    <span className="text-xs text-on-surface-variant">(not installed)</span>
                  )}
                  {tool.available && !registered && (
                    <span className="text-xs text-warning">(detected, not registered)</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {tool.quota && registered && (tool.quota.exhausted || !tool.planUsage?.windows.length) && (
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      tool.quota.exhausted ? 'bg-error/10 text-error' : 'bg-surface-container-high text-on-surface-variant'
                    }`}>
                      {tool.quota.exhausted ? 'Quota Exhausted' : 'No recorded quota block'}
                    </span>
                  )}
                  {tool.available && !registered && (
                    <button
                      onClick={() => handleQuickAdd(tool)}
                      disabled={adding === tool.name}
                      className="text-xs px-2 py-1 bg-primary text-on-primary rounded-full hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      {adding === tool.name ? 'Adding...' : 'Add'}
                    </button>
                  )}
                </div>
              </div>

              {tool.available && registered && (
                <div className="flex items-center gap-2 pl-4 text-xs">
                  <span className="text-on-surface-variant shrink-0">Model:</span>
                  <CliModelPicker
                    label={`Model for ${tool.name}`}
                    value={currentModel}
                    onChange={value => void handleModelChange(tool, registered, value)}
                    models={options}
                    disabled={!onUpdate}
                    commitCustomOnBlur
                    className="bg-surface-container-low border border-outline-variant/20 rounded px-2 py-1 text-on-surface text-xs w-full max-w-xs"
                  />
                  {tool.modelFlag && (
                    <span className="text-[10px] text-on-surface-variant font-mono">→ {tool.modelFlag}</span>
                  )}
                  {options.length === 0 && provider && (
                    <span className="text-[10px] text-on-surface-variant">
                      (catalog unavailable — use the default or enter a custom model ID)
                    </span>
                  )}
                </div>
              )}

              {tool.billingInfo && (
                <div className="pl-4 text-[11px] text-on-surface-variant flex items-start gap-1.5">
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>
                    {tool.billingInfo.planNote}.{' '}
                    <a
                      href={tool.billingInfo.pricingDocUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline inline-flex items-center gap-0.5"
                    >
                      Pricing <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                    {' · '}
                    <a
                      href={tool.billingInfo.modelsDocUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline inline-flex items-center gap-0.5"
                    >
                      Models <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
