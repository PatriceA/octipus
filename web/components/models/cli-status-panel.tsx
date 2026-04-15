'use client';

import { useState } from 'react';
import { Terminal, Plus } from 'lucide-react';
import { type Model, type CLITool } from '@/lib/types/models';

export interface CLIStatusPanelProps {
  tools: CLITool[];
  registeredModels: Model[];
  onAdd: (model: Record<string, unknown>) => Promise<void>;
}

export function CLIStatusPanel({ tools, registeredModels, onAdd }: CLIStatusPanelProps) {
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
        topics: ['coding', 'review'],
        priority: 80,
        costPerInputToken: 0,
        costPerOutputToken: 0,
      });
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="bg-surface-container rounded-[1rem] border border-outline-variant/10 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Terminal className="w-5 h-5 text-violet-400" />
        <h2 className="font-semibold text-white">Detected CLI Tools</h2>
      </div>
      <p className="text-xs text-on-surface-variant mb-3">
        These CLI subscription tools were detected on your system. Add them to use as models.
      </p>
      <div className="space-y-2">
        {tools.map(tool => {
          const registered = isRegistered(tool);
          return (
            <div key={tool.name} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${
                  !tool.available ? 'bg-on-surface-variant' : registered ? 'bg-emerald-400' : 'bg-yellow-400'
                }`} />
                <span className="text-white">{tool.name}</span>
                {!tool.available && (
                  <span className="text-xs text-on-surface-variant">(not installed)</span>
                )}
                {tool.available && !registered && (
                  <span className="text-xs text-yellow-400">(detected, not registered)</span>
                )}
                {tool.available && registered && (
                  <span className="text-xs text-emerald-400">(active)</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {tool.quota && registered && (
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    tool.quota.exhausted
                      ? 'bg-error/10 text-error'
                      : 'bg-emerald-500/10 text-emerald-400'
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
          );
        })}
      </div>
    </div>
  );
}
