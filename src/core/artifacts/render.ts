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

/**
 * Strip <script> and inline event handlers from user-supplied template HTML.
 *
 * This is the render-time backstop. Author-time, `extractInteractiveScript`
 * has already lifted a template's own JS into a CSP-pinned bundle, so by the
 * time a stored template reaches here it should have nothing left to strip —
 * anything this removes arrived some other way and is not something we are
 * willing to execute.
 *
 * The unquoted form (`onclick=doThing()`, valid HTML5) is matched too. CSP
 * already blocks it from running, but this function is documented as the layer
 * that removes it, and a guarantee that only holds for quoted attributes is
 * the kind that gets relied on and then quietly isn't true.
 */
export function sanitizeTemplate(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(HANDLER_ATTR_RE, '');
}

// ── author-time JS extraction ──────────────────────────────────────
// A hand-authored page keeps its JS in `<script>` blocks and `onclick="…"`
// attributes. Neither can survive a `script-src 'self' <hash>` CSP inline, so
// both are lifted out here into one source string, bundled to a file, and
// served from the artifact's own origin. Handlers become `data-octi-h` markers
// bound by generated `addEventListener` calls — no `new Function`, so no
// `'unsafe-eval'`, and no `'unsafe-inline'`.
//
// The bundle is a single IIFE, so the user's top-level `function foo(){}` and
// the generated `onclick="foo()"` binding share one scope. That is why the
// bindings are appended to the same source instead of relying on globals.

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)(?:<\/script>|$)/gi;
/** `on<event>=` with a double-quoted, single-quoted, or bare value. */
const HANDLER_ATTR_RE = /\son([a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/**
 * `type` values that mean "this is JavaScript". Anything else — a
 * `type="application/json"` data island, `text/template`, an unknown MIME — is
 * NOT script and must never reach the bundler: it is a syntax error there, and
 * because every script on the page is concatenated into one entry file, one
 * data island would fail the build for the whole artifact.
 */
const JS_TYPE_RE = /^(?:|module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i;

function scriptTypeOf(attrs: string): string {
  const m = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  return (m ? (m[1] ?? m[2] ?? m[3] ?? '') : '').trim();
}

const BIND_HELPER = `function __octiBind(id, ev, fn) {
  var els = document.querySelectorAll('[data-octi-h="' + id + '"]');
  for (var i = 0; i < els.length; i++) els[i].addEventListener(ev, fn);
}`;

/** HTML-attribute decode. The browser does this before treating the value as JS. */
function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export interface ExtractedScript {
  /** Template with `<script>` removed and `on*=` rewritten to `data-octi-h`. */
  template: string;
  /** Concatenated JS plus generated handler bindings. Empty when the page has none. */
  source: string;
  /** Things silently dropped, for the caller to surface. */
  warnings: string[];
}

export function extractInteractiveScript(html: string): ExtractedScript {
  const warnings: string[] = [];
  const scripts: string[] = [];

  let template = html.replace(SCRIPT_RE, (_m, attrs: string, body: string) => {
    // Remote scripts can't be bundled and would need a CSP origin allowance —
    // an artifact runs its own code only.
    if (/\bsrc\s*=/i.test(attrs)) {
      warnings.push(
        'A `<script src="…">` was dropped — an artifact may only run its own inline JS (no third-party scripts). Inline the code instead.',
      );
      return '';
    }
    const type = scriptTypeOf(attrs);
    if (!JS_TYPE_RE.test(type)) {
      warnings.push(
        `A \`<script type="${type}">\` block was dropped — only JavaScript is supported, and feeding a non-JS block to the bundler would break every other script on the page. Put the data in the markup or in a data source instead.`,
      );
      return '';
    }
    scripts.push(body);
    return '';
  });

  const bindings: string[] = [];
  template = template.replace(HANDLER_ATTR_RE, (_m, event: string, dq?: string, sq?: string, bare?: string) => {
    const code = decodeAttr(dq ?? sq ?? bare ?? '');
    const id = `h${bindings.length}`;
    bindings.push(
      `__octiBind(${JSON.stringify(id)}, ${JSON.stringify(event)}, function (event) {\n${code}\n});`,
    );
    return ` data-octi-h="${id}"`;
  });

  if (scripts.length === 0 && bindings.length === 0) {
    return { template: html, source: '', warnings };
  }

  const source = [
    scripts.join('\n;\n'),
    bindings.length > 0 ? BIND_HELPER : '',
    bindings.join('\n'),
  ]
    .filter(Boolean)
    .join('\n');

  return { template, source, warnings };
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
/**
 * Legacy fallback templates used when an artifact has no version template
 * and no widgets attached. New artifacts should use the toolbox widgets
 * (art_widget_table / art_widget_list / art_widget_kpi_card / …) which
 * the page handler auto-lays-out via renderDefaultLayout. These three
 * stay here for back-compat with phase-1 artifacts created before the
 * toolbox shipped — do not extend.
 */
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
