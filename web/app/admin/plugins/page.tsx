'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, CircleCheck, Cpu, Power, Settings2, ShieldAlert, ShieldOff, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { ConsentDialog, type ConsentSource } from '@/components/plugins/consent-dialog';
import { FieldInputs, type FieldValues, fromFieldValues, problemsOf, toFieldValues } from '@/components/business/common';
import { api } from '@/lib/api';
import {
  AGENT_RUN_NOTE,
  type BundledPluginView,
  displayText,
  DOCUMENTS_WRITE_NOTE,
  egressReadWarning,
  MAX_PLUGIN_SECRET_LENGTH,
  MODEL_CLI_TOOLS_APPROVAL,
  MODEL_CLI_TOOLS_WARNING,
  PLUGIN_BUNDLED_KEY,
  originLabel,
  PLUGIN_PACKAGES_KEY,
  PLUGIN_SANDBOX_KEY,
  type PluginConsentResult,
  type PluginSandboxStatus,
  type PluginNetworkStatus,
  type PluginPackageView,
  type PluginRunItem,
  type PluginSignatureStatus,
  type PluginUsageView,
} from '@/lib/plugin-packages';
import { PLUGIN_PAGES_KEY } from '@/lib/plugin-pages';
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
 * An in-process plugin (runtime `in-process`) runs in the server process with
 * its full authority, so it needs one approval more than a package: for the
 * approved content hash, shown here. Shown while that approval is missing and
 * there is no changed content to review first. The server refuses (409) a
 * hash that is no longer the approved content or no longer what the files
 * hash to.
 */
function InProcessApproval({ pkg }: { pkg: PluginPackageView }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const approve = useMutation({
    mutationFn: (hash: string) => api.patch<PluginPackageView>(`/plugin-packages/${encodeURIComponent(pkg.name)}`, { approveInProcess: hash }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
    },
    onError: (err: Error) => {
      setError(problemsOf(err));
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
    },
  });
  if (pkg.runtime !== 'in-process' || pkg.inProcess?.approved || pkg.actualHash || !pkg.contentHash) return null;
  const hash = pkg.contentHash;
  return (
    <div className="mt-2 space-y-1 rounded-xs border border-warning/40 p-2" role="group" aria-label={`In-process approval for ${pkg.name}`}>
      <p className="text-xs text-on-surface">
        Runs in the server process: no sandbox, with the server&apos;s network, files, data and agent loop. It is not loaded until
        you approve that for this content.
      </p>
      <dl className="grid grid-cols-[6rem_1fr] gap-x-2 text-xs">
        <dt className="text-on-surface-variant">content</dt>
        <dd className="font-mono break-all" data-testid="in-process-hash">{hash}</dd>
      </dl>
      <button
        type="button"
        disabled={approve.isPending}
        onClick={() => {
          if (confirm(`Run ${pkg.name} in the server process, with the server's full authority, for the content that hashes to ${hash}?`)) approve.mutate(hash);
        }}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50"
      >
        <Cpu className="w-3.5 h-3.5" /> Approve running in the server process
      </button>
      {error && <p role="alert" className="text-xs text-error whitespace-pre-line">! {error}</p>}
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
 *
 * The value never enters React or react-query state: the input is
 * uncontrolled and read from its ref when the request is made, the mutation's
 * variable is only `'set'` or `'clear'`, and the mutation is reset and kept
 * for no time (`gcTime: 0`) once it settles, so nothing holds the value after
 * the request.
 */
function SecretRow({ pkg, secret }: { pkg: PluginPackageView; secret: SecretDecl }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [message, setMessage] = useState<FormMessage>(null);
  const isSet = pkg.secretsSet.includes(secret.key);
  const put = useMutation({
    gcTime: 0,
    mutationFn: (action: 'set' | 'clear') => api.put<{ saved: boolean }>(
      `/plugin-packages/${encodeURIComponent(pkg.name)}/secrets/${encodeURIComponent(secret.key)}`,
      { value: action === 'clear' ? null : (input.current?.value ?? '') },
    ),
    onSuccess: (_res, action) => {
      if (input.current) input.current.value = '';
      setFilled(false);
      setMessage({ kind: 'ok', text: action === 'clear' ? `${secret.label} cleared.` : `${secret.label} saved.` });
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
    },
    onError: (err: Error) => setMessage({ kind: 'error', text: problemsOf(err) }),
  });
  const send = (action: 'set' | 'clear') => {
    setMessage(null);
    put.mutate(action, { onSettled: () => put.reset() });
  };
  const id = `plugin-${pkg.name}-secret-${secret.key}`;
  return (
    <form
      aria-label={`Secret ${secret.key} of ${pkg.name}`}
      data-testid="plugin-secret"
      data-key={secret.key}
      className="space-y-1"
      onSubmit={(e) => {
        e.preventDefault();
        const length = input.current?.value.length ?? 0;
        if (length > MAX_PLUGIN_SECRET_LENGTH) {
          setMessage({ kind: 'error', text: `The value is ${length} characters; a secret holds at most ${MAX_PLUGIN_SECRET_LENGTH}.` });
        } else if (input.current?.value.trim()) {
          send('set');
        }
      }}
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
          ref={input}
          defaultValue=""
          disabled={put.isPending}
          onChange={(e) => setFilled(e.target.value.trim() !== '')}
          className="flex-1 min-w-48 bg-surface-container-high border border-outline-variant rounded-md py-1 px-2 text-on-surface text-sm"
        />
        <button type="submit" disabled={put.isPending || !filled} className="px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50">
          {isSet ? 'Replace' : 'Set'}
        </button>
        {isSet && (
          <button
            type="button"
            disabled={put.isPending}
            onClick={() => { if (confirm(`Clear ${secret.label} of ${pkg.name}?`)) send('clear'); }}
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

/**
 * What a package adds besides tools: its pages (sidebar entries while it is
 * enabled) and the host API scopes it asks for, each approved or not. A scope
 * a new version adds is not approved: enabling asks for it.
 */
/** Exactly when a package with approved host scopes gets a token (src/plugins/packages/host-api.ts, `hostCallKind`). */
const HOST_TOKEN_WHEN = 'A call gets a short-lived token for them (at most 30 seconds, for that call only) only when a user starts it: '
  + 'a tool call of their own agent in their conversation, a slash command they type, or a button on the package\'s page. '
  + 'Schedules, events and context calls never get one. The token acts as that user, within their own data and permission rules. '
  + 'An upgrade asks for this approval again.';

/** The egress warning, as the shared declarations word it (src/shared/plugin-declarations.ts), or ''. */
function egressWarningText(scopes: readonly string[]): string {
  const warning = egressReadWarning(scopes);
  return warning ? `Warning: ${warning}` : '';
}

/** The notes of the scopes in `scopes` that need saying in the approval. */
function scopeNotes(scopes: readonly string[]): string[] {
  return [
    ...(scopes.includes('agent:run') ? [AGENT_RUN_NOTE] : []),
    ...(scopes.includes('documents:write') ? [DOCUMENTS_WRITE_NOTE] : []),
  ];
}

/** The confirmation of approving `model:cli-tools` for `pkg`. */
function modelCliToolsConfirm(pkg: PluginPackageView): string {
  const trust = pkg.modelCliTools;
  return `Approve ${MODEL_CLI_TOOLS_APPROVAL} for ${pkg.name}? ${MODEL_CLI_TOOLS_WARNING} Its reason: "${trust?.reason ?? ''}".`
    + `${trust?.sourcesWarning ? ` ${trust.sourcesWarning}` : ''} An upgrade asks for this approval again.`;
}

/**
 * A package's `model.trustedInput` and its approval (`model:cli-tools`): the
 * warning, its reason, the other sources it reads from, and a button that
 * approves or revokes it on its own (sent with the approved host scopes,
 * which `approveHostScopes` replaces as a whole).
 */
function ModelCliTools({ pkg }: { pkg: PluginPackageView }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const trust = pkg.modelCliTools;
  const others = (pkg.approvedHostScopes ?? []).filter((s) => s !== MODEL_CLI_TOOLS_APPROVAL);
  const change = useMutation({
    mutationFn: (approve: boolean) => api.patch<PluginPackageView>(`/plugin-packages/${encodeURIComponent(pkg.name)}`, {
      approveHostScopes: approve ? [...others, MODEL_CLI_TOOLS_APPROVAL] : others,
    }),
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY }); },
    onError: (err: Error) => setError(problemsOf(err)),
  });
  if (!trust) return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs text-on-surface-variant" data-testid="plugin-model-cli-tools" data-approved={trust.approved} data-active={trust.active}>
      <p>
        model calls on CLI lanes:{' '}
        <code className={cn('font-mono', trust.approved ? tone('warn') : tone('quiet'))}>{MODEL_CLI_TOOLS_APPROVAL}</code>{' '}
        {trust.active
          ? <span className={tone('warn')}>approved: its model calls may run on CLI agents</span>
          : trust.approved
            ? <span className={tone('warn')}>approved; takes effect once model:complete is approved too</span>
            : <span>not approved: its model calls stay off CLI lanes</span>}
        <button
          type="button"
          disabled={change.isPending}
          onClick={() => {
            if (trust.approved) { change.mutate(false); return; }
            if (confirm(modelCliToolsConfirm(pkg))) change.mutate(true);
          }}
          aria-label={`${trust.approved ? 'Revoke' : 'Approve'} ${MODEL_CLI_TOOLS_APPROVAL} for ${pkg.name}`}
          className="ml-2 inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer disabled:opacity-50"
        >
          {trust.approved ? 'revoke' : 'approve'}
        </button>
      </p>
      <p className={tone('warn')} data-testid="plugin-model-cli-tools-warning">{MODEL_CLI_TOOLS_WARNING}</p>
      <p data-testid="plugin-model-cli-tools-reason">reason given by the package: “{trust.reason}”</p>
      {trust.sourcesWarning && <p className={tone('warn')} data-testid="plugin-model-cli-tools-sources">{trust.sourcesWarning}</p>}
      {error && <p role="alert" className="text-error whitespace-pre-line">! {error}</p>}
    </div>
  );
}

function PagesAndScopes({ pkg, unapproved }: { pkg: PluginPackageView; unapproved: string[] }) {
  const pages = pkg.manifest.ui?.pages ?? [];
  const scopes = pkg.manifest.host ?? [];
  if (pages.length === 0 && scopes.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs text-on-surface-variant">
      {pages.length > 0 && (
        <p data-testid="plugin-pages">
          pages: {pages.map((p) => `${p.title} (/plugins/${pkg.name}/${p.path})`).join(', ')}
        </p>
      )}
      {scopes.length > 0 && (
        <p data-testid="plugin-host-scopes">
          host API:{' '}
          {scopes.map((s, i) => (
            <span key={s}>
              {i > 0 && ', '}
              <code className={cn('font-mono', unapproved.includes(s) ? tone('warn') : tone('ok'))} data-scope={s} data-approved={!unapproved.includes(s)}>{s}</code>
            </span>
          ))}
          {unapproved.length > 0 && <span className={tone('warn')}> · {unapproved.length} not approved; enabling asks you to agree to them</span>}
          {egressWarningText(scopes) && <span className={cn('block', tone('warn'))} data-testid="plugin-egress-warning">{egressWarningText(scopes)}</span>}
          {scopeNotes(scopes).map((note) => <span key={note} className="block" data-testid="plugin-scope-note">{note}</span>)}
          <span className="block">{HOST_TOKEN_WHEN}</span>
        </p>
      )}
    </div>
  );
}

/** Whether a package adds anything besides tools (docs/PLUGIN-PACKAGES.md#contributions). */
function hasContributions(pkg: PluginPackageView): boolean {
  const c = pkg.contributions;
  return !!c && (c.commands.length > 0 || c.schedules.length > 0 || c.events.length > 0 || !!c.prompt || !!c.context);
}

function LastRun({ run }: { run: { at: string; ok: boolean; error: string | null } | null }) {
  if (!run) return null;
  return run.ok
    ? <span className={tone('quiet')}> · last run ok {new Date(run.at).toLocaleString()}</span>
    : <span className={tone('bad')}> · last run failed: {run.error}</span>;
}

/**
 * What a package adds besides tools, in full: its slash commands, schedules,
 * event handlers, turn context and the whole prompt text it puts in every
 * user's agents. Nothing of it is bound until an admin approves exactly this
 * (the contributions hash); shown in the row and in the enable confirmation.
 */
function Contributions({ pkg }: { pkg: PluginPackageView }) {
  if (!hasContributions(pkg)) return null;
  const c = pkg.contributions;
  const roles = (r: string[] | null) => (r ? `agents of the roles ${r.join(', ')}` : 'every agent');
  return (
    <div className="mt-2 space-y-1 text-xs text-on-surface-variant" data-testid="plugin-contributions">
      <p className={c.approved ? tone('ok') : tone('warn')} data-testid="plugin-contributions-approval">
        {c.approved
          ? <>contributions approved for <span className="font-mono">{c.approvedHash}</span></>
          : <>contributions not approved{c.hash && <> (<span className="font-mono">{c.hash}</span>)</>}: nothing below is active until you agree to it when enabling</>}
      </p>
      <ul className="space-y-0.5 list-disc pl-4">
        {c.commands.map((x) => (
          <li key={`c-${x.name}`} data-testid="plugin-contribution-command">
            command <code className="font-mono">/{x.name}</code> → {x.tool} ({x.effect ?? '?'}), run as the user who types it: {x.description}
          </li>
        ))}
        {c.schedules.map((x) => (
          <li key={`s-${x.id}`} data-testid="plugin-contribution-schedule">
            schedule <code className="font-mono">{x.id}</code> <code className="font-mono">{x.cron}</code> (UTC) → {x.tool} ({x.effect ?? '?'}), run as the installing admin, unattended
            <LastRun run={x.lastRun} />
          </li>
        ))}
        {c.events.map((x) => (
          <li key={`e-${x.on}-${x.tool}`} data-testid="plugin-contribution-event">
            on <code className="font-mono">{x.on}</code> of every user → {x.tool} ({x.effect ?? '?'}), run as that user (ids only)
            <LastRun run={x.lastRun} />
          </li>
        ))}
        {c.context && (
          <li data-testid="plugin-contribution-context" className={tone('warn')}>
            context: {c.context.tool} ({c.context.effect ?? '?'}) receives the message of every turn of every user — root agents and
            workers, {roles(c.context.roles)} — and its answer is put in front of the agent
            <LastRun run={c.context.lastRun} />
          </li>
        )}
        {c.prompt && (
          <li data-testid="plugin-contribution-prompt">
            prompt: <code className="font-mono">{c.prompt.file}</code> is added to the system prompt of {roles(c.prompt.roles)}, for every
            user, fenced as third-party text:
            <pre
              className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-xs border border-outline-variant bg-surface-container p-2 font-mono text-on-surface"
              data-testid="plugin-prompt-text"
            >
              {c.prompt.text ?? '(the file cannot be read)'}
            </pre>
          </li>
        )}
      </ul>
      {c.problems.map((p) => <p key={p} className={tone('bad')}>! {p}</p>)}
    </div>
  );
}

/** Where a package came from, and its revocation, if any: a banner the admin cannot miss. */
function Provenance({ pkg }: { pkg: PluginPackageView }) {
  return (
    <>
      <p className="mt-1 text-xs text-on-surface-variant" data-testid="plugin-origin">{originLabel(pkg.origin)}</p>
      {pkg.revocation && (
        <div role="alert" className="mt-2 flex items-start gap-2 rounded-xs border border-error/60 bg-error/10 p-2 text-xs text-on-surface" data-testid="plugin-revocation-banner">
          <ShieldOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" aria-hidden />
          <span>
            {pkg.revocation.kind === 'package' ? `This version is revoked by the ${pkg.revocation.source === 'marketplace' ? 'Octipus marketplace' : 'configuration'}` : `The key that signed it is revoked (${pkg.revocation.keyId})`}
            : {displayText(pkg.revocation.reason) || 'no reason given'}. It does not start and cannot be enabled; upgrade to a version that is not revoked.
          </span>
        </div>
      )}
    </>
  );
}

/** The package's use over 30 days (tokens, cost, model calls, runs, per user), and its running background runs with Cancel. */
function UsagePanel({ pkg }: { pkg: PluginPackageView }) {
  const qc = useQueryClient();
  const usage = useQuery({
    queryKey: [...PLUGIN_PACKAGES_KEY, pkg.name, 'usage'],
    queryFn: () => api.get<PluginUsageView>(`/plugin-packages/${encodeURIComponent(pkg.name)}/usage?days=30`),
  });
  const runs = useQuery({
    queryKey: [...PLUGIN_PACKAGES_KEY, pkg.name, 'runs'],
    queryFn: () => api.get<PluginRunItem[]>(`/plugin-packages/${encodeURIComponent(pkg.name)}/runs?status=running`),
    refetchInterval: 10_000,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.delete<{ id: string; status: string }>(`/plugin-packages/${encodeURIComponent(pkg.name)}/runs/${encodeURIComponent(id)}`),
    onSettled: () => { void qc.invalidateQueries({ queryKey: [...PLUGIN_PACKAGES_KEY, pkg.name, 'runs'] }); },
  });
  const u = usage.data;
  return (
    <div className="mt-2 space-y-2 rounded-xs border border-outline-variant/40 p-3 text-xs" role="group" aria-label={`Usage of ${pkg.name}`} data-testid="plugin-usage">
      {usage.error && <p role="alert" className="text-error">! {problemsOf(usage.error)}</p>}
      {u && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
          <div><dt className="text-on-surface-variant">tokens (30 days)</dt><dd className="text-on-surface" data-testid="plugin-usage-tokens">{(u.inputTokens + u.outputTokens).toLocaleString()}</dd></div>
          <div><dt className="text-on-surface-variant">cost</dt><dd className="text-on-surface" data-testid="plugin-usage-cost">${u.cost.toFixed(2)}</dd></div>
          <div><dt className="text-on-surface-variant">model calls</dt><dd className="text-on-surface">{u.modelCalls}</dd></div>
          <div><dt className="text-on-surface-variant">background runs</dt><dd className="text-on-surface">{u.runs}</dd></div>
        </dl>
      )}
      {u?.byUser && u.byUser.length > 0 && (
        <table className="w-full text-left" data-testid="plugin-usage-by-user">
          <caption className="text-left text-on-surface-variant">by user</caption>
          <thead className="text-on-surface-variant"><tr><th className="font-normal">user</th><th className="font-normal">tokens</th><th className="font-normal">cost</th><th className="font-normal">calls</th><th className="font-normal">runs</th></tr></thead>
          <tbody>
            {u.byUser.map((x) => (
              <tr key={x.userId} className="border-t border-outline-variant/30"><td className="font-mono">{x.userId}</td><td>{x.tokens.toLocaleString()}</td><td>${x.cost.toFixed(2)}</td><td>{x.modelCalls}</td><td>{x.runs}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <div>
        <h4 className="font-medium text-on-surface">running background runs</h4>
        {(runs.data ?? []).length === 0 ? <p className="text-on-surface-variant">None running.</p> : (
          <ul className="space-y-1" data-testid="plugin-runs">
            {(runs.data ?? []).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2" data-testid="plugin-run" data-id={r.id}>
                <span className="text-on-surface">{displayText(r.title)}</span>
                <span className="text-on-surface-variant">{r.role} · user <span className="font-mono">{r.userId}</span> · since {new Date(r.startedAt).toLocaleTimeString()}</span>
                <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)} aria-label={`Cancel the run ${displayText(r.title)}`}
                  className="rounded-xs border border-outline-variant px-2 py-0.5 text-on-surface hover:bg-surface-container-high disabled:opacity-50">
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
        {cancel.error && <p role="alert" className="text-error">! {problemsOf(cancel.error)}</p>}
      </div>
    </div>
  );
}

function PackageRow({ pkg }: { pkg: PluginPackageView }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [consenting, setConsenting] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const uninstall = useMutation({
    mutationFn: () => api.delete<{ uninstalled: boolean }>(`/plugin-packages/${encodeURIComponent(pkg.name)}`),
    onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY }); },
    onError: (err: Error) => setError(problemsOf(err)),
  });
  const declaredScopes = pkg.manifest.host ?? [];
  const unapproved = declaredScopes.filter((s) => !(pkg.approvedHostScopes ?? []).includes(s));
  // Disabling is one PATCH; enabling goes through the consent for the package's content as installed.
  const disable = useMutation({
    mutationFn: () => api.patch<PluginPackageView>(`/plugin-packages/${encodeURIComponent(pkg.name)}`, { enabled: false }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
      // Its pages come and go with it in the sidebar.
      void qc.invalidateQueries({ queryKey: PLUGIN_PAGES_KEY });
    },
    onError: (err: Error) => { setError(problemsOf(err)); void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY }); },
  });
  const hosts = pkg.manifest.network ?? [];
  const inProcess = pkg.runtime === 'in-process';
  const running = inProcess ? 'loaded' : 'running';
  return (
    <li className="px-4 py-3 text-sm" data-testid="plugin-package" data-name={pkg.name}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-on-surface font-medium">{pkg.name}</span>
        <span className="text-xs text-on-surface-variant">{pkg.version}</span>
        <span className="text-xs text-on-surface-variant flex-1 min-w-0 truncate" title={pkg.manifest.description}>{pkg.manifest.title}</span>
        {inProcess && (
          <span className="text-xs text-warning" title="Runs in the server process, not in a sandbox" data-testid="plugin-runtime">
            in-process{pkg.inProcess?.approved ? '' : ' · not approved'}
          </span>
        )}
        <span className={cn('text-xs', pkg.connected ? tone('ok') : tone('quiet'))}>
          {pkg.enabled ? (pkg.connected ? running : 'enabled') : 'disabled'}
        </span>
        <SignatureState signature={pkg.signature} />
        <NetworkState network={pkg.network} />
        <button
          type="button"
          disabled={disable.isPending}
          onClick={() => {
            if (pkg.enabled) disable.mutate();
            else setConsenting(true);
          }}
          aria-label={`${pkg.enabled ? 'Disable' : 'Enable'} ${pkg.name}`}
          className="inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer disabled:opacity-50"
        >
          <Power className="w-3.5 h-3.5" /> {pkg.enabled ? 'disable' : 'enable'}
        </button>
        <button
          type="button"
          onClick={() => setShowUsage((u) => !u)}
          aria-expanded={showUsage}
          aria-label={`Usage of ${pkg.name}`}
          className="inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer"
        >
          <BarChart3 className="w-3.5 h-3.5" /> usage
        </button>
        {!inProcess && <button
          type="button"
          onClick={() => setConfiguring((c) => !c)}
          aria-expanded={configuring}
          aria-label={`Configure ${pkg.name}`}
          className="inline-flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface cursor-pointer"
        >
          <Settings2 className="w-3.5 h-3.5" /> configure
        </button>}
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
      {inProcess ? (
        <p className="mt-1 text-xs text-on-surface-variant">
          entry: <code className="font-mono">{pkg.manifest.entry}</code>
          {pkg.inProcess?.approved && <> · approved to run in the server process for <span className="font-mono">{pkg.inProcess.approvedHash}</span></>}
        </p>
      ) : (
        <p className="mt-1 text-xs text-on-surface-variant">
          tools: {Object.entries(pkg.manifest.tools ?? {}).map(([t, d]) => `${t} (${d.effect})`).join(', ')}
          {' · '}hosts: {hosts.length ? hosts.join(', ') : 'none'}
        </p>
      )}
      <p className="mt-1 text-xs text-on-surface-variant" data-testid="plugin-network-detail">{pkg.network.detail}</p>
      {pkg.authoredBy && (
        <p className="mt-1 text-xs text-warning" data-testid="plugin-authored-by">
          Authored by an agent (session <span className="font-mono">{pkg.authoredBy.sessionId ?? 'none'}</span>, for user{' '}
          <span className="font-mono">{pkg.authoredBy.userId}</span>). Review its content hash, tools, effects and hosts before enabling it.
        </p>
      )}
      <Provenance pkg={pkg} />
      <PagesAndScopes pkg={pkg} unapproved={unapproved} />
      <ModelCliTools pkg={pkg} />
      <Contributions pkg={pkg} />
      {pkg.signature && pkg.signature.status !== 'valid' && pkg.signature.status !== 'unsigned' && (
        <p className="mt-1 text-xs text-on-surface-variant">{pkg.signature.detail}</p>
      )}
      {pkg.problem && (
        <p className="mt-1 text-xs text-error inline-flex items-center gap-1" data-testid="plugin-problem">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0" /> {pkg.problem}
        </p>
      )}
      <ContentReview pkg={pkg} />
      <InProcessApproval pkg={pkg} />
      {configuring && <PackageConfig pkg={pkg} />}
      {showUsage && <UsagePanel pkg={pkg} />}
      {consenting && (
        <ConsentDialog
          source={{ kind: 'installed', name: pkg.name }}
          onClose={() => setConsenting(false)}
          onDone={(result) => {
            setConsenting(false);
            setError(null);
            setNotice(result.enabled ? `${pkg.name} is enabled.` : `Agreed; not enabled${result.enableProblem ? `: ${result.enableProblem}` : ''}.`);
            void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
            void qc.invalidateQueries({ queryKey: PLUGIN_PAGES_KEY });
          }}
        />
      )}
      {notice && <p role="status" className="mt-1 text-xs text-on-surface-variant" data-testid="plugin-notice">{notice}</p>}
      {error && <p role="alert" className="mt-1 text-xs text-error whitespace-pre-line">! {error}</p>}
    </li>
  );
}

/** Install from a directory on the server or an https tarball (which must be signed by a trusted publisher). */
/** What a consent's result says once it is done. */
function installedText(res: PluginConsentResult): string {
  return `Installed ${res.name} ${res.version} (${res.enabled ? 'enabled' : 'disabled'}).${res.enableProblem ? ` Not enabled: ${res.enableProblem}.` : ''}${res.warnings.length ? ` ${res.warnings.join(' ')}` : ''}`;
}

function InstallForm() {
  const qc = useQueryClient();
  const [source, setSource] = useState('');
  const [consent, setConsent] = useState<ConsentSource | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      aria-label="Install a plugin package"
      onSubmit={(e) => {
        e.preventDefault();
        const s = source.trim();
        if (s) { setMessage(null); setConsent({ kind: 'preview', body: s.startsWith('https://') ? { url: s } : { path: s } }); }
      }}
    >
      <input
        aria-label="Package directory or https URL"
        placeholder="/opt/plugins/finapi or https://…/finapi-1.0.0.tar.gz"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        className="flex-1 min-w-64 bg-surface-container-high border border-outline-variant rounded-md py-1 px-2 text-on-surface text-sm"
      />
      <button type="submit" disabled={consent !== null || !source.trim()} className="px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50">
        Install
      </button>
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={cn('w-full text-xs', message.kind === 'error' ? 'text-error' : 'text-on-surface-variant')}>{message.text}</p>}
      {consent && (
        <ConsentDialog
          source={consent}
          onClose={() => setConsent(null)}
          onDone={(res) => {
            setConsent(null);
            setSource('');
            setMessage({ kind: 'ok', text: installedText(res) });
            void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
          }}
        />
      )}
    </form>
  );
}

/**
 * The first-party plugins shipped with Octipus (docs/PLUGIN-PACKAGES.md#bundled-plugins).
 * Installing one is an install like any other: pinned, disabled until an
 * admin enables it and approves its host API scopes on its row above.
 */
function BundledPlugins() {
  const qc = useQueryClient();
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const { data } = useQuery({
    queryKey: PLUGIN_BUNDLED_KEY,
    queryFn: () => api.get<BundledPluginView[]>('/plugin-packages/bundled'),
  });
  const [installing, setInstalling] = useState<string | null>(null);
  const bundled = Array.isArray(data) ? data : [];
  if (bundled.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="bundled-plugins" aria-labelledby="bundled-plugins-title">
      <h3 id="bundled-plugins-title" className="section-label">bundled</h3>
      <p className="text-xs text-on-surface-variant">
        Plugins that ship with Octipus. They install like any package: you agree to what each declares, and it is
        pinned to its content.
      </p>
      <ul className="term-frame rounded-xs divide-y divide-outline-variant/10">
        {bundled.map((b) => {
          const upgrade = b.installed !== null && b.installed !== b.version;
          return (
            <li key={b.name} className="p-3 flex flex-wrap items-start gap-3 text-sm" data-testid="bundled-plugin" data-name={b.name}>
              <div className="flex-1 min-w-0 space-y-0.5">
                <p className="text-on-surface"><span className="font-semibold">{b.title}</span> <span className="text-xs text-on-surface-variant">{b.name} {b.version}</span></p>
                <p className="text-xs text-on-surface-variant">{b.description}</p>
                {(b.host ?? []).length > 0 && (
                  <p className="text-xs text-on-surface-variant">asks for <code className="font-mono">{b.host.join(', ')}</code></p>
                )}
                {b.problem && <p className="text-xs text-error">{b.problem}</p>}
              </div>
              {b.taken ? (
                <span className={cn('text-xs', tone('warn'))} data-testid="bundled-taken">name taken by another package</span>
              ) : b.installed !== null && !upgrade ? (
                <span className={cn('text-xs', tone('ok'))}>installed</span>
              ) : (
                <button
                  type="button"
                  disabled={installing !== null || Boolean(b.problem)}
                  onClick={() => { setMessage(null); setInstalling(b.name); }}
                  className="px-2 py-1 rounded-xs bg-primary text-on-primary text-xs cursor-pointer disabled:opacity-50"
                  aria-label={`${upgrade ? 'Upgrade' : 'Install'} ${b.name}`}
                >
                  {upgrade ? `Upgrade to ${b.version}` : 'Install'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={cn('text-xs', message.kind === 'error' ? 'text-error' : 'text-on-surface-variant')}>{message.text}</p>}
      {installing && (
        <ConsentDialog
          source={{ kind: 'preview', body: { bundled: installing } }}
          onClose={() => setInstalling(null)}
          onDone={(res) => {
            setInstalling(null);
            setMessage({ kind: 'ok', text: installedText(res) });
            void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
            void qc.invalidateQueries({ queryKey: PLUGIN_BUNDLED_KEY });
          }}
        />
      )}
    </section>
  );
}

/** "plugin sandbox: active runner X / unavailable: …" (docs/PLUGIN-PACKAGES.md#the-sandbox). */
function SandboxState() {
  const { data, error } = useQuery({
    queryKey: PLUGIN_SANDBOX_KEY,
    queryFn: () => api.get<PluginSandboxStatus>('/plugin-packages/sandbox'),
  });
  if (error) return <p role="alert" className="text-xs text-error">! {(error as Error).message}</p>;
  if (!data) return null;
  return (
    <p role={data.runner ? undefined : 'alert'} data-testid="plugin-sandbox-state" data-runner={data.runner ?? ''}
      className={cn('flex items-start gap-2 rounded-xs border p-2 text-xs',
        data.runner ? 'border-outline-variant/40 text-on-surface-variant' : 'border-error/60 bg-error/10 text-on-surface')}>
      {data.runner ? <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" aria-hidden />}
      <span>
        plugin sandbox: {data.summary}
        {data.setting === 'off' && <> · <code>plugins.sandbox</code> is off: plugins not from the marketplace run NOT sandboxed, as the server&apos;s user</>}
      </span>
    </p>
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
            Connections to other systems, each its own process with only its declared tools and hosts. Installing or
            enabling one shows what it declares, item by item, and runs only once you agree to each, for its exact content.
            One whose files changed since then does not start until its new content is approved. A package from a URL
            must be signed by a publisher in <code>plugins.trustedPublishers</code>.
          </p>
        </div>
      </div>
      <SandboxState />
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
      <BundledPlugins />
    </div>
  );
}
