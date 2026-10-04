/**
 * Which routes act on a space (docs/plans/coworking-spec.md §5.4, §5.11).
 *
 * Every route `createServer()` mounts is classified: it acts on the space the
 * header names (`SPACE_ROUTES`) or it is personal (the prefixes below). A new
 * route prefix fails this test until someone decides which it is — a route
 * that silently ran personal for a member acting in a space, or acted on a
 * space without the access layer, is exactly the bug this guards.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { isDeniedWorkspaceExempt, isSpaceRoute, SPACE_ROUTES, spaceTargetOf } from './space-routes';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

/**
 * Personal routes: with a space in the header they run in the caller's
 * default personal workspace (agents and pipelines by id excepted, see
 * `spaceTargetOf`).
 */
const PERSONAL_PREFIXES = [
  '/api/admin', '/api/agents', '/api/auth', '/api/capabilities', '/api/channels', '/api/chat',
  '/api/connectors', '/api/devices', '/api/digest', '/api/email', '/api/eval', '/api/evaluations',
  '/api/gateway', '/api/graph', '/api/health', '/api/hooks', '/api/invites', '/api/logs', '/api/mcp',
  '/api/me', '/api/memory', '/api/metrics', '/api/models', '/api/permission-requests', '/api/persona',
  '/api/pipelines', '/api/plugins', '/api/reader', '/api/recurring-tasks', '/api/research', '/api/roles',
  '/api/runs', '/api/saml', '/api/scim', '/api/search', '/api/settings', '/api/skills', '/api/spend-budgets',
  '/api/swarm', '/api/tools', '/api/topics', '/api/trajectories', '/api/vault', '/api/verification',
  '/api/voice', '/api/webhooks', '/api/workspace', '/v1',
  // The artifact SDK script, served beside the hosted pages: no content.
  '/octipus-artifact-client.js',
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

describe('SPACE_ROUTES classification', () => {
  test('every mounted route is either a space route or a listed personal route, never both', async () => {
    const { createServer } = await import('./server');
    const routes = createServer().routeTable();
    expect(routes.length).toBeGreaterThan(100);
    const unclassified: string[] = [];
    const both: string[] = [];
    for (const { method, path } of routes) {
      const space = isSpaceRoute(path);
      const personal = PERSONAL_PREFIXES.some((p) => under(path, p));
      if (!space && !personal) unclassified.push(`${method} ${path}`);
      if (space && personal) both.push(`${method} ${path}`);
    }
    expect(unclassified, 'classify these in SPACE_ROUTES or PERSONAL_PREFIXES').toEqual([]);
    expect(both).toEqual([]);
    // Every SPACE_ROUTES entry names mounted routes (no stale entry).
    for (const r of SPACE_ROUTES) {
      expect(routes.some(({ path }) => under(path, r.prefix)), r.prefix).toBe(true);
    }
  }, 60_000);

  test('the spec’s space routes are listed', () => {
    for (const path of ['/api/notes', '/api/tasks/x/comments', '/api/documents/upload', '/api/artifacts/x', '/a/slug', '/__artifacts__/a/slug',
      '/api/knowledge/search', '/api/sessions/x/messages', '/api/spaces/x/members', '/api/notifications']) {
      expect(isSpaceRoute(path), path).toBe(true);
    }
    for (const path of ['/api/chat/approve', '/api/models', '/api/search', '/api/settings', '/api/notesx', '/api/memory']) {
      expect(isSpaceRoute(path), path).toBe(false);
    }
  });

  test('agents and pipelines addressed by id take the row’s workspace', () => {
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const q = (s: string) => new URLSearchParams(s);
    expect(spaceTargetOf('/api/agents/agent-1/stop', q(''))).toEqual({ kind: 'agent', id: 'agent-1' });
    expect(spaceTargetOf('/api/agents/route', q(''))).toBeNull();
    expect(spaceTargetOf(`/api/pipelines/${id}/pause`, q(''))).toEqual({ kind: 'pipeline', id });
    expect(spaceTargetOf('/api/pipelines/templates', q(''))).toBeNull();
    expect(spaceTargetOf('/api/agents', q(`sessionId=${id}`))).toEqual({ kind: 'session', id });
    expect(spaceTargetOf('/api/models', q(`sessionId=${id}`))).toBeNull();
  });

  test('a denied workspace still reaches auth, health, the workspace list and the space list', () => {
    expect(isDeniedWorkspaceExempt('GET', '/api/auth/me')).toBe(true);
    expect(isDeniedWorkspaceExempt('GET', '/api/health/live')).toBe(true);
    expect(isDeniedWorkspaceExempt('GET', '/api/me/workspaces')).toBe(true);
    expect(isDeniedWorkspaceExempt('GET', '/api/spaces')).toBe(true);
    expect(isDeniedWorkspaceExempt('POST', '/api/spaces')).toBe(false);
    expect(isDeniedWorkspaceExempt('GET', '/api/notes')).toBe(false);
  });
});
