'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Power, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import {
  PLUGIN_PACKAGES_KEY,
  type PluginInstallResult,
  type PluginNetworkStatus,
  type PluginPackageView,
  type PluginSignatureStatus,
} from '@/lib/plugin-packages';
import { cn } from '@/lib/utils';

const NETWORK_LABEL: Record<PluginNetworkStatus['state'], string> = {
  restricted: 'network restricted',
  offline: 'offline',
  not_enforced: 'network not enforced',
  refused: 'refused: sandbox required',
};

const SIGNATURE_LABEL: Record<PluginSignatureStatus['status'], string> = {
  valid: 'signed',
  unsigned: 'unsigned',
  unknown_key: 'unknown key',
  revoked: 'key revoked',
  expired: 'key expired',
  invalid: 'invalid signature',
  changed: 'signature file changed',
};

/** Bad news in red, caveats in amber, the rest quiet. */
function tone(kind: 'bad' | 'warn' | 'ok' | 'quiet'): string {
  return { bad: 'text-error', warn: 'text-warning', ok: 'text-tertiary', quiet: 'text-on-surface-variant' }[kind];
}

/** The network state, said plainly: `refused` means the server is not started at all. */
function NetworkState({ network }: { network: PluginNetworkStatus }) {
  const kind = network.state === 'refused' ? 'bad' : network.state === 'not_enforced' ? 'warn' : 'ok';
  return (
    <span className={cn('text-xs', tone(kind))} title={network.detail} data-testid="plugin-network">
      {NETWORK_LABEL[network.state]}
    </span>
  );
}

function SignatureState({ signature }: { signature: PluginSignatureStatus | null }) {
  if (!signature) return <span className="text-xs text-on-surface-variant">not pinned yet</span>;
  const kind = signature.status === 'valid' ? 'ok'
    : signature.status === 'unsigned' || signature.status === 'unknown_key' ? 'quiet'
      : 'bad';
  return (
    <span className={cn('text-xs', tone(kind))} title={signature.detail} data-testid="plugin-signature">
      {SIGNATURE_LABEL[signature.status]}{signature.publisher ? ` · ${signature.publisher}` : ''}
    </span>
  );
}

/**
 * A package whose files (or signature file) changed since they were
 * approved: the hash recorded and the hash the files have now, and approving
 * exactly the hash shown. The server hashes the files again and refuses
 * (409) when they changed after this page read them.
 */
function ContentReview({ pkg }: { pkg: PluginPackageView }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const approve = useMutation({
    mutationFn: (hash: string) => api.patch<PluginPackageView>(`/plugin-packages/${encodeURIComponent(pkg.name)}`, { approveContent: hash }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
    },
    onError: (err: Error) => {
      setError(err.message);
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
    },
  });
  if (!pkg.actualHash) return null;
  const hash = pkg.actualHash;
  return (
    <div className="mt-2 space-y-1 rounded-xs border border-warning/40 p-2" role="group" aria-label={`Content review for ${pkg.name}`}>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-2 text-xs">
        <dt className="text-on-surface-variant">recorded</dt>
        <dd className="font-mono break-all" data-testid="recorded-hash">{pkg.contentHash ?? 'none'}</dd>
        <dt className="text-on-surface-variant">actual</dt>
        <dd className="font-mono break-all" data-testid="actual-hash">{hash}</dd>
      </dl>
      <p className="text-xs text-on-surface-variant">
        Review the files in the package directory first: approving records this hash, and the package runs what hashes to it.
      </p>
      <button
        type="button"
        disabled={approve.isPending}
        onClick={() => {
          if (confirm(`Approve the content of ${pkg.name} that hashes to ${hash}?`)) approve.mutate(hash);
        }}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50"
      >
        <CircleCheck className="w-3.5 h-3.5" /> Approve this content
      </button>
      {error && <p role="alert" className="text-xs text-error">! {error}</p>}
    </div>
  );
}

function PackageRow({ pkg }: { pkg: PluginPackageView }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch<PluginPackageView>(`/plugin-packages/${encodeURIComponent(pkg.name)}`, { enabled }),
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY }); },
    // A refusal can come from files changed since the page loaded: reload, so the review shows.
    onError: (err: Error) => { setError(err.message); void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY }); },
  });
  const hosts = pkg.manifest.network ?? [];
  return (
    <li className="px-4 py-3 text-sm" data-testid="plugin-package" data-name={pkg.name}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-on-surface font-medium">{pkg.name}</span>
        <span className="text-xs text-on-surface-variant">{pkg.version}</span>
        <span className="text-xs text-on-surface-variant flex-1 min-w-0 truncate" title={pkg.manifest.description}>{pkg.manifest.title}</span>
        <span className={cn('text-xs', pkg.connected ? tone('ok') : tone('quiet'))}>
          {pkg.enabled ? (pkg.connected ? 'running' : 'enabled') : 'disabled'}
        </span>
        <SignatureState signature={pkg.signature} />
        <NetworkState network={pkg.network} />
        <button
          type="button"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!pkg.enabled)}
          aria-label={`${pkg.enabled ? 'Disable' : 'Enable'} ${pkg.name}`}
          className="inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer disabled:opacity-50"
        >
          <Power className="w-3.5 h-3.5" /> {pkg.enabled ? 'disable' : 'enable'}
        </button>
      </div>
      <p className="mt-1 text-xs text-on-surface-variant">
        tools: {Object.entries(pkg.manifest.tools).map(([t, d]) => `${t} (${d.effect})`).join(', ')}
        {' · '}hosts: {hosts.length ? hosts.join(', ') : 'none'}
      </p>
      <p className="mt-1 text-xs text-on-surface-variant" data-testid="plugin-network-detail">{pkg.network.detail}</p>
      {pkg.signature && pkg.signature.status !== 'valid' && pkg.signature.status !== 'unsigned' && (
        <p className="mt-1 text-xs text-on-surface-variant">{pkg.signature.detail}</p>
      )}
      {pkg.problem && (
        <p className="mt-1 text-xs text-error inline-flex items-center gap-1" data-testid="plugin-problem">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0" /> {pkg.problem}
        </p>
      )}
      <ContentReview pkg={pkg} />
      {error && <p role="alert" className="mt-1 text-xs text-error">! {error}</p>}
    </li>
  );
}

/** Install from a directory on the server or an https tarball (which must be signed by a trusted publisher). */
function InstallForm() {
  const qc = useQueryClient();
  const [source, setSource] = useState('');
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const install = useMutation({
    mutationFn: (s: string) => api.post<PluginInstallResult>('/plugin-packages', s.startsWith('https://') ? { url: s } : { path: s }),
    onSuccess: (res) => {
      setSource('');
      setMessage({ kind: 'ok', text: `Installed ${res.name} ${res.version} (disabled).${res.warnings?.length ? ` ${res.warnings.join(' ')}` : ''}` });
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
    },
    onError: (err: Error) => setMessage({ kind: 'error', text: err.message }),
  });
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      aria-label="Install a plugin package"
      onSubmit={(e) => { e.preventDefault(); if (source.trim()) install.mutate(source.trim()); }}
    >
      <input
        aria-label="Package directory or https URL"
        placeholder="/opt/plugins/finapi or https://…/finapi-1.0.0.tar.gz"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        className="flex-1 min-w-64 bg-surface-container-high border border-outline-variant rounded-md py-1 px-2 text-on-surface text-sm"
      />
      <button type="submit" disabled={install.isPending || !source.trim()} className="px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50">
        Install
      </button>
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={cn('w-full text-xs', message.kind === 'error' ? 'text-error' : 'text-on-surface-variant')}>{message.text}</p>}
    </form>
  );
}

/**
 * Admin → Plugin packages (docs/PLUGIN-PACKAGES.md): what is installed, who
 * signed it, whether its network is enforced, and content waiting for
 * approval after a hash mismatch.
 */
export default function AdminPluginPackagesPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: PLUGIN_PACKAGES_KEY,
    queryFn: () => api.get<PluginPackageView[]>('/plugin-packages'),
    refetchInterval: 15_000,
  });
  const packages = data ?? [];
  return (
    <div className="space-y-4" data-testid="admin-plugin-packages">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="section-label">plugin packages</h2>
          <p className="mt-1 text-xs text-on-surface-variant">
            Connections to other systems, each its own process with only its declared tools and hosts. A package starts
            disabled; one whose files changed since they were approved does not start until its new content is approved.
            A package from a URL must be signed by a publisher in <code>plugins.trustedPublishers</code>.
          </p>
        </div>
        <Link href="/admin/plugins/browse" className="text-xs text-primary hover:underline">browse registries →</Link>
      </div>
      <InstallForm />
      {error && <p role="alert" className="text-xs text-error">! {(error as Error).message}</p>}
      {isLoading ? (
        <div className="p-8 text-center text-on-surface-variant">Loading…</div>
      ) : packages.length === 0 ? (
        <div className="p-8 text-center text-on-surface-variant border border-outline-variant/40 rounded-xs border-dashed">
          <p aria-hidden className="text-[16px] text-outline mb-1">[ ]</p>
          <p className="text-[12px]">no plugin packages installed</p>
        </div>
      ) : (
        <ul className="term-frame rounded-xs divide-y divide-outline-variant/10">
          {packages.map((p) => <PackageRow key={p.name} pkg={p} />)}
        </ul>
      )}
    </div>
  );
}
