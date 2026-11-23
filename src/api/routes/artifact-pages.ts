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
 * share-link redeem. Anonymous outer links get a generic session-entry page;
 * embeds and unauthorized retries return 404 without revealing existence.
 */

import { Elysia } from '@/api/http';
import { existsSync } from 'fs';
import { createHash } from 'node:crypto';
import { apiContext } from '@/api/context';
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import { findViewableArtifactBySlug } from '@/db/repositories/space';
import { artifactEntryPage } from '@/core/artifacts/entry-page';
import { publicLinkBase } from '@/core/public-url';
import { buildEmbedCsp, embedCspHeader, embedOriginSources } from '@/core/artifacts/csp';
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
import { authorizeArtifactViewerToken } from '@/core/artifacts/viewer-access';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { bundleFilePath } from '@/core/artifacts/bundler';
import { artifactLifecycleBus } from '@/core/artifacts/lifecycle-bus';
import { recordArtifactView } from '@/core/artifacts/scheduler';
import { artifactSdkFilePath, resolveArtifactSettings } from '@/core/artifacts/settings';
import type { Artifact } from '@/db/schema/artifacts';
import { clientIp } from '@/security/client-ip';
import { coreLogger } from '@/utils/logger';
import { fileAt } from '@/utils/fs-file';

const TOKEN_TTL_SECONDS = 5 * 60;

interface AuthResult {
  artifact: Artifact;
  /** The signed share link the request was admitted by, if that is how. */
  shareLinkId?: string;
}

async function authorizeForRequest(opts: {
  slug: string;
  user: { id: string } | null;
  shareToken: string | null;
}): Promise<AuthResult | null> {
  let artifact: Artifact | null = null;

  if (opts.user) {
    // The viewer's personal workspaces and the spaces they are a member of
    // (docs/plans/coworking-spec.md §5.5) — never a workspace looked up by
    // owner alone, which a space (no owning user) would not match and a raw
    // `workspaces.user_id` read would. `private` is the creator's only.
    artifact = await findViewableArtifactBySlug(opts.user.id, opts.slug);
    if (artifact) return { artifact };
  }

  if (opts.shareToken) {
    const verified = await verifyShareLinkToken(opts.shareToken);
    if (!verified) return null;
    const a = await artifactsRepository.getById(verified.artifactId);
    if (!a || a.slug !== opts.slug) return null;
    return { artifact: a, shareLinkId: verified.shareLinkId };
  }

  if (!artifact) {
    // One query, not a slug lookup per workspace on the install.
    const a = await artifactsRepository.findPublicBySlug(opts.slug);
    if (a) return { artifact: a };
  }

  return null;
}

/**
 * Is the built SDK on disk? Memoised — it cannot appear at runtime, and this
 * is consulted on every embed render. A stored `artifacts.sdkSha256` is NOT
 * sufficient evidence: the setting outlives the file (e.g. a backend image
 * built without `web/public`), and advertising a script we then 404 on is how
 * live refresh silently stopped working.
 */
let sdkPresent: boolean | null = null;
function sdkAvailable(): boolean {
  if (sdkPresent === null) {
    sdkPresent = existsSync(artifactSdkFilePath());
    if (!sdkPresent) {
      coreLogger.warn(
        { path: artifactSdkFilePath() },
        'artifact.sdk.missing — embeds will render without live refresh; run `npx tsx scripts/build-artifact-sdk.ts`',
      );
    }
  }
  return sdkPresent;
}

/** Serve the SDK from the API origin, where the embed page's CSP `'self'` points. */
async function handleSdk(ctx: HandlerCtx) {
  const file = fileAt(artifactSdkFilePath());
  if (!(await file.exists())) {
    ctx.set.status = 404;
    return 'Not found';
  }
  ctx.set.headers['content-type'] = 'application/javascript; charset=utf-8';
  ctx.set.headers['cache-control'] = 'public, max-age=300';
  return file.text();
}

/** Render the authorized bundle inline under its exact CSP hash. */
function buildEmbedHtml(input: {
  artifact: Artifact;
  /** The current version's own network (`none` for a knowledge-base refresh's page). */
  versionNetwork?: 'default' | 'none';
  templateBody: string;
  css: string;
  token: string;
  // Inline the authorized bundle: opaque sandbox subrequests cannot carry
  // SameSite cookies, so a private bundle URL would return 404 in browsers.
  bundle?: { source: string };
}): { html: string; csp: string } {
  const settings = resolveArtifactSettings();
  // A closed page (a saved interactive answer, or a version an agent wrote
  // from the owner's knowledge base) reaches nothing: no live refresh, so no
  // SDK, gateway or viewer token in it either.
  const closed = input.artifact.network === 'none' || input.versionNetwork === 'none';
  const cspHashes = settings.sdkSha256 && !closed ? [settings.sdkSha256] : [];
  const script = input.bundle?.source.replace(/<\/script/gi, '<\\/script');
  if (script) cspHashes.push(createHash('sha256').update(script).digest('hex'));
  const csp = buildEmbedCsp({
    scriptSha256s: cspHashes,
    gatewayWss: settings.gatewayWss || undefined,
    frameAncestors: input.artifact.allowedEmbedOrigins ?? [],
    network: closed ? 'none' : 'default',
  });
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${escapeHtml(input.artifact.title)}</title>
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="octipus-artifact-id" content="${escapeHtml(input.artifact.id)}">
${closed ? '' : `<meta name="octipus-artifact-token" content="${escapeHtml(input.token)}">`}
${settings.gatewayWss && !closed ? `<meta name="octipus-gateway-wss" content="${escapeHtml(settings.gatewayWss)}">` : ''}
<style>${input.css}</style>
</head><body>
${input.templateBody}
${sdkAvailable() && !closed ? `<script src="/octipus-artifact-client.js"></script>` : ''}
${script ? `<script>${script}</script>` : ''}
</body></html>`;
  return { html, csp };
}

/** For responses that are data, not pages: nothing loads, nothing runs, and the document has an opaque origin. */
const INERT_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/**
 * Headers every artifact response that carries artifact content gets. No
 * referrer: an embed URL can carry a share token (`?t=`), and the page loads
 * images from anywhere. Never cached: an embed carries a freshly minted
 * viewer token, and a private artifact's page must not outlive its access.
 */
function setArtifactDocumentHeaders(ctx: HandlerCtx): void {
  ctx.set.headers['referrer-policy'] = 'no-referrer';
  ctx.set.headers['cache-control'] = 'private, no-store';
}

/**
 * The outer page's policy. It is server-written (an escaped title and one
 * frame), so it runs no script and loads nothing but its own embed; it may be
 * framed where the embed may.
 */
function outerCsp(artifact: Artifact): string {
  const ancestors = ["'self'", ...embedOriginSources(artifact.allowedEmbedOrigins)].join(' ');
  return `default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors ${ancestors}; base-uri 'none'; form-action 'none'`;
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
  const rl = checkRateLimit(`a:${clientIp(ctx.request, ctx.socketAddress)}`, { capacity: 30, refillPerSecond: 1 });
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
    // A cross-site navigation omits SameSite=Strict cookies even for a signed-in
    // owner. Establish this origin, then retry with cookies. Embeds and the
    // retry itself still fail closed; no artifact metadata enters this page.
    if (!ctx.user && !ctx.query.t && ctx.request.headers.get('X-Octipus-Artifact-Entry') !== '1') {
      const entry = artifactEntryPage(`${publicLinkBase()}/login?returnTo=%2Fartifacts`);
      ctx.set.headers['content-type'] = 'text/html; charset=utf-8';
      ctx.set.headers['content-security-policy'] = entry.csp;
      ctx.set.headers['cache-control'] = 'no-store';
      return entry.html;
    }
    ctx.set.status = 404;
    return 'Not found';
  }
  const url = new URL(ctx.request.url);
  const embedQs = typeof ctx.query.t === 'string' ? `?t=${encodeURIComponent(ctx.query.t)}` : '';
  const embedSrc = `${url.pathname.replace(/\/$/, '')}/embed${embedQs}`;
  ctx.set.headers['content-type'] = 'text/html; charset=utf-8';
  ctx.set.headers['content-security-policy'] = outerCsp(auth.artifact);
  // The outer page is a top-level document: keep openers out of it.
  ctx.set.headers['cross-origin-opener-policy'] = 'same-origin';
  setArtifactDocumentHeaders(ctx);
  return buildOuterHtml(auth.artifact, embedSrc);
}

async function handleEmbed(ctx: HandlerCtx) {
  const rl = checkRateLimit(`embed:${clientIp(ctx.request, ctx.socketAddress)}`, { capacity: 30, refillPerSecond: 1 });
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
    // Widgets go in after the template pass: their HTML is server output,
    // already escaped, and data inside it must not be expanded or sanitized.
    body = resolveWidgetTags(renderTemplate(template, { data, title: auth.artifact.title }), widgetRender.bySlot);
  } catch (err) {
    coreLogger.error({ err, artifactId: auth.artifact.id }, 'artifact.render.failed');
    ctx.set.status = 500;
    return 'Render error';
  }

  const now = Math.floor(Date.now() / 1000);
  const token = signArtifactToken({
    aid: auth.artifact.id,
    wid: auth.artifact.workspaceId,
    scope: 'view',
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    ...(auth.shareLinkId ? { slid: auth.shareLinkId } : {}),
  });

  recordArtifactView(auth.artifact.id);
  artifactLifecycleBus.emitEvent({
    type: 'artifact:viewed',
    artifactId: auth.artifact.id,
    viewerUserId: ctx.user?.id ?? null,
  });

  // Deliver the script with the already-authorized document. A sandboxed
  // document has an opaque origin, so fetching a protected bundle separately
  // loses SameSite cookies and the browser blocks the 404 as an opaque response.
  let bundle: { source: string } | undefined;
  if (version) {
    const file = fileAt(bundleFilePath(auth.artifact.id, version.id));
    if (await file.exists()) bundle = { source: await file.text() };
  }

  const page = buildEmbedHtml({ artifact: auth.artifact, versionNetwork: version?.network, templateBody: body, css, token, bundle });
  ctx.set.headers['content-type'] = 'text/html; charset=utf-8';
  // Also as a header: `frame-ancestors` is ignored when delivered via <meta>,
  // so `allowedEmbedOrigins` was never actually enforced. The <meta> copy stays
  // for the rest of the policy. The header also sandboxes the page, so the
  // embed never runs with the app's origin when opened directly.
  ctx.set.headers['content-security-policy'] = embedCspHeader(page.csp);
  setArtifactDocumentHeaders(ctx);
  return page.html;
}

async function handleExport(ctx: HandlerCtx) {
  const rl = checkRateLimit(`export:${clientIp(ctx.request, ctx.socketAddress)}`, { capacity: 30, refillPerSecond: 1 });
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
  // A download, never a page: whatever type the export names, opened in the
  // browser it runs nothing and has no origin.
  ctx.set.headers['content-security-policy'] = INERT_CSP;
  setArtifactDocumentHeaders(ctx);
  return payload.body;
}

/**
 * The embed's live data read (`GET /a/:slug/data/:sourceName?vt=<token>`):
 * the latest snapshot of one source, for the SDK to patch the page with. The
 * viewer token minted into the embed is the only credential — never a session
 * cookie or API token, which an opaque-origin page does not carry anyway — and
 * it opens exactly this: one artifact (the one the slug names), read-only, for
 * the token's few minutes, until revoked (`authorizeArtifactViewerToken`). It
 * is not accepted by any `/api` route.
 *
 * The page is a sandboxed (opaque-origin) document, so this is a cross-origin
 * read: the token travels in the query (a header would need a CORS preflight)
 * and the answer allows any origin without credentials.
 */
async function handleData(ctx: HandlerCtx) {
  ctx.set.headers['access-control-allow-origin'] = '*';
  ctx.set.headers['content-security-policy'] = INERT_CSP;
  setArtifactDocumentHeaders(ctx);
  const rl = checkRateLimit(`data:${clientIp(ctx.request, ctx.socketAddress)}`, { capacity: 60, refillPerSecond: 2 });
  if (!rl.allowed) {
    ctx.set.status = 429;
    ctx.set.headers['retry-after'] = String(rl.retryAfterSeconds ?? 1);
    return { error: 'Too many requests' };
  }
  const token = typeof ctx.query.vt === 'string' ? ctx.query.vt : '';
  const denied = () => {
    ctx.set.status = 401;
    return { error: 'invalid or expired viewer token' };
  };
  if (!token) return denied();
  // The slug names the artifact; the token must be for that one. A token
  // carries its artifact id, so read it only to find the candidate.
  const claimed = artifactIdClaimedBy(token);
  if (!claimed) return denied();
  const authorized = await authorizeArtifactViewerToken(token, claimed);
  if (!authorized || authorized.artifact.slug !== ctx.params.slug) return denied();

  const src = await artifactsRepository.getSourceByName(authorized.artifact.id, ctx.params.sourceName);
  if (!src) {
    ctx.set.status = 404;
    return { error: 'source not found' };
  }
  const snap = await artifactsRepository.getLatestSnapshot(src.id);
  if (!snap) return { payload: null, capturedAt: null };
  return { payload: snap.payloadJson, capturedAt: snap.capturedAt, snapshotId: snap.id };
}

/** The `aid` a token claims, unverified — `authorizeArtifactViewerToken` checks it. */
function artifactIdClaimedBy(token: string): string | null {
  const body = token.split('.')[1];
  if (!body) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { aid?: unknown };
    return typeof parsed.aid === 'string' && UUID_RE.test(parsed.aid) ? parsed.aid : null;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  .get('/octipus-artifact-client.js', handleSdk)
  .get('/a/:slug', handleOuter)
  .get('/a/:slug/embed', handleEmbed)
  .get('/a/:slug/export/:exportId', handleExport)
  .get('/a/:slug/data/:sourceName', handleData);

/** Path-prefix fallback — works without any DNS configuration. */
export const artifactPageRoutesFallback = new Elysia({ prefix: '/__artifacts__' })
  .use(apiContext)
  .get('/a/:slug', handleOuter)
  .get('/a/:slug/embed', handleEmbed)
  .get('/a/:slug/export/:exportId', handleExport)
  .get('/a/:slug/data/:sourceName', handleData);
