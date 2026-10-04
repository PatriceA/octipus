/**
 * Which routes act on a space (docs/plans/coworking-spec.md §5.4).
 *
 * The web sends the selected workspace in `X-Octipus-Workspace` on every
 * call. When it names a space, only the routes listed here act on the
 * space: their handlers read and write space rows through
 * `contentRepos(principal)`, by the member's role. Every other route is
 * personal: the server derive rewrites the principal to the caller's default
 * personal workspace before the handler runs, so a personal route never
 * acts on space rows and the web needs no per-call header logic.
 *
 * One exception: a route that addresses a session, agent or pipeline by id
 * (`?sessionId=`, `/:id`) takes its workspace from that row, so a member's
 * private chat in a space still lists and stops its own agents and
 * pipelines (`spaceTargetOf`, reads and stops only — never a run). Access
 * then follows the space rules.
 *
 * `src/api/space-routes.test.ts` classifies every mounted route: a new
 * route prefix fails it until it is listed here or among the personal
 * prefixes the test names.
 */

export interface SpaceRoute {
  /** Path prefix, matched by whole segments. */
  readonly prefix: string;
  readonly what: string;
}

export const SPACE_ROUTES: readonly SpaceRoute[] = [
  { prefix: '/api/notes', what: 'notes and their links' },
  { prefix: '/api/tasks', what: 'tasks and task comments' },
  { prefix: '/api/documents', what: 'uploaded documents' },
  { prefix: '/api/artifacts', what: 'live artifacts' },
  { prefix: '/a', what: 'hosted artifact pages (subdomain mount)' },
  { prefix: '/__artifacts__', what: 'hosted artifact pages (path fallback)' },
  { prefix: '/api/knowledge', what: 'the knowledge base, in the space scope' },
  { prefix: '/api/sessions', what: "the member's private chats in the space, and their files" },
  { prefix: '/api/spaces', what: 'the space itself: members, invites, activity' },
  { prefix: '/api/notifications', what: "the member's notifications from the space" },
];

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Whether `pathname` is a route that acts on the space the header names. */
export function isSpaceRoute(pathname: string): boolean {
  return SPACE_ROUTES.some((r) => underPrefix(pathname, r.prefix));
}

/**
 * Paths a member whose space is gone must still reach, so their client can
 * recover (the web logs out on any `/auth/me` failure): the guard answers
 * 404 for a denied workspace everywhere else on `/api` and `/v1`.
 */
export function isDeniedWorkspaceExempt(method: string, pathname: string): boolean {
  if (underPrefix(pathname, '/api/auth')) return true;
  if (underPrefix(pathname, '/api/health')) return true;
  if (pathname === '/api/me/workspaces') return true;
  return method === 'GET' && pathname === '/api/spaces';
}

/** A session, agent or pipeline a personal route addresses by id. */
export type SpaceTarget =
  | { kind: 'session'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'pipeline'; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Static segments under `/api/agents` and `/api/pipelines` that are not ids. */
const AGENT_STATIC = new Set(['route']);

/**
 * What a member may do to their own agent or pipeline in a space from a
 * personal route: read it (GET), and stop it. Nothing that runs the model
 * (`POST /api/agents/:id/message`, starting, resuming or approving a
 * pipeline) keeps the space principal — those run personal, where the
 * space row is not found; agent runs in a space go through §5.6.
 */
const STOP_ACTIONS: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/api\/agents\/[^/]+\/stop$/ },
  { method: 'DELETE', pattern: /^\/api\/agents\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/pipelines\/[^/]+\/(?:stop|pause)$/ },
];

function keepsSpace(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  return STOP_ACTIONS.some((a) => a.method === m && a.pattern.test(pathname));
}

/**
 * The row a personal route addresses by id, whose workspace decides the
 * request's: `/api/agents/:id…`, `/api/pipelines/:id…`, and `?sessionId=`
 * on the agent and pipeline lists — for reads and stops only
 * (`keepsSpace`). Null for anything else, which then runs personal.
 */
export function spaceTargetOf(method: string, pathname: string, searchParams: URLSearchParams): SpaceTarget | null {
  if (!keepsSpace(method, pathname)) return null;
  const agent = /^\/api\/agents\/([^/]+)(?:\/|$)/.exec(pathname);
  if (agent && !AGENT_STATIC.has(agent[1])) return { kind: 'agent', id: decodeURIComponent(agent[1]) };
  const pipeline = /^\/api\/pipelines\/([^/]+)(?:\/|$)/.exec(pathname);
  if (pipeline && UUID_RE.test(pipeline[1])) return { kind: 'pipeline', id: pipeline[1] };
  if (pathname === '/api/agents' || pathname === '/api/pipelines') {
    const sessionId = searchParams.get('sessionId');
    if (sessionId && UUID_RE.test(sessionId)) return { kind: 'session', id: sessionId };
  }
  return null;
}
