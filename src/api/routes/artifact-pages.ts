/**
 * Hosted artifact pages — `/a/:slug` (outer chrome) and `/a/:slug/embed`
 * (inner sandboxed doc with locked-down CSP). Mounted at TWO prefixes:
 *   - `/a/:slug` — what the artifacts subdomain proxies to (subdomain mode)
 *   - `/__artifacts__/a/:slug` — main host fallback when no DNS is set
 *
 * Both paths execute the same handlers; the URL the UI surfaces is governed
 * by `getArtifactsHostMode()` so users don't see the dual mount. The local
 * fallback always works without any configuration.
 *
 * Auth flow: session cookie/Bearer → workspace check; else `?t=<token>` →
 * share-link redeem; else 404 (never 401 — don't leak existence).
 */

import { Elysia } from 'elysia';
import { apiContext } from '@/api/context';
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import { workspaces } from '@/db/schema/organizations';
import { getDb } from '@/db/postgres';
import { eq } from 'drizzle-orm';
import { buildEmbedCsp } from '@/core/artifacts/csp';
import { buildDataBus } from '@/core/artifacts/pipeline';
import { BUILTIN_TEMPLATES, escapeHtml, renderTemplate } from '@/core/artifacts/render';
import {
  ARTIFACT_BASE_CSS,
  ARTIFACT_OUTER_CSS,
  DEFAULT_LAYOUT_CSS,
  renderDefaultLayout,
  renderWidgets,
  resolveWidgetTags,
} from '@/core/artifacts/widget-render';
import { signArtifactToken } from '@/core/artifacts/token';
import { verifyShareLinkToken } from '@/core/artifacts/share-link';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { bundleFilePath } from '@/core/artifacts/bundler';
import { artifactLifecycleBus } from '@/core/artifacts/lifecycle-bus';
import { recordArtifactView } from '@/core/artifacts/scheduler';
import { resolveArtifactSettings } from '@/core/artifacts/settings';
import type { Artifact } from '@/db/schema/artifacts';
import { coreLogger } from '@/utils/logger';

const TOKEN_TTL_SECONDS = 5 * 60;

interface AuthResult {
  artifact: Artifact;
  scope: 'view' | 'view+refresh';
}

function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function authorizeForRequest(opts: {
  slug: string;
  user: { id: string } | null;
  shareToken: string | null;
}): Promise<AuthResult | null> {
  let artifact: Artifact | null = null;

  if (opts.user) {
    const db = getDb();
    const owned = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.userId, opts.user.id));
    for (const ws of owned) {
      const a = await artifactsRepository.getBySlug(ws.id, opts.slug);
      if (a) {
        artifact = a;
        break;
      }
    }
    if (artifact && (artifact.visibility === 'workspace' || artifact.visibility === 'private')) {
      if (artifact.visibility === 'private' && artifact.createdByUserId !== opts.user.id) {
        return null;
      }
      return { artifact, scope: 'view+refresh' };
    }
    if (artifact && artifact.visibility === 'public') {
      return { artifact, scope: 'view' };
    }
  }

  if (opts.shareToken) {
    const verified = await verifyShareLinkToken(opts.shareToken);
    if (!verified) return null;
    const a = await artifactsRepository.getById(verified.artifactId);
    if (!a || a.slug !== opts.slug) return null;
    return { artifact: a, scope: 'view' };
  }

  if (!artifact) {
    const db = getDb();
    const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);
    for (const ws of allWorkspaces) {
      const a = await artifactsRepository.getBySlug(ws.id, opts.slug);
      if (a && a.visibility === 'public') {
        return { artifact: a, scope: 'view' };
      }
    }
  }

  return null;
}

/**
 * NO `integrity=` on these script tags. The embed runs in a
 * `sandbox="allow-scripts"` iframe, i.e. an opaque origin, so the browser
 * treats even a same-path subresource as cross-origin and refuses to check SRI
 * without CORS ("the resource requires the request to be CORS enabled to check
 * the integrity … has been blocked"). CORS is not available either: the bundle
 * route authenticates by cookie or share token, and `Origin: null` cannot be
 * paired with credentialed CORS. `script-src 'self'` is what actually gates
 * these — and both files are served by this app, to a viewer this same handler
 * already authorized, so SRI was guarding nothing.
 */
function buildEmbedHtml(input: {
  artifact: Artifact;
  templateBody: string;
  css: string;
  token: string;
  /** Same-origin URL of this version's JS bundle, when it has one. */
  bundle?: { src: string };
}): { html: string; csp: string } {
  const settings = resolveArtifactSettings();
  const cspHashes = settings.sdkSha256 ? [settings.sdkSha256] : [];
  const csp = buildEmbedCsp({
    scriptSha256s: cspHashes,
    gatewayWss: settings.gatewayWss || undefined,
    frameAncestors: input.artifact.allowedEmbedOrigins ?? [],
  });
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${escapeHtml(input.artifact.title)}</title>
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="octipus-artifact-id" content="${escapeHtml(input.artifact.id)}">
<meta name="octipus-artifact-token" content="${escapeHtml(input.token)}">
${settings.gatewayWss ? `<meta name="octipus-gateway-wss" content="${escapeHtml(settings.gatewayWss)}">` : ''}
<style>${input.css}</style>
</head><body>
${input.templateBody}
${settings.sdkSha256 ? `<script src="/octipus-artifact-client.js"></script>` : ''}
${input.bundle ? `<script src="${escapeHtml(input.bundle.src)}"></script>` : ''}
</body></html>`;
  return { html, csp };
}

function buildOuterHtml(artifact: Artifact, embedSrc: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(artifact.title)}</title>
<style>${ARTIFACT_OUTER_CSS}</style>
</head><body>
<div class="octi-outer">
  <header class="octi-outer-header">
    <h1>${escapeHtml(artifact.title)}</h1>
    <span class="octi-outer-brand">Octipus</span>
  </header>
  <iframe class="octi-outer-frame" sandbox="allow-scripts" src="${escapeHtml(embedSrc)}"></iframe>
</div>
</body></html>`;
}

// Loose typing — Elysia's contextual types are awkward to share between
// handlers; the runtime shape is identical and the routes below pin the
// actual schema via Elysia.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerCtx = any;

async function handleOuter(ctx: HandlerCtx) {
  const rl = checkRateLimit(`a:${clientIp(ctx.request)}`, { capacity: 30, refillPerSecond: 1 });
  if (!rl.allowed) {
    ctx.set.status = 429;
    ctx.set.headers['retry-after'] = String(rl.retryAfterSeconds ?? 1);
    return 'Too many requests';
  }
  const auth = await authorizeForRequest({
    slug: ctx.params.slug,
    user: ctx.user ?? null,
    shareToken: typeof ctx.query.t === 'string' ? ctx.query.t : null,
  });
  if (!auth) {
    ctx.set.status = 404;
    return 'Not found';
  }
  const url = new URL(ctx.request.url);
  const embedQs = typeof ctx.query.t === 'string' ? `?t=${encodeURIComponent(ctx.query.t)}` : '';
  const embedSrc = `${url.pathname}/embed${embedQs}`;
  ctx.set.headers['content-type'] = 'text/html; charset=utf-8';
  return buildOuterHtml(auth.artifact, embedSrc);
}

async function handleEmbed(ctx: HandlerCtx) {
  const rl = checkRateLimit(`embed:${clientIp(ctx.request)}`, { capacity: 30, refillPerSecond: 1 });
  if (!rl.allowed) {
    ctx.set.status = 429;
    ctx.set.headers['retry-after'] = String(rl.retryAfterSeconds ?? 1);
    return 'Too many requests';
  }
  const auth = await authorizeForRequest({
    slug: ctx.params.slug,
    user: ctx.user ?? null,
    shareToken: typeof ctx.query.t === 'string' ? ctx.query.t : null,
  });
  if (!auth) {
    ctx.set.status = 404;
    return 'Not found';
  }

  const version = auth.artifact.currentVersionId
    ? await artifactsRepository.getVersion(auth.artifact.currentVersionId)
    : null;

  // Data bus: sources + transforms. Falls back to the legacy direct-snapshot
  // read when there are no transforms — same shape either way.
  const bus = await buildDataBus(auth.artifact.id);
  const data = bus.data;

  // Widgets: render every registered widget, then either splice into the
  // template (`<x-widget id="..."/>`) or auto-layout when there's no template.
  const widgetRender = await renderWidgets(auth.artifact.id, data);

  const baseTemplate = version?.htmlTemplate || '';
  const hasWidgets = Object.keys(widgetRender.bySlot).length > 0;
  const defaultLayout = hasWidgets ? await renderDefaultLayout(auth.artifact.id, widgetRender.bySlot) : '';
  const template = baseTemplate
    || (hasWidgets ? defaultLayout : (BUILTIN_TEMPLATES[auth.artifact.type] || BUILTIN_TEMPLATES.dashboard));
  const widgetCss = hasWidgets ? `${DEFAULT_LAYOUT_CSS}\n${widgetRender.css}` : '';
  // Base CSS first so user-supplied CSS can override tokens / element styles.
  // Without this baseline, artifacts rendered on the bare artifact subdomain
  // (which doesn't load the web app's global stylesheet) looked unstyled —
  // just black serif text on white. Always inject; cost is ~3KB gzipped.
  const css = `${ARTIFACT_BASE_CSS}\n${widgetCss}\n${version?.css ?? ''}`.trim();

  let body: string;
  try {
    const withWidgets = resolveWidgetTags(template, widgetRender.bySlot);
    body = renderTemplate(withWidgets, { data, title: auth.artifact.title });
  } catch (err) {
    coreLogger.error({ err, artifactId: auth.artifact.id }, 'artifact.render.failed');
    ctx.set.status = 500;
    return 'Render error';
  }

  const now = Math.floor(Date.now() / 1000);
  const token = signArtifactToken({
    aid: auth.artifact.id,
    wid: auth.artifact.workspaceId,
    scope: auth.scope,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  });

  recordArtifactView(auth.artifact.id);
  artifactLifecycleBus.emitEvent({
    type: 'artifact:viewed',
    artifactId: auth.artifact.id,
    viewerUserId: ctx.user?.id ?? null,
  });

  // This version's own JS, lifted out of the template at author time and
  // served from the artifact's origin (inline script can't run under the CSP).
  // Existence only — the hash is not used (see buildEmbedHtml on why there is
  // no SRI here), so do not read and digest the whole file on every request.
  let bundle: { src: string } | undefined;
  if (version && (await Bun.file(bundleFilePath(auth.artifact.id, version.id)).exists())) {
    const qs = typeof ctx.query.t === 'string' ? `?t=${encodeURIComponent(ctx.query.t)}` : '';
    // Derive from the request path so this works under both mounts.
    const src = `${new URL(ctx.request.url).pathname.replace(/\/embed$/, '/bundle.js')}${qs}`;
    bundle = { src };
  }

  const page = buildEmbedHtml({ artifact: auth.artifact, templateBody: body, css, token, bundle });
  ctx.set.headers['content-type'] = 'text/html; charset=utf-8';
  // Also as a header: `frame-ancestors` is ignored when delivered via <meta>,
  // so `allowedEmbedOrigins` was never actually enforced. The <meta> copy stays
  // for the rest of the policy.
  ctx.set.headers['content-security-policy'] = page.csp;
  return page.html;
}

/** Serve the current version's built JS bundle. Same auth as the embed. */
async function handleBundle(ctx: HandlerCtx) {
  const rl = checkRateLimit(`bundle:${clientIp(ctx.request)}`, { capacity: 30, refillPerSecond: 1 });
  if (!rl.allowed) {
    ctx.set.status = 429;
    ctx.set.headers['retry-after'] = String(rl.retryAfterSeconds ?? 1);
    return 'Too many requests';
  }
  const auth = await authorizeForRequest({
    slug: ctx.params.slug,
    user: ctx.user ?? null,
    shareToken: typeof ctx.query.t === 'string' ? ctx.query.t : null,
  });
  if (!auth || !auth.artifact.currentVersionId) {
    ctx.set.status = 404;
    return 'Not found';
  }

  const file = Bun.file(bundleFilePath(auth.artifact.id, auth.artifact.currentVersionId));
  if (!(await file.exists())) {
    ctx.set.status = 404;
    return 'Not found';
  }
  ctx.set.headers['content-type'] = 'application/javascript; charset=utf-8';
  // The URL is slug-keyed, not version-keyed — publishing a new version reuses
  // it. Caching would serve stale JS whose hash no longer matches the embed's
  // `integrity`, i.e. a page that silently stops working.
  ctx.set.headers['cache-control'] = 'no-cache';
  return file.text();
}

async function handleExport(ctx: HandlerCtx) {
  const rl = checkRateLimit(`export:${clientIp(ctx.request)}`, { capacity: 30, refillPerSecond: 1 });
  if (!rl.allowed) {
    ctx.set.status = 429;
    ctx.set.headers['retry-after'] = String(rl.retryAfterSeconds ?? 1);
    return 'Too many requests';
  }
  const auth = await authorizeForRequest({
    slug: ctx.params.slug,
    user: ctx.user ?? null,
    shareToken: typeof ctx.query.t === 'string' ? ctx.query.t : null,
  });
  if (!auth) {
    ctx.set.status = 404;
    return 'Not found';
  }

  const exp = await artifactsRepository.getExportByPublicId(auth.artifact.id, ctx.params.exportId);
  if (!exp) {
    ctx.set.status = 404;
    return 'Export not found';
  }

  const { ensureToolboxLoaded, getToolboxRegistry } = await import('@/core/artifacts/toolbox');
  await ensureToolboxLoaded();
  const tool = getToolboxRegistry().get(exp.toolId);
  if (!tool || tool.family !== 'export') {
    coreLogger.error(
      { artifactId: auth.artifact.id, exportId: exp.exportId, toolId: exp.toolId },
      'artifact.export.unknown_tool',
    );
    ctx.set.status = 500;
    return 'Export tool not registered';
  }

  // Build data bus + resolve binds, same pattern as widgets.
  const bus = await buildDataBus(auth.artifact.id);
  const resolved: Record<string, unknown> = { ...(exp.paramsJson ?? {}) };
  for (const [paramName, pathExpr] of Object.entries(exp.bindJson ?? {})) {
    resolved[paramName] = resolveBusPath(bus.data, pathExpr);
  }

  let payload: { filename: string; contentType: string; body: string };
  try {
    const out = await tool.execute(resolved, {
      principalId: '',
      workspaceId: auth.artifact.workspaceId,
      artifactId: auth.artifact.id,
      nodeName: exp.exportId,
    });
    if (!out || typeof out !== 'object') throw new Error('export tool returned non-object');
    payload = out as typeof payload;
    if (typeof payload.body !== 'string') throw new Error('export tool returned no `body` string');
  } catch (err) {
    coreLogger.error(
      { artifactId: auth.artifact.id, exportId: exp.exportId, error: (err as Error).message },
      'artifact.export.failed',
    );
    ctx.set.status = 500;
    return 'Export failed';
  }

  ctx.set.headers['content-type'] = payload.contentType;
  ctx.set.headers['content-disposition'] =
    `attachment; filename="${payload.filename.replace(/"/g, '')}"`;
  return payload.body;
}

function resolveBusPath(root: Record<string, unknown>, expr: string): unknown {
  if (!expr) return root;
  const parts = expr.split('.').map((p) => p.trim()).filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return cur;
}

/** Subdomain-mode mount (also catches direct hits to the main host). */
export const artifactPageRoutes = new Elysia()
  .use(apiContext)
  .get('/a/:slug', handleOuter)
  .get('/a/:slug/embed', handleEmbed)
  .get('/a/:slug/bundle.js', handleBundle)
  .get('/a/:slug/export/:exportId', handleExport);

/** Path-prefix fallback — works without any DNS configuration. */
export const artifactPageRoutesFallback = new Elysia({ prefix: '/__artifacts__' })
  .use(apiContext)
  .get('/a/:slug', handleOuter)
  .get('/a/:slug/embed', handleEmbed)
  .get('/a/:slug/bundle.js', handleBundle)
  .get('/a/:slug/export/:exportId', handleExport);
