'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save, Tags } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';

interface TopicRow {
  value: string;
  label: string;
  description: string;
  kind: 'text' | 'background' | 'vision' | 'ocr' | 'embedding';
  primaryModel: string | null;
  backupModel: string | null;
  executorModel: string | null;
  temperature: number | null;
  maxTokens: number | null;
}

interface ModelOption {
  name: string;
  isEnabled: boolean;
}

const KIND_LABELS: Record<TopicRow['kind'], string> = {
  text: 'text',
  background: 'background',
  vision: 'vision',
  ocr: 'ocr',
  embedding: 'embedding',
};

function numOrNull(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function TopicCard({
  topic,
  models,
  canEdit,
  onSaved,
}: {
  topic: TopicRow;
  models: ModelOption[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [primary, setPrimary] = useState(topic.primaryModel ?? '');
  const [backup, setBackup] = useState(topic.backupModel ?? '');
  const [executor, setExecutor] = useState(topic.executorModel ?? '');
  const [temperature, setTemperature] = useState(topic.temperature?.toString() ?? '');
  const [maxTokens, setMaxTokens] = useState(topic.maxTokens?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);

  // Local form state is seeded from props once. The parent gives each card a
  // `key` derived from the server values, so a save→refetch that changes them
  // remounts the card with fresh defaults (no setState-in-effect sync needed).

  const dirty =
    primary !== (topic.primaryModel ?? '') ||
    backup !== (topic.backupModel ?? '') ||
    executor !== (topic.executorModel ?? '') ||
    temperature !== (topic.temperature?.toString() ?? '') ||
    maxTokens !== (topic.maxTokens?.toString() ?? '');

  const save = async () => {
    setSaving(true);
    try {
      // Binding (primary/backup) and extras are separate endpoints.
      if (primary !== (topic.primaryModel ?? '') || backup !== (topic.backupModel ?? '')) {
        await api.put(`/topics/${topic.value}/binding`, {
          primaryModel: primary || null,
          backupModel: backup || null,
        });
      }
      await api.patch(`/topics/${topic.value}/config`, {
        executorModel: executor || null,
        temperature: numOrNull(temperature),
        maxTokens: numOrNull(maxTokens),
      });
      setSavedAt(Date.now());
      onSaved();
    } catch (err) {
      console.error(`Failed to save topic "${topic.value}":`, err);
    } finally {
      setSaving(false);
    }
  };

  const modelNames = models.map((m) => m.name);
  // Include any currently-bound model even if it's now disabled/missing, so the
  // selector shows the real value rather than silently resetting it.
  const optionsFor = (current: string) =>
    current && !modelNames.includes(current) ? [current, ...modelNames] : modelNames;

  const selectCls =
    'bg-surface-container-low border border-outline-variant/10 rounded text-xs px-2 py-1 text-on-surface disabled:opacity-50 min-w-[9rem]';
  const inputCls =
    'bg-surface-container-low border border-outline-variant/10 rounded text-xs px-2 py-1 text-on-surface w-20 disabled:opacity-50';

  return (
    <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-on-surface">{topic.label}</h3>
            <span className="font-mono text-[10px] text-on-surface-variant">{topic.value}</span>
            <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-surface-container-high text-on-surface-variant">
              {KIND_LABELS[topic.kind]}
            </span>
          </div>
          <p className="text-xs text-on-surface-variant mt-0.5">{topic.description}</p>
        </div>
        {canEdit && (
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded bg-primary-container/60 text-primary disabled:opacity-40 cursor-pointer shrink-0"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {savedAt && !dirty ? 'Saved' : 'Save'}
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 items-center text-xs">
        <label className="flex items-center gap-1.5">
          <span className="text-on-surface-variant w-16">Primary</span>
          <select className={selectCls} value={primary} disabled={!canEdit} onChange={(e) => setPrimary(e.target.value)}>
            <option value="">— none —</option>
            {optionsFor(primary).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-on-surface-variant w-16">Backup</span>
          <select className={selectCls} value={backup} disabled={!canEdit} onChange={(e) => setBackup(e.target.value)}>
            <option value="">— none —</option>
            {optionsFor(backup).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5" title="Planner→executor split (W9): a swarm child for this topic runs on this model. Empty = same as primary.">
          <span className="text-on-surface-variant w-16">Executor</span>
          <select className={selectCls} value={executor} disabled={!canEdit} onChange={(e) => setExecutor(e.target.value)}>
            <option value="">— same as primary —</option>
            {optionsFor(executor).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5" title="Per-topic temperature override (blank = model default)">
          <span className="text-on-surface-variant">Temp</span>
          <input className={inputCls} type="number" step="0.1" min="0" max="2" value={temperature} disabled={!canEdit}
            placeholder="default" onChange={(e) => setTemperature(e.target.value)} />
        </label>
        <label className="flex items-center gap-1.5" title="Per-topic max output tokens override (blank = model default)">
          <span className="text-on-surface-variant">Max tok</span>
          <input className={inputCls} type="number" step="256" min="1" value={maxTokens} disabled={!canEdit}
            placeholder="default" onChange={(e) => setMaxTokens(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

export default function TopicsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = !!user?.isAdmin;

  const { data: topicsData, isLoading } = useQuery({
    queryKey: ['topics-config'],
    queryFn: async () => {
      try {
        return await api.get<{ topics: TopicRow[] }>('/topics');
      } catch {
        return { topics: [] as TopicRow[] };
      }
    },
  });

  const { data: modelsData } = useQuery({
    queryKey: ['models'],
    queryFn: async () => {
      try {
        return await api.get<{ models: ModelOption[] }>('/models');
      } catch {
        return { models: [] as ModelOption[] };
      }
    },
  });

  const topics = topicsData?.topics || [];
  const models = (modelsData?.models || []).filter((m) => m.isEnabled);
  const onSaved = () => queryClient.invalidateQueries({ queryKey: ['topics-config'] });

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h1 className="text-base font-semibold lowercase">
            <span className="text-outline">octi:</span>
            <span className="text-on-surface">~/topics</span>
            <span className="text-primary font-bold"> $</span>
            <span aria-hidden className="term-caret" />
          </h1>
          <p className="text-on-surface-variant">
            Per-topic model routing and overrides. Assign the primary/backup model each topic routes to, an optional
            executor model (planner→executor split), and per-topic temperature / max-token overrides.
          </p>
          {!canEdit && (
            <p className="text-sm text-warning mt-1">Read-only — admin access is required to change topic configuration.</p>
          )}
        </div>
        <Tags className="w-5 h-5 text-on-surface-variant mt-1" />
      </div>

      {isLoading ? (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Loading...
        </div>
      ) : (
        <div className={cn('space-y-3')}>
          {topics.map((topic) => (
            <TopicCard
              key={`${topic.value}:${topic.primaryModel}:${topic.backupModel}:${topic.executorModel}:${topic.temperature}:${topic.maxTokens}`}
              topic={topic}
              models={models}
              canEdit={canEdit}
              onSaved={onSaved}
            />
          ))}
        </div>
      )}
    </div>
  );
}
