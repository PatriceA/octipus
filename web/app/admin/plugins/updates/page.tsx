'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { problemsOf } from '@/components/business/common';
import { ConsentDialog } from '@/components/plugins/consent-dialog';
import { api } from '@/lib/api';
import {
  displayText,
  PLUGIN_PACKAGES_KEY,
  PLUGIN_REVOCATIONS_KEY,
  PLUGIN_UPDATES_KEY,
  type PluginRevocationRow,
  type PluginUpdateView,
  registryLabel,
} from '@/lib/plugin-packages';
import { cn } from '@/lib/utils';

/** Clearing a revocation: always with a reason, which the audit log keeps. */
function ClearRevocation({ r }: { r: PluginRevocationRow }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const clear = useMutation({
    mutationFn: () => api.delete<{ cleared: boolean; note: string }>(`/plugin-packages/revocations/${encodeURIComponent(r.id)}`, { reason: reason.trim() }),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: PLUGIN_REVOCATIONS_KEY });
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
    },
  });
  if (r.clearedAt) return <span className="text-xs text-on-surface-variant">cleared: {displayText(r.clearReason)}</span>;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-on-surface-variant underline hover:text-on-surface" aria-label={`Clear the revocation of ${displayText(r.name ?? r.keyId)}`}>
        clear
      </button>
    );
  }
  const id = `clear-${r.id}`;
  return (
    <form className="flex w-full flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) clear.mutate(); }}>
      <label htmlFor={id} className="text-xs text-on-surface">Why clear it? (kept in the audit log)</label>
      <input id={id} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required
        className="min-w-48 flex-1 rounded-md border border-outline-variant bg-surface-container-high px-2 py-1 text-sm text-on-surface" />
      <button type="submit" disabled={reason.trim().length < 3 || clear.isPending} className="rounded-xs bg-primary px-2 py-1 text-xs text-on-primary disabled:opacity-50">Clear revocation</button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-on-surface-variant hover:text-on-surface">Cancel</button>
      <p className="w-full text-xs text-on-surface-variant">If the marketplace still lists it, its next index revokes it again.</p>
      {clear.error && <p role="alert" className="w-full text-xs text-error">! {problemsOf(clear.error)}</p>}
    </form>
  );
}

/**
 * Admin → Plugins → Updates: installed packages with a newer version from the
 * same source, each with what changes in what it asks for (what widens
 * stands out); Upgrade goes through the consent. Below, the revocations the
 * marketplace published, each clearable with a reason.
 */
export default function UpdatesPage() {
  const qc = useQueryClient();
  const [upgrading, setUpgrading] = useState<PluginUpdateView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const updates = useQuery({ queryKey: PLUGIN_UPDATES_KEY, queryFn: () => api.get<PluginUpdateView[]>('/plugin-packages/updates') });
  const revocations = useQuery({ queryKey: PLUGIN_REVOCATIONS_KEY, queryFn: () => api.get<PluginRevocationRow[]>('/plugin-packages/revocations') });
  const list = updates.data ?? [];
  const revoked = revocations.data ?? [];
  return (
    <div className="space-y-6" data-testid="admin-plugin-updates">
      <section className="space-y-2" aria-labelledby="updates-title">
        <h2 id="updates-title" className="section-label">updates</h2>
        <p className="text-xs text-on-surface-variant">Newer versions from the source each package was installed from. Upgrades are never automatic.</p>
        {message && <p role="status" className="text-xs text-on-surface" data-testid="updates-message">{message}</p>}
        {updates.error && <p role="alert" className="text-xs text-error">! {problemsOf(updates.error)}</p>}
        {updates.isLoading ? <p className="text-xs text-on-surface-variant">Loading…</p> : list.length === 0 ? (
          <p className="rounded-xs border border-dashed border-outline-variant/40 p-4 text-center text-xs text-on-surface-variant">Everything installed from a registry is up to date.</p>
        ) : (
          <ul className="term-frame divide-y divide-outline-variant/10 rounded-xs">
            {list.map((u) => (
              <li key={u.name} className="space-y-1 px-4 py-3 text-sm" data-testid="plugin-update" data-name={u.name}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium text-on-surface">{displayText(u.name)}</span>
                  <span className="text-xs text-on-surface-variant">{displayText(u.installed)} → {displayText(u.latest)} · {registryLabel(u.registry)}</span>
                  {u.diff?.widened && <span className="rounded-xs border border-warning/60 px-1 text-[11px] text-warning">asks for more</span>}
                  <span className="flex-1" />
                  <button type="button" onClick={() => setUpgrading(u)} className="inline-flex items-center gap-1 rounded-xs bg-primary px-2 py-1 text-xs text-on-primary" aria-label={`Upgrade ${u.name} to ${u.latest}`}>
                    <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden /> Upgrade
                  </button>
                </div>
                {u.diff === null ? <p className="text-xs text-warning">The registry does not list what this version asks for.</p>
                  : u.diff.changes.length === 0 ? <p className="text-xs text-on-surface-variant">Asks for nothing new.</p> : (
                    <ul className="space-y-0.5 text-xs" aria-label={`What changes in ${u.name}`}>
                      {u.diff.changes.map((c) => (
                        <li key={`${c.kind}-${c.text}`} data-widens={c.widens} className={cn(c.widens ? 'font-medium text-warning' : 'text-on-surface-variant')}>
                          {c.widens ? '+ ' : '− '}{c.change} {displayText(c.text)}
                        </li>
                      ))}
                    </ul>
                  )}
                {u.warnings.filter((w) => w.code !== 'widens').map((w) => <p key={`${w.code}-${w.message}`} className="text-xs text-on-surface-variant">{displayText(w.message)}</p>)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="revocations-title">
        <h2 id="revocations-title" className="section-label">revocations</h2>
        <p className="text-xs text-on-surface-variant">
          Versions and keys the marketplace revoked. They apply to packages installed from the marketplace only: a revoked version does not
          start and cannot be enabled. One published by a key revoked since (a version revoked by a signing key, or a key revoked by a root key that the
          backup root revoked) is not enforced until a trusted key lists it again.
        </p>
        {revocations.error && <p role="alert" className="text-xs text-error">! {problemsOf(revocations.error)}</p>}
        {revoked.length === 0 ? <p className="text-xs text-on-surface-variant">None.</p> : (
          <ul className="term-frame divide-y divide-outline-variant/10 rounded-xs">
            {revoked.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs" data-testid="plugin-revocation" data-id={r.id} data-enforced={r.enforced}>
                <ShieldOff className={cn('h-3.5 w-3.5', r.enforced ? 'text-error' : 'text-on-surface-variant')} aria-hidden />
                <span className="font-medium text-on-surface">{r.kind === 'package' ? `${displayText(r.name)} ${displayText(r.version)}` : <code className="font-mono">{displayText(r.keyId)}</code>}</span>
                {r.signerRevoked && !r.clearedAt && (
                  <span className="rounded-xs border border-warning/60 px-1 text-[11px] text-warning" data-testid="revocation-signer-revoked" title={`Signed by ${r.signedByKey}, revoked since`}>
                    from a revoked signer · not enforced
                  </span>
                )}
                <span className="flex-1 text-on-surface-variant">{displayText(r.reason) || 'no reason given'} · since {new Date(r.firstSeenAt).toLocaleDateString()}</span>
                <ClearRevocation r={r} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {upgrading && (
        <ConsentDialog
          source={{ kind: 'preview', body: { registry: upgrading.registry, name: upgrading.name, version: upgrading.latest } }}
          onClose={() => setUpgrading(null)}
          onDone={(result) => {
            setUpgrading(null);
            setMessage(`${result.name} is now ${result.version}${result.enabled ? ', enabled' : ', disabled'}.${result.enableProblem ? ` Not enabled: ${result.enableProblem}.` : ''}`);
            void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
          }}
        />
      )}
    </div>
  );
}
