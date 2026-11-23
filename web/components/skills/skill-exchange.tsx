'use client';

/**
 * Skill exchange on the Skills page (docs/SKILL-EXCHANGE.md): export chosen
 * skills as one JSON bundle, and import a bundle or a SKILL.md — previewed in
 * full (content, signature, collisions) before anything is written, installed
 * only on Install, with a decision for every name that is already taken.
 * Listings of the configured skill registries are browsed here too, and go
 * through the same preview and install: there is no install without a preview.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, Download, Loader2, Search, ShieldAlert, ShieldCheck, Upload, X } from 'lucide-react';
import { useState } from 'react';
import { Portal } from '@/components/ui/portal';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type {
  SkillBundleExport,
  SkillImportDecision,
  SkillImportPreview,
  SkillImportResult,
  SkillImportSource,
} from '../../../src/shared/skill-exchange';
import type { SkillRegistryListing, SkillRegistryListingResponse } from '../../../src/shared/skill-registry';

interface ExportableSkill {
  id: string;
  name: string;
  description: string;
  mounted?: boolean;
}

function Dialog({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <Portal>
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
        <div
          role="dialog"
          aria-label={title}
          className={cn('bg-surface-container rounded-xl shadow-xl w-full mx-4 max-h-[90vh] flex flex-col', wide ? 'max-w-3xl' : 'max-w-lg')}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between p-4 border-b border-outline-variant/10">
            <h2 className="text-lg font-semibold text-on-surface">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="text-on-surface-variant hover:text-on-surface cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="p-4 space-y-4 overflow-y-auto">{children}</div>
        </div>
      </div>
    </Portal>
  );
}

function ErrorLine({ message }: { message: string }) {
  if (!message) return null;
  return <div role="alert" className="text-sm text-error bg-error-container/60 rounded-lg px-3 py-2">{message}</div>;
}

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

export function ExportSkillsDialog({ skills, onClose }: { skills: ExportableSkill[]; onClose: () => void }) {
  const exportable = skills.filter((s) => !s.mounted);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const toggle = (id: string) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const download = async () => {
    setError('');
    setBusy(true);
    try {
      const ids = exportable.filter((s) => chosen.has(s.id)).map((s) => s.id);
      const result = await api.get<SkillBundleExport>(`/skills/exchange/export?ids=${ids.map(encodeURIComponent).join(',')}`);
      const blob = new Blob([`${JSON.stringify(result.bundle, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = ids.length === 1 ? `${result.bundle.skills[0].name.replace(/[^a-zA-Z0-9_-]+/g, '_')}.skills.json` : 'skills.skills.json';
      link.click();
      URL.revokeObjectURL(url);
      setNote(result.note);
    } catch (err) {
      setError(message(err, 'Could not export the skills'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Export skills" onClose={onClose}>
      <ErrorLine message={error} />
      <p className="text-sm text-on-surface-variant">
        One JSON file with each skill&apos;s content and metadata — no ids, owners or usage data. Mounted skills are not listed: copy their folder instead.
      </p>
      <div className="flex gap-2 text-xs">
        <button type="button" className="text-primary cursor-pointer" onClick={() => setChosen(new Set(exportable.map((s) => s.id)))}>Select all</button>
        <button type="button" className="text-primary cursor-pointer" onClick={() => setChosen(new Set())}>Clear</button>
      </div>
      <ul className="space-y-1 max-h-72 overflow-y-auto">
        {exportable.map((s) => (
          <li key={s.id}>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={chosen.has(s.id)} onChange={() => toggle(s.id)} className="mt-1" />
              <span><span className="text-on-surface">{s.name}</span> <span className="text-on-surface-variant">— {s.description}</span></span>
            </label>
          </li>
        ))}
      </ul>
      {note && <p role="status" className="text-xs text-on-surface-variant">{note}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg cursor-pointer">Close</button>
        <button type="button" onClick={() => void download()} disabled={busy || chosen.size === 0}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer">
          <Download className="w-4 h-4" />
          {busy ? 'Exporting…' : `Download ${chosen.size || ''} ${chosen.size === 1 ? 'skill' : 'skills'}`}
        </button>
      </div>
    </Dialog>
  );
}

type SourceKind = 'file' | 'paste' | 'url' | 'registry';

const SOURCE_LABELS: Record<SourceKind, string> = { file: 'Upload a file', paste: 'Paste', url: 'From a URL', registry: 'Browse registries' };

/**
 * The configured skill registries' listings, searchable. Index text is shown
 * as plain text (never HTML). "Preview" hands the listing to the import
 * preview; nothing installs from here.
 */
function RegistryBrowser({ onPreview, busy }: { onPreview: (listing: SkillRegistryListing) => void; busy: boolean }) {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const { data: result, error: failure, isFetching: loading } = useQuery({
    queryKey: ['skill-registry', term],
    queryFn: () => api.get<SkillRegistryListingResponse>(`/skills/exchange/registry${term ? `?q=${encodeURIComponent(term)}` : ''}`),
  });
  const error = failure ? message(failure, 'Could not read the skill registries') : '';

  if (result && result.registries.length === 0) {
    return (
      <p className="text-sm text-on-surface-variant">
        No skill registry is configured, and none is contacted until an administrator adds one (Settings → Skills, skills.registries).
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <ErrorLine message={error} />
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setTerm(query.trim()); }}>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the skill registries" placeholder="Search by name, description, tag or author"
          className="flex-1 px-3 py-2 bg-surface-container-low border border-outline-variant/10 rounded-lg text-sm text-on-surface" />
        <button type="submit" disabled={loading} className="flex items-center gap-1.5 px-3 py-2 text-sm bg-surface-container-high text-on-surface rounded-lg disabled:opacity-50 cursor-pointer">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}Search
        </button>
      </form>
      {result?.errors.map((e) => <p key={e.registry} className="text-xs text-warning">{e.registry}: {e.error}</p>)}
      {result && result.listings.length === 0 && <p className="text-sm text-on-surface-variant">No skill matches.</p>}
      <ul className="space-y-2 max-h-96 overflow-y-auto">
        {result?.listings.map((l) => {
          const trusted = l.signature.status === 'valid';
          return (
            <li key={`${l.registry}/${l.name}`} className="rounded-xs ring-1 ring-outline-variant/10 p-3 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-medium text-on-surface break-words">{l.name} <span className="text-xs text-on-surface-variant">{l.version} · {l.registry}{l.author ? ` · ${l.author}` : ''}</span></h3>
                  <p className="text-xs text-on-surface-variant whitespace-pre-wrap break-words">{l.description}</p>
                  <p className="text-xs text-on-surface-variant">Skills: {l.skills.join(', ')}</p>
                  {l.tags.length > 0 && <p className="text-xs text-on-surface-variant">Tags: {l.tags.join(', ')}</p>}
                </div>
                <button type="button" disabled={busy} onClick={() => onPreview(l)} className="shrink-0 px-3 py-1.5 text-xs bg-primary text-on-primary rounded-xs disabled:opacity-50 cursor-pointer">
                  Preview
                </button>
              </div>
              <p className={cn('flex items-center gap-1 text-xs', trusted ? 'text-tertiary' : 'text-warning')}>
                {trusted ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}{l.signature.detail}
              </p>
              {l.installedVersion && (
                <p className={cn('flex items-center gap-1 text-xs', l.updateAvailable ? 'text-primary' : 'text-on-surface-variant')}>
                  {l.updateAvailable && <ArrowUpCircle className="w-3.5 h-3.5" />}
                  {l.updateAvailable ? `Installed ${l.installedVersion}; ${l.version} is available (preview it to update)` : `Installed ${l.installedVersion}`}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {result?.truncated && <p className="text-xs text-on-surface-variant">More skills match than are shown; narrow the search.</p>}
    </div>
  );
}

/** What the user picked for one previewed skill. */
type Choice = { action: 'create' | 'skip' | 'replace' | 'rename'; newName: string };

function SignatureLine({ preview }: { preview: SkillImportPreview }) {
  const { signature } = preview;
  const good = signature.status === 'valid';
  const Icon = good ? ShieldCheck : ShieldAlert;
  return (
    <div className={cn('flex items-start gap-2 text-sm rounded-lg px-3 py-2', good ? 'bg-tertiary/10 text-tertiary' : 'bg-warning/10 text-warning')}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div>
        <p>{good ? `Signed by ${signature.publisher}` : signature.detail}</p>
        {signature.keyId && <p className="text-xs break-all opacity-80">{signature.keyId}</p>}
        <p className="text-xs break-all opacity-80">Content hash {preview.contentHash}</p>
      </div>
    </div>
  );
}

export function ImportSkillsDialog({ isAdmin, onClose }: { isAdmin: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<SourceKind>('file');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [source, setSource] = useState<SkillImportSource | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SkillImportResult | null>(null);

  /** A pasted or uploaded text: a bundle when it is a JSON object, else a SKILL.md. */
  const textSource = (value: string): SkillImportSource => (value.trimStart().startsWith('{') ? { bundle: value } : { skillMd: value });

  const readFile = async (file: File | undefined) => {
    setPreview(null);
    setDone(null);
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
  };

  const runPreview = async (from?: SkillImportSource) => {
    setError('');
    setPreview(null);
    setDone(null);
    const next = from ?? (kind === 'url' ? { url: url.trim() } : textSource(text));
    setBusy(true);
    try {
      const result = await api.post<SkillImportPreview>('/skills/exchange/preview', next);
      setSource(next);
      setPreview(result);
      setChoices(Object.fromEntries(result.skills.map((item) => [item.skill.name, {
        action: item.collision ? 'skip' : 'create',
        newName: `${item.skill.name} (imported)`,
      } satisfies Choice])));
    } catch (err) {
      setError(message(err, 'Could not read that import'));
    } finally {
      setBusy(false);
    }
  };

  const runInstall = async () => {
    if (!preview || !source) return;
    setError('');
    setBusy(true);
    try {
      const decisions: SkillImportDecision[] = preview.skills.map((item) => {
        const choice = choices[item.skill.name];
        if (choice.action === 'rename') return { name: item.skill.name, action: 'rename', newName: choice.newName };
        if (choice.action === 'replace' && item.collision) return { name: item.skill.name, action: 'replace', skillId: item.collision.id };
        return { name: item.skill.name, action: choice.action === 'skip' ? 'skip' : 'create' };
      });
      const result = await api.post<SkillImportResult>('/skills/exchange/install', { ...source, contentHash: preview.contentHash, decisions });
      setDone(result);
      for (const key of ['skills', 'skill-usage', 'skill-registry']) void queryClient.invalidateQueries({ queryKey: [key] });
    } catch (err) {
      setError(message(err, 'Could not install the skills'));
    } finally {
      setBusy(false);
    }
  };

  const setChoice = (name: string, change: Partial<Choice>) => setChoices((prev) => ({ ...prev, [name]: { ...prev[name], ...change } }));
  const writes = preview ? preview.skills.filter((i) => choices[i.skill.name]?.action !== 'skip').length : 0;

  return (
    <Dialog title="Import skills" onClose={onClose} wide>
      <ErrorLine message={error} />
      {done ? (
        <div role="status" className="space-y-2 text-sm">
          <p className="text-on-surface">
            {done.created.length} created, {done.replaced.length} replaced, {done.skipped.length} skipped.
          </p>
          {[...done.created, ...done.replaced].map((s) => <p key={s.id} className="text-on-surface-variant">{s.name}</p>)}
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm bg-primary text-on-primary rounded-xs cursor-pointer">Done</button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm text-on-surface-variant">
            A skill is prompt text that steers your agents. Read it in full before you install it: nothing is written until you press Install.
          </p>
          <div className="flex gap-1.5" role="tablist">
            {(['file', 'paste', ...(isAdmin ? ['url' as const] : []), 'registry'] as SourceKind[]).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => { setKind(k); setPreview(null); }}
                className={cn('px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer', kind === k ? 'bg-primary text-on-surface' : 'bg-surface-container-high text-on-surface-variant')}>
                {SOURCE_LABELS[k]}
              </button>
            ))}
          </div>
          {kind === 'file' && (
            <label className="block text-sm text-on-surface-variant">
              A skill bundle (.json) or a SKILL.md
              <input type="file" accept=".json,.md,application/json,text/markdown" onChange={(e) => void readFile(e.target.files?.[0])} className="block mt-1 text-sm" />
              {fileName && <span className="text-xs">{fileName}</span>}
            </label>
          )}
          {kind === 'paste' && (
            <textarea value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} rows={8} aria-label="Bundle JSON or SKILL.md"
              placeholder="Paste a skill bundle (JSON) or a SKILL.md (frontmatter + body)"
              className="w-full px-3 py-2 bg-surface-container-low border border-outline-variant/10 rounded-lg text-sm font-mono text-on-surface" />
          )}
          {kind === 'url' && (
            <label className="block text-sm text-on-surface-variant">
              An https URL of a bundle signed by a publisher in plugins.trustedPublishers
              <input type="url" value={url} onChange={(e) => { setUrl(e.target.value); setPreview(null); }} placeholder="https://…/skills.json"
                className="w-full mt-1 px-3 py-2 bg-surface-container-low border border-outline-variant/10 rounded-lg text-sm text-on-surface" />
            </label>
          )}
          {kind === 'registry' && !preview && (
            <RegistryBrowser busy={busy} onPreview={(l) => void runPreview({ registry: { registry: l.registry, name: l.name, version: l.version } })} />
          )}
          {!preview && kind !== 'registry' && (
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg cursor-pointer">Cancel</button>
              <button type="button" onClick={() => void runPreview()} disabled={busy || (kind === 'url' ? !url.trim() : !text.trim())}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-on-primary rounded-xs disabled:opacity-50 cursor-pointer">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}Preview
              </button>
            </div>
          )}
          {preview && (
            <div className="space-y-3">
              {preview.registry && (
                <p className="text-xs text-on-surface-variant break-all">
                  {preview.registry.name} {preview.registry.version} from the registry {preview.registry.registry} ({preview.url})
                </p>
              )}
              <SignatureLine preview={preview} />
              {preview.refusal && <ErrorLine message={preview.refusal} />}
              {preview.warnings.map((w) => <p key={w} className="text-xs text-warning">{w}</p>)}
              {preview.skills.map((item) => {
                const choice = choices[item.skill.name];
                const { collision } = item;
                return (
                  <div key={item.skill.name} className="rounded-xs ring-1 ring-outline-variant/10 p-3 space-y-2">
                    <div>
                      <h3 className="font-medium text-on-surface">{item.skill.name} <span className="text-xs text-on-surface-variant">· {item.skill.category}</span></h3>
                      <p className="text-xs text-on-surface-variant">{item.skill.description}</p>
                    </div>
                    {collision && (
                      <div className="text-xs text-warning space-y-1">
                        <p>A {collision.kind === 'own' ? 'skill of yours' : `${collision.kind} skill`} is already named &quot;{collision.name}&quot;.</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <select aria-label={`What to do with ${item.skill.name}`} value={choice.action}
                            onChange={(e) => setChoice(item.skill.name, { action: e.target.value as Choice['action'] })}
                            className="px-2 py-1 bg-surface-container border border-outline-variant/10 rounded text-xs text-on-surface">
                            <option value="skip">Don&apos;t import it</option>
                            <option value="rename">Import under another name</option>
                            {collision.canReplace && <option value="replace">Replace &quot;{collision.name}&quot;</option>}
                          </select>
                          {choice.action === 'rename' && (
                            <input aria-label={`New name for ${item.skill.name}`} value={choice.newName}
                              onChange={(e) => setChoice(item.skill.name, { newName: e.target.value })}
                              className="px-2 py-1 bg-surface-container border border-outline-variant/10 rounded text-xs text-on-surface" />
                          )}
                        </div>
                      </div>
                    )}
                    {!collision && (
                      <label className="flex items-center gap-2 text-xs text-on-surface-variant">
                        <input type="checkbox" checked={choice.action !== 'skip'} onChange={(e) => setChoice(item.skill.name, { action: e.target.checked ? 'create' : 'skip' })} />
                        Import this skill
                      </label>
                    )}
                    <details>
                      <summary className="text-xs text-primary cursor-pointer">Full content</summary>
                      <pre className="mt-2 text-xs text-on-surface-variant bg-surface-container-low rounded-lg p-3 whitespace-pre-wrap font-mono max-h-80 overflow-y-auto">
                        {[
                          item.skill.content,
                          ...(['principles', 'bestPractices', 'antiPatterns', 'frameworks'] as const)
                            .filter((f) => item.skill[f].length > 0)
                            .map((f) => `${f}:\n${item.skill[f].map((x) => `- ${x}`).join('\n')}`),
                        ].filter(Boolean).join('\n\n') || '(no body)'}
                      </pre>
                    </details>
                  </div>
                );
              })}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setPreview(null)} className="px-4 py-2 text-sm text-on-surface/80 bg-surface-container-high rounded-lg cursor-pointer">Back</button>
                <button type="button" onClick={() => void runInstall()} disabled={busy || !preview.installable || writes === 0}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary text-on-primary rounded-xs disabled:opacity-50 cursor-pointer">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  Install {writes} {writes === 1 ? 'skill' : 'skills'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
