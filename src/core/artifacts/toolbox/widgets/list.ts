/**
 * art_widget_list — title + link + summary list. Replaces the hand-crafted
 * news template that ships today as `BUILTIN_TEMPLATES.news`.
 */

import type { ToolboxTool } from '../types';
import { asArray, asString, escapeHtml, path, type WidgetRender } from './_shared';

interface Params {
  items: unknown;
  titlePath?: string;
  linkPath?: string;
  summaryPath?: string;
  metaPath?: string;
  emptyText?: string;
}

export const listWidget: ToolboxTool<Params, WidgetRender> = {
  id: 'art_widget_list',
  family: 'widget',
  description: 'Title + link + summary list (the workhorse for news feeds, PR queues, search results).',
  keywords: ['list', 'news', 'feed', 'links', 'items'],
  defaultPermission: 'ALLOW',
  params: {
    items: { type: 'array', required: true, description: 'Bound array of items.' },
    titlePath: { type: 'string', default: 'title', description: 'Dotted path to each item title.' },
    linkPath: { type: 'string', default: 'link', description: 'Dotted path to each item URL.' },
    summaryPath: { type: 'string', default: 'summary', description: 'Dotted path to each item summary text.' },
    metaPath: { type: 'string', default: 'pubDate', description: 'Dotted path to small metadata (date / author).' },
    emptyText: { type: 'string', default: 'Nothing here yet.', description: 'Shown when items is empty.' },
  },
  returns: '`{ html, css }` — `<ul>` with one `<li>` per item.',
  examples: [
    {
      summary: 'Bind to an RSS feed',
      params: { items: [], titlePath: 'title', linkPath: 'link', summaryPath: 'summary' },
    },
  ],

  async execute(params) {
    const items = asArray(params.items);
    if (items.length === 0) {
      return { html: `<p class="aw-empty">${escapeHtml(params.emptyText ?? 'Nothing here yet.')}</p>` };
    }
    const titlePath = params.titlePath ?? 'title';
    const linkPath = params.linkPath ?? 'link';
    const summaryPath = params.summaryPath ?? 'summary';
    const metaPath = params.metaPath ?? 'pubDate';

    const li = items
      .map((item) => {
        const title = escapeHtml(asString(path(item, titlePath)));
        const link = asString(path(item, linkPath));
        const summary = escapeHtml(asString(path(item, summaryPath)));
        const meta = escapeHtml(asString(path(item, metaPath)));
        const titleEl = link
          ? `<a href="${escapeHtml(link)}" class="aw-list-title">${title}</a>`
          : `<span class="aw-list-title">${title}</span>`;
        const metaEl = meta ? `<div class="aw-list-meta">${meta}</div>` : '';
        const sumEl = summary ? `<p class="aw-list-summary">${summary}</p>` : '';
        return `<li>${titleEl}${metaEl}${sumEl}</li>`;
      })
      .join('');

    return { html: `<ul class="aw-list">${li}</ul>`, css: LIST_CSS };
  },
};

const LIST_CSS = `
.aw-list { list-style: none; padding: 0; margin: 0; font: 14px/1.5 system-ui, sans-serif; }
.aw-list li { padding: 12px 0; border-bottom: 1px solid #f3f4f6; }
.aw-list-title { font-weight: 600; color: #111827; text-decoration: none; }
.aw-list-title:hover { text-decoration: underline; }
.aw-list-meta { font-size: 12px; color: #6b7280; margin-top: 2px; }
.aw-list-summary { margin: 6px 0 0; color: #374151; }
`;

export default listWidget;
