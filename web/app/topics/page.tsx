'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Loader2, Save, Tags } from 'lucide-react';
import { useState } from 'react';
import { RootModelNote } from '@/components/models/root-model-note';
import { PageHeader } from '@/components/ui/page-header';
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
  const [saveError, setSaveError] = useState('');

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
    setSaveError('');
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
      // Surface the failure to the user instead of only logging — a silent
      // console.error reads as a successful save.
      console.error(`Failed to save topic "${topic.value}":`, err);
      setSaveError(err instanceof Error ? err.message : 'Failed to save. Please try again.');
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
  // w-28 + right padding so the number-spinner arrows don't overlap the
  // "default" placeholder / typed value (w-20 was too narrow and clipped them).
  const inputCls =
    'bg-surface-container-low border border-outline-variant/10 rounded text-xs pl-2 pr-1.5 py-1 text-on-surface w-28 disabled:opacity-50';

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

      {saveError && (
        <p className="mt-2 text-xs text-error bg-error/10 px-2 py-1 rounded">{saveError}</p>
      )}
    </div>
  );
}

// One-click "run everything on a single model" setup: binds the chosen model as
// primary for every text topic (and makes it default), demoting any current
// holders. The Topics-page home for what used to live on the Models page.
function AssignAllPanel({ models, onApplied }: { models: ModelOption[]; onApplied: () => void }) {
  const [model, setModel] = useState('');
  const mutation = useMutation({
    mutationFn: (name: string) => api.post('/topics/assign-all', { model: name }),
    onSuccess: () => {
      onApplied();
      setModel('');
    },
  });

  return (
    <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4">
      <div className="flex items-start gap-2 mb-2">
        <Layers className="w-4 h-4 text-primary mt-0.5 shrink-0" />
        <div className="min-w-0">
          <h3 className="font-medium text-on-surface text-sm">Use one model for all topics</h3>
          <p className="text-xs text-on-surface-variant mt-0.5">
            Single-model setup for small / local installs — binds the chosen model as primary for every text
            topic and makes it the default. embedding, OCR and vision stay unbound (add those separately).
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="bg-surface-container-low border border-outline-variant/10 rounded text-xs px-2 py-1.5 text-on-surface min-w-[12rem]"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={mutation.isPending}
        >
          <option value="">— select a model —</option>
          {models.map((m) => (
            <option key={m.name} value={m.name}>{m.name}</option>
          ))}
        </select>
        <button
          onClick={() => model && mutation.mutate(model)}
          disabled={!model || mutation.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary-container/60 text-primary disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {mutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Layers className="w-3 h-3" />}
          Apply to all text topics
        </button>
        {mutation.isError && (
          <span className="text-xs text-error">
            {mutation.error instanceof Error ? mutation.error.message : 'Failed to apply'}
          </span>
        )}
      </div>
    </div>
  );
}

export default function TopicsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = !!user?.isAdmin;

  const { data: topicsData, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['topics-config'],
    // Let the fetch error propagate so the UI can show a real failure instead
    // of an empty "no topics" success when /topics is down or auth fails.
    queryFn: () => api.get<{ topics: TopicRow[] }>('/topics'),
  });

  const { data: modelsData } = useQuery({
    queryKey: ['models'],
    // Don't swallow: let react-query record the error (and apply its retry)
    // rather than masking a /models failure as "no models". This only feeds the
    // model/executor dropdowns, so the page still renders topics on failure.
    queryFn: () => api.get<{ models: ModelOption[] }>('/models'),
  });

  const topics = topicsData?.topics || [];
  const models = (modelsData?.models || []).filter((m) => m.isEnabled);
  const onSaved = () => queryClient.invalidateQueries({ queryKey: ['topics-config'] });
  // Assign-all touches bindings across every model, so refresh both queries.
  const onAssignedAll = () => {
    queryClient.invalidateQueries({ queryKey: ['topics-config'] });
    queryClient.invalidateQueries({ queryKey: ['models'] });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="topics"
        badge={<Tags className="w-5 h-5 text-on-surface-variant" />}
        description="Per-topic model routing and overrides. Assign the primary/backup model each topic routes to, an optional executor model (planner→executor split), and per-topic temperature / max-token overrides."
      />
      {!canEdit && (
        <p className="text-sm text-warning">Read-only — admin access is required to change topic configuration.</p>
      )}

      <RootModelNote />

      {canEdit && models.length > 0 && <AssignAllPanel models={models} onApplied={onAssignedAll} />}

      {isLoading ? (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Loading...
        </div>
      ) : isError ? (
        <div className="bg-error/10 ring-1 ring-error/30 rounded-xs p-6 text-center space-y-3">
          <p className="text-sm text-error">
            Failed to load topics: {error instanceof Error ? error.message : 'Unknown error'}
          </p>
          <button
            onClick={() => refetch()}
            className="px-3 py-1.5 text-xs rounded bg-error/20 text-error cursor-pointer"
          >
            Retry
          </button>
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
