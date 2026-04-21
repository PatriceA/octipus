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
              ? 'bg-primary text-[#002a6d]'
              : 'bg-surface-container-highest text-on-surface-variant hover:bg-surface-container-high'
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
