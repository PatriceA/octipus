'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, GraduationCap, Loader2, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { WORKER_ROLES } from '@/lib/types/models';
import { cn } from '@/lib/utils';

interface Expert {
  id: string;
  userId: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  role: string;
  /** Model lane (canonical topic) this expert resolves its model from. */
  topic: string;
  systemPrompt: string | null;
  modelPreference: string | null;
  skillIds: string[] | null;
  isSystem: boolean;
}

interface TopicRow {
  value: string;
  label: string;
  kind: 'text' | 'background' | 'vision' | 'ocr' | 'embedding';
  primaryModel: string | null;
  executorModel: string | null;
}

interface ModelOption {
  name: string;
  modelId: string;
  isEnabled: boolean;
}

/** May be an Expert or an `{ error }` body (the API returns errors with 200). */
type ExpertResponse = Expert | { error: string };

interface ExpertFormValues {
  name: string;
  description: string;
  role: string;
  topic: string;
  modelPreference: string;
  systemPrompt: string;
}

const emptyForm: ExpertFormValues = {
  name: '',
  description: '',
  role: 'general',
  topic: 'agents',
  modelPreference: '',
  systemPrompt: '',
};

const selectCls =
  'bg-surface-container-low border border-outline-variant/10 rounded text-xs px-2 py-1.5 text-on-surface disabled:opacity-50 min-w-[10rem]';
const inputCls =
  'w-full bg-surface-container-low border border-outline-variant/10 rounded text-xs px-2 py-1.5 text-on-surface disabled:opacity-50';

/**
 * The "expert → lane → model" routing line — mirrors the backend resolution
 * order (modelPreference → lane executor/primary → fail loud) so the user
 * sees which model actually serves this expert.
 */
function RoutingLine({ expert, topics }: { expert: Expert; topics: TopicRow[] }) {
  const lane = topics.find((t) => t.value === expert.topic);
  const laneModel = lane?.primaryModel ?? null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-on-surface-variant mt-1.5">
      <span className="font-mono">{expert.name}</span>
      <ArrowRight className="w-3 h-3 shrink-0" />
      {expert.modelPreference ? (
        <span className="font-mono text-primary" title="Pinned via the expert's model preference — overrides the lane binding">
          {expert.modelPreference} (pinned)
        </span>
      ) : (
        <>
          <span className="px-1.5 py-0.5 rounded-full bg-surface-container-high font-mono">{expert.topic}</span>
          <ArrowRight className="w-3 h-3 shrink-0" />
          {laneModel ? (
            <span className="font-mono text-primary">{laneModel}</span>
          ) : (
            <span className="text-error" title="No primary model bound to this lane — workers for this expert fail to spawn. Bind one on the Topics page.">
              ⚠ lane unbound
            </span>
          )}
          {lane?.executorModel && (
            <span title="This lane sets an executor model — swarm-spawned children run on it instead of the primary">
              (executor: <span className="font-mono">{lane.executorModel}</span>)
            </span>
          )}
        </>
      )}
    </div>
  );
}

function ExpertForm({
  initial,
  lanes,
  models,
  /** System experts: identity/prompt is code-owned (reseeded at boot) — only lane + model are editable. */
  laneAndModelOnly,
  saving,
  error,
  onSave,
  onCancel,
}: {
  initial: ExpertFormValues;
  lanes: TopicRow[];
  models: ModelOption[];
  laneAndModelOnly: boolean;
  saving: boolean;
  error: string;
  onSave: (v: ExpertFormValues) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ExpertFormValues>(initial);
  const set = (patch: Partial<ExpertFormValues>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="mt-3 space-y-3 border-t border-outline-variant/10 pt-3">
      {!laneAndModelOnly && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs text-on-surface-variant mb-1">Name</span>
            <input className={inputCls} value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Tax Advisor" />
          </label>
          <label className="block">
            <span className="block text-xs text-on-surface-variant mb-1" title="Tool bundle + base prompt. Also what the orchestrator's routing table keys on.">Role (tools)</span>
            <select className={cn(selectCls, 'w-full')} value={form.role} onChange={(e) => set({ role: e.target.value })}>
              {WORKER_ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="block text-xs text-on-surface-variant mb-1">Description (the orchestrator routes by this — say what the expert is good at)</span>
            <input className={inputCls} value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="e.g. German tax law: VAT, income tax, filing deadlines" />
          </label>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs text-on-surface-variant mb-1" title="Which model lane serves this expert. The lane's primary model runs its workers.">Topic (model lane)</span>
          <select className={cn(selectCls, 'w-full')} value={form.topic} onChange={(e) => set({ topic: e.target.value })}>
            {lanes.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label} {l.primaryModel ? `→ ${l.primaryModel}` : '(unbound)'}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-on-surface-variant mb-1" title="Optional: pin a specific model, overriding the lane binding.">Model override (optional)</span>
          <select className={cn(selectCls, 'w-full')} value={form.modelPreference} onChange={(e) => set({ modelPreference: e.target.value })}>
            <option value="">— use the lane's model —</option>
            {models.map((m) => (
              <option key={m.name} value={m.modelId}>{m.name}</option>
            ))}
          </select>
        </label>
      </div>

      {!laneAndModelOnly && (
        <label className="block">
          <span className="block text-xs text-on-surface-variant mb-1">System prompt (optional — replaces the role's base prompt)</span>
          <textarea
            className={cn(inputCls, 'min-h-24 font-mono')}
            value={form.systemPrompt}
            onChange={(e) => set({ systemPrompt: e.target.value })}
            placeholder="You are a meticulous German tax advisor…"
          />
        </label>
      )}

      {error && <p className="text-xs text-error bg-error/10 px-2 py-1 rounded">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave(form)}
          disabled={saving || (!laneAndModelOnly && !form.name.trim())}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary-container/60 text-primary disabled:opacity-40 cursor-pointer"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          Save
        </button>
        <button
          onClick={onCancel}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-surface-container-high text-on-surface-variant cursor-pointer"
        >
          <X className="w-3 h-3" />
          Cancel
        </button>
      </div>
    </div>
  );
}

function ExpertCard({
  expert,
  topics,
  models,
  canEditIdentity,
  canEditLane,
  canDelete,
  onChanged,
}: {
  expert: Expert;
  topics: TopicRow[];
  models: ModelOption[];
  canEditIdentity: boolean;
  canEditLane: boolean;
  canDelete: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const lanes = topics.filter((t) => t.kind === 'text');

  const update = useMutation({
    mutationFn: (v: ExpertFormValues) => {
      const body: Record<string, unknown> = {
        topic: v.topic,
        modelPreference: v.modelPreference || null,
      };
      if (canEditIdentity) {
        body.name = v.name;
        body.description = v.description || null;
        body.role = v.role;
        body.systemPrompt = v.systemPrompt || null;
      }
      return api.patch<ExpertResponse>(`/experts/${expert.id}`, body);
    },
    onSuccess: (res) => {
      if (res && 'error' in res) {
        setError(res.error);
        return;
      }
      setError('');
      setEditing(false);
      onChanged();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to save'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete<{ error?: string }>(`/experts/${expert.id}`),
    onSuccess: (res) => {
      if (res?.error) {
        setError(res.error);
        return;
      }
      onChanged();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Failed to delete'),
  });

  return (
    <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-on-surface">{expert.name}</h3>
            <span className={cn(
              'px-1.5 py-0.5 text-[10px] rounded-full',
              expert.isSystem ? 'bg-surface-container-high text-on-surface-variant' : 'bg-primary-container/60 text-primary',
            )}>
              {expert.isSystem ? 'system' : 'custom'}
            </span>
            <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-surface-container-high text-on-surface-variant font-mono">
              role: {expert.role}
            </span>
          </div>
          {expert.description && <p className="text-xs text-on-surface-variant mt-0.5">{expert.description}</p>}
          <RoutingLine expert={expert} topics={topics} />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {(canEditIdentity || canEditLane) && !editing && (
            <button
              onClick={() => { setError(''); setEditing(true); }}
              className="flex items-center gap-1 px-2 py-1.5 text-xs rounded bg-surface-container-high text-on-surface-variant cursor-pointer"
              title={canEditIdentity ? 'Edit expert' : 'Change model lane / pinned model (identity of system experts is code-owned)'}
            >
              <Pencil className="w-3 h-3" />
              Edit
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => { if (confirm(`Delete expert "${expert.name}"?`)) remove.mutate(); }}
              disabled={remove.isPending}
              className="flex items-center gap-1 px-2 py-1.5 text-xs rounded bg-error/10 text-error disabled:opacity-40 cursor-pointer"
            >
              {remove.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>

      {!editing && error && <p className="mt-2 text-xs text-error bg-error/10 px-2 py-1 rounded">{error}</p>}

      {editing && (
        <ExpertForm
          initial={{
            name: expert.name,
            description: expert.description ?? '',
            role: expert.role,
            topic: expert.topic || 'agents',
            modelPreference: expert.modelPreference ?? '',
            systemPrompt: expert.systemPrompt ?? '',
          }}
          lanes={lanes}
          models={models}
          laneAndModelOnly={!canEditIdentity}
          saving={update.isPending}
          error={error}
          onSave={(v) => update.mutate(v)}
          onCancel={() => { setEditing(false); setError(''); }}
        />
      )}
    </div>
  );
}

export default function ExpertsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const { data: expertsData, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['experts'],
    queryFn: () => api.get<{ experts: Expert[] }>('/experts'),
  });
  const { data: topicsData } = useQuery({
    queryKey: ['topics-config'],
    queryFn: () => api.get<{ topics: TopicRow[] }>('/topics'),
  });
  const { data: modelsData } = useQuery({
    queryKey: ['models'],
    queryFn: () => api.get<{ models: ModelOption[] }>('/models'),
  });

  const experts = expertsData?.experts ?? [];
  const topics = topicsData?.topics ?? [];
  const models = (modelsData?.models ?? []).filter((m) => m.isEnabled);
  const lanes = topics.filter((t) => t.kind === 'text');
  const custom = experts.filter((e) => !e.isSystem);
  const system = experts.filter((e) => e.isSystem);

  const onChanged = () => queryClient.invalidateQueries({ queryKey: ['experts'] });

  const create = useMutation({
    mutationFn: (v: ExpertFormValues) =>
      api.post<ExpertResponse>('/experts', {
        name: v.name,
        description: v.description || undefined,
        role: v.role,
        topic: v.topic,
        modelPreference: v.modelPreference || undefined,
        systemPrompt: v.systemPrompt || undefined,
      }),
    onSuccess: (res) => {
      if (res && 'error' in res) {
        setCreateError(res.error);
        return;
      }
      setCreateError('');
      setCreating(false);
      onChanged();
    },
    onError: (err) => setCreateError(err instanceof Error ? err.message : 'Failed to create'),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="experts"
        badge={<GraduationCap className="w-5 h-5 text-on-surface-variant" />}
        description="The specialists the orchestrator can route work to. Each expert carries a role (its tools + base prompt) and a topic lane (which model serves it) — add your own experts and they become routable immediately."
      />

      {user && (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4">
          {!creating ? (
            <button
              onClick={() => { setCreateError(''); setCreating(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary-container/60 text-primary cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              New expert
            </button>
          ) : (
            <>
              <h3 className="font-medium text-on-surface text-sm">New expert</h3>
              <ExpertForm
                initial={emptyForm}
                lanes={lanes}
                models={models}
                laneAndModelOnly={false}
                saving={create.isPending}
                error={createError}
                onSave={(v) => create.mutate(v)}
                onCancel={() => { setCreating(false); setCreateError(''); }}
              />
            </>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center text-on-surface-variant">
          <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
          Loading...
        </div>
      ) : isError ? (
        <div className="bg-error/10 ring-1 ring-error/30 rounded-xs p-6 text-center space-y-3">
          <p className="text-sm text-error">
            Failed to load experts: {error instanceof Error ? error.message : 'Unknown error'}
          </p>
          <button onClick={() => refetch()} className="px-3 py-1.5 text-xs rounded bg-error/20 text-error cursor-pointer">
            Retry
          </button>
        </div>
      ) : (
        <>
          {custom.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-on-surface-variant">your experts</h2>
              {custom.map((e) => (
                <ExpertCard
                  key={e.id}
                  expert={e}
                  topics={topics}
                  models={models}
                  canEditIdentity={!!user && (user.isAdmin || e.userId === user.id)}
                  canEditLane={!!user && (user.isAdmin || e.userId === user.id)}
                  canDelete={!!user && (user.isAdmin || e.userId === user.id)}
                  onChanged={onChanged}
                />
              ))}
            </section>
          )}

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-on-surface-variant">system experts</h2>
            {system.map((e) => (
              <ExpertCard
                key={e.id}
                expert={e}
                topics={topics}
                models={models}
                // Identity/prompt of system experts is code-owned and resynced at
                // boot — editing it here would silently revert. Lane + pinned
                // model are operator-owned (admin).
                canEditIdentity={false}
                canEditLane={!!user?.isAdmin}
                canDelete={false}
                onChanged={onChanged}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
