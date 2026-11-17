'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CircleCheck, Info, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { problemsOf } from '@/components/business/common';
import { Portal } from '@/components/ui/portal';
import { api } from '@/lib/api';
import {
  displayText,
  guidanceTone,
  originLabel,
  type PluginConsentItem,
  type PluginConsentResult,
  type PluginConsentView,
  type PluginGuidanceWarning,
  type PluginInstallPreview,
  type PluginPermissionDiff,
  requiredConsentIds,
} from '@/lib/plugin-packages';
import { cn } from '@/lib/utils';
import { SetupFields } from './setup-fields';
import { CompanionServices } from './companion-services';
import { fromFieldValues, toFieldValues, type FieldValues } from '@/components/business/common';
import type { PluginSetupConfiguration, PluginSetupDraft, PluginSetupCheck } from '../../../src/shared/plugin-setup';

/** How long Install stays disabled once the declarations show, so a click aimed at what was there before cannot land on it (as the plugin page's confirm). */
export const CONSENT_ARM_DELAY_MS = 700;

/** What the consent is for: a package to download, verify and stage (`POST /preview`), or an installed one (`GET /:name/consent`). */
export type ConsentSource =
  | { kind: 'preview'; body: Record<string, unknown> }
  | { kind: 'installed'; name: string };

interface ConsentData {
  configuration?: PluginSetupConfiguration;
  name: string;
  version: string;
  title: string;
  contentHash: string;
  signedBy: string | null;
  origin: PluginInstallPreview['origin'] | null;
  declarations: PluginConsentItem[];
  guidance: PluginGuidanceWarning[];
  diff: PluginPermissionDiff | null;
  upgradeFrom: string | null;
  previewId: string | null;
}

async function load(source: ConsentSource): Promise<ConsentData> {
  if (source.kind === 'preview') {
    const p = await api.post<PluginInstallPreview>('/plugin-packages/preview', source.body);
    return { ...p, previewId: p.previewId };
  }
  const v = await api.get<PluginConsentView>(`/plugin-packages/${encodeURIComponent(source.name)}/consent`);
  return { ...v, diff: null, upgradeFrom: null, previewId: null };
}

function Guidance({ text, tone }: { text: string; tone: 'warning' | 'info' }) {
  const Icon = tone === 'warning' ? AlertTriangle : Info;
  return (
    <p className={cn('mt-1 flex items-start gap-1 text-xs', tone === 'warning' ? 'text-warning' : 'text-on-surface-variant')} data-testid="consent-guidance" data-tone={tone}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span><span className="sr-only">{tone === 'warning' ? 'Warning: ' : 'Note: '}</span>{displayText(text)}</span>
    </p>
  );
}

/**
 * The install consent (docs/PLUGIN-PACKAGES.md#installing-and-managing):
 * every declaration as a row with a checkbox, its plain words and what
 * exactly is declared, and the guidance under it, never blocking. In an
 * upgrade, items unchanged and agreed to before are ticked and greyed; new
 * and changed ones are marked. Install stays disabled until every required
 * item is ticked, and for a moment after the list shows. An optional item
 * (handing the stored data to a new publisher) is a choice, never pre-ticked,
 * sent only when ticked. What is agreed to
 * is bound to the content hash shown: the server refuses anything else.
 */
export function ConsentDialog({ source, onClose, onDone, enableByDefault }: {
  source: ConsentSource;
  onClose: () => void;
  onDone: (result: PluginConsentResult) => void;
  enableByDefault?: boolean;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [enable, setEnable] = useState(enableByDefault ?? source.kind === 'installed');
  const [armed, setArmed] = useState(false);
  const [stage, setStage] = useState<'configure' | 'review' | 'test' | 'ready'>('review');
  const [values, setValues] = useState<FieldValues>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [setupError, setSetupError] = useState('');
  const [savedAt, setSavedAt] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [recoveryName, setRecoveryName] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PluginConsentResult | null>(null);
  const revision = useRef(0);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const effectiveSource: ConsentSource = recoveryName ? { kind: 'installed', name: recoveryName } : source;
  const query = useQuery({
    queryKey: ['plugin-consent', effectiveSource],
    queryFn: () => load(effectiveSource),
    retry: false,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const data = query.data;
  useEffect(() => {
    if (!data?.configuration) return;
    let cancelled = false;
    api.get<{ draft: PluginSetupDraft | null }>(`/plugin-packages/setup/${encodeURIComponent(data.name)}/draft`).then(({ draft }) => {
      if (cancelled) return;
      setTicked({});
      revision.current = draft?.revision ?? 0;
      const configuration = data.configuration!;
      const initial = draft?.contentHash === data.contentHash ? draft.settings : configuration.settings;
      setValues(toFieldValues(configuration.fields, initial));
      setStage(configuration.fields.length || configuration.secrets.some(s => !s.configured) ? 'configure' : 'review');
      if (enableByDefault === undefined) setEnable(true);
      setHydrated(true);
    }).catch(error => { if (!cancelled) setSetupError(`Could not restore setup: ${problemsOf(error)}`); });
    return () => { cancelled = true; };
  }, [data, query.dataUpdatedAt, enableByDefault]);
  const saveDraft = useCallback(async () => {
    if (!data?.configuration || !hydrated) return Promise.resolve();
    const settings = fromFieldValues(data.configuration.fields, values);
    const next = saving.current.then(async () => {
      const result = await api.put<{ draft: PluginSetupDraft }>(`/plugin-packages/setup/${encodeURIComponent(data.name)}/draft`, {
        previewId: data.previewId ?? undefined, contentHash: data.contentHash, settings, revision: revision.current,
        stage: stage === 'configure' ? 'configure' : 'review',
      });
      revision.current = result.draft.revision;
      setSavedAt(result.draft.updatedAt);
    });
    saving.current = next.catch(error => { setSetupError(problemsOf(error)); });
    return next;
  }, [data, hydrated, values, stage]);
  useEffect(() => {
    if (!hydrated || stage !== 'configure' && stage !== 'review') return;
    const timer = setTimeout(() => { void saveDraft().catch(error => setSetupError(problemsOf(error))); }, 800);
    return () => clearTimeout(timer);
    // Save only edits, not the save receipt itself.
  }, [saveDraft, hydrated, stage]);
  const preflight = useMutation({
    mutationFn: async () => {
      if (!data?.configuration) return;
      for (const secret of data.configuration.secrets) if (secret.required && !secret.configured && !secretValues[secret.key]?.trim()) throw new Error(`${secret.label} is required. Enter it here; it goes directly to the vault on install.`);
      await api.post(`/plugin-packages/setup/${encodeURIComponent(data.name)}/preflight`, { previewId: data.previewId ?? undefined, contentHash: data.contentHash, settings: fromFieldValues(data.configuration.fields, values) });
      await saveDraft();
    },
    onSuccess: () => { setSetupError(''); setStage('review'); },
  });
  const connectionCheck = useMutation({
    mutationFn: (result: PluginConsentResult) => api.post<PluginSetupCheck>(`/plugin-packages/setup/${encodeURIComponent(result.name)}/check`, { contentHash: result.contentHash }),
    onSuccess: check => { setReceipt(current => current ? { ...current, check } : null); setStage(check.ok ? 'ready' : 'test'); },
  });
  useEffect(() => {
    if (!data) return;
    const timer = setTimeout(() => setArmed(true), CONSENT_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [data]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (receipt) onDone(receipt); else onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [onClose, onDone, receipt]);
  const required = data ? requiredConsentIds(data.declarations) : [];
  const allTicked = required.every((id) => ticked[id]);
  const submit = useMutation({
    mutationFn: () => {
      if (!data) throw new Error('Nothing to agree to');
      // Every required item, and an optional choice only when ticked (never pre-ticked).
      const accepted = data.declarations.filter((i) => !i.carried && ticked[i.id] === true).map((i) => i.id);
      const configuration = data.configuration ? { settings: fromFieldValues(data.configuration.fields, values), secrets: secretValues } : {};
      return data.previewId && !data.configuration?.installed
        ? api.post<PluginConsentResult>('/plugin-packages/install', { previewId: data.previewId, contentHash: data.contentHash, accepted, enable, ...configuration })
        : api.post<PluginConsentResult>(`/plugin-packages/${encodeURIComponent(data.name)}/consent`, { contentHash: data.contentHash, accepted, enable, ...configuration });
    },
    onSuccess: result => {
      if (!data?.configuration) { onDone(result); return; }
      setSecretValues({}); setReceipt(result);
      if (result.enableProblem) { setSetupError(result.enableProblem); setRecoveryName(result.name); return; }
      if (result.enabled && data.configuration.check) { setStage('test'); connectionCheck.mutate(result); }
      else setStage('ready');
    },
  });
  const recover = useMutation({ mutationFn: () => data ? load({ kind: 'installed', name: data.name }) : Promise.reject(new Error('No package to inspect')),
    onSuccess: installed => {
      if (installed.contentHash !== data?.contentHash) { setSetupError('The installed content differs. Close this dialog and review the installed package.'); return; }
      setSecretValues({}); setRecoveryName(installed.name); setSetupError('Installation was found. Continue configuration without reinstalling. Vault values are not read back; enter a replacement only if you need to change one.');
    } });
  const upgrade = data?.upgradeFrom !== null && data?.upgradeFrom !== undefined;
  const action = data?.configuration?.installed ? (enable ? 'Apply and enable' : 'Save configuration') : source.kind === 'installed' ? (enable ? 'Agree and enable' : 'Agree') : upgrade ? 'Upgrade' : 'Install';

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 font-sans">
        <div
          ref={dialog}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="plugin-consent"
          className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-outline-variant bg-surface-container shadow-2xl outline-none"
        >
          <div className="flex items-start gap-2 border-b border-outline-variant/60 px-4 py-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-sm font-semibold text-on-surface">
                {data ? `${data.configuration ? 'Set up' : action} ${displayText(data.title)}` : source.kind === 'preview' ? 'Checking the package…' : 'Reading the package…'}
              </h2>
              {data && (
                <p className="mt-0.5 text-xs text-on-surface-variant">
                  <code className="font-mono">{displayText(data.name)}</code> {displayText(data.version)}
                  {upgrade && <> (installed: {displayText(data.upgradeFrom)})</>}
                  {' · '}{originLabel(data.origin)}
                  {' · '}{data.signedBy ? `signed by ${displayText(data.signedBy)}` : 'not signed by a trusted publisher'}
                </p>
              )}
            </div>
            <button type="button" onClick={() => receipt ? onDone(receipt) : onClose()} aria-label="Close" className="rounded-xs p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {data?.configuration && <nav aria-label="Plugin setup progress" className="flex flex-wrap gap-3 border-b border-outline-variant pb-3 text-xs">{(['configure', 'review', 'test', 'ready'] as const).map((step, index) => <span key={step} aria-current={step === stage ? 'step' : undefined} className={step === stage ? 'font-semibold text-primary' : 'text-on-surface-variant'}>{index + 1}. { { configure: 'Connect resources', review: 'Review access', test: 'Check readiness', ready: 'Ready' }[step]}</span>)}</nav>}
            {query.isLoading && <p className="text-xs text-on-surface-variant" role="status">Downloading and verifying the signature, the listing and the content hash…</p>}
            {query.error && <p role="alert" className="whitespace-pre-line text-xs text-error">! {problemsOf(query.error)}</p>}
            {data?.configuration && stage === 'configure' && <SetupFields configuration={data.configuration} values={values} onChange={setValues} secrets={secretValues} onSecrets={setSecretValues} disabled={submit.isPending || !hydrated} />}
            {data?.configuration?.companions?.length && (stage === 'configure' || stage === 'test') ? <CompanionServices companions={data.configuration.companions} plugin={receipt?.name ?? (data.configuration.installed ? data.name : undefined)} /> : null}
            {data?.configuration && !hydrated && <p role="status" className="text-xs text-on-surface-variant">Restoring saved configuration…</p>}
            {setupError && <p role="alert" className="text-sm text-error">{setupError}</p>}
            {preflight.error && <p role="alert" className="text-sm text-error">{problemsOf(preflight.error)}</p>}
            {data && stage === 'review' && (
              <>
                {data.configuration && <>
                  <p className="text-sm text-on-surface">{data.configuration.installed ? 'This exact package is already installed. Setup will configure it without installing it again.' : 'Local use does not require marketplace publishing or your own signing key.'}</p>
                  <details className="rounded-lg border border-outline-variant p-3"><summary className="cursor-pointer text-sm">Selected resources and settings</summary><dl className="mt-2 space-y-2 text-xs">{Object.entries(fromFieldValues(data.configuration.fields, values)).map(([key, value]) => <div key={key}><dt className="font-medium">{data.configuration?.fields.find(f => f.key === key)?.label ?? key}</dt><dd className="whitespace-pre-wrap break-all text-on-surface-variant">{String(value)}</dd></div>)}</dl></details>
                </>}
                <p className="text-xs text-on-surface">
                  Review what this plugin can do. Approve its required access together, or inspect the individual items. Optional choices remain yours.
                </p>
                <details className="text-xs text-on-surface-variant"><summary className="cursor-pointer">Technical verification</summary><code className="break-all font-mono" data-testid="consent-content-hash">{data.contentHash}</code></details>
                {data.guidance.length > 0 && (
                  <div className="space-y-0.5" data-testid="consent-notes">
                    {data.guidance.map((g) => <Guidance key={`${g.code}-${g.message}`} text={g.message} tone={g.code === 'deprecated' || g.code === 'signature' || g.code === 'incompatible' ? 'warning' : 'info'} />)}
                  </div>
                )}
                {data.diff && data.diff.changes.length > 0 && (
                  <section aria-label="What changes from the installed version" data-testid="consent-diff" className="rounded-xs border border-outline-variant/50 p-2">
                    <h3 className="text-xs font-medium text-on-surface">What changes from {displayText(data.upgradeFrom)}</h3>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {data.diff.changes.map((c) => (
                        <li key={`${c.kind}-${c.text}`} className={c.widens ? 'text-warning' : 'text-on-surface-variant'} data-widens={c.widens}>
                          {c.widens ? 'asks for more: ' : ''}{c.change} {displayText(c.text)}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                <label className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm font-medium"><input type="checkbox" className="mt-0.5 accent-primary" checked={allTicked} disabled={submit.isPending} onChange={e => setTicked(current => ({ ...current, ...Object.fromEntries(required.map(id => [id, e.target.checked])) }))} />Approve all required access described below for this package</label>
                <ul className="space-y-1.5" aria-label="Declarations">
                  {data.declarations.map((item) => {
                    const id = `consent-${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
                    const fresh = upgrade && !item.carried;
                    return (
                      <li
                        key={item.id}
                        data-testid="consent-item"
                        data-id={item.id}
                        data-carried={item.carried}
                        data-status={item.status}
                        className={cn(
                          'rounded-xs border px-2 py-1.5',
                          item.carried ? 'border-outline-variant/30 bg-surface-container-low' : fresh ? 'border-primary/60 bg-primary/5' : 'border-outline-variant/50',
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            id={id}
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                            checked={item.carried || ticked[item.id] === true}
                            disabled={item.carried || submit.isPending}
                            onChange={(e) => setTicked((t) => ({ ...t, [item.id]: e.target.checked }))}
                            aria-describedby={`${id}-detail`}
                          />
                          <div className="min-w-0 flex-1">
                            <label htmlFor={id} className="text-sm text-on-surface">
                              {displayText(item.label)}
                              {item.carried && <span className="ml-2 text-xs text-on-surface-variant">(unchanged, agreed before)</span>}
                              {fresh && item.status === 'new' && <span className="ml-2 rounded-xs bg-primary px-1 text-[11px] font-medium text-on-primary">new</span>}
                              {fresh && item.status === 'changed' && <span className="ml-2 rounded-xs bg-primary px-1 text-[11px] font-medium text-on-primary">changed</span>}
                              {item.optional && <span className="ml-2 text-xs text-on-surface-variant" data-testid="consent-optional">(optional: left unticked, it is not done)</span>}
                            </label>
                            <details className="text-xs text-on-surface-variant"><summary className="cursor-pointer">Details</summary><p id={`${id}-detail`} className="break-all font-mono">{displayText(item.detail)}</p></details>
                            {item.guidance && <Guidance text={item.guidance} tone={guidanceTone(item)} />}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {receipt && (stage === 'test' || stage === 'ready') && <section className="space-y-3" aria-live="polite">
              <h3 className="text-lg font-semibold">{stage === 'ready' ? receipt.enabled ? 'Your plugin is ready' : 'Installed and kept disabled' : 'Checking readiness'}</h3>
              {connectionCheck.isPending && <p>Running the plugin’s declared read-only test…</p>}
              {receipt.check && <p className={receipt.check.ok ? 'text-tertiary' : 'text-error'}>{receipt.check.message}</p>}
              {connectionCheck.error && <p role="alert" className="text-error">{problemsOf(connectionCheck.error)}</p>}
              {!data?.configuration?.check && receipt.enabled && <p className="text-sm text-on-surface-variant">Enabled. This plugin does not provide an automatic connection test.</p>}
              {stage === 'test' && !connectionCheck.isPending && <button type="button" onClick={() => connectionCheck.mutate(receipt)} className="rounded-lg border border-outline-variant px-3 py-2 text-sm">Retry connection test</button>}
            </section>}
            {submit.error && <p role="alert" className="whitespace-pre-line text-xs text-error">! {problemsOf(submit.error)}</p>}
            {submit.error && data?.previewId && <button type="button" disabled={recover.isPending} onClick={() => recover.mutate()} className="text-sm text-primary underline">Check whether installation already finished</button>}
            {recover.error && <p role="alert" className="text-sm text-error">{problemsOf(recover.error)}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-outline-variant/60 px-4 py-3">
            {stage === 'review' && <label className="flex items-center gap-2 text-xs text-on-surface">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={enable} onChange={(e) => setEnable(e.target.checked)} disabled={submit.isPending} />
              {source.kind === 'installed' ? 'Enable it now' : 'Enable after install'}
            </label>}
            <span className="flex-1 text-xs text-on-surface-variant" aria-live="polite" data-testid="consent-progress">
              {stage === 'configure' ? savedAt ? 'Configuration saved · secrets stay unsaved until install' : 'Configuration saves automatically · secrets are not saved in drafts' : stage === 'review' && data ? `${required.filter((x) => ticked[x]).length} of ${required.length} agreed` : ''}
            </span>
            <button type="button" onClick={() => receipt ? onDone(receipt) : onClose()} className="rounded-xs border border-outline-variant px-3 py-1.5 text-xs text-on-surface hover:bg-surface-container-high">
              {receipt ? 'Close' : 'Cancel'}
            </button>
            {stage === 'configure' && <button type="button" disabled={preflight.isPending || !hydrated} onClick={() => preflight.mutate()} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary disabled:opacity-50">{preflight.isPending ? 'Checking…' : 'Continue to review'}</button>}
            {stage === 'review' && <>
            {data?.configuration && (data.configuration.fields.length > 0 || data.configuration.secrets.length > 0) && <button type="button" onClick={() => { setTicked({}); setStage('configure'); }} className="text-xs text-primary underline">Edit configuration</button>}
            <button
              type="button"
              disabled={!data || !armed || !allTicked || submit.isPending || !!data.configuration && !hydrated || !!submit.error && !!data.previewId && !recoveryName}
              onClick={() => submit.mutate()}
              className="inline-flex items-center gap-1 rounded-xs bg-primary px-3 py-1.5 text-xs font-medium text-on-primary disabled:opacity-50"
            >
              <CircleCheck className="h-3.5 w-3.5" aria-hidden /> {action}
            </button></>}
            {stage === 'ready' && receipt && <button type="button" onClick={() => onDone(receipt)} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary">Done</button>}
          </div>
        </div>
      </div>
    </Portal>
  );
}
