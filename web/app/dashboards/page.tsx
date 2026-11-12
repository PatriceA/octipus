'use client';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { PluginDashboardView, PluginWidgetData, PluginWidgetLink, PluginWidgetTone } from '../../../src/shared/plugin-package';

const DashboardChart = lazy(() => import('@/components/plugins/dashboard-chart'));

type Widget = PluginDashboardView['widgets'][number];

const TONE: Record<PluginWidgetTone, string> = {
  good: 'text-tertiary',
  warn: 'text-warning',
  bad: 'text-error',
  neutral: 'text-on-surface',
};
const toneClass = (tone: PluginWidgetTone | undefined) => (tone ? TONE[tone] : 'text-on-surface');

const SPAN: Record<1 | 2 | 3, string> = { 1: 'lg:col-span-1', 2: 'lg:col-span-2', 3: 'lg:col-span-3' };

/**
 * `/dashboards/:name/:id`: a plugin package's dashboard (docs/PLUGIN-PACKAGES.md#dashboards),
 * drawn here with the app's own components. Each widget asks the server for
 * its data; the server calls the widget's read tool as the signed-in user,
 * with the arguments the manifest fixes, and checks the answer. Nothing of
 * the plugin runs in the browser; every string is drawn as text.
 */
export default function PluginDashboardPage() {
  const params = useParams();
  const name = params.name ?? '';
  const id = params.id ?? '';
  const view = useQuery({
    queryKey: ['plugin-dashboard', name, id],
    queryFn: () => api.get<PluginDashboardView>(`/plugins/${encodeURIComponent(name)}/dashboards/${encodeURIComponent(id)}`),
    retry: false,
  });

  if (view.isLoading) {
    return <main className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-on-surface-variant" /></main>;
  }
  if (!view.data) {
    return (
      <main className="p-6" data-testid="plugin-dashboard-missing">
        <h1 className="text-lg font-semibold text-on-surface">Dashboard not available</h1>
        <p className="mt-2 text-sm text-on-surface-variant">This dashboard does not exist, or its plugin is not enabled.</p>
      </main>
    );
  }
  const d = view.data;
  return (
    <main className="p-4 sm:p-6" data-testid="plugin-dashboard">
      <PageHeader title={d.title} description={`From the plugin ${d.pluginTitle}`} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {d.widgets.map((w) => <WidgetCard key={w.id} plugin={d.plugin} dashboard={d.id} widget={w} />)}
      </div>
    </main>
  );
}

function WidgetCard({ plugin, dashboard, widget }: { plugin: string; dashboard: string; widget: Widget }) {
  const data = useQuery({
    queryKey: ['plugin-widget', plugin, dashboard, widget.id],
    queryFn: () => api.post<{ data: PluginWidgetData; at: string }>(
      `/plugins/${encodeURIComponent(plugin)}/dashboards/${encodeURIComponent(dashboard)}/widgets/${encodeURIComponent(widget.id)}`, {},
    ),
    retry: false,
    refetchOnWindowFocus: false,
    // Only while shown: react-query stops refetching when the page unmounts or the tab hides.
    refetchInterval: widget.refreshSeconds ? widget.refreshSeconds * 1000 : false,
    refetchIntervalInBackground: false,
  });
  const error = data.error instanceof ApiError || data.error instanceof Error ? data.error.message : null;
  return (
    <Card className={cn('flex min-h-40 flex-col p-4', SPAN[widget.width])}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium text-on-surface-variant">{widget.title}</h2>
        <button
          type="button"
          className="rounded p-1 text-on-surface-variant hover:bg-surface-container-high disabled:opacity-40"
          onClick={() => void data.refetch()}
          disabled={data.isFetching}
          aria-label={`Refresh ${widget.title}`}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', data.isFetching && 'animate-spin')} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {data.isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-on-surface-variant" />
        ) : error ? (
          <p className="text-sm text-error" data-testid="widget-error">{error}</p>
        ) : data.data ? (
          <WidgetBody data={data.data.data} />
        ) : null}
      </div>
      {data.data?.data.updatedAt && <p className="mt-2 text-xs text-on-surface-variant">Updated {formatTime(data.data.data.updatedAt)}</p>}
    </Card>
  );
}

function formatTime(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString();
}

/** A link the server checked (https, to the plugin's declared hosts); checked again here, opened in a new tab. */
function Linked({ link, children }: { link?: PluginWidgetLink; children: React.ReactNode }) {
  if (!link || !link.url.startsWith('https://')) return <>{children}</>;
  return (
    <a href={link.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 hover:underline" title={link.label ?? link.url}>
      {children}
      <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
    </a>
  );
}

function cell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v.toLocaleString();
  return String(v);
}

function WidgetBody({ data }: { data: PluginWidgetData }) {
  switch (data.type) {
    case 'stat':
      return (
        <div>
          <div className={cn('text-3xl font-semibold tabular-nums', toneClass(data.tone))}>
            {typeof data.value === 'number' ? data.value.toLocaleString() : data.value}
            {data.unit && <span className="ml-1 text-base font-normal text-on-surface-variant">{data.unit}</span>}
          </div>
          {(data.label || data.delta !== undefined) && (
            <p className="mt-1 text-sm text-on-surface-variant">
              {data.label}
              {data.delta !== undefined && (
                <span className={cn('ml-2', data.delta > 0 ? 'text-tertiary' : data.delta < 0 ? 'text-error' : '')}>
                  {data.delta > 0 ? '+' : ''}{data.delta.toLocaleString()}
                </span>
              )}
            </p>
          )}
          {data.caption && <p className="mt-1 text-xs text-on-surface-variant">{data.caption}</p>}
        </div>
      );
    case 'list':
      if (data.items.length === 0) return <p className="text-sm text-on-surface-variant">Nothing to show.</p>;
      return (
        <ul className="divide-y divide-outline-variant">
          {data.items.map((item, i) => (
            <li key={i} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className={cn('truncate text-sm', toneClass(item.tone))}><Linked link={item.link}>{item.title}</Linked></p>
                {item.subtitle && <p className="truncate text-xs text-on-surface-variant">{item.subtitle}</p>}
              </div>
              {item.value && <span className="shrink-0 text-sm tabular-nums text-on-surface-variant">{item.value}</span>}
            </li>
          ))}
        </ul>
      );
    case 'table':
      if (data.rows.length === 0) return <p className="text-sm text-on-surface-variant">Nothing to show.</p>;
      return (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-container text-xs text-on-surface-variant">
              <tr>
                {data.columns.map((c) => <th key={c.key} className={cn('px-2 py-1 font-medium', c.align === 'right' ? 'text-right' : 'text-left')}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className={cn('border-t border-outline-variant', toneClass(row.tone))}>
                  {data.columns.map((c, j) => (
                    <td key={c.key} className={cn('px-2 py-1', c.align === 'right' && 'text-right tabular-nums')}>
                      {j === 0 ? <Linked link={row.link}>{cell(row.values[c.key])}</Linked> : cell(row.values[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'chart':
      return (
        <div className="h-56">
          <Suspense fallback={<Loader2 className="h-5 w-5 animate-spin text-on-surface-variant" />}>
            <DashboardChart data={data} />
          </Suspense>
        </div>
      );
    case 'text':
      return <p className="whitespace-pre-wrap text-sm text-on-surface">{data.text}</p>;
  }
}
