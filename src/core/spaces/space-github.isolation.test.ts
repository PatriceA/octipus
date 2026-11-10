/**
 * A space's GitHub token and the identity a space run acts with
 * (docs/plans/coworking-spec.md §9.5).
 *
 *   - every git, shell, gh and CLI-agent run in a space gets a fresh tool
 *     home of its own, seeded only with the space's GitHub login, removed
 *     after the run; the host's SSH agent, askpass and credential helpers
 *     never reach it (real git, real shell);
 *   - the GitHub tool, through a real handler call, runs gh with the space's
 *     token and refuses without one; personal sessions keep the host's gh;
 *     its writes follow the role, its reads do not mark the session private;
 *   - a new token or a removal deletes the superseded ciphertext;
 *   - what the removed connector framework stored (space and personal
 *     `connector_<id>_*` rows) neither surfaces nor reaches an agent, and
 *     its routes are gone.
 *
 * Driven through the real routes (`createServer()`) and tools. Backed by
 * ephemeral PGlite.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

/** What `gh` was asked to run, with the environment it would have had, read while the run's home existed. */
const ghRuns: Array<{ args: string[]; env: Record<string, string>; hostsYml: string | null }> = [];
vi.mock('@/utils/gh', async () => {
  const actual = await vi.importActual<typeof import('@/utils/gh')>('@/utils/gh');
  return {
    ...actual,
    runGh: async (args: string[], opts: import('@/utils/gh').RunGhOptions = {}) => {
      const env = actual.ghEnv(opts);
      const hosts = env.GH_CONFIG_DIR ? join(env.GH_CONFIG_DIR, 'hosts.yml') : null;
      ghRuns.push({ args, env, hostsYml: hosts && existsSync(hosts) ? readFileSync(hosts, 'utf8') : null });
      return '[]';
    },
  };
});

const ownerId = randomUUID();
const editorId = randomUUID();
const commenterId = randomUUID();
const coOwnerId = randomUUID();

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};
let spaceId: string;
let otherSpaceId: string;

async function call(who: string, method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[who]}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
}

async function agentContext(userId: string, space: { workspaceId: string; role: 'owner' | 'editor' | 'commenter' } | null): Promise<AgentContext> {
  const { buildAgentContext } = await import('@/core/agent/context');
  return buildAgentContext({
    sessionId: randomUUID(),
    userId,
    scope: space
      ? { workspaceId: space.workspaceId, space: { workspaceId: space.workspaceId, role: space.role, scope: null }, trigger: 'user', funding: 'own' }
      : { workspaceId: null, space: null, trigger: 'user', funding: 'own' },
    topic: 'general',
    model: 'test-model',
    role: 'general',
    root: true,
    attended: false,
    status: 'running',
  });
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-space-github-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: ownerId, username: 'owner' },
    { id: editorId, username: 'editor' },
    { id: commenterId, username: 'commenter' },
    { id: coOwnerId, username: 'coowner' },
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of [['owner', ownerId], ['editor', editorId], ['commenter', commenterId], ['coowner', coOwnerId]]) {
    tokens[name] = (await getSessionManager().create(id)).token;
  }
  const { createServer } = await import('@/api/server');
  app = createServer();
  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(ownerId, [[editorId, 'editor'], [commenterId, 'commenter']], 'Launch');
  otherSpaceId = await spaceWith(ownerId, [[coOwnerId, 'editor']], 'Second');
  const res = await call('owner', 'PATCH', `/api/spaces/${otherSpaceId}/members/${coOwnerId}`, { body: { role: 'owner' } });
  expect(res.status).toBe(200);
  // The space's GitHub token.
  expect((await call('owner', 'PUT', `/api/spaces/${spaceId}/github`, { body: { token: 'ghp_space' } })).status).toBe(200);
  const { getPermissionManager } = await import('@/security/permissions');
  for (const id of [editorId, commenterId]) await getPermissionManager().setPermission(id, 'shell', 'execute', 'ALLOW');
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('a space run\'s tool home (§9.5)', () => {
  test('fresh per run, seeded only with the space\'s GitHub login, removed after it', async () => {
    const { openSpaceToolHome, createSpaceToolHome } = await import('@/security/space-tool-env');
    const ctx = await agentContext(editorId, { workspaceId: spaceId, role: 'editor' });
    const a = await openSpaceToolHome({ ...ctx, space: ctx.space! });
    const b = await openSpaceToolHome({ ...ctx, space: ctx.space! });
    try {
      expect(a.dir).not.toBe(b.dir);
      expect(a.env).toMatchObject({
        HOME: a.dir, XDG_CONFIG_HOME: join(a.dir, '.config'), GH_CONFIG_DIR: join(a.dir, '.config', 'gh'),
        GIT_CONFIG_GLOBAL: join(a.dir, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      });
      expect(readFileSync(join(a.dir, '.config', 'gh', 'hosts.yml'), 'utf8')).toContain('oauth_token: "ghp_space"');
      expect(readFileSync(join(a.dir, '.gitconfig'), 'utf8')).toContain('name = "editor"');
    } finally {
      a.dispose();
      b.dispose();
    }
    expect(existsSync(a.dir)).toBe(false);
    // A commenter's run cannot write through the connection: nothing seeded.
    const commenter = await agentContext(commenterId, { workspaceId: spaceId, role: 'commenter' });
    const c = await openSpaceToolHome({ ...commenter, space: commenter.space! });
    try {
      expect(existsSync(join(c.dir, '.config', 'gh', 'hosts.yml'))).toBe(false);
      expect(c.gitArgs).toEqual(['-c', 'credential.helper=']);
    } finally {
      c.dispose();
    }
    // A space without GitHub: no login, and every credential helper reset.
    const bare = createSpaceToolHome(otherSpaceId, { githubToken: null });
    try {
      expect(existsSync(join(bare.dir, '.config', 'gh', 'hosts.yml'))).toBe(false);
      expect(bare.gitArgs).toEqual(['-c', 'credential.helper=']);
    } finally {
      bare.dispose();
    }
  });

  test('the Git tool in a space: no host agent, askpass or helper; github.com authenticates as the space (real git)', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/host-agent.sock';
    process.env.GIT_ASKPASS = '/usr/local/bin/host-askpass';
    // A host helper handed down the way `git -c` does it.
    process.env.GIT_CONFIG_PARAMETERS = '\'credential.helper=!f() { echo username=host; echo password=HOST-SECRET; }; f\'';
    try {
      const { gitTool } = await import('@/tools/git');
      const ctx = await agentContext(editorId, { workspaceId: spaceId, role: 'editor' });
      const plan = await gitTool.spawnPlanFor(ctx, ['credential', 'fill']);
      try {
        expect(plan.home).not.toBeNull();
        expect(plan.args.slice(0, 2)).toEqual(['-c', 'credential.helper=']);
        for (const k of ['SSH_AUTH_SOCK', 'GIT_ASKPASS', 'GIT_CONFIG_PARAMETERS']) expect(plan.env[k], k).toBeUndefined();
        expect(plan.env).toMatchObject({ HOME: plan.home!.dir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
        const filled = spawnSync('git', plan.args, { env: plan.env, cwd: plan.home!.dir, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
        expect(filled.stdout).toContain('password=ghp_space');
        expect(filled.stdout).not.toContain('HOST-SECRET');
        // Another host: no helper at all, and no prompt.
        const other = spawnSync('git', plan.args, { env: plan.env, cwd: plan.home!.dir, input: 'protocol=https\nhost=gitlab.example\n\n', encoding: 'utf8' });
        expect(other.stdout).not.toContain('password=');
      } finally {
        plan.home?.dispose();
      }
      // A personal session keeps the host's setup.
      const personal = await gitTool.spawnPlanFor(await agentContext(editorId, null), ['status']);
      expect(personal).toMatchObject({ args: ['status'], home: null });
      expect(personal.env.SSH_AUTH_SOCK).toBe('/tmp/host-agent.sock');
    } finally {
      delete process.env.SSH_AUTH_SOCK;
      delete process.env.GIT_ASKPASS;
      delete process.env.GIT_CONFIG_PARAMETERS;
    }
  });

  test('the shell in a space runs in its own home whatever the call\'s env says; the home is gone afterwards (real shell)', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/host-agent.sock';
    try {
      const { ShellTool } = await import('@/tools/shell');
      const tool = new ShellTool();
      await tool.initialize();
      const ctx = await agentContext(editorId, { workspaceId: spaceId, role: 'editor' });
      const { WorkspaceFS } = await import('@/security/workspace-fs');
      mkdirSync(WorkspaceFS.forAgent(ctx).root, { recursive: true });
      const run = tool.getTool('run')!;
      const result = await run.execute({
        command: 'printf "%s|%s|%s|%s\\n" "$HOME" "$GH_CONFIG_DIR" "${SSH_AUTH_SOCK:-none}" "$X"; cat "$GH_CONFIG_DIR/hosts.yml"',
        useShell: true,
        env: { SSH_AUTH_SOCK: '/tmp/forced.sock', GH_CONFIG_DIR: '/root/.config/gh', HOME: '/root', X: 'kept' },
      }, ctx) as { stdout: string; exitCode: number };
      expect(result.exitCode).toBe(0);
      const [home, ghDir, sock, x] = result.stdout.split('\n')[0].split('|');
      expect(home).toMatch(/octipus-space-home-/);
      expect(ghDir).toBe(join(home, '.config', 'gh'));
      expect(sock).toBe('none');
      expect(x).toBe('kept');
      expect(result.stdout).toContain('oauth_token: "ghp_space"');
      expect(existsSync(home)).toBe(false);
    } finally {
      delete process.env.SSH_AUTH_SOCK;
    }
  });

  test('CLI agents: the run\'s home, the host agent gone, the vendor config kept', async () => {
    const { createSpaceToolHome } = await import('@/security/space-tool-env');
    const { cliSpaceEnv } = await import('@/core/cli-child-env');
    const home = createSpaceToolHome(spaceId, { githubToken: null });
    try {
      const env = cliSpaceEnv({ HOME: '/home/octi', PATH: '/bin', SSH_AUTH_SOCK: '/tmp/a.sock', GIT_SSH_COMMAND: 'ssh -i host' }, home);
      expect(env).toMatchObject({ HOME: home.dir, GH_CONFIG_DIR: join(home.dir, '.config', 'gh'), CLAUDE_CONFIG_DIR: '/home/octi/.claude', CODEX_HOME: '/home/octi/.codex', PATH: '/bin' });
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
      expect(env.GIT_SSH_COMMAND).not.toContain('host');
    } finally {
      home.dispose();
    }
  });
});

describe('the GitHub tool in a space (§9.5), through a real handler call', () => {
  test('space token and the run\'s own home; refused without a connection; personal sessions keep the host\'s gh', async () => {
    const { GitHubTool } = await import('@/tools/github');
    const tool = new GitHubTool();
    await tool.initialize();
    const list = tool.getTool('repo_list')!;

    ghRuns.length = 0;
    await list.execute({}, await agentContext(editorId, { workspaceId: spaceId, role: 'editor' }));
    expect(ghRuns).toHaveLength(1);
    const [run] = ghRuns;
    expect(run.args.slice(0, 2)).toEqual(['repo', 'list']);
    expect(run.env.GH_TOKEN).toBe('ghp_space');
    expect(run.env.GH_CONFIG_DIR).toMatch(/octipus-space-home-/);
    expect(run.hostsYml).toContain('ghp_space');
    // Gone with the run.
    expect(existsSync(run.env.GH_CONFIG_DIR)).toBe(false);

    await expect(list.execute({}, await agentContext(ownerId, { workspaceId: otherSpaceId, role: 'owner' })))
      .rejects.toThrow(/This space has no GitHub connection/);

    process.env.GH_TOKEN = 'host-token';
    try {
      ghRuns.length = 0;
      await list.execute({}, await agentContext(editorId, null));
      expect(ghRuns[0].env.GH_TOKEN).toBe('host-token');
      expect(ghRuns[0].env.GH_CONFIG_DIR).toBeUndefined();
    } finally {
      delete process.env.GH_TOKEN;
    }
  });
});

describe('the space\'s GitHub in a space session (§9.5)', () => {
  test('its writes follow the role and its reads do not mark the session private', async () => {
    const { routeApprovalFor } = await import('@/security/approval-route');
    const { getFlowLabel } = await import('@/security/flow-guard');
    const editor = { ...await agentContext(editorId, { workspaceId: spaceId, role: 'editor' }), attended: true };
    for (const [toolId, action, toolName] of [['github', 'write', 'create_issue'], ['github', 'manage', 'pr_merge']]) {
      expect(await routeApprovalFor(editor, { toolId, action, toolName }, { level: 'ALLOW' }), `${toolId}.${action}`).toMatchObject({ route: 'execute' });
    }
    const commenter = { ...await agentContext(commenterId, { workspaceId: spaceId, role: 'commenter' }), attended: true };
    expect(await routeApprovalFor(commenter, { toolId: 'github', action: 'write', toolName: 'create_issue' }, { level: 'ALLOW' }))
      .toMatchObject({ route: 'deny', reason: expect.stringMatching(/can only read and comment/) });
    expect(await routeApprovalFor(editor, { toolId: 'github', action: 'read', toolName: 'issue_list' }, { level: 'ALLOW' })).toMatchObject({ route: 'execute' });
    expect(getFlowLabel(editor.sessionId).private).toBe(false);
    // A space session is offered it.
    const { withoutPersonalOnlyTools } = await import('@/security/space-tools');
    const h = (name: string, toolId: string, permissionAction: string) => ({ name, toolId, permissionAction, description: '', parameters: { type: 'object' }, execute: async () => null });
    expect(withoutPersonalOnlyTools([h('github__issue_create', 'github', 'write')]).map((t) => t.name)).toEqual(['github__issue_create']);
  });
});

describe('space secrets keep no superseded ciphertext', () => {
  test('a new token replaces the row, a removal deletes it', async () => {
    const { queryRaw } = await import('@/db/postgres');
    const count = async () => Number((await queryRaw(
      `SELECT count(*)::int AS n FROM vault WHERE scope = 'space' AND workspace_id = $1 AND name = 'connector_github_access_token'`, [spaceId],
    )).rows[0].n);
    expect(await count()).toBe(1);
    expect((await call('owner', 'PUT', `/api/spaces/${spaceId}/github`, { body: { token: 'ghp_space_2' } })).status).toBe(200);
    expect(await count()).toBe(1);
    expect((await call('owner', 'DELETE', `/api/spaces/${spaceId}/github`)).status).toBe(200);
    expect(await count()).toBe(0);
    expect(await (await call('owner', 'GET', `/api/spaces/${spaceId}/github`)).json()).toEqual({ connected: false, connectedBy: null, connectedAt: null });
    // Back for the tests after this one.
    expect((await call('owner', 'PUT', `/api/spaces/${spaceId}/github`, { body: { token: 'ghp_space' } })).status).toBe(200);
  });
});

describe('what the removed connector framework stored before the upgrade', () => {
  test('space and personal connector tokens neither surface, nor reach an agent; the routes are gone', async () => {
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { spaceRepos } = await import('@/db/repositories/space');
    const { getVault } = await import('@/security/vault');
    const owner = await resolvedPrincipal(ownerId, spaceId);
    // As the connector framework wrote them: `connector_<id>_*`, space-scoped and personal.
    for (const id of ['atlassian', 'linear', 'example']) {
      await spaceRepos(owner).secrets.write(`connector_${id}_access_token`, `space-${id}`, 'oauth_token');
      await spaceRepos(owner).secrets.write(`connector_${id}_refresh_token`, `space-rt-${id}`, 'oauth_token');
      await getVault().store(ownerId, `connector_${id}_access_token`, `personal-${id}`, { credentialType: 'oauth_token' });
      await getVault().store(ownerId, `connector_${id}_token_expiry`, new Date(Date.now() + 3600_000).toISOString(), { credentialType: 'other' });
    }

    // The space settings read only the GitHub token, which still works.
    const github = await call('owner', 'GET', `/api/spaces/${spaceId}/github`);
    expect(github.status).toBe(200);
    expect(await github.json()).toMatchObject({ connected: true, connectedBy: 'owner' });
    const { spaceGithubToken } = await import('@/core/spaces/github-token');
    expect(await spaceGithubToken(await resolvedPrincipal(editorId, spaceId))).toBe('ghp_space');

    // The personal rows are ordinary secrets: listed on the Secrets page, and deletable there.
    const listed = await call('owner', 'GET', '/api/vault');
    expect(listed.status).toBe(200);
    const credentials = (await listed.json() as { credentials: Array<{ id: string; name: string }> }).credentials;
    const stale = credentials.find((c) => c.name === 'connector_linear_access_token');
    expect(stale).toBeDefined();
    expect(JSON.stringify(credentials)).not.toContain('personal-linear');
    expect((await call('owner', 'DELETE', `/api/vault/${stale!.id}`)).status).toBe(200);

    // The mailbox OAuth (Google, Microsoft 365) does not read them as its own.
    const { getOAuthManager } = await import('@/security/oauth');
    expect(await getOAuthManager().getConnectionStatus(ownerId, 'google')).toEqual({ connected: false, provider: 'google' });
    expect(await getOAuthManager().getValidToken(ownerId, 'microsoft')).toBeNull();

    // No connector tool reaches an agent's role tools, personal or in a space.
    const { getToolsForRole } = await import('@/core/agent/roles');
    for (const ctx of [await agentContext(ownerId, null), await agentContext(ownerId, { workspaceId: spaceId, role: 'owner' })]) {
      const names = getToolsForRole(ctx.role as Parameters<typeof getToolsForRole>[0]).map((t) => t.name);
      expect(names.filter((n) => n.startsWith('connector_'))).toEqual([]);
    }

    // The connector routes, personal and space, no longer exist.
    expect((await call('owner', 'GET', '/api/connectors')).status).toBe(404);
    expect((await call('owner', 'POST', '/api/connectors/linear/authorize')).status).toBe(404);
    expect((await call('owner', 'DELETE', '/api/connectors/linear')).status).toBe(404);
    expect((await call('owner', 'GET', `/api/spaces/${spaceId}/connectors`)).status).toBe(404);
    expect((await call('owner', 'POST', `/api/spaces/${spaceId}/connectors/github`, { body: { token: 'ghp_x' } })).status).toBe(404);
    // An OAuth flow cannot be started for one either.
    const flow = await call('owner', 'GET', '/api/auth/oauth/linear/authorize');
    expect(flow.status).toBe(400);
    const { OAuthManager } = await import('@/security/oauth');
    await expect(new OAuthManager().generateAuthorizationUrl(ownerId, 'linear', { browserBinding: 'a'.repeat(64) })).rejects.toThrow(/not configured/);
  });
});
