import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { CliModelPicker } from '@/components/models/cli-model-picker';
import type {
  SessionCliBinding,
  SessionCliOverride,
  SessionModelControls,
} from '../../../src/shared/session-model-controls';

export function useSessionModelControls(sessionId: string | null) {
  return useQuery({
    queryKey: ['session-model-controls', sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const response = await api.get<SessionModelControls>(
        `/sessions/${encodeURIComponent(sessionId!)}/model-controls`,
      );
      if (!Array.isArray(response.bindings) || !Array.isArray(response.runs) || !Array.isArray(response.overrides))
        throw new Error('Session model settings are unavailable from this server.');
      return response;
    },
    refetchInterval: (query) => query.state.data?.runs.some((run) => run.status === 'running') ? 10000 : 30000,
    retry: false,
  });
}

/** Session overrides are separate from global bindings and from already running subprocesses. */
export default function SessionModelControlsPanel({ sessionId }: { sessionId: string | null }) {
  const [editing, setEditing] = useState(false);
  const query = useSessionModelControls(sessionId);
  const data = query.data;
  const runs = data?.runs ?? [];
  const current = runs.filter((r) => r.status === 'running');
  const shown = current.length ? current : runs.slice(0, 1);
  return (
    <div className="space-y-3">
      {query.isError && (
        <p role="alert" className="text-xs text-warning">
          Model settings unavailable.{' '}
          <button type="button" className="underline" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      )}
      {shown.map((run) => (
        <div key={run.id} className="rounded-lg border border-outline-variant/60 p-2 text-xs">
          <p className="text-on-surface-variant">
            {run.root ? 'Coordinator' : run.role} · {run.status === 'running' ? 'running' : 'latest run'}
          </p>
          <p data-testid="session-run-model" className="break-words font-medium mt-1">
            {run.model ?? 'CLI default — model not reported'}
          </p>
          <p className="text-on-surface-variant mt-1">
            {run.adapter}
            {run.effort ? ` · ${run.effort} effort` : ''}
          </p>
        </div>
      ))}
      {!shown.length && !query.isError && (
        <p className="text-xs text-on-surface-variant">
          {query.isPending && sessionId ? 'Loading models…' : 'No model recorded yet.'}
        </p>
      )}
      {data?.editable === false && <p className="text-xs text-on-surface-variant">Choose Companion's model in Companion settings.</p>}
      {!!data?.bindings.length && data.editable !== false && (
        <details onToggle={(e) => setEditing(e.currentTarget.open)}>
          <summary className="cursor-pointer text-xs text-primary">
            Models for this session{data.overrides.length ? ` · ${data.overrides.length} overrides` : ''}
          </summary>
          <p className="my-2 text-xs text-on-surface-variant">
            Changes apply at the next CLI launch, including the next pipeline stage. Running work continues. Changing
            model or effort starts a fresh CLI context with the saved conversation; private CLI history and its cache
            are lost. Global settings stay as they are.
          </p>
          <div className="space-y-3">
            {editing &&
              data.bindings.map((binding) => (
                <BindingEditor
                  key={`${binding.modelName}:${binding.topic}`}
                  binding={binding}
                  data={data}
                  sessionId={sessionId!}
                />
              ))}
          </div>
        </details>
      )}
    </div>
  );
}

function BindingEditor({
  binding,
  data,
  sessionId,
}: {
  binding: SessionCliBinding;
  data: SessionModelControls;
  sessionId: string;
}) {
  const [role, setRole] = useState('');
  const [saved, setSaved] = useState(false);
  const selected = data.overrides.find(
    (e) => e.modelName === binding.modelName && e.topic === binding.topic && (e.role ?? '') === role,
  );
  // Remount for each scope/saved value, so a session/agent switch never retains another form's draft.
  return (
    <div className="rounded-lg border border-outline-variant/60 p-2 space-y-2 text-xs">
      <p className="font-medium">
        {binding.topic} · {binding.adapter}
      </p>
      <p className="text-on-surface-variant break-words">{binding.modelName}</p>
      <label className="block">
        Applies to
        <select
          aria-label={`Agent for ${binding.topic} ${binding.modelName}`}
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="mt-1 w-full bg-surface-container border border-outline-variant rounded-sm p-2"
        >
          <option value="">All agents on this topic</option>
          {Array.from(new Set(['general', 'coding', 'review', 'qa', ...data.runs.map((r) => r.role)])).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <OverrideForm
        key={JSON.stringify([role, selected])}
        binding={binding}
        role={role}
        selected={selected}
        data={data}
        sessionId={sessionId}
        onSaved={() => setSaved(true)}
      />
      {saved && (
        <p role="status" className="text-primary">
          Saved for the next launch.
        </p>
      )}
    </div>
  );
}
function OverrideForm({
  binding,
  role,
  selected,
  data,
  sessionId,
  onSaved,
}: {
  onSaved: () => void;
  binding: SessionCliBinding;
  role: string;
  selected?: SessionCliOverride;
  data: SessionModelControls;
  sessionId: string;
}) {
  const [model, setModel] = useState(selected?.model ?? '');
  const [effort, setEffort] = useState(selected?.effort ?? '');
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (reset: boolean) => {
      const others = data.overrides.filter(
        (e) => !(e.modelName === binding.modelName && e.topic === binding.topic && (e.role ?? '') === role),
      );
      const entry: SessionCliOverride = {
        modelName: binding.modelName,
        topic: binding.topic,
        ...(role ? { role } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(effort ? { effort } : {}),
      };
      return api.put(`/sessions/${encodeURIComponent(sessionId)}/model-controls`, {
        revision: data.revision,
        overrides: reset || (!entry.model && !entry.effort) ? others : [...others, entry],
      });
    },
    onSuccess: () => {
      onSaved();
      void client.invalidateQueries({ queryKey: ['session-model-controls', sessionId] });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ['session-model-controls', sessionId] });
    },
  });
  const catalog = useQuery({
    queryKey: ['session-cli-catalog', sessionId, binding.modelName],
    enabled: binding.modelSelectable !== false,
    staleTime: 300000,
    retry: false,
    queryFn: () =>
      api.get<{ models: Array<{ id: string; label: string }>; error?: string }>(
        `/sessions/${encodeURIComponent(sessionId)}/model-controls/catalog?modelName=${encodeURIComponent(binding.modelName)}`,
      ),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(false);
      }}
      className="space-y-2"
    >
      {binding.modelSelectable !== false && (
        <div>
          <p>Model</p>
          <CliModelPicker
            label={`Model for ${binding.topic} ${binding.modelName}`}
            value={model}
            onChange={setModel}
            models={catalog.data?.models.length ? catalog.data.models : binding.models}
            defaultLabel={`Use configured default${binding.model ? ` (${binding.model})` : ' (vendor default)'}`}
            className="mt-1 w-full bg-surface-container border border-outline-variant rounded-sm p-2"
          />
        </div>
      )}
      {(catalog.data?.error || catalog.isError) && (
        <p className="text-on-surface-variant">
          {catalog.data?.error ?? 'Model catalog unavailable.'} Configured choices are preserved.{' '}
          <button type="button" className="underline" onClick={() => void catalog.refetch()}>Retry catalog</button>
        </p>
      )}
      {!!binding.efforts.length && (
        <label className="block">
          Reasoning effort
          <select
            aria-label={`Effort for ${binding.topic} ${binding.modelName}`}
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            className="mt-1 w-full bg-surface-container border border-outline-variant rounded-sm p-2"
          >
            <option value="">Use configured default{binding.effort ? ` (${binding.effort})` : ''}</option>
            {binding.efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-sm bg-primary text-on-primary px-3 py-2 disabled:opacity-50"
        >
          Save
        </button>
        {selected && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate(true)}
            className="px-2 py-2 text-primary"
          >
            Reset to defaults
          </button>
        )}
      </div>
      {save.isError && (
        <p role="alert" className="text-warning">
          {save.error.message}
        </p>
      )}
    </form>
  );
}
