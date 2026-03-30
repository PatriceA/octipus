'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, Cpu, Bot, Server } from 'lucide-react';
import { api } from '@/lib/api';
import {
  type SettingItem,
  useSettingActions,
  SettingsGroup,
  SecretsRedirectBanner,
} from './setting-field';

/** Categories that belong on the Configuration tab (server/runtime settings only) */
const SERVER_CATEGORIES = new Set([
  'litellm',
  'ollama',
  'agent',
  'orchestrator',
  'api',
  'logging',
  'voice',
  'security',
]);

/** Visual grouping of categories into sections */
const SECTIONS = [
  {
    id: 'llm',
    title: 'LLM & Models',
    description: 'Model proxy and inference settings',
    icon: Cpu,
    subsections: [
      { category: 'litellm', label: 'LiteLLM Proxy' },
      { category: 'ollama', label: 'Ollama' },
    ],
  },
  {
    id: 'agent',
    title: 'Agent & Orchestrator',
    description: 'Agent execution limits and pipeline configuration',
    icon: Bot,
    subsections: [
      { category: 'agent', label: 'Agent' },
      { category: 'orchestrator', label: 'Orchestrator' },
    ],
  },
  {
    id: 'server',
    title: 'Server',
    description: 'API, logging, voice, and session settings',
    icon: Server,
    subsections: [
      { category: 'api', label: 'API' },
      { category: 'logging', label: 'Logging' },
      { category: 'voice', label: 'Voice' },
      { category: 'security', label: 'Security' },
    ],
  },
];

export function ConfigurationTab() {
  const { saving, saved, error, handleSave, handleReset } = useSettingActions();

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: Record<string, SettingItem[]>; categories: string[] }>('/settings'),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
      </div>
    );
  }

  const allSettings = data?.settings || {};

  // Filter: only server categories, exclude secret fields
  const getFilteredSettings = (category: string): SettingItem[] => {
    if (!SERVER_CATEGORIES.has(category)) return [];
    return (allSettings[category] || []).filter(s => !s.isSecret);
  };

  // Check if any secret exists across server categories
  const hasSecrets = Object.entries(allSettings)
    .filter(([cat]) => SERVER_CATEGORIES.has(cat))
    .some(([, items]) => items.some(s => s.isSecret));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-extrabold tracking-tighter text-white">System Configuration</h2>
        <p className="text-sm text-on-surface-variant mt-1">
          Runtime settings. Changes take effect immediately without restart.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-error-dim/10 border border-error-dim/20 rounded-lg">
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {hasSecrets && <SecretsRedirectBanner />}

      {SECTIONS.map((section) => {
        // Only render section if it has at least one setting
        const hasSettings = section.subsections.some(
          sub => getFilteredSettings(sub.category).length > 0
        );
        if (!hasSettings) return null;

        return (
          <div
            key={section.id}
            className="bg-[#131313] rounded-[1rem] overflow-hidden"
          >
            {/* Section header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-outline-variant/10">
              <section.icon className="w-5 h-5 text-on-surface-variant" />
              <div>
                <h3 className="text-base font-semibold text-white">{section.title}</h3>
                <p className="text-xs text-on-surface-variant">{section.description}</p>
              </div>
            </div>

            {/* Subsections */}
            <div className="divide-y divide-outline-variant/10">
              {section.subsections.map((sub) => {
                const items = getFilteredSettings(sub.category);
                if (items.length === 0) return null;

                return (
                  <div key={sub.category} className="px-5 py-4">
                    <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-1">
                      {sub.label}
                    </h4>
                    <SettingsGroup
                      settings={items}
                      onSave={handleSave}
                      onReset={handleReset}
                      saving={saving}
                      saved={saved}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
