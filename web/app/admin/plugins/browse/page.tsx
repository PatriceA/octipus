'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import {
  PLUGIN_PACKAGES_KEY,
  PLUGIN_REGISTRY_KEY,
  type PluginInstallResult,
  type PluginRegistryEntry,
  type PluginRegistryListing,
} from '@/lib/plugin-packages';
import { cn } from '@/lib/utils';

const entryKey = (e: PluginRegistryEntry) => `${e.registry}\n${e.name}\n${e.version}`;

/**
 * Admin → Plugin packages → Browse: what the registries in
 * `plugins.registries` offer. Install downloads the tarball over https,
 * checks it against the sha256 the index lists, and installs it only with a
 * valid signature by a trusted publisher; an installed package is upgraded.
 * It starts disabled, as any install.
 */
export default function AdminPluginBrowsePage() {
  const qc = useQueryClient();
  const [messages, setMessages] = useState<Record<string, { kind: 'error' | 'ok'; text: string }>>({});
  const { data, isLoading, error } = useQuery({
    queryKey: PLUGIN_REGISTRY_KEY,
    queryFn: () => api.get<PluginRegistryListing>('/plugin-packages/registry'),
  });
  const install = useMutation({
    mutationFn: (e: PluginRegistryEntry) => api.post<PluginInstallResult>('/plugin-packages', {
      url: e.url, sha256: e.sha256, name: e.name, version: e.version, ...(e.installedVersion !== null ? { upgrade: true } : {}),
    }),
    onSuccess: (res, e) => {
      setMessages((m) => ({ ...m, [entryKey(e)]: { kind: 'ok', text: `Installed ${res.name} ${res.version}, signed by ${res.signedBy ?? '?'}; enable it on the packages page.` } }));
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
    },
    onError: (err: Error, e) => setMessages((m) => ({ ...m, [entryKey(e)]: { kind: 'error', text: err.message } })),
  });
  const packages = data?.packages ?? [];

  return (
    <div className="space-y-4" data-testid="admin-plugin-browse">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="section-label">browse registries</h2>
          <p className="mt-1 text-xs text-on-surface-variant">
            Packages listed by the registries in <code>plugins.registries</code>. Installing downloads the package over
            https, checks it against the listed sha256 and requires a valid signature by a publisher in{' '}
            <code>plugins.trustedPublishers</code>. It starts disabled.
          </p>
        </div>
        <Link href="/admin/plugins" className="text-xs text-primary hover:underline">← installed packages</Link>
      </div>
      {error && <p role="alert" className="text-xs text-error">! {(error as Error).message}</p>}
      {(data?.errors ?? []).map((e) => (
        <p key={e.registry} role="alert" className="text-xs text-warning">! {e.registry}: {e.error}</p>
      ))}
      {isLoading ? (
        <div className="p-8 text-center text-on-surface-variant">Loading…</div>
      ) : packages.length === 0 ? (
        <div className="p-8 text-center text-on-surface-variant border border-outline-variant/40 rounded-xs border-dashed">
          <p aria-hidden className="text-[16px] text-outline mb-1">[ ]</p>
          <p className="text-[12px]">no packages listed; add a registry under <code>plugins.registries</code> in Settings</p>
        </div>
      ) : (
        <ul className="term-frame rounded-xs divide-y divide-outline-variant/10">
          {packages.map((e) => {
            const key = entryKey(e);
            const message = messages[key];
            const current = e.installedVersion === e.version;
            return (
              <li key={key} className="px-4 py-3 text-sm" data-testid="registry-package" data-name={e.name}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-on-surface font-medium">{e.name}</span>
                  <span className="text-xs text-on-surface-variant">{e.version}</span>
                  <span className="text-xs text-on-surface-variant flex-1 min-w-0 truncate">{e.description ?? ''}</span>
                  <span className="text-xs text-on-surface-variant">{e.registry}</span>
                  {e.installedVersion !== null && (
                    <span className={cn('text-xs', current ? 'text-tertiary' : 'text-warning')}>installed {e.installedVersion}</span>
                  )}
                  <button
                    type="button"
                    disabled={install.isPending || current}
                    onClick={() => install.mutate(e)}
                    aria-label={`${e.installedVersion !== null ? 'Upgrade' : 'Install'} ${e.name} ${e.version}`}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50"
                  >
                    <Download className="w-3.5 h-3.5" /> {e.installedVersion !== null ? 'Upgrade' : 'Install'}
                  </button>
                </div>
                <p className="mt-1 text-xs text-on-surface-variant font-mono break-all" title="The sha256 the download must hash to">{e.sha256}</p>
                {message && (
                  <p role={message.kind === 'error' ? 'alert' : 'status'} className={cn('mt-1 text-xs', message.kind === 'error' ? 'text-error' : 'text-on-surface-variant')}>
                    {message.text}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
