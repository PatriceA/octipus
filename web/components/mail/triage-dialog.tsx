'use client';

import { Archive, ChevronDown, ChevronRight, Loader2, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Portal } from '@/components/ui/portal';
import { api } from '@/lib/api';
import type { MailboxKey } from '../../../src/shared/email';
import { btn, btnGhost, btnPrimary, type EmailTriage, field, type InboxItem, sourceLabel, who } from './email-shared';
import { keyOf } from './mailboxes';
import { TriageReview } from './triage-review';

export type TriageScope = 'untriaged' | 'unread' | 'all';
export interface TriageSettings {
  scope: TriageScope;
  applyLabels: boolean;
  autoArchive: boolean;
  archiveCategories: string[];
  instructions: string;
  skipDialog: boolean;
  /** Triage new inbox mail without being asked. */
  auto: boolean;
}
/** The last automatic run that triaged something or failed. */
export interface LastAutoTriage { at: string; triaged: number; archived: number; skipped?: number; error?: string }
interface Preview {
  settings: TriageSettings;
  capabilities: { labels: boolean; archive: boolean; imap: boolean };
  lastAuto: LastAutoTriage | null;
  counts: Record<TriageScope, number>;
  ownerLabelled: number;
  categories: Record<string, string>;
  rules: { priority: string[]; sees: string; examples: string };
  models: { decision: { name: string; local: boolean } | null; llm: { name: string } | { error: string } };
  thresholds: { priority: number; category: number } | null;
}
export interface TriageRun {
  id: string;
  total: number;
  done: number;
  stage: 'starting' | 'decision' | 'llm' | 'applying' | 'done';
  finished: boolean;
  cancelled?: boolean;
  error?: string;
  result?: { triage: Record<string, EmailTriage>; labeled: number; labelError?: string; archived: string[]; archiveProposed: string[]; protected?: number };
}

const SCOPE_TEXT: Record<TriageScope, string> = {
  untriaged: 'Not triaged yet',
  unread: 'Unread',
  all: 'All loaded mail',
};
const STAGE_TEXT: Record<TriageRun['stage'], string> = {
  starting: 'Preparing…',
  decision: 'The decision model is reading',
  llm: 'The LLM is answering what is left',
  applying: 'Applying labels',
  done: 'Done',
};

type Row = { name: string; description: string };
const toRows = (c: Record<string, string>): Row[] => Object.entries(c).map(([name, description]) => ({ name, description }));

/**
 * Start a run with the saved settings over `mailboxes` (one, or every inbox
 * of "All inboxes"). Each row names its mailbox; with `newest` the server
 * reads the newest mail of each. Used by the dialog and by the one-click path.
 */
export async function startTriage(mailboxes: MailboxKey[], items: InboxItem[], scope: TriageScope, newest?: number): Promise<TriageRun> {
  const body = newest
    ? { newest, scope, mailboxes }
    : { items: items.map((it) => ({ id: it.id, from: it.from, subject: it.subject, snippet: it.snippet, mailbox: keyOf(it) })) };
  return (await api.post<{ run: TriageRun }>('/email/triage/run', body)).run;
}

/** "Fri 09:41: 4 triaged, 1 archived". */
export function lastAutoText(last: LastAutoTriage): string {
  const when = new Date(last.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const parts = [`${last.triaged} triaged`, ...(last.archived ? [`${last.archived} archived`] : []), ...(last.skipped ? [`${last.skipped} kept from the models by their protection level`] : [])];
  return last.error ? `${when}: failed (${last.error})${last.triaged ? `, ${parts.join(', ')}` : ''}` : `${when}: ${parts.join(', ')}`;
}

/** The loaded rows a scope takes, the way the server counts them. */
export function rowsInScope(items: InboxItem[], scope: TriageScope): InboxItem[] {
  if (scope === 'all') return items;
  return items.filter((it) => (scope === 'unread' ? it.unread : !it.triage));
}

interface Props {
  /** The mailboxes being triaged: one, or every inbox of "All inboxes". */
  mailboxes: MailboxKey[];
  /** The inbox rows the page has loaded. */
  items: InboxItem[];
  /** A run already going (or just finished) when the dialog opens. */
  run: TriageRun | null;
  onRun: (run: TriageRun | null) => void;
  /** Archive these mails (the result's proposal). */
  onArchive: (ids: string[]) => Promise<void>;
  /** Put a batch this run archived back in the inbox. */
  onUnarchive: (ids: string[]) => Promise<void>;
  onClose: () => void;
}

/**
 * "Triage inbox": what a run will do and what the models are told, then its
 * progress, then its result. Nothing in the mailbox changes before Start, and
 * archiving is either an explicit setting shown here or a proposal afterwards.
 */
export function TriageDialog({ mailboxes, items, run, onRun, onArchive, onUnarchive, onClose }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [settings, setSettings] = useState<TriageSettings | null>(null);
  const [error, setError] = useState('');
  const [useNewest, setUseNewest] = useState(false);
  const [newest, setNewest] = useState(100);
  const [catRows, setCatRows] = useState<Row[] | null>(null);
  const [rulesOpen, setRulesOpen] = useState(true);
  const [busy, setBusy] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [archivePick, setArchivePick] = useState<Set<string> | null>(null);
  const [undone, setUndone] = useState(false);

  const loadPreview = useCallback(async () => {
    try {
      const res = await api.post<Preview & { error?: string }>(`/email/triage/preview?provider=${encodeURIComponent(mailboxes[0])}`, { items: items.slice(0, 500).map((it) => ({ id: it.id, unread: it.unread, mailbox: keyOf(it) })) });
      if (res.error) { setError(res.error); return; }
      setPreview(res);
      setSettings((current) => current ?? res.settings);
    } catch (err) { setError((err as Error).message); }
  }, [items, mailboxes]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load the preview once on open
    loadPreview();
    // Only on open: reloading whenever the list refreshes would reset what the owner is editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (patch: Partial<TriageSettings>) => setSettings((s) => (s ? { ...s, ...patch } : s));
  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items]);
  const llmError = preview && 'error' in preview.models.llm ? preview.models.llm.error : '';
  // A server from before IMAP triage sends no capabilities: Google / Microsoft only.
  const caps = preview?.capabilities ?? { labels: true, archive: true, imap: false };
  const count = !preview || !settings ? 0 : preview.counts[settings.scope];
  const calibrationChanges = !!preview && !!settings && settings.instructions.trim() !== preview.settings.instructions;

  const saveCategories = async (reset = false) => {
    if (!catRows) return;
    setBusy('categories'); setError('');
    try {
      const categories = reset ? null : Object.fromEntries(catRows.filter((r) => r.name.trim()).map((r) => [r.name.trim().toLowerCase(), r.description]));
      await api.put('/email/categories', { categories });
      setCatRows(null);
      await loadPreview();
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };

  const start = async () => {
    if (!settings) return;
    setBusy('start'); setError('');
    try {
      await api.put('/email/triage/settings', settings);
      onRun(await startTriage(mailboxes, rowsInScope(items, settings.scope), settings.scope, useNewest ? newest : undefined));
    } catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  };

  const cancel = async () => {
    try { onRun((await api.post<{ run: TriageRun | null }>('/email/triage/run/cancel', {})).run); }
    catch (err) { setError((err as Error).message); }
  };

  const result = run?.finished ? run.result : undefined;
  const proposed = result?.archiveProposed ?? [];
  const picked = archivePick ?? new Set(proposed);
  const summary = useMemo(() => {
    const cells: Record<string, Record<string, number>> = {};
    const sources: Record<string, number> = {};
    for (const t of Object.values(result?.triage ?? {})) {
      const row = (cells[t.category ?? 'other'] ??= {});
      row[t.priority] = (row[t.priority] ?? 0) + 1;
      if (t.source) sources[t.source] = (sources[t.source] ?? 0) + 1;
    }
    return { cells, sources, total: Object.keys(result?.triage ?? {}).length };
  }, [result]);

  const view: 'setup' | 'running' | 'result' = run && !run.finished ? 'running' : run?.finished ? 'result' : 'setup';

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 font-sans sm:items-center">
        <div className="fixed inset-0 bg-black/60" onClick={onClose} />
        <div role="dialog" aria-modal="true" aria-label="Triage inbox" className="relative w-full max-w-2xl rounded-xl border border-outline-variant bg-surface-container shadow-2xl animate-enter">
          <div className="flex items-center justify-between border-b border-outline-variant/60 px-5 py-3">
            <h2 className="flex items-center gap-2 text-base font-semibold text-on-surface"><Sparkles className="h-4 w-4 text-accent" /> Triage inbox</h2>
            <button onClick={onClose} aria-label="Close" className={btnGhost}><X className="h-4 w-4" /></button>
          </div>

          <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4 text-sm text-on-surface">
            {error && <p role="alert" className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-error">{error}</p>}

            {view === 'setup' && !preview && !error && <p className="flex items-center gap-2 text-on-surface-variant"><Loader2 className="h-4 w-4 animate-spin" /> Looking at your inbox…</p>}

            {view === 'setup' && preview && settings && (
              <>
                <section aria-label="Which mails" className="space-y-2">
                  <h3 className="font-medium">Which mails</h3>
                  <div className="space-y-1.5">
                    {(['untriaged', 'unread', 'all'] as const).map((scope) => (
                      <label key={scope} className="flex cursor-pointer items-center gap-2">
                        <input type="radio" name="triage-scope" checked={!useNewest && settings.scope === scope} onChange={() => { setUseNewest(false); set({ scope }); }} />
                        <span>{SCOPE_TEXT[scope]}</span>
                        <span className="text-on-surface-variant">{preview.counts[scope]}</span>
                      </label>
                    ))}
                    <label className="flex cursor-pointer flex-wrap items-center gap-2">
                      <input type="radio" name="triage-scope" checked={useNewest} onChange={() => setUseNewest(true)} />
                      <span>The newest</span>
                      <input aria-label="Number of newest mails" type="number" min={1} max={500} value={newest} onFocus={() => setUseNewest(true)} onChange={(e) => setNewest(Math.min(500, Math.max(1, Number(e.target.value) || 1)))} className={field} style={{ width: '5rem' }} />
                      <span>in the inbox, {settings.scope === 'all' ? 'all of them' : `${SCOPE_TEXT[settings.scope].toLowerCase()} only`}</span>
                    </label>
                  </div>
                  <p className="text-on-surface-variant">
                    {useNewest ? `Up to ${newest} mails will be triaged.` : `${count} ${count === 1 ? 'mail' : 'mails'} will be triaged.`}
                    {preview.ownerLabelled > 0 && ` ${preview.ownerLabelled} of the loaded mails carry your own label: those are kept as they are and no model is asked.`}
                  </p>
                </section>

                <section aria-label="Categories" className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">Categories</h3>
                    {!catRows && <button className={btnGhost} onClick={() => setCatRows(toRows(preview.categories))}>Edit</button>}
                  </div>
                  {!catRows ? (
                    <ul className="flex flex-wrap gap-1.5">
                      {Object.entries(preview.categories).map(([name, description]) => (
                        <li key={name} title={description} className="rounded-full border border-outline-variant/60 px-2.5 py-1 text-xs"><span className="font-medium">{name}</span> <span className="text-on-surface-variant">· {description}</span></li>
                      ))}
                    </ul>
                  ) : (
                    <div className="space-y-2 rounded-md border border-outline-variant/40 p-3">
                      <p className="text-xs text-on-surface-variant">The description tells the model what belongs in a category. Names: lowercase letters, digits, - and _. &quot;other&quot; is always kept. Changing the list restarts the decision model&apos;s calibration.</p>
                      {catRows.map((r, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2">
                          <input aria-label="Category name" value={r.name} maxLength={32} onChange={(e) => setCatRows(catRows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${field} w-36`} />
                          <input aria-label="Category description" value={r.description} maxLength={200} onChange={(e) => setCatRows(catRows.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} className={`${field} min-w-40 flex-1`} />
                          <button aria-label={`Remove ${r.name || 'category'}`} onClick={() => setCatRows(catRows.filter((_, j) => j !== i))} className={btnGhost}><Trash2 className="h-4 w-4" /></button>
                        </div>
                      ))}
                      <div className="flex flex-wrap gap-2">
                        <button className={btn} disabled={catRows.length >= 20} onClick={() => setCatRows([...catRows, { name: '', description: '' }])}><Plus className="h-3.5 w-3.5" /> Add</button>
                        <button className={btnPrimary} disabled={busy === 'categories'} onClick={() => saveCategories()}>Save categories</button>
                        <button className={btnGhost} disabled={busy === 'categories'} onClick={() => saveCategories(true)} title="Forget your list and use the presets">Reset to presets</button>
                        <button className={btnGhost} onClick={() => setCatRows(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </section>

                <section aria-label="What the model is told" className="space-y-2">
                  <button className="flex items-center gap-1 font-medium" aria-expanded={rulesOpen} onClick={() => setRulesOpen(!rulesOpen)}>
                    {rulesOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} What the model is told
                  </button>
                  {rulesOpen && (
                    <div className="space-y-2 rounded-md bg-surface-container-low p-3 text-on-surface-variant">
                      <p><span className="text-on-surface">It sees:</span> {preview.rules.sees}</p>
                      <div>
                        <p className="text-on-surface">Priority rules:</p>
                        <ul className="ml-4 list-disc">{preview.rules.priority.map((rule) => <li key={rule}>{rule}</li>)}</ul>
                      </div>
                      <p><span className="text-on-surface">Examples:</span> {preview.rules.examples}</p>
                    </div>
                  )}
                  <label className="block space-y-1">
                    <span className="font-medium">Your instructions <span className="font-normal text-on-surface-variant">(optional, saved)</span></span>
                    <textarea aria-label="Your instructions" rows={2} maxLength={1000} value={settings.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="e.g. Anything from my accountant is high. Job alerts are always low." className={field} />
                  </label>
                  {calibrationChanges && <p className="text-xs text-on-surface-variant">New instructions change the question the models answer, so the decision model&apos;s calibration starts again and the LLM answers more mail for a while.</p>}
                </section>

                <section aria-label="Models" className="space-y-1">
                  <h3 className="font-medium">Who answers</h3>
                  {llmError ? <p role="alert" className="text-error">{llmError}</p> : (
                    <p className="text-on-surface-variant">
                      {preview.models.decision
                        ? <><span className="text-on-surface">{preview.models.decision.name}</span> (decision model, {preview.models.decision.local ? 'runs on this install' : 'hosted'}) answers the mails it is sure of. <span className="text-on-surface">{'name' in preview.models.llm ? preview.models.llm.name : ''}</span> answers the rest and checks one in ten.</>
                        : <><span className="text-on-surface">{'name' in preview.models.llm ? preview.models.llm.name : ''}</span> answers every mail. No decision model is bound.</>}
                    </p>
                  )}
                </section>

                <section aria-label="After triage" className="space-y-2">
                  <h3 className="font-medium">After triage</h3>
                  {!caps.labels ? (
                    <p className="text-on-surface-variant">An IMAP or POP3 mailbox keeps its mail as it is: triage gives each mail a priority and a category here, without labels in the mailbox or archiving.</p>
                  ) : (
                  <>
                  {caps.imap && <p className="text-xs text-on-surface-variant">Labels and archiving apply to Gmail and Outlook mail; IMAP mail gets its priority and category only.</p>}
                  <label className="flex cursor-pointer items-start gap-2">
                    <input type="checkbox" className="mt-0.5" checked={settings.applyLabels} onChange={(e) => set({ applyLabels: e.target.checked })} />
                    <span>Label each mail in the mailbox <span className="text-on-surface-variant">(a Gmail label or Outlook category named Octipus/&lt;category&gt;; mail is not moved)</span></span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input type="checkbox" className="mt-0.5" checked={settings.autoArchive} onChange={(e) => set({ autoArchive: e.target.checked })} />
                    <span>Archive low-priority mail of chosen categories without asking <span className="text-on-surface-variant">(off: you get the list to confirm afterwards)</span></span>
                  </label>
                  <div className="ml-6 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-on-surface-variant">Archive categories:</span>
                    {Object.keys(preview.categories).filter((c) => c !== 'other').map((c) => {
                      const on = settings.archiveCategories.includes(c);
                      return <button key={c} aria-pressed={on} onClick={() => set({ archiveCategories: on ? settings.archiveCategories.filter((x) => x !== c) : [...settings.archiveCategories, c] })} className={`rounded-full border px-2 py-0.5 text-xs ${on ? 'border-primary/50 bg-primary-container text-on-primary-container' : 'border-outline-variant/60 text-on-surface-variant hover:bg-surface-container-high'}`}>{c}</button>;
                    })}
                  </div>
                  </>
                  )}
                </section>

                <section aria-label="Automatic triage" className="space-y-1.5">
                  <h3 className="font-medium">Automatic triage</h3>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input type="checkbox" className="mt-0.5" checked={settings.auto} onChange={(e) => set({ auto: e.target.checked })} />
                    <span>Triage new mail automatically <span className="text-on-surface-variant">(every few minutes, at most 20 mails at a time, with these settings: your Gmail / Outlook inbox and your own IMAP mailboxes; a space&apos;s shared mailbox only by hand)</span></span>
                  </label>
                  <p className="text-xs text-on-surface-variant">Every run asks the models above, so it costs what a run by hand costs. It starts with mail that arrives after you turn it on.</p>
                  {preview.lastAuto && <p className={`text-xs ${preview.lastAuto.error ? 'text-error' : 'text-on-surface-variant'}`}>Last automatic run: {lastAutoText(preview.lastAuto)}</p>}
                </section>
              </>
            )}

            {view === 'running' && run && (
              <section aria-label="Progress" className="space-y-3 py-4">
                <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin text-accent" /> {STAGE_TEXT[run.stage]}</p>
                <div role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done} className="h-2 overflow-hidden rounded-full bg-surface-container-highest">
                  <div className="h-full bg-primary transition-all" style={{ width: `${run.total ? Math.round((run.done / run.total) * 100) : 0}%` }} />
                </div>
                <p className="text-on-surface-variant">{run.done} of {run.total} mails. You can close this window; triage keeps running.</p>
              </section>
            )}

            {view === 'result' && run && (
              <section aria-label="Result" className="space-y-4">
                {run.error && <p role="alert" className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-error">Triage failed: {run.error}</p>}
                {run.cancelled && <p className="text-on-surface-variant">Triage was cancelled. Answers given before that are kept.</p>}
                {result && (
                  <>
                    <p><span className="font-medium">{summary.total} {summary.total === 1 ? 'mail' : 'mails'} triaged.</span>{' '}
                      <span className="text-on-surface-variant">{(['owner', 'decision', 'llm'] as const).filter((s) => summary.sources[s]).map((s) => `${summary.sources[s]} ${sourceLabel[s]}`).join(' · ')}</span>
                    </p>
                    {summary.total > 0 && (
                      <table className="w-full text-left text-sm">
                        <thead><tr className="text-xs text-on-surface-variant"><th className="py-1 font-normal">Category</th><th className="py-1 text-right font-normal">High</th><th className="py-1 text-right font-normal">Normal</th><th className="py-1 text-right font-normal">Low</th></tr></thead>
                        <tbody>
                          {Object.entries(summary.cells).sort(([a], [b]) => a.localeCompare(b)).map(([category, row]) => (
                            <tr key={category} className="border-t border-outline-variant/30">
                              <td className="py-1">{category}</td>
                              <td className={`py-1 text-right tabular-nums ${row.high ? 'font-medium text-error' : 'text-on-surface-variant/50'}`}>{row.high ?? 0}</td>
                              <td className="py-1 text-right tabular-nums">{row.normal ?? 0}</td>
                              <td className="py-1 text-right tabular-nums text-on-surface-variant">{row.low ?? 0}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {result.labeled > 0 && <p className="text-on-surface-variant">{result.labeled} labelled in the mailbox.</p>}
                    {result.labelError && <p className="text-error">Labelling failed: {result.labelError}</p>}
                    {!!result.protected && <p className="text-on-surface-variant">{result.protected} IMAP {result.protected === 1 ? 'mail was' : 'mails were'} left out: {result.protected === 1 ? 'its' : 'their'} protection level keeps {result.protected === 1 ? 'it' : 'them'} on local models, and the triage models are not local.</p>}
                    {result.archived.length > 0 && (
                      <p className="flex flex-wrap items-center gap-2">
                        {undone ? `${result.archived.length} put back in the inbox.` : `${result.archived.length} low-priority ${result.archived.length === 1 ? 'mail' : 'mails'} archived.`}
                        {!undone && <button className={btn} disabled={busy === 'undo'} onClick={async () => { setBusy('undo'); try { await onUnarchive(result.archived); setUndone(true); } catch (err) { setError((err as Error).message); } finally { setBusy(''); } }}>Undo</button>}
                      </p>
                    )}
                    {proposed.length > 0 && (
                      <div className="space-y-2 rounded-md border border-outline-variant/40 p-3">
                        <p className="font-medium">{proposed.length} low-priority {proposed.length === 1 ? 'mail looks' : 'mails look'} safe to archive</p>
                        <ul className="max-h-48 space-y-1 overflow-y-auto">
                          {proposed.map((id) => {
                            const it = byId.get(id);
                            return (
                              <li key={id}>
                                <label className="flex cursor-pointer items-center gap-2">
                                  <input type="checkbox" checked={picked.has(id)} onChange={(e) => { const next = new Set(picked); if (e.target.checked) next.add(id); else next.delete(id); setArchivePick(next); }} />
                                  <span className="w-36 shrink-0 truncate text-on-surface-variant">{it ? who(it.from) : 'Mail not in the loaded list'}</span>
                                  <span className="truncate">{it?.subject}</span>
                                  <span className="ml-auto shrink-0 text-xs text-on-surface-variant">{result.triage[id]?.category}</span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                        <button className={btn} disabled={picked.size === 0 || busy === 'archive'} onClick={async () => { setBusy('archive'); try { await onArchive([...picked]); onRun({ ...run, result: { ...result, archiveProposed: proposed.filter((id) => !picked.has(id)) } }); setArchivePick(null); } catch (err) { setError((err as Error).message); } finally { setBusy(''); } }}>
                          <Archive className="h-4 w-4" /> Archive {picked.size}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {view !== 'running' && (
              <section aria-label="Review" className="space-y-2 border-t border-outline-variant/40 pt-3">
                <button className={btnGhost} aria-expanded={reviewOpen} onClick={() => setReviewOpen(!reviewOpen)}>{reviewOpen ? 'Hide the review' : 'Review the answers the model was unsure of, or label a backlog'}</button>
                {reviewOpen && <TriageReview onClose={() => setReviewOpen(false)} />}
              </section>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant/60 px-5 py-3">
            {view === 'setup' && settings ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-on-surface-variant">
                <input type="checkbox" checked={settings.skipDialog} onChange={(e) => set({ skipDialog: e.target.checked })} />
                Start right away next time, with these settings
              </label>
            ) : <span />}
            <div className="flex gap-2">
              {view === 'setup' && <button className={btnGhost} onClick={onClose}>Cancel</button>}
              {view === 'setup' && <button className={btnPrimary} disabled={!preview || !settings || !!llmError || !!catRows || busy === 'start' || (!useNewest && count === 0)} onClick={start}>{busy === 'start' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {useNewest ? 'Start triage' : `Triage ${count} ${count === 1 ? 'mail' : 'mails'}`}</button>}
              {view === 'running' && <button className={btn} onClick={cancel}>Stop triage</button>}
              {view === 'running' && <button className={btnPrimary} onClick={onClose}>Run in background</button>}
              {view === 'result' && <button className={btnGhost} onClick={() => onRun(null)}>Triage again…</button>}
              {view === 'result' && <button className={btnPrimary} onClick={onClose}>Done</button>}
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}
