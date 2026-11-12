'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { problemsOf } from '@/components/business/common';
import { api } from '@/lib/api';
import { displayText, formatStoreBytes, MY_PLUGIN_USAGE_KEY, type MyPluginUsage } from '@/lib/plugin-packages';

/**
 * Settings → My plugin usage: each enabled plugin package the signed-in user
 * has used in the last 30 days (tokens, cost, model calls, background runs),
 * their own running background runs, which they can cancel, and what each
 * plugin keeps for them in its store, which they can delete ("Delete my data").
 */
export function PluginUsageTab() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: MY_PLUGIN_USAGE_KEY,
    queryFn: () => api.get<MyPluginUsage[]>('/plugin-packages/my-usage?days=30'),
    refetchInterval: 15_000,
  });
  const cancel = useMutation({
    mutationFn: (r: { plugin: string; id: string }) => api.delete<{ id: string; status: string }>(`/plugin-packages/${encodeURIComponent(r.plugin)}/runs/${encodeURIComponent(r.id)}`),
    onSettled: () => { void qc.invalidateQueries({ queryKey: MY_PLUGIN_USAGE_KEY }); },
  });
  const erase = useMutation({
    mutationFn: (plugin: string) => api.delete<{ name: string; entries: number; bytes: number }>(`/plugin-packages/${encodeURIComponent(plugin)}/store/me`),
    onSettled: () => { void qc.invalidateQueries({ queryKey: MY_PLUGIN_USAGE_KEY }); },
  });
  const list = data ?? [];
  return (
    <section className="space-y-3" aria-labelledby="my-plugin-usage-title" data-testid="my-plugin-usage">
      <h2 id="my-plugin-usage-title" className="text-sm font-semibold text-on-surface">My plugin usage</h2>
      <p className="text-xs text-on-surface-variant">What the plugin packages you used spent on your behalf in the last 30 days, the background runs they started for you, and the data they keep for you.</p>
      {error && <p role="alert" className="text-xs text-error">! {problemsOf(error)}</p>}
      {isLoading ? <p className="text-xs text-on-surface-variant">Loading…</p> : list.length === 0 ? (
        <p className="text-xs text-on-surface-variant">You have not used a plugin in the last 30 days.</p>
      ) : (
        <ul className="space-y-2">
          {list.map((p) => (
            <li key={p.name} className="rounded-md border border-outline-variant/50 p-3 text-xs" data-testid="my-plugin" data-name={p.name}>
              <p className="text-sm font-medium text-on-surface">{displayText(p.title)} <span className="text-xs font-normal text-on-surface-variant">{displayText(p.name)}</span></p>
              <p className="text-on-surface-variant" data-testid="my-plugin-totals">
                {(p.usage.inputTokens + p.usage.outputTokens).toLocaleString()} tokens · ${p.usage.cost.toFixed(2)} · {p.usage.modelCalls} model calls · {p.usage.runs} runs
              </p>
              {p.store && (
                <div className="mt-1 flex flex-wrap items-center gap-2" data-testid="my-plugin-store">
                  <span className="text-on-surface-variant" data-testid="my-plugin-store-size">
                    Stored for you: {formatStoreBytes(p.store.bytes)} in {p.store.entries} {p.store.entries === 1 ? 'entry' : 'entries'}
                    {p.store.quotaBytes !== null ? ` of ${formatStoreBytes(p.store.quotaBytes)}` : ''}
                  </span>
                  {p.store.entries > 0 && (
                    <button type="button" disabled={erase.isPending}
                      onClick={() => { if (confirm(`Delete everything ${displayText(p.title)} keeps for you (${formatStoreBytes(p.store?.bytes ?? 0)})? This cannot be undone.`)) erase.mutate(p.name); }}
                      aria-label={`Delete my data of ${displayText(p.title)}`}
                      className="rounded-xs border border-outline-variant px-2 py-0.5 text-error hover:bg-surface-container-high disabled:opacity-50">
                      Delete my data
                    </button>
                  )}
                </div>
              )}
              {p.runs.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {p.runs.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-2" data-testid="my-plugin-run">
                      <span className="text-on-surface">{displayText(r.title)}</span>
                      <span className="text-on-surface-variant">running since {new Date(r.startedAt).toLocaleTimeString()}</span>
                      <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate({ plugin: p.name, id: r.id })} aria-label={`Cancel the run ${displayText(r.title)}`}
                        className="rounded-xs border border-outline-variant px-2 py-0.5 text-on-surface hover:bg-surface-container-high disabled:opacity-50">
                        Cancel
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {cancel.error && <p role="alert" className="text-xs text-error">! {problemsOf(cancel.error)}</p>}
      {erase.error && <p role="alert" className="text-xs text-error">! {problemsOf(erase.error)}</p>}
    </section>
  );
}
