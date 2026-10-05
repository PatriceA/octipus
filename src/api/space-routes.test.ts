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
      '/api/knowledge/search', '/api/sessions/x/messages', '/api/spaces/x/members', '/api/notifications',
      '/api/spaces/x/rooms', '/api/spaces/x/rooms/r/messages', '/api/spaces/x/rooms/r/members/u', '/api/spaces/x/memory/e']) {
      expect(isSpaceRoute(path), path).toBe(true);
    }
    for (const path of ['/api/chat/approve', '/api/models', '/api/search', '/api/settings', '/api/notesx', '/api/memory']) {
      expect(isSpaceRoute(path), path).toBe(false);
    }
  });

  test('agents and pipelines addressed by id keep the space for reads and stops only', () => {
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const q = (s: string) => new URLSearchParams(s);
    expect(spaceTargetOf('POST', '/api/agents/agent-1/stop', q(''))).toEqual({ kind: 'agent', id: 'agent-1' });
    expect(spaceTargetOf('GET', '/api/agents/agent-1', q(''))).toEqual({ kind: 'agent', id: 'agent-1' });
    expect(spaceTargetOf('DELETE', '/api/agents/agent-1', q(''))).toEqual({ kind: 'agent', id: 'agent-1' });
    expect(spaceTargetOf('GET', '/api/agents/route', q(''))).toBeNull();
    expect(spaceTargetOf('POST', `/api/pipelines/${id}/pause`, q(''))).toEqual({ kind: 'pipeline', id });
    expect(spaceTargetOf('GET', '/api/pipelines/templates', q(''))).toBeNull();
    expect(spaceTargetOf('GET', '/api/agents', q(`sessionId=${id}`))).toEqual({ kind: 'session', id });
    expect(spaceTargetOf('GET', '/api/models', q(`sessionId=${id}`))).toBeNull();
    // Anything that runs the model runs personal (finding: a viewer started a space pipeline).
    expect(spaceTargetOf('POST', '/api/pipelines', q(`sessionId=${id}`))).toBeNull();
    expect(spaceTargetOf('POST', '/api/agents', q(`sessionId=${id}`))).toBeNull();
    expect(spaceTargetOf('POST', '/api/agents/agent-1/message', q(''))).toBeNull();
    expect(spaceTargetOf('POST', `/api/pipelines/${id}/resume`, q(''))).toBeNull();
    expect(spaceTargetOf('POST', `/api/pipelines/${id}/approve/s1`, q(''))).toBeNull();
    expect(spaceTargetOf('POST', `/api/pipelines/${id}/plan`, q(''))).toBeNull();
    expect(spaceTargetOf('PATCH', `/api/pipelines/${id}/checkpoints/1`, q(''))).toBeNull();
  });

  test('every mounted method and path that acts on a space is reviewed (method + path, not prefix)', async () => {
    const { createServer } = await import('./server');
    const routes = createServer().routeTable();
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const acting: string[] = [];
    for (const { method, path } of routes) {
      if (isSpaceRoute(path)) {
        acting.push(`${method} ${path}`);
        continue;
      }
      // Personal routes that keep the space when they address a row by id.
      const concrete = path.replace(/:[A-Za-z]+/g, id);
      const query = new URLSearchParams(`sessionId=${id}`);
      if (spaceTargetOf(method, concrete, query)) acting.push(`${method} ${path} (by target)`);
    }
    expect(acting.sort(), 'a new handler acting on a space: review its access, then list it here').toEqual([...SPACE_ACTING].sort());
  }, 60_000);

  test('a denied workspace still reaches auth, health, the workspace list and the space list', () => {
    expect(isDeniedWorkspaceExempt('GET', '/api/auth/me')).toBe(true);
    expect(isDeniedWorkspaceExempt('GET', '/api/health/live')).toBe(true);
    expect(isDeniedWorkspaceExempt('GET', '/api/me/workspaces')).toBe(true);
    expect(isDeniedWorkspaceExempt('GET', '/api/spaces')).toBe(true);
    expect(isDeniedWorkspaceExempt('POST', '/api/spaces')).toBe(false);
    expect(isDeniedWorkspaceExempt('GET', '/api/notes')).toBe(false);
  });
});

/**
 * Every handler that runs with the space principal when the header names a
 * space. Adding a handler under a space prefix (or one a target keeps in the
 * space) fails the classification test until its access is reviewed and it
 * is listed here.
 */
const SPACE_ACTING = [
  'GET /api/spaces', 'POST /api/spaces', 'GET /api/spaces/:id', 'PATCH /api/spaces/:id', 'POST /api/spaces/:id/archive',
  'POST /api/spaces/:id/unarchive', 'DELETE /api/spaces/:id', 'GET /api/spaces/:id/members', 'PATCH /api/spaces/:id/members/:userId',
  'DELETE /api/spaces/:id/members/:userId', 'GET /api/spaces/:id/invites', 'POST /api/spaces/:id/invites',
  'DELETE /api/spaces/:id/invites/:inviteId', 'GET /api/spaces/:id/activity',
  // Funding and budgets (S5): read for members, writes owner-only (sponsor raises).
  'PUT /api/spaces/:id/funding', 'GET /api/spaces/:id/budget', 'PUT /api/spaces/:id/budget',
  // Space connectors (S5): listed for members, connect/disconnect owner-only.
  'GET /api/spaces/:id/connectors', 'POST /api/spaces/:id/connectors/:connectorId',
  'DELETE /api/spaces/:id/connectors/:connectorId',
  // Room modes (S5): read for room members, set by room creator or space owner; feedback by room members.
  'GET /api/spaces/:id/rooms/:roomId/mode', 'PUT /api/spaces/:id/rooms/:roomId/mode',
  'PUT /api/spaces/:id/rooms/:roomId/messages/:messageId/feedback',
  // Live documents (S3): the agent's edit mode (owner), file leases (members, by role).
  'PUT /api/spaces/:id/agent-edit-mode', 'GET /api/spaces/:id/file-leases', 'POST /api/spaces/:id/file-leases',
  'DELETE /api/spaces/:id/file-leases',
  // Rooms and space memory (S2): every handler checks `roomAccess` / the membership itself.
  'GET /api/spaces/:id/rooms', 'POST /api/spaces/:id/rooms', 'GET /api/spaces/:id/rooms/:roomId/messages',
  'POST /api/spaces/:id/rooms/:roomId/messages', 'PATCH /api/spaces/:id/rooms/:roomId', 'GET /api/spaces/:id/rooms/:roomId/members',
  'POST /api/spaces/:id/rooms/:roomId/members/:userId', 'DELETE /api/spaces/:id/rooms/:roomId/members/:userId',
  'PATCH /api/spaces/:id/rooms/:roomId/me', 'GET /api/spaces/:id/memory', 'POST /api/spaces/:id/memory',
  'DELETE /api/spaces/:id/memory/:entryId',
  'GET /api/sessions/:id/learning', 'POST /api/sessions/:id/learning', 'POST /api/sessions/:id/monitors/events',
  'GET /api/sessions/:id/monitors', 'POST /api/sessions/:id/monitors/:monitorId/control', 'GET /api/sessions', 'GET /api/sessions/:id',
  'GET /api/sessions/:id/plan', 'POST /api/sessions/:id/plan/feedback', 'POST /api/sessions', 'PATCH /api/sessions/:id',
  'DELETE /api/sessions/:id', 'GET /api/sessions/:id/messages', 'POST /api/sessions/:id/attachments', 'GET /api/sessions/:id/files',
  'PUT /api/sessions/:id/files', 'GET /api/sessions/:id/changes', 'GET /api/sessions/:id/changes/diff', 'POST /api/sessions/:id/complete',
  'GET /api/sessions/stats/active',
  'GET /api/tasks', 'GET /api/tasks/role-agents', 'PUT /api/tasks/role-agents', 'GET /api/tasks/:id', 'POST /api/tasks',
  'PATCH /api/tasks/:id', 'POST /api/tasks/:id/checkout', 'POST /api/tasks/:id/release', 'GET /api/tasks/:id/comments',
  'POST /api/tasks/:id/comments', 'DELETE /api/tasks/:id',
  'GET /api/notifications', 'POST /api/notifications/:id/read', 'POST /api/notifications/read-all',
  'GET /api/artifacts/_meta', 'GET /api/artifacts', 'POST /api/artifacts', 'GET /api/artifacts/spec/:slugOrId', 'GET /api/artifacts/:id',
  'PUT /api/artifacts/:id', 'DELETE /api/artifacts/:id', 'GET /api/artifacts/:id/versions',
  'POST /api/artifacts/:id/versions/:versionId/restore', 'GET /api/artifacts/:id/data-sources', 'POST /api/artifacts/:id/data-sources',
  'DELETE /api/artifacts/:id/data-sources/:sourceId', 'POST /api/artifacts/:id/refresh', 'GET /api/artifacts/:id/data/:sourceName',
  'POST /api/artifacts/:id/share-links', 'GET /api/artifacts/:id/share-links', 'DELETE /api/artifacts/:id/share-links/:linkId',
  'GET /api/artifacts/:id/feed.rss',
  'POST /api/documents/upload', 'GET /api/documents', 'GET /api/documents/:id', 'GET /api/documents/:id/raw', 'DELETE /api/documents/:id',
  'POST /api/documents/:id/cancel',
  'GET /api/knowledge/readiness', 'GET /api/knowledge', 'GET /api/knowledge/stats', 'POST /api/knowledge/search', 'GET /api/knowledge/:id',
  'DELETE /api/knowledge/:id', 'POST /api/knowledge/cleanup', 'GET /api/knowledge/cleanup-history', 'POST /api/knowledge/index',
  'GET /api/notes', 'POST /api/notes', 'POST /api/notes/query', 'GET /api/notes/index', 'GET /api/notes/tags', 'POST /api/notes/capture',
  'GET /api/notes/:id', 'GET /api/notes/:id/suggestions', 'PATCH /api/notes/:id/pin', 'DELETE /api/notes/:id',
  // Space notes (S3): revisions and the agent's edit proposals; 404 in a personal workspace.
  'GET /api/notes/proposals', 'POST /api/notes/proposals/:proposalId/accept', 'POST /api/notes/proposals/:proposalId/reject',
  'GET /api/notes/:id/revisions', 'GET /api/notes/:id/revisions/:revisionId', 'POST /api/notes/:id/revisions/:revisionId/restore',
  // A live editor's text the server never got, merged through the hub (S3).
  'POST /api/notes/:id/merge',
  'GET /a/:slug', 'GET /a/:slug/embed', 'GET /a/:slug/bundle.js', 'GET /a/:slug/export/:exportId',
  'GET /__artifacts__/a/:slug', 'GET /__artifacts__/a/:slug/embed', 'GET /__artifacts__/a/:slug/bundle.js',
  'GET /__artifacts__/a/:slug/export/:exportId',
  // Personal routes kept in the space by the row they address: reads and stops only.
  'GET /api/agents (by target)', 'GET /api/agents/:id (by target)', 'POST /api/agents/:id/stop (by target)',
  'DELETE /api/agents/:id (by target)', 'GET /api/agents/:id/events (by target)',
  'GET /api/pipelines (by target)', 'GET /api/pipelines/:id (by target)', 'GET /api/pipelines/:id/plan (by target)',
  'GET /api/pipelines/:id/checkpoints (by target)', 'POST /api/pipelines/:id/pause (by target)', 'POST /api/pipelines/:id/stop (by target)',
];
