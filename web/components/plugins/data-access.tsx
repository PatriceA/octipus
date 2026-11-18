'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { problemsOf } from '@/components/business/common';
import type { PluginProtectionView } from '../../../src/shared/plugin-protection';
import type { PluginSetupResources } from '../../../src/shared/plugin-setup';
import type { PluginPackageView } from '../../../src/shared/plugin-package';
const names = ['', 'Public', 'Internal', 'Confidential', 'Strictly confidential'];
export function PluginDataAccess({ pkg }: { pkg: PluginPackageView }) {
  const policy = useQuery({
    queryKey: ['plugin-data-access', pkg.name],
    queryFn: () => api.get<PluginProtectionView>(`/plugin-packages/${pkg.name}/protection`),
    retry: false,
  });
  const resources = useQuery({
    queryKey: ['plugin-setup-resources'],
    queryFn: () => api.get<PluginSetupResources>('/plugin-packages/setup/resources'),
    retry: false,
  });
  if (policy.error || resources.error)
    return (
      <p role="alert" className="text-error">
        {problemsOf(policy.error ?? resources.error)}
      </p>
    );
  if (!policy.data || !resources.data) return <p>Loading data access…</p>;
  return <Editor key={policy.data.contentHash} pkg={pkg} policy={policy.data} resources={resources.data} />;
}
function Editor({
  pkg,
  policy,
  resources,
}: {
  pkg: PluginPackageView;
  policy: PluginProtectionView;
  resources: PluginSetupResources;
}) {
  const qc = useQueryClient();
  const [level, setLevel] = useState(policy.approval?.level ?? policy.allowedLevel);
  const initial =
    policy.approval?.connections.map((c) => c.id) ??
    String(pkg.settings.collector_connections ?? '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const [selected, setSelected] = useState(initial);
  const save = useMutation({
    mutationFn: () =>
      api.put<PluginProtectionView>(`/plugin-packages/${pkg.name}/protection`, {
        contentHash: policy.contentHash,
        level,
        connections: selected,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({
        queryKey: ['plugin-data-access', pkg.name],
      });
      await qc.invalidateQueries({ queryKey: ['plugin-pages'] });
      await qc.invalidateQueries({ queryKey: ['protected-plugin', pkg.name] });
    },
  });
  return (
    <section
      className="mt-4 space-y-4 rounded-xl border border-outline-variant bg-surface-container p-4"
      data-testid="plugin-data-access"
    >
      <h3 className="text-base font-semibold">Data access</h3>
      <p className="text-sm text-on-surface-variant">
        Choose the classification this plugin may handle. This is an owner setting; its signed package stays unchanged.
      </p>
      {policy.needsReview && (
        <p role="alert" className="text-warning">
          The package was updated. Review and save this data access again; saved protected records are preserved.
        </p>
      )}
      <label className="block text-sm">
        Data classification
        <select
          aria-label="Data classification"
          className="mt-1 block rounded-lg border border-outline-variant bg-surface px-3 py-2"
          value={level}
          onChange={(e) => setLevel(Number(e.target.value))}
        >
          {[1, 2, 3, 4].map((v) => (
            <option key={v} value={v} disabled={v > policy.configurableMaximum}>
              {names[v]}
              {v > policy.configurableMaximum ? ' — unsupported by current capabilities' : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-on-surface-variant">{policy.explanation}</p>
      <p className="text-xs text-on-surface-variant">
        Package default: {names[policy.declaredLevel]}. Owner setting: {names[level]}.
      </p>
      {(pkg.manifest.host ?? []).some((s) => s === 'repos:collect' || s === 'connections:read') && (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Connections trusted for this data</legend>
          {resources.connections.map((c) => (
            <label key={c.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={(e) =>
                  setSelected(e.target.checked ? [...selected, c.id] : selected.filter((id) => id !== c.id))
                }
              />
              <span>
                {c.id}
                <span className="ml-2 text-on-surface-variant">
                  {c.origin}
                  {c.pathPrefix}
                </span>
              </span>
            </label>
          ))}
          <p className="text-xs text-on-surface-variant">
            Existing repository-folder and connection permissions still apply. A changed connection destination needs a
            new approval.
          </p>
        </fieldset>
      )}
      <p className="text-sm">
        Saving approves {names[level]} data for these package bytes and selected destinations. Existing saved data is
        raised to this classification, never lowered. Protected data uses chat and the Octipus-rendered view, where
        plugin browser code does not run.
      </p>
      {save.error && (
        <p role="alert" className="text-error">
          {problemsOf(save.error)}
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="text-tertiary">
          Data access saved.
        </p>
      )}
      <div className="flex gap-4">
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          className="rounded-lg bg-primary px-4 py-2 text-sm text-on-primary disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save data access'}
        </button>
        <a href={`/plugins/${pkg.name}/_protected`} className="self-center text-sm text-primary underline">
          Open protected view
        </a>
      </div>
    </section>
  );
}
