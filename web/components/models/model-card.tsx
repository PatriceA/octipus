'use client';

import { AlertCircle, CheckCircle, Cpu, Pencil, Star, Terminal, Trash2, XCircle } from 'lucide-react';
import type { Model } from '@/lib/types/models';

export interface ModelCardProps {
  model: Model;
  onSetDefault: (name: string) => void;
  onEdit: (model: Model) => void;
  onToggleEnabled: (model: Model) => void;
  onDelete: (name: string) => void;
}

function HealthBadge({ health }: { health?: Model['health'] }) {
  const config = {
    healthy: { color: 'text-tertiary', icon: CheckCircle, label: 'Healthy' },
    unhealthy: { color: 'text-error', icon: XCircle, label: 'Unhealthy' },
    unknown: { color: 'text-on-surface-variant', icon: AlertCircle, label: 'Unknown' },
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
    ollama: 'bg-tertiary-container/40 text-tertiary border border-tertiary/60',
    openai: 'bg-tertiary/10 text-tertiary',
    anthropic: 'bg-orange-500/10 text-warning',
    gemini: 'bg-primary/10 text-primary',
    deepseek: 'bg-teal-500/10 text-tertiary',
    cli: 'bg-violet-500/10 text-primary',
    openrouter: 'bg-primary/10 text-primary',
    custom: 'bg-surface-container-high text-on-surface-variant',
  };

  return (
    <span className={`px-2 py-0.5 text-xs rounded-full font-medium ${colors[provider] || colors.custom}`}>
      {provider}
    </span>
  );
}

export { HealthBadge, ProviderBadge };

export function ModelCard({ model, onSetDefault, onEdit, onToggleEnabled, onDelete }: ModelCardProps) {
  return (
    <div
      className={`bg-surface-container rounded-xs border ${
        model.isEnabled
          ? 'border-outline-variant/10'
          : 'border-outline-variant/10 opacity-60'
      } p-4 relative group`}
    >
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {!model.isDefault && (
          <button
            onClick={() => onSetDefault(model.name)}
            className="p-1.5 text-on-surface-variant hover:text-warning hover:bg-warning/10 rounded cursor-pointer"
            title="Set as default"
          >
            <Star className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={() => onEdit(model)}
          className="p-1.5 text-on-surface-variant hover:text-primary hover:bg-primary/10 rounded cursor-pointer"
          title="Edit model"
        >
          <Pencil className="w-4 h-4" />
        </button>
        <button
          onClick={() => onToggleEnabled(model)}
          className="p-1.5 text-on-surface-variant hover:text-warning hover:bg-warning/10 rounded cursor-pointer"
          title={model.isEnabled ? 'Disable' : 'Enable'}
        >
          {model.isEnabled ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <XCircle className="w-4 h-4" />
          )}
        </button>
        <button
          onClick={() => onDelete(model.name)}
          className="p-1.5 text-on-surface-variant hover:text-error hover:bg-error/10 rounded cursor-pointer"
          title="Delete model"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      <div className="mb-3 pr-20">
        <div className="flex items-center gap-2">
          {model.provider === 'cli' ? (
            <Terminal className="w-5 h-5 text-primary" />
          ) : (
            <Cpu className="w-5 h-5 text-primary" />
          )}
          <h3 className="font-semibold text-on-surface">{model.name}</h3>
          {model.isDefault && (
            <span className="px-2 py-0.5 bg-primary/10 text-primary text-xs rounded-full flex items-center gap-1 shrink-0">
              <Star className="w-3 h-3" /> Default
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between items-center">
          <span className="text-on-surface-variant">Provider</span>
          <ProviderBadge provider={model.provider} />
        </div>
        <div className="flex justify-between">
          <span className="text-on-surface-variant">Model ID</span>
          <span className="text-on-surface font-mono text-xs">{model.modelId}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-on-surface-variant">Context</span>
          <span className="text-on-surface">{(model.contextWindow / 1000).toFixed(0)}k</span>
        </div>
        {model.costPerInputToken > 0 && (
          <div className="flex justify-between">
            <span className="text-on-surface-variant">Cost (in/out)</span>
            <span className="text-on-surface text-xs">
              ${model.costPerInputToken}/${model.costPerOutputToken} /1M
            </span>
          </div>
        )}
        {model.provider === 'cli' && (
          <div className="flex justify-between">
            <span className="text-on-surface-variant">Cost</span>
            <span className="text-tertiary text-xs font-medium">Subscription/Provider pricing</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-on-surface-variant">Priority</span>
          <span className="text-on-surface">{model.priority}</span>
        </div>
        {model.metadata?.paramCount ? (
          <div className="flex justify-between">
            <span className="text-on-surface-variant">Params</span>
            <span className="text-on-surface">{(model.metadata.paramCount / 1_000_000_000).toFixed(0)}B</span>
          </div>
        ) : null}
      </div>

      <div className="mt-3 pt-3 border-t border-outline-variant/10 flex flex-wrap gap-1.5">
        {model.supportsVision && (
          <span className="px-2 py-0.5 bg-primary/10 text-primary text-xs rounded">Vision</span>
        )}
        {model.supportsTools && (
          <span className="px-2 py-0.5 bg-primary/10 text-primary text-xs rounded">Tools</span>
        )}
        {model.supportsStreaming && (
          <span className="px-2 py-0.5 bg-primary/10 text-primary text-xs rounded">Stream</span>
        )}
        {model.provider === 'cli' && (
          <span className="px-2 py-0.5 bg-violet-500/10 text-primary text-xs rounded">Sub-Agent</span>
        )}
      </div>

      {model.topics && model.topics.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {model.topics.map((topic) => (
            <span key={topic} className="px-2 py-0.5 bg-surface-container-high text-on-surface-variant text-xs rounded">
              {topic}
            </span>
          ))}
        </div>
      )}

      {model.metadata?.description && (
        <p className="mt-2 text-xs text-on-surface-variant">{model.metadata.description}</p>
      )}
    </div>
  );
}
