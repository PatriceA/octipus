'use client';

import { useState, useEffect } from 'react';
import { Search, Code, Eye, FileText, BarChart3, Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';

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
  search: <Search className="w-3.5 h-3.5" />,
  code: <Code className="w-3.5 h-3.5" />,
  eye: <Eye className="w-3.5 h-3.5" />,
  'file-text': <FileText className="w-3.5 h-3.5" />,
  'bar-chart': <BarChart3 className="w-3.5 h-3.5" />,
  bot: <Bot className="w-3.5 h-3.5" />,
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
    <div className="flex items-center gap-1.5 flex-wrap">
      {presets.map((preset) => (
        <button
          key={preset.id}
          onClick={() => onSelect(selectedPresetId === preset.id ? null : preset.id)}
          className={cn(
            'flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
            selectedPresetId === preset.id
              ? 'bg-primary-800 text-white'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
          )}
          title={preset.description || preset.name}
        >
          {preset.icon && ICON_MAP[preset.icon] ? ICON_MAP[preset.icon] : null}
          {preset.name}
        </button>
      ))}
    </div>
  );
}
