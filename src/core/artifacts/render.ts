/**
 * Server-side artifact template renderer. V1 supports `{{ data.<source>.<path> }}`
 * substitution and `{{#each data.<source>.items}}…{{/each}}` blocks. All values
 * are HTML-escaped. User-supplied script tags are stripped — custom JS arrives
 * via the bundler pipeline (step 6) and runs only with a CSP-pinned sha256.
 */

export interface RenderInput {
  /** Snapshot payload per source name. */
  data: Record<string, unknown>;
  /** Optional CSS injected into <style>. */
  css?: string;
  /** Title used in <title>/<h1>. */
  title?: string;
}

export function escapeHtml(value: unknown): string {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip <script> and inline event handlers from user-supplied template HTML. */
export function sanitizeTemplate(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
}

/** Resolve a dotted path on `data`. Array indices supported via numeric parts. */
function resolvePath(data: Record<string, unknown>, expr: string): unknown {
  const parts = expr.split('.').map((p) => p.trim()).filter(Boolean);
  let cur: unknown = data;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

const EXPR_RE = /\{\{\s*([^#/][^}]*?)\s*\}\}/g;
const EACH_RE = /\{\{#each\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g;

/** Render a template string against `data`. Two-pass: each-blocks, then expressions. */
export function renderTemplate(template: string, input: RenderInput): string {
  const safeTemplate = sanitizeTemplate(template);

  const withEach = safeTemplate.replace(EACH_RE, (_, expr: string, body: string) => {
    const list = resolvePath({ data: input.data, title: input.title } as Record<string, unknown>, expr.trim());
    if (!Array.isArray(list)) return '';
    return list
      .map((item) => {
        return body.replace(EXPR_RE, (_m: string, e: string) => {
          const trimmed = e.trim();
          // `this.<field>` refers to the current iteration item.
          if (trimmed === 'this') return escapeHtml(item);
          if (trimmed.startsWith('this.')) {
            return escapeHtml(resolvePath({ this: item } as Record<string, unknown>, trimmed));
          }
          return escapeHtml(
            resolvePath({ data: input.data, title: input.title } as Record<string, unknown>, trimmed),
          );
        });
      })
      .join('');
  });

  return withEach.replace(EXPR_RE, (_m, e: string) => {
    return escapeHtml(
      resolvePath({ data: input.data, title: input.title } as Record<string, unknown>, e.trim()),
    );
  });
}

// ── built-in templates ─────────────────────────────────────────────
export const BUILTIN_TEMPLATES: Record<string, string> = {
  dashboard: `<section class="artifact-dashboard">
  <h1>{{title}}</h1>
  <pre data-bind="default">{{data.default}}</pre>
</section>`,

  news: `<section class="artifact-news">
  <h1>{{title}}</h1>
  <ul>
    {{#each data.feed.items}}
      <li><a href="{{this.link}}">{{this.title}}</a><br><small>{{this.pubDate}}</small><p>{{this.summary}}</p></li>
    {{/each}}
  </ul>
</section>`,

  table: `<section class="artifact-table">
  <h1>{{title}}</h1>
  <table>
    <tbody>
      {{#each data.rows}}
        <tr><td>{{this}}</td></tr>
      {{/each}}
    </tbody>
  </table>
</section>`,
};

/** Render an RSS/Atom-like XML doc from `data.feed.items`. */
export function renderRssFeed(input: { title: string; link: string; items: Array<{ title: string; link: string; pubDate?: string | null; summary?: string }> }): string {
  const xmlEscape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const items = input.items
    .map(
      (it) => `<item>
  <title>${xmlEscape(it.title)}</title>
  <link>${xmlEscape(it.link)}</link>
  ${it.pubDate ? `<pubDate>${xmlEscape(it.pubDate)}</pubDate>` : ''}
  <description>${xmlEscape(it.summary ?? '')}</description>
</item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${xmlEscape(input.title)}</title>
<link>${xmlEscape(input.link)}</link>
${items}
</channel></rss>`;
}
