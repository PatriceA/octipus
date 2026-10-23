/**
 * Every part of the install is core or belongs to one module (docs/MODULES.md).
 *
 * Like the space routes (src/api/space-routes.test.ts): each mounted route,
 * built-in tool, module job and sidebar page is on the core lists below or
 * declared by exactly one module in `src/modules/`. A new feature fails here
 * until whoever adds it decides which it is, so nothing slips in as always-on
 * by accident.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MODULES } from '@/modules';
import { discoverTools } from '@/tools/discovery';
import { moduleOfPath, moduleOfTool } from './registry';

/** Route prefixes of the core: always mounted, always answering. */
const CORE_ROUTE_PREFIXES = [
  '/v1',
  '/api/admin', '/api/agents', '/api/auth', '/api/backups', '/api/capabilities', '/api/channels',
  '/api/chat', '/api/connectors', '/api/devices', '/api/digest', '/api/documents', 
  '/api/eval', '/api/evaluations', '/api/gateway', '/api/graph', '/api/health', '/api/heartbeat', '/api/hooks',
  '/api/invites', '/api/knowledge', '/api/logs', '/api/mcp', '/api/me', '/api/memory', '/api/metrics', '/api/models',
  '/api/modules', '/api/notes', '/api/notifications', '/api/onboarding', '/api/permission-requests', '/api/persona',
  '/api/pipelines', '/api/plugin-packages', '/api/plugins', '/api/recurring-tasks', '/api/remote-spaces',
  '/api/roles', '/api/runs', '/api/saml', '/api/scim', '/api/search', '/api/sessions', '/api/settings',
  '/api/skills', '/api/spaces', '/api/spend-budgets', '/api/swarm', '/api/tasks', '/api/tools', '/api/topics',
  '/api/trajectories', '/api/vault', '/api/verification', '/api/voice', '/api/webhooks', '/api/workspace',
];

/** Built-in tool containers of the core. */
const CORE_TOOLS = [
  'atlassian', 'browser', 'browser-ext', 'data', 'docker', 'documents',
  'filesystem', 'git', 'github', 'gitlab', 'google-workspace', 'inline-ui', 'knowledge',
  'mcp_admin', 'messaging', 'microsoft365', 'monitor', 'notes', 'plan', 'profiles', 'repo_registry', 'scheduling',
  'shell', 'skill-distill', 'task_state', 'tasks', 'visual', 'voice', 'websearch',
];

/** Sidebar pages of the core. */
const CORE_PAGES = [
  '/', '/chat', '/tasks', '/my-work', '/notifications', '/agents', '/notes', '/documents',
  '/knowledge', '/pipelines', '/hooks', '/models', '/mcp', '/settings', '/tools',
  '/permissions', '/persona', '/profiles', '/memory', '/skills', '/topics', '/eval', '/secrets', '/admin/users',
  '/rooms', '/spaces/remote',
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}.`);

/** Every `.ts` file under `dir`, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('core or module', () => {
  test('every mounted route is a module\'s or under a core prefix', async () => {
    const { createServer } = await import('@/api/server');
    const routes = createServer().routeTable();
    expect(routes.length).toBeGreaterThan(100);
    const unclassified = routes
      .filter(({ path }) => moduleOfPath(path) === undefined && !CORE_ROUTE_PREFIXES.some((p) => under(path, p)))
      .map(({ method, path }) => `${method} ${path}`);
    expect(unclassified, 'add these to a module in src/modules/ or to CORE_ROUTE_PREFIXES').toEqual([]);
    // No module prefix is stale: each serves at least one mounted route.
    for (const m of MODULES) {
      for (const prefix of m.routes) expect(routes.some(({ path }) => under(path, prefix)), `${m.id}: ${prefix}`).toBe(true);
    }
    // A core prefix that has become a module's whole route is stale.
    const moduleRoutes = MODULES.flatMap((m) => m.routes);
    expect(CORE_ROUTE_PREFIXES.filter((p) => moduleRoutes.includes(p))).toEqual([]);
  });

  test('every built-in tool is a module\'s or core, never both', async () => {
    const ids = (await discoverTools()).map((t) => t.tool.id);
    for (const id of ids) {
      const owner = moduleOfTool(id);
      expect(owner !== undefined || CORE_TOOLS.includes(id), `${id}: add it to a module or to CORE_TOOLS`).toBe(true);
      expect(owner !== undefined && CORE_TOOLS.includes(id), `${id} is both core and ${owner}'s`).toBe(false);
    }
    expect(CORE_TOOLS.filter((id) => !ids.includes(id)), 'stale CORE_TOOLS entries').toEqual([]);
  });

  test('every sidebar page is a module\'s or core, and every module page exists', () => {
    const sidebar = readFileSync(join(process.cwd(), 'web/components/sidebar.tsx'), 'utf8');
    const hrefs = [...sidebar.matchAll(/href: '([^']+)'/g)].map((m) => m[1]);
    const modulePages = MODULES.flatMap((m) => m.pages);
    for (const href of hrefs) {
      const isModule = modulePages.includes(href);
      expect(isModule || CORE_PAGES.includes(href), `${href}: add it to a module or to CORE_PAGES`).toBe(true);
      expect(isModule && CORE_PAGES.includes(href), `${href} is both`).toBe(false);
    }
    for (const page of modulePages) {
      const dir = join(process.cwd(), 'web/app', page);
      expect(statSync(dir, { throwIfNoEntry: false })?.isDirectory(), `web/app${page}`).toBe(true);
    }
  });

  test('every module job is checked where it runs, and every checked job is a module\'s', () => {
    const checked = new Set(sources(join(process.cwd(), 'src')).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/isJobOn\('([^']+)'\)/g)].map((m) => m[1])));
    const jobs = MODULES.flatMap((m) => m.jobs);
    expect(jobs.filter((job) => !checked.has(job)), 'a declared job nothing checks').toEqual([]);
    expect([...checked].filter((job) => !jobs.includes(job)), 'a checked job no module declares').toEqual([]);
  });
});
