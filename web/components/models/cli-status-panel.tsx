'use client';

import { ExternalLink, Info, Plus, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { CLITool, Model } from '@/lib/types/models';

export interface CLIStatusPanelProps {
  tools: CLITool[];
  registeredModels: Model[];
  onAdd: (model: Record<string, unknown>) => Promise<void>;
  onUpdate?: (id: string, patch: Record<string, unknown>) => Promise<void>;
}

interface DiscoveredModel {
  id: string;
  label: string;
  tier: string;
}

export function CLIStatusPanel({ tools, registeredModels, onAdd, onUpdate }: CLIStatusPanelProps) {
  if (tools.length === 0) return null;

  const [adding, setAdding] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<Record<string, DiscoveredModel[]>>({});

  // Fetch the curated model list for each CLI's underlying provider once on mount.
  useEffect(() => {
    const providersToLoad: string[] = Array.from(
      new Set(tools.map(t => t.modelProvider).filter((p): p is NonNullable<typeof p> => !!p))
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
      ? 'bg-emerald-500/10 text-emerald-400'
      : mode === 'api-key'
        ? 'bg-amber-500/10 text-amber-400'
        : 'bg-sky-500/10 text-sky-400';
    const label = mode === 'subscription' ? 'Subscription' : mode === 'api-key' ? 'API key' : 'Mixed';
    return <span className={`text-[10px] px-2 py-0.5 rounded ${cls}`}>{label}</span>;
  };

  return (
    <div className="bg-surface-container rounded-[1rem] border border-outline-variant/10 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Terminal className="w-5 h-5 text-violet-400" />
        <h2 className="font-semibold text-white">Detected CLI Tools</h2>
      </div>
      <p className="text-xs text-on-surface-variant mb-3">
        These vendor CLIs were detected on your system. Billing and quota are vendor-managed —
        see <a className="underline" href="/docs/features/cli-providers/" target="_blank" rel="noreferrer">CLI Providers docs</a>.
      </p>
      <div className="space-y-3">
        {tools.map(tool => {
          const registered = findRegistered(tool);
          const provider = tool.modelProvider;
          const options = provider ? discovered[provider] || [] : [];
          const currentModel = (registered?.metadata?.cliAgent as { model?: string } | undefined)?.model || '';

          return (
            <div key={tool.name} className="space-y-2 border-b border-outline-variant/5 pb-3 last:border-0 last:pb-0">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    !tool.available ? 'bg-on-surface-variant' : registered ? 'bg-emerald-400' : 'bg-yellow-400'
                  }`} />
                  <span className="text-white truncate">{tool.name}</span>
                  {tool.billingInfo && billingBadge(tool.billingInfo.billingMode)}
                  {!tool.available && (
                    <span className="text-xs text-on-surface-variant">(not installed)</span>
                  )}
                  {tool.available && !registered && (
                    <span className="text-xs text-yellow-400">(detected, not registered)</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {tool.quota && registered && (
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      tool.quota.exhausted ? 'bg-error/10 text-error' : 'bg-emerald-500/10 text-emerald-400'
                    }`}>
                      {tool.quota.exhausted ? 'Quota Exhausted' : 'Quota OK'}
                    </span>
                  )}
                  {tool.available && !registered && (
                    <button
                      onClick={() => handleQuickAdd(tool)}
                      disabled={adding === tool.name}
                      className="text-xs px-2 py-1 bg-violet-600 text-white rounded-full hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      {adding === tool.name ? 'Adding...' : 'Add'}
                    </button>
                  )}
                </div>
              </div>

              {tool.available && registered && (
                <div className="flex items-center gap-2 pl-4 text-xs">
                  <label className="text-on-surface-variant shrink-0">Model:</label>
                  <select
                    value={currentModel}
                    onChange={(e) => handleModelChange(tool, registered, e.target.value)}
                    disabled={!onUpdate || options.length === 0}
                    className="bg-surface-container-low border border-outline-variant/20 rounded px-2 py-1 text-white text-xs flex-1 max-w-xs"
                  >
                    <option value="">(vendor default)</option>
                    {options.map(opt => (
                      <option key={opt.id} value={opt.id}>
                        {opt.label} {opt.tier ? `· ${opt.tier}` : ''}
                      </option>
                    ))}
                  </select>
                  {tool.modelFlag && (
                    <span className="text-[10px] text-on-surface-variant font-mono">→ {tool.modelFlag}</span>
                  )}
                  {options.length === 0 && provider && (
                    <span className="text-[10px] text-on-surface-variant">
                      (configure {provider} API key for picker)
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
