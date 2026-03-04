'use client';

import { CheckCircle, XCircle, AlertCircle, Trash2, Star, Terminal, Pencil, Cpu } from 'lucide-react';
import { type Model } from '@/lib/types/models';

export interface ModelCardProps {
  model: Model;
  onSetDefault: (name: string) => void;
  onEdit: (model: Model) => void;
  onToggleEnabled: (model: Model) => void;
  onDelete: (name: string) => void;
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

export { HealthBadge, ProviderBadge };

export function ModelCard({ model, onSetDefault, onEdit, onToggleEnabled, onDelete }: ModelCardProps) {
  return (
    <div
      className={`bg-white dark:bg-gray-800/90 rounded-xl shadow-sm ring-1 ${
        model.isEnabled
          ? 'ring-gray-200/60 dark:ring-gray-700/60'
          : 'ring-gray-200/60 dark:ring-gray-700/60 opacity-60'
      } p-4 relative group`}
    >
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {!model.isDefault && (
          <button
            onClick={() => onSetDefault(model.name)}
            className="p-1.5 text-gray-500 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded cursor-pointer"
            title="Set as default"
          >
            <Star className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={() => onEdit(model)}
          className="p-1.5 text-gray-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded cursor-pointer"
          title="Edit model"
        >
          <Pencil className="w-4 h-4" />
        </button>
        <button
          onClick={() => onToggleEnabled(model)}
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
          onClick={() => onDelete(model.name)}
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
  );
}
