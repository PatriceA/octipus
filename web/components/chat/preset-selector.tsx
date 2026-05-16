'use client';

import { BarChart3, Bot, Code, Eye, FileText, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Preset {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  role: string;
}

interface PresetSelectorProps {
  selectedPresetId: string | null;
  onSelect: (presetId: string | null) => void;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  search: <Search className="w-3 h-3" />,
  code: <Code className="w-3 h-3" />,
  eye: <Eye className="w-3 h-3" />,
  'file-text': <FileText className="w-3 h-3" />,
  'bar-chart': <BarChart3 className="w-3 h-3" />,
  bot: <Bot className="w-3 h-3" />,
};

export function PresetSelector({ selectedPresetId, onSelect }: PresetSelectorProps) {
  const [presets, setPresets] = useState<Preset[]>([]);

  useEffect(() => {
    api.get<{ presets: Preset[] }>('/presets')
      .then((data) => {
        if (data?.presets) setPresets(data.presets);
      })
      .catch(() => {});
  }, []);

  if (presets.length === 0) return null;

  return (
    <div className="flex items-center gap-1 flex-wrap font-mono">
      {presets.map((preset) => {
        const active = selectedPresetId === preset.id;
        return (
          <button
            key={preset.id}
            onClick={() => onSelect(active ? null : preset.id)}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-xs text-[11px] border transition-colors cursor-pointer',
              active
                ? 'bg-primary-container/40 border-primary text-primary'
                : 'border-outline-variant/60 text-on-surface-variant hover:text-on-surface hover:border-outline',
            )}
            title={preset.description || preset.name}
          >
            {preset.icon && ICON_MAP[preset.icon] ? ICON_MAP[preset.icon] : null}
            {preset.name}
          </button>
        );
      })}
    </div>
  );
}
