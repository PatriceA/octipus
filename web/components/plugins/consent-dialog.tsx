'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CircleCheck, Info, ShieldCheck, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
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

/** How long Install stays disabled once the declarations show, so a click aimed at what was there before cannot land on it (as the plugin page's confirm). */
export const CONSENT_ARM_DELAY_MS = 700;

/** What the consent is for: a package to download, verify and stage (`POST /preview`), or an installed one (`GET /:name/consent`). */
export type ConsentSource =
  | { kind: 'preview'; body: Record<string, unknown> }
  | { kind: 'installed'; name: string };

interface ConsentData {
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
  const query = useQuery({
    queryKey: ['plugin-consent', source],
    queryFn: () => load(source),
    retry: false,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const data = query.data;
  useEffect(() => {
    if (!data) return;
    const timer = setTimeout(() => setArmed(true), CONSENT_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [data]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [onClose]);
  const required = data ? requiredConsentIds(data.declarations) : [];
  const allTicked = required.every((id) => ticked[id]);
  const submit = useMutation({
    mutationFn: () => {
      if (!data) throw new Error('Nothing to agree to');
      // Every required item, and an optional choice only when ticked (never pre-ticked).
      const accepted = data.declarations.filter((i) => !i.carried && ticked[i.id] === true).map((i) => i.id);
      return data.previewId
        ? api.post<PluginConsentResult>('/plugin-packages/install', { previewId: data.previewId, contentHash: data.contentHash, accepted, enable })
        : api.post<PluginConsentResult>(`/plugin-packages/${encodeURIComponent(data.name)}/consent`, { contentHash: data.contentHash, accepted, enable });
    },
    onSuccess: (result) => onDone(result),
  });
  const upgrade = data?.upgradeFrom !== null && data?.upgradeFrom !== undefined;
  const action = source.kind === 'installed' ? (enable ? 'Agree and enable' : 'Agree') : upgrade ? 'Upgrade' : 'Install';

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
                {data ? `${action} ${displayText(data.title)}` : source.kind === 'preview' ? 'Checking the package…' : 'Reading the package…'}
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
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-xs p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {query.isLoading && <p className="text-xs text-on-surface-variant" role="status">Downloading and verifying the signature, the listing and the content hash…</p>}
            {query.error && <p role="alert" className="whitespace-pre-line text-xs text-error">! {problemsOf(query.error)}</p>}
            {data && (
              <>
                <p className="text-xs text-on-surface">
                  It declares what it will do. Tick each item to agree to it; {source.kind === 'installed' ? 'enabling' : 'the install'} runs only
                  with every item agreed, for exactly this content:{' '}
                  <code className="break-all font-mono text-on-surface-variant" data-testid="consent-content-hash">{data.contentHash}</code>
                </p>
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
                            <p id={`${id}-detail`} className="break-all font-mono text-xs text-on-surface-variant">{displayText(item.detail)}</p>
                            {item.guidance && <Guidance text={item.guidance} tone={guidanceTone(item)} />}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {submit.error && <p role="alert" className="whitespace-pre-line text-xs text-error">! {problemsOf(submit.error)}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-outline-variant/60 px-4 py-3">
            <label className="flex items-center gap-2 text-xs text-on-surface">
              <input type="checkbox" className="h-4 w-4 accent-primary" checked={enable} onChange={(e) => setEnable(e.target.checked)} disabled={submit.isPending} />
              {source.kind === 'installed' ? 'Enable it now' : 'Enable after install'}
            </label>
            <span className="flex-1 text-xs text-on-surface-variant" aria-live="polite" data-testid="consent-progress">
              {data ? `${required.filter((x) => ticked[x]).length} of ${required.length} agreed` : ''}
            </span>
            <button type="button" onClick={onClose} className="rounded-xs border border-outline-variant px-3 py-1.5 text-xs text-on-surface hover:bg-surface-container-high">
              Cancel
            </button>
            <button
              type="button"
              disabled={!data || !armed || !allTicked || submit.isPending}
              onClick={() => submit.mutate()}
              className="inline-flex items-center gap-1 rounded-xs bg-primary px-3 py-1.5 text-xs font-medium text-on-primary disabled:opacity-50"
            >
              <CircleCheck className="h-3.5 w-3.5" aria-hidden /> {action}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
