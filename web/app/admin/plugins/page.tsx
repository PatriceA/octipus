'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Power, Settings2, ShieldAlert, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { FieldInputs, type FieldValues, fromFieldValues, problemsOf, toFieldValues } from '@/components/business/common';
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

/**
 * A package's settings, typed by its manifest's fields, saved in one PATCH
 * (the server checks them; all or nothing). A required setting cannot be
 * cleared while the package is enabled.
 */
function SettingsForm({ pkg }: { pkg: PluginPackageView }) {
  const qc = useQueryClient();
  const fields = pkg.manifest.settings ?? [];
  const [values, setValues] = useState<FieldValues>(() => toFieldValues(fields, pkg.settings));
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const save = useMutation({
    mutationFn: (v: FieldValues) => api.patch<PluginPackageView>(`/plugin-packages/${encodeURIComponent(pkg.name)}`, { settings: fromFieldValues(fields, v) }),
    onSuccess: (view) => {
      setValues(toFieldValues(fields, view.settings));
      setMessage({ kind: 'ok', text: 'Settings saved.' });
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
    },
    onError: (err: Error) => setMessage({ kind: 'error', text: problemsOf(err) }),
  });
  if (fields.length === 0) return <p className="text-xs text-on-surface-variant">No settings.</p>;
  return (
    <form
      aria-label={`Settings of ${pkg.name}`}
      className="space-y-2"
      onSubmit={(e) => { e.preventDefault(); setMessage(null); save.mutate(values); }}
    >
      <FieldInputs fields={fields} values={values} onChange={setValues} disabled={save.isPending} idPrefix={`plugin-${pkg.name}-setting`} />
      <button type="submit" disabled={save.isPending} className="px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50">
        Save settings
      </button>
      <Message message={message} />
    </form>
  );
}

type FormMessage = { kind: 'error' | 'ok'; text: string } | null;

function Message({ message }: { message: FormMessage }) {
  if (!message) return null;
  return (
    <p role={message.kind === 'error' ? 'alert' : 'status'} className={cn('text-xs whitespace-pre-line', message.kind === 'error' ? 'text-error' : 'text-on-surface-variant')}>
      {message.kind === 'error' ? `! ${message.text}` : message.text}
    </p>
  );
}

type SecretDecl = NonNullable<PluginPackageView['manifest']['secrets']>[number];

/**
 * One declared secret: whether it has a value (never the value), a field to
 * set a new one (write-only, emptied once saved) and, when set, Clear.
 */
function SecretRow({ pkg, secret }: { pkg: PluginPackageView; secret: SecretDecl }) {
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<FormMessage>(null);
  const isSet = pkg.secretsSet.includes(secret.key);
  const put = useMutation({
    mutationFn: (v: string | null) => api.put<{ saved: boolean }>(`/plugin-packages/${encodeURIComponent(pkg.name)}/secrets/${encodeURIComponent(secret.key)}`, { value: v }),
    onSuccess: (_res, v) => {
      setValue('');
      setMessage({ kind: 'ok', text: v === null ? `${secret.label} cleared.` : `${secret.label} saved.` });
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
    },
    onError: (err: Error) => setMessage({ kind: 'error', text: problemsOf(err) }),
  });
  const id = `plugin-${pkg.name}-secret-${secret.key}`;
  return (
    <form
      aria-label={`Secret ${secret.key} of ${pkg.name}`}
      data-testid="plugin-secret"
      data-key={secret.key}
      className="space-y-1"
      onSubmit={(e) => { e.preventDefault(); if (value.trim()) { setMessage(null); put.mutate(value); } }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="text-xs font-medium text-on-surface-variant">
          {secret.label}{secret.required ? ' *' : ''} <code className="font-mono">{secret.key}</code>
        </label>
        <span className={cn('text-xs', isSet ? tone('ok') : secret.required ? tone('warn') : tone('quiet'))} data-testid="plugin-secret-state">
          {isSet ? 'set' : 'not set'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          placeholder={isSet ? 'a new value replaces the stored one' : 'value'}
          value={value}
          disabled={put.isPending}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 min-w-48 bg-surface-container-high border border-outline-variant rounded-md py-1 px-2 text-on-surface text-sm"
        />
        <button type="submit" disabled={put.isPending || !value.trim()} className="px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50">
          {isSet ? 'Replace' : 'Set'}
        </button>
        {isSet && (
          <button
            type="button"
            disabled={put.isPending}
            onClick={() => { if (confirm(`Clear ${secret.label} of ${pkg.name}?`)) { setMessage(null); put.mutate(null); } }}
            className="px-2 py-1 rounded-xs text-xs text-on-surface-variant hover:text-on-surface cursor-pointer disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>
      {secret.help && <p className="text-xs text-on-surface-variant">{secret.help}</p>}
      <Message message={message} />
    </form>
  );
}

/** Settings and secrets of a package, opened from its row. */
function PackageConfig({ pkg }: { pkg: PluginPackageView }) {
  const secrets = pkg.manifest.secrets ?? [];
  return (
    <div className="mt-2 space-y-3 rounded-xs border border-outline-variant/40 p-3" role="group" aria-label={`Configure ${pkg.name}`}>
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-on-surface">settings</h3>
        <SettingsForm pkg={pkg} />
      </section>
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-on-surface">secrets</h3>
        <p className="text-xs text-on-surface-variant">Kept in the vault and handed only to the package; a stored value is never shown.</p>
        {secrets.length === 0
          ? <p className="text-xs text-on-surface-variant">No secrets.</p>
          : secrets.map((s) => <SecretRow key={s.key} pkg={pkg} secret={s} />)}
      </section>
    </div>
  );
}

function PackageRow({ pkg }: { pkg: PluginPackageView }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const uninstall = useMutation({
    mutationFn: () => api.delete<{ uninstalled: boolean }>(`/plugin-packages/${encodeURIComponent(pkg.name)}`),
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY }); },
    onError: (err: Error) => setError(problemsOf(err)),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch<PluginPackageView>(`/plugin-packages/${encodeURIComponent(pkg.name)}`, { enabled }),
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY }); },
    // A refusal can come from files changed since the page loaded: reload, so the review shows.
    onError: (err: Error) => { setError(problemsOf(err)); void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY }); },
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
        <button
          type="button"
          onClick={() => setConfiguring((c) => !c)}
          aria-expanded={configuring}
          aria-label={`Configure ${pkg.name}`}
          className="inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer"
        >
          <Settings2 className="w-3.5 h-3.5" /> configure
        </button>
        <button
          type="button"
          disabled={uninstall.isPending}
          onClick={() => {
            if (confirm(`Uninstall ${pkg.name}? Its files, data directory, settings and secrets are deleted.`)) uninstall.mutate();
          }}
          aria-label={`Uninstall ${pkg.name}`}
          className="inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-error cursor-pointer disabled:opacity-50"
        >
          <Trash2 className="w-3.5 h-3.5" /> uninstall
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
      {configuring && <PackageConfig pkg={pkg} />}
      {error && <p role="alert" className="mt-1 text-xs text-error whitespace-pre-line">! {error}</p>}
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
 * signed it, whether its network is enforced, content waiting for approval
 * after a hash mismatch, its settings and secrets (write-only), and uninstall.
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
