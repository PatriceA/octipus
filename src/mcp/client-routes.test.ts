import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Every path the MCP server calls must be a route this API actually serves.
 *
 * Three shipped MCP tools pointed at endpoints that do not exist and 404'd on
 * every single invocation, for as long as they had existed:
 * `octipus_create_pipeline` (`POST /api/pipelines`), `octipus_list_audit_log`
 * (`GET /api/audit`, really `/api/admin/audit`) and `octipus_get_setting`
 * (`GET /api/settings/:key`, which had a PUT and a reset but no GET). Nothing
 * failed: the tools were advertised, the model called them, and the error came
 * back as prose inside a tool result.
 *
 * A dead tool is worse than a missing one — it costs schema tokens on every
 * request and sends the model down a path that cannot work.
 *
 * Both sides are read from source rather than from a running server, so this
 * runs in the ordinary unit suite.
 */

const ROUTES_DIR = 'src/api/routes';
const CLIENT = 'mcp-server/src/client.ts';

/** `.get('/x', …)` / `.post(`/x/${id}`, …)` — method + literal path. */
const ROUTE_RE = /\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]*)[`'"]/g;
/** `new Elysia({ prefix: '/x' })` */
const PREFIX_RE = /new Elysia\(\{\s*prefix:\s*'([^']+)'/;
/**
 * `this.request('/api/x', { method: 'POST' })` — method defaults to GET.
 *
 * Template literals are matched to their closing backtick rather than to the
 * first quote, because a path like `` `/api/memory${qs ? '?' + qs : ''}` ``
 * carries quotes INSIDE the interpolation.
 */
const CALL_RE =
  /this\.request(?:<[^>]*>)?\(\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")\s*(?:,\s*\{\s*method:\s*'([A-Z]+)')?/g;

/**
 * `/settings/:key` and `/settings/${key}` both become `/settings/*`.
 *
 * An interpolation that IS a whole segment is a path parameter. One glued to
 * the end of a segment (`/events${qs}`) is a query string the client builds
 * itself, so it and everything after it are dropped — otherwise every such call
 * reads as a route that does not exist.
 */
function normalize(path: string): string {
  const segments = path.replace(/\$\{[^}]*\}?/g, '\u0000').split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '\u0000') {
      out.push('*');
      continue;
    }
    const cut = seg.indexOf('\u0000');
    out.push(cut === -1 ? seg : seg.slice(0, cut));
    if (cut !== -1) break;
  }
  return out
    .join('/')
    .replace(/:[^/]+/g, '*')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '');
}

function serverRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    const src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    const prefix = PREFIX_RE.exec(src)?.[1] ?? '';
    for (const [, method, path] of src.matchAll(ROUTE_RE)) {
      routes.add(`${method.toUpperCase()} ${normalize(`/api${prefix}${path}`)}`);
    }
  }
  return routes;
}

function clientCalls(): Array<{ key: string; raw: string }> {
  const src = readFileSync(CLIENT, 'utf8');
  const out: Array<{ key: string; raw: string }> = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(CALL_RE)) {
    const path = m[1] ?? m[2] ?? m[3] ?? '';
    const method = m[4];
    const key = `${method ?? 'GET'} ${normalize(path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, raw: `${method ?? 'GET'} ${path}` });
  }
  return out;
}

describe('the MCP server only calls routes that exist', () => {
  test('every client path resolves to a registered route', () => {
    const routes = serverRoutes();
    const missing = clientCalls()
      .filter(({ key }) => !routes.has(key))
      .map(({ raw }) => raw);

    expect(
      missing,
      `MCP tools calling routes this API does not serve — every one of these 404s on ` +
        `every invocation:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  test('the extraction found both sides (guards against a silently empty check)', () => {
    expect(serverRoutes().size).toBeGreaterThan(100);
    expect(clientCalls().length).toBeGreaterThan(40);
  });
});
