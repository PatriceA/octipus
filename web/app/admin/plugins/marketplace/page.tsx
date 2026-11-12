'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, Package, Search, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ConsentDialog } from '@/components/plugins/consent-dialog';
import { AuthedImage } from '@/components/ui/authed-image';
import { Markdown } from '@/components/ui/markdown-renderer';
import { Portal } from '@/components/ui/portal';
import { api } from '@/lib/api';
import {
  displayText,
  foldForSearch,
  listingImages,
  type MarketplaceListing,
  type MarketplacePluginView,
  PLUGIN_MARKETPLACE_KEY,
  PLUGIN_PACKAGES_KEY,
  PLUGIN_UPDATES_KEY,
  registryLabel,
} from '@/lib/plugin-packages';
import { cn } from '@/lib/utils';

type Sort = 'relevance' | 'name' | 'newest' | 'downloads';

const UNCONFIGURED = 'The Octipus marketplace is not configured in this build';

/** A link from the listing (homepage, author): https only, opened without opener or referrer; anything else is not a link. */
function SafeLink({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  let ok = false;
  try {
    ok = !!href && new URL(href).protocol === 'https:';
  } catch {
    ok = false;
  }
  if (!ok) return null;
  return (
    <a href={href as string} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex items-center gap-1 text-primary underline hover:opacity-80">
      {children} <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

/** How well `p` matches the folded search words: title first, then tags, summary, author. 0: no match. */
function relevance(p: MarketplacePluginView, words: string[]): number {
  if (words.length === 0) return 1;
  const fields: Array<[string, number]> = [
    [foldForSearch(`${p.title} ${p.name}`), 8], [foldForSearch(p.tags.join(' ')), 4], [foldForSearch(`${p.summary} ${p.description}`), 2],
    [foldForSearch(p.author?.name ?? ''), 1],
  ];
  let score = 0;
  for (const word of words) {
    const hit = fields.filter(([text]) => text.includes(word)).reduce((sum, [, weight]) => sum + weight, 0);
    if (hit === 0) return 0;
    score += hit;
  }
  return score;
}

const newest = (p: MarketplacePluginView) => p.versions.map((v) => v.publishedAt ?? '').sort().at(-1) ?? '';

function Badges({ p }: { p: MarketplacePluginView }) {
  const badges: Array<{ text: string; tone: string }> = [];
  if (p.revoked) badges.push({ text: 'revoked', tone: 'border-error/60 text-error' });
  if (p.updateAvailable) badges.push({ text: `update ${displayText(p.updateAvailable)}`, tone: 'border-primary/60 text-primary' });
  else if (p.installedVersion) badges.push({ text: `installed ${displayText(p.installedVersion)}`, tone: 'border-tertiary/60 text-tertiary' });
  if (!p.compatibility.ok) badges.push({ text: 'incompatible', tone: 'border-warning/60 text-warning' });
  if (p.deprecated) badges.push({ text: 'deprecated', tone: 'border-warning/60 text-warning' });
  if (badges.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1" data-testid="marketplace-badges">
      {badges.map((b) => <span key={b.text} className={cn('rounded-xs border px-1 text-[11px]', b.tone)}>{b.text}</span>)}
    </span>
  );
}

function Icon({ p, size = 'h-10 w-10' }: { p: MarketplacePluginView; size?: string }) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-container-high text-on-surface-variant [&_img]:h-full [&_img]:w-full [&_img]:object-cover', size)}>
      {p.icon ? <AuthedImage src={p.icon} alt="" /> : <Package className="h-5 w-5" aria-hidden />}
    </span>
  );
}

function Card({ p, onOpen }: { p: MarketplacePluginView; onOpen: () => void }) {
  return (
    <li data-testid="marketplace-card" data-name={p.name} data-registry={p.registry}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${displayText(p.title)}: details`}
        className="flex h-full w-full flex-col gap-2 rounded-md border border-outline-variant/50 bg-surface-container-low p-3 text-left hover:border-primary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="flex items-start gap-3">
          <Icon p={p} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-on-surface">{displayText(p.title)}</span>
            <span className="block truncate text-xs text-on-surface-variant">
              {displayText(p.author?.name ?? p.name)}{p.category ? ` · ${displayText(p.category)}` : ''}{p.latest ? ` · ${displayText(p.latest)}` : ''}
            </span>
          </span>
        </span>
        <span className="line-clamp-2 text-xs text-on-surface">{displayText(p.summary || p.description)}</span>
        {p.askSummary.length > 0 && (
          <span className="line-clamp-2 text-xs text-on-surface-variant" data-testid="marketplace-asks">
            <span className="font-medium">What it asks for:</span> {p.askSummary.map(displayText).join('; ')}
          </span>
        )}
        <span className="mt-auto flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
          <span data-testid="marketplace-registry">{registryLabel(p.registry)}</span>
          {p.downloads !== null && <span data-testid="marketplace-downloads"><Download className="inline h-3 w-3" aria-hidden /> {p.downloads.toLocaleString()} downloads</span>}
          <Badges p={p} />
        </span>
      </button>
    </li>
  );
}

/** One plugin in full: README, screenshots, changelog, versions, licence, links, publisher, signature, and Install. */
function Detail({ p, onClose, onInstall }: { p: MarketplacePluginView; onClose: () => void; onInstall: () => void }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [onClose]);
  const images = useMemo(() => ({ image: listingImages([p.icon, ...p.screenshots]) }), [p.icon, p.screenshots]);
  const current = p.installedVersion !== null && p.updateAvailable === null;
  const blocked = p.latest === null ? (p.compatibility.reason ?? 'No version can be installed here') : p.revoked && !p.updateAvailable && !p.installedVersion ? `Revoked: ${p.revoked}` : null;
  const latest = p.versions.find((v) => v.version === p.latest);
  return (
    <Portal>
      <div className="fixed inset-0 z-40 flex justify-end bg-black/40 font-sans" onClick={onClose}>
        <div
          ref={panel}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          data-testid="marketplace-detail"
          onClick={(e) => e.stopPropagation()}
          className="flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-outline-variant bg-surface-container shadow-2xl outline-none"
        >
          <div className="flex items-start gap-3 border-b border-outline-variant/60 p-4">
            <Icon p={p} size="h-12 w-12" />
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold text-on-surface">{displayText(p.title)}</h2>
              <p className="text-xs text-on-surface-variant">
                <code className="font-mono">{displayText(p.name)}</code>{p.latest ? ` ${displayText(p.latest)}` : ''} · <span data-testid="detail-registry">{registryLabel(p.registry)}</span>
              </p>
              <p className="mt-1 text-sm text-on-surface">{displayText(p.summary || p.description)}</p>
              <div className="mt-1"><Badges p={p} /></div>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-xs p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              {current ? (
                <span className="text-xs text-tertiary">Installed {displayText(p.installedVersion)}</span>
              ) : (
                <button
                  type="button"
                  onClick={onInstall}
                  disabled={blocked !== null}
                  className="inline-flex items-center gap-1 rounded-xs bg-primary px-3 py-1.5 text-xs font-medium text-on-primary disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden /> {p.updateAvailable ? `Upgrade to ${displayText(p.updateAvailable)}` : 'Install'}
                </button>
              )}
              {blocked && <span className="text-xs text-warning">{displayText(blocked)}</span>}
            </div>
            {p.warnings.length > 0 && (
              <ul className="space-y-0.5 text-xs text-on-surface-variant" data-testid="detail-warnings">
                {p.warnings.map((w) => <li key={`${w.code}-${w.message}`}>{displayText(w.message)}</li>)}
              </ul>
            )}
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-on-surface-variant">Source</dt><dd>{registryLabel(p.registry)}</dd>
              <dt className="text-on-surface-variant">Signature</dt>
              <dd data-testid="detail-signature">
                {p.registry === 'marketplace'
                  ? 'Checked at install: it must be signed by a key the marketplace\'s root-signed keys.json endorses now.'
                  : 'Checked at install: it must be signed by a publisher in plugins.trustedPublishers.'}
                {latest?.contentHash && <> Content <code className="break-all font-mono">{latest.contentHash}</code>.</>}
              </dd>
              <dt className="text-on-surface-variant">Publisher</dt><dd>{displayText(p.publisher) || '—'} <span className="text-on-surface-variant">(as the listing states)</span></dd>
              {p.author && <><dt className="text-on-surface-variant">Author</dt><dd>{displayText(p.author.name)} {p.author.url && <SafeLink href={p.author.url}>site</SafeLink>}</dd></>}
              <dt className="text-on-surface-variant">Licence</dt><dd>{displayText(p.license) || '—'}</dd>
              {p.homepage && <><dt className="text-on-surface-variant">Homepage</dt><dd><SafeLink href={p.homepage}>{displayText(p.homepage)}</SafeLink></dd></>}
              {p.downloads !== null && <><dt className="text-on-surface-variant">Downloads</dt><dd>{p.downloads.toLocaleString()} <span className="text-on-surface-variant">(reported by the marketplace)</span></dd></>}
            </dl>
            {p.declarations.length > 0 && (
              <section aria-labelledby={`${titleId}-asks`}>
                <h3 id={`${titleId}-asks`} className="text-xs font-semibold text-on-surface">What it asks for</h3>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-on-surface-variant" data-testid="detail-declarations">
                  {p.declarations.map((d) => <li key={d.id}>{displayText(d.label)} <span className="font-mono">{displayText(d.detail)}</span></li>)}
                </ul>
                <p className="mt-1 text-xs text-on-surface-variant">Installing shows each item again, to agree to one by one; the host checks the download says exactly this.</p>
              </section>
            )}
            {p.screenshots.length > 0 && (
              <section aria-label="Screenshots" className="flex gap-2 overflow-x-auto [&_img]:max-h-48 [&_img]:rounded-md" data-testid="detail-screenshots">
                {p.screenshots.map((s, i) => <AuthedImage key={s} src={s} alt={`Screenshot ${i + 1}`} />)}
              </section>
            )}
            {p.readme && (
              <section aria-label="README" data-testid="detail-readme" className="rounded-md border border-outline-variant/40 p-3">
                <Markdown content={p.readme} listing={images} />
              </section>
            )}
            {p.changelog && (
              <section aria-labelledby={`${titleId}-changes`} data-testid="detail-changelog">
                <h3 id={`${titleId}-changes`} className="text-xs font-semibold text-on-surface">Changelog</h3>
                <Markdown content={p.changelog} listing={images} className="text-xs" />
              </section>
            )}
            <section aria-labelledby={`${titleId}-versions`}>
              <h3 id={`${titleId}-versions`} className="text-xs font-semibold text-on-surface">Versions</h3>
              <table className="mt-1 w-full text-left text-xs" data-testid="detail-versions">
                <thead className="text-on-surface-variant"><tr><th className="py-0.5 font-normal">Version</th><th className="font-normal">Published</th><th className="font-normal">Here</th></tr></thead>
                <tbody>
                  {p.versions.map((v) => (
                    <tr key={v.version} className="border-t border-outline-variant/30">
                      <td className="py-0.5 font-mono">{displayText(v.version)}</td>
                      <td>{v.publishedAt ? new Date(v.publishedAt).toLocaleDateString() : '—'}</td>
                      <td className={v.revoked || !v.compatibility.ok ? 'text-warning' : 'text-on-surface-variant'}>
                        {v.revoked ? `revoked: ${displayText(v.revoked)}` : v.compatibility.ok ? 'can be installed' : displayText(v.compatibility.reason)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/**
 * Admin → Plugins → Marketplace: the Octipus marketplace and the registries
 * in `plugins.registries`, searchable at once (title, summary, tags, author;
 * case and accents folded), by category, sorted. A card opens the detail; its
 * Install opens the consent.
 */
export default function MarketplacePage() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const [q, setQ] = useState(() => params.get('q') ?? '');
  const [category, setCategory] = useState<string | null>(() => params.get('category'));
  const [sort, setSort] = useState<Sort>('relevance');
  const [open, setOpen] = useState<string | null>(null);
  const [installing, setInstalling] = useState<MarketplacePluginView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: PLUGIN_MARKETPLACE_KEY,
    queryFn: () => api.get<MarketplaceListing>('/plugin-packages/marketplace'),
  });
  const plugins = data?.plugins ?? [];
  const hasDownloads = plugins.some((p) => p.downloads !== null);
  const words = foldForSearch(q).split(/\s+/).filter(Boolean);
  const shown = plugins
    .map((p, i) => ({ p, i, score: relevance(p, words) }))
    .filter(({ p, score }) => score > 0 && (category === null || p.category === category))
    .sort((a, b) => {
      if (sort === 'name') return a.p.title.localeCompare(b.p.title);
      if (sort === 'newest') return newest(b.p).localeCompare(newest(a.p)) || a.i - b.i;
      if (sort === 'downloads') return (b.p.downloads ?? -1) - (a.p.downloads ?? -1) || a.i - b.i;
      return b.score - a.score || a.i - b.i;
    })
    .map(({ p }) => p);
  const key = (p: MarketplacePluginView) => `${p.registry}\n${p.name}`;
  const detail = plugins.find((p) => key(p) === open) ?? null;
  const registries = [...new Set([...plugins.map((p) => p.registry), ...(data?.errors ?? []).map((e) => e.registry)])].filter((r) => r !== 'marketplace');
  const searchId = useId();

  return (
    <div className="space-y-4" data-testid="admin-plugin-marketplace">
      <div>
        <h2 className="section-label">marketplace</h2>
        <p className="mt-1 text-xs text-on-surface-variant">
          Plugins from the Octipus marketplace and the registries in <code>plugins.registries</code>. Each is verified at install
          (signature, listing, content hash) and runs only with what it declares, item by item, once you agree to it.
        </p>
      </div>
      {data?.state === 'unconfigured' && <p role="status" className="rounded-xs border border-outline-variant/50 p-2 text-xs text-on-surface" data-testid="marketplace-state">{UNCONFIGURED}.</p>}
      {data?.state === 'off' && <p role="status" className="rounded-xs border border-outline-variant/50 p-2 text-xs text-on-surface" data-testid="marketplace-state">{displayText(data.message) || 'The Octipus marketplace is turned off (plugins.marketplace: false).'}</p>}
      {data?.state === 'error' && <p role="alert" className="rounded-xs border border-error/50 p-2 text-xs text-error" data-testid="marketplace-state">! {displayText(data.message) || 'The Octipus marketplace could not be read.'}</p>}
      {error && <p role="alert" className="text-xs text-error">! {(error as Error).message}</p>}
      {(data?.stale ?? []).map((s) => (
        <p key={s.file} role="alert" className="rounded-xs border border-warning/60 p-2 text-xs text-warning" data-testid="marketplace-stale">! {displayText(s.message)}</p>
      ))}
      {/* The marketplace's own read error is the state line above; its refused ("replaced") entries are listed here. */}
      {(data?.errors ?? []).filter((e) => e.registry !== 'marketplace' || data?.state !== 'error').map((e, i) => (
        <p key={`${e.registry}-${i}`} role="alert" className="text-xs text-warning" data-testid="marketplace-registry-error">! {registryLabel(e.registry)}: {displayText(e.error)}</p>
      ))}
      {registries.length > 0 && (
        <p className="text-xs text-on-surface-variant" data-testid="marketplace-registries">
          Also listing: {registries.map(registryLabel).join(', ')}
        </p>
      )}
      {message && <p role="status" className="text-xs text-on-surface" data-testid="marketplace-message">{message}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={searchId} className="relative min-w-64 flex-1">
          <span className="sr-only">Search plugins</span>
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant" aria-hidden />
          <input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, summary, tag or author"
            className="w-full rounded-md border border-outline-variant bg-surface-container-high py-1.5 pl-8 pr-2 text-sm text-on-surface"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-on-surface-variant">
          Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-md border border-outline-variant bg-surface-container-high px-2 py-1 text-sm text-on-surface">
            <option value="relevance">Relevance</option>
            <option value="name">Name</option>
            <option value="newest">Newest</option>
            {hasDownloads && <option value="downloads">Most downloaded</option>}
          </select>
        </label>
      </div>
      {(data?.categories ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Categories">
          {[null, ...(data?.categories ?? [])].map((c) => (
            <button
              key={c ?? 'all'}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={cn('rounded-full border px-2.5 py-0.5 text-xs', category === c ? 'border-primary bg-primary text-on-primary' : 'border-outline-variant text-on-surface hover:bg-surface-container-high')}
            >
              {c === null ? 'All' : displayText(c)}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="p-8 text-center text-on-surface-variant">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="rounded-xs border border-dashed border-outline-variant/40 p-8 text-center text-xs text-on-surface-variant" data-testid="marketplace-empty">
          {plugins.length === 0 ? 'No plugins listed.' : 'No plugins match.'}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Plugins" aria-live="polite">
          {shown.map((p) => <Card key={key(p)} p={p} onOpen={() => setOpen(key(p))} />)}
        </ul>
      )}
      {detail && !installing && <Detail p={detail} onClose={() => setOpen(null)} onInstall={() => setInstalling(detail)} />}
      {installing && (
        <ConsentDialog
          source={{ kind: 'preview', body: { registry: installing.registry, name: installing.name, ...(installing.updateAvailable ?? installing.latest ? { version: installing.updateAvailable ?? installing.latest } : {}) } }}
          onClose={() => setInstalling(null)}
          onDone={(result) => {
            setInstalling(null);
            setOpen(null);
            setMessage(`${result.name} ${result.version} is installed${result.enabled ? ' and enabled' : ', disabled'}.${result.enableProblem ? ` Not enabled: ${result.enableProblem}.` : ''}`);
            void qc.invalidateQueries({ queryKey: PLUGIN_MARKETPLACE_KEY });
            void qc.invalidateQueries({ queryKey: PLUGIN_PACKAGES_KEY });
            void qc.invalidateQueries({ queryKey: PLUGIN_UPDATES_KEY });
          }}
        />
      )}
    </div>
  );
}
