/**
 * Agent refresh of a live artifact (docs/ARTIFACTS.md#agent-refresh) over
 * embedded PGlite and the real REST routes. The agent run is a scripted
 * double (`runRefreshAgent` replaced by a queue of scripted replies), so no
 * model is called; the last suite runs the real runner with a scripted
 * worker to pin what the agent is given.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { RefreshRunInput } from './agent-refresh-runner';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

type Step = { reply: string } | { fail: Error } | { wait: Promise<string> };
const script = vi.hoisted(() => ({ steps: [] as Step[], calls: [] as RefreshRunInput[] }));
vi.mock('./agent-refresh-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-refresh-runner')>();
  return {
    ...actual,
    runRefreshAgent: async (input: RefreshRunInput) => {
      script.calls.push(input);
      const step = script.steps.shift();
      if (!step) throw new Error('scripted runner: no step left');
      if ('fail' in step) throw step.fail;
      if ('wait' in step) return step.wait;
      return step.reply;
    },
  };
});

const policy = vi.hoisted(() => ({ retentionDays: 0, trashDays: 30 }));
vi.mock('@/core/artifacts/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/artifacts/settings')>();
  return { ...actual, resolveArtifactRetention: () => ({ ...policy }) };
});

// The real runner's worker, scripted (last suite).
const worker = vi.hoisted(() => ({ spawn: null as null | ((...args: unknown[]) => Promise<unknown>) }));
vi.mock('@/core/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/agent')>();
  return {
    ...actual,
    getAgentService: () => ({ spawnWorker: (...args: unknown[]) => worker.spawn!(...args) }),
  };
});

const DAY = 24 * 60 * 60 * 1000;
const alice = randomUUID();
const bob = randomUUID();
type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};

const PAGE = '```html\n<h1>Fresh</h1><button onclick="go()">go</button><script>function go(){ document.title = "y"; }</script>\n```\n```css\nh1 { color: red; }\n```';

afterEach(() => {
  script.steps.length = 0;
  script.calls.length = 0;
  policy.retentionDays = 0;
  vi.useRealTimers();
});

async function call(method: string, path: string, opts: { body?: unknown; as?: string; auth?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  else headers.authorization = `Bearer ${tokens[opts.as ?? alice]}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-artifact-agent-refresh-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  // In-memory queue and pub/sub, as an embedded install runs them.
  initializeStorage({ mode: 'embedded' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: alice, username: 'refresh-alice' }, { id: bob, username: 'refresh-bob' }]);
  const { getSessionManager } = await import('@/security/auth/session');
  tokens[alice] = (await getSessionManager().create(alice)).token;
  tokens[bob] = (await getSessionManager().create(bob)).token;
  const { createServer } = await import('@/api/server');
  app = createServer();
}, 120_000);

/** An artifact of alice with one version and a stored refresh instruction. */
async function seed(slug: string, instruction = 'List this week\'s Rust releases'): Promise<{ id: string; versionId: string; workspaceId: string }> {
  const res = await call('POST', '/api/artifacts', { body: { slug, title: slug, type: 'html', htmlTemplate: '<p>old</p>' } });
  expect(res.status).toBe(201);
  const { artifact } = await res.json();
  expect((await call('PUT', `/api/artifacts/${artifact.id}/agent-refresh`, { body: { instruction } })).status).toBe(200);
  return { id: artifact.id, versionId: artifact.currentVersionId, workspaceId: artifact.workspaceId };
}

async function state(id: string) {
  const res = await call('GET', `/api/artifacts/${id}/agent-refresh`);
  expect(res.status).toBe(200);
  return (await res.json()).refresh as import('@/shared/artifacts').AgentRefreshView;
}

async function current(id: string) {
  const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
  const a = await artifactsRepository.getById(id);
  return { versionId: a?.currentVersionId ?? null, versions: (await artifactsRepository.listVersions(id)).length };
}

async function settled(id: string): Promise<import('@/shared/artifacts').AgentRefreshView> {
  for (let i = 0; i < 200; i++) {
    const s = await state(id);
    if (!s.running && s.lastOutcome) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('refresh did not settle');
}

describe('manual refresh by the owner', () => {
  test('a successful run replaces the page atomically with a new current version', async () => {
    const a = await seed('manual-ok');
    script.steps.push({ reply: PAGE });
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
    const s = await settled(a.id);
    expect(s).toMatchObject({ lastOutcome: 'success', lastError: null, consecutiveFailures: 0 });
    expect(s.lastSuccessAt).not.toBeNull();

    const after = await current(a.id);
    expect(after.versionId).not.toBe(a.versionId);
    expect(after.versions).toBe(2);
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    const v = await artifactsRepository.getVersion(after.versionId!);
    expect(v?.htmlTemplate).toContain('<h1>Fresh</h1>');
    expect(v?.htmlTemplate).not.toContain('<script');
    expect(v?.css).toBe('h1 { color: red; }');
    expect(v?.changeSummary).toBe('agent refresh');
    const { bundleFilePath } = await import('./bundler');
    expect(existsSync(bundleFilePath(a.id, after.versionId!))).toBe(true);

    // The run was the owner's, from the stored instruction only.
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]).toMatchObject({ ownerUserId: alice, instruction: 'List this week\'s Rust releases', trigger: 'user', workspaceId: a.workspaceId });
    expect(JSON.stringify(script.calls[0])).not.toContain('<p>old</p>');
  });

  test('a failed run keeps the current version and records the error', async () => {
    const a = await seed('manual-fail');
    script.steps.push({ fail: new Error('model unavailable') });
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
    const s = await settled(a.id);
    expect(s).toMatchObject({ lastOutcome: 'failed', lastError: 'model unavailable', lastSuccessAt: null });
    expect(await current(a.id)).toEqual({ versionId: a.versionId, versions: 1 });

    // A run that returns no valid page is a failure too, and leaves no version behind.
    script.steps.push({ reply: 'I could not find anything new.' });
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
    expect(await settled(a.id)).toMatchObject({ lastOutcome: 'failed', lastError: 'The agent did not return a ```html block' });
    expect(await current(a.id)).toEqual({ versionId: a.versionId, versions: 1 });
  });

  test('an edit made while the run was going wins; the refreshed page is discarded', async () => {
    const a = await seed('edited-meanwhile');
    let release!: (s: string) => void;
    script.steps.push({ wait: new Promise<string>((r) => { release = r; }) });
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
    expect((await call('PUT', `/api/artifacts/${a.id}`, { body: { htmlTemplate: '<p>edited by hand</p>' } })).status).toBe(200);
    const edited = await current(a.id);
    release(PAGE);
    const s = await settled(a.id);
    expect(s.lastOutcome).toBe('failed');
    expect(s.lastError).toMatch(/edited, restored or deleted/);
    expect(await current(a.id)).toEqual(edited);
  });

  test('concurrent refresh requests start one run', async () => {
    const a = await seed('concurrent');
    let release!: (s: string) => void;
    script.steps.push({ wait: new Promise<string>((r) => { release = r; }) }, { reply: PAGE });
    const statuses = (await Promise.all([1, 2, 3].map(() => call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)))).map((r) => r.status).sort();
    expect(statuses).toEqual([202, 409, 409]);
    expect((await state(a.id)).running).toBe(true);
    release(PAGE);
    expect((await settled(a.id)).lastOutcome).toBe('success');
    expect(script.calls).toHaveLength(1);
    expect(script.steps).toHaveLength(1);
  });

  test('a paused spend budget refuses the run before any agent starts, and the refusal is recorded', async () => {
    const a = await seed('budget');
    const { upsertBudget, deleteBudget, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    const budget = await upsertBudget({ userId: alice, scopeKind: 'user', period: 'month', limitUsd: 5 });
    const { getDb } = await import('@/db/postgres');
    const { spendBudgets } = await import('@/db/schema/spend-budgets');
    const { eq } = await import('drizzle-orm');
    await getDb().update(spendBudgets).set({ pausedAt: new Date() }).where(eq(spendBudgets.id, budget.id));
    _resetSpendBudgetsForTests();
    try {
      const res = await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'refresh_refused' });
      const s = await state(a.id);
      expect(s.running).toBe(false);
      expect(s.lastOutcome).toBe('refused');
      expect(s.lastError).toMatch(/Spend budget exceeded/);
      expect(script.calls).toHaveLength(0);
      expect(await current(a.id)).toEqual({ versionId: a.versionId, versions: 1 });
    } finally {
      await deleteBudget(budget.id);
      _resetSpendBudgetsForTests();
    }
  });
});

describe('who can trigger a refresh', () => {
  test('a user outside the workspace cannot see or start it', async () => {
    const a = await seed('not-bobs');
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`, { as: bob })).status).toBe(404);
    expect((await call('GET', `/api/artifacts/${a.id}/agent-refresh`, { as: bob })).status).toBe(404);
    expect((await call('PUT', `/api/artifacts/${a.id}/agent-refresh`, { as: bob, body: { instruction: 'x' } })).status).toBe(404);
    expect(script.calls).toHaveLength(0);
  });

  test('a member who can see and edit the artifact but does not own it gets 403, and nothing runs', async () => {
    const a = await seed('someone-elses');
    // Alice's workspace holds it, but bob created it: alice may view and edit it, not spend on it.
    const { getDb } = await import('@/db/postgres');
    const { artifacts } = await import('@/db/schema/artifacts');
    const { eq } = await import('drizzle-orm');
    await getDb().update(artifacts).set({ createdByUserId: bob }).where(eq(artifacts.id, a.id));
    expect((await call('GET', `/api/artifacts/${a.id}`)).status).toBe(200);
    for (const [method, path, body] of [
      ['POST', `/api/artifacts/${a.id}/agent-refresh/run`, undefined],
      ['GET', `/api/artifacts/${a.id}/agent-refresh`, undefined],
      ['PUT', `/api/artifacts/${a.id}/agent-refresh`, { instruction: 'spend my budget', intervalMinutes: 60 }],
    ] as const) {
      const res = await call(method, path, { body });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'not_owner' });
    }
    // And the stored row was not touched by the attempt.
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    expect((await artifactRefreshRepository.get(a.id))?.instruction).toBe('List this week\'s Rust releases');
    expect(script.calls).toHaveLength(0);
  });

  test('an embed viewer token cannot start a refresh by any route', async () => {
    const a = await seed('viewer-token', 'x');
    expect((await call('PUT', `/api/artifacts/${a.id}`, { body: { visibility: 'public' } })).status).toBe(200);
    const { signArtifactToken } = await import('./token');
    const now = Math.floor(Date.now() / 1000);
    const vt = signArtifactToken({ aid: a.id, wid: a.workspaceId, scope: 'view', iat: now, exp: now + 300 });
    const run = `/api/artifacts/${a.id}/agent-refresh/run`;
    expect((await call('POST', run, { auth: `Bearer ${vt}` })).status).toBe(401);
    expect((await call('POST', run, { auth: `ArtifactToken ${vt}` })).status).toBe(401);
    expect((await call('POST', `${run}?vt=${encodeURIComponent(vt)}`, { auth: '' })).status).toBe(401);
    // The hosted page routes have no refresh at all, signed in or not.
    expect((await call('POST', `/__artifacts__/a/viewer-token/agent-refresh/run?vt=${encodeURIComponent(vt)}`, { auth: '' })).status).toBe(404);
    expect((await call('POST', '/__artifacts__/a/viewer-token/refresh', { auth: '' })).status).toBe(404);
    expect(script.calls).toHaveLength(0);
    expect((await state(a.id)).lastAttemptAt).toBeNull();
  });
});

describe('the schedule', () => {
  test('an owner schedule below the minimum interval is refused', async () => {
    const a = await seed('too-often');
    expect((await call('PUT', `/api/artifacts/${a.id}/agent-refresh`, { body: { intervalMinutes: 5 } })).status).toBe(400);
    expect((await state(a.id)).intervalMinutes).toBeNull();
  });

  test('a schedule fires through the shared scheduler, then re-arms one interval later', async () => {
    const a = await seed('scheduled');
    const { getScheduler } = await import('@/core/scheduler');
    const { registerAgentRefreshHandler } = await import('./agent-refresh');
    registerAgentRefreshHandler();
    const res = await call('PUT', `/api/artifacts/${a.id}/agent-refresh`, { body: { intervalMinutes: 60 } });
    expect(res.status).toBe(200);
    const armed = (await res.json()).refresh;
    expect(armed.intervalMinutes).toBe(60);
    const due = new Date(armed.nextRunAt).getTime();
    expect(due - Date.now()).toBeGreaterThan(59 * 60_000);

    script.steps.push({ reply: PAGE });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(due + 1000);
    const scheduler = getScheduler();
    scheduler.start(1);
    try {
      const s = await settled(a.id);
      expect(s.lastOutcome).toBe('success');
      expect(script.calls[0]?.trigger).toBe('schedule');
      // Re-armed under the same chain, one interval after this run.
      for (let i = 0; i < 100 && (await state(a.id)).nextRunAt === armed.nextRunAt; i++) await new Promise((r) => setTimeout(r, 20));
      expect(new Date((await state(a.id)).nextRunAt!).getTime()).toBeGreaterThan(due + 59 * 60_000);
    } finally {
      await scheduler.stop();
    }
    expect((await current(a.id)).versions).toBe(2);
  });

  test('a schedule that keeps failing backs off, then turns itself off and tells the owner', async () => {
    const a = await seed('flaky');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const { handleAgentRefreshTask, MAX_SCHEDULE_FAILURES, nextScheduleDelayMs, setAgentRefreshSchedule } = await import('./agent-refresh');
    await setAgentRefreshSchedule(a.id, 60);
    const chain = (await artifactRefreshRepository.get(a.id))!.scheduleChain!;
    const notify = vi.fn(async () => {});
    const task = { payload: { artifactId: a.id, chain } } as unknown as import('@/core/scheduler').ScheduledTask;
    for (let i = 1; i <= MAX_SCHEDULE_FAILURES; i++) {
      script.steps.push({ fail: new Error(`upstream down ${i}`) });
      const before = Date.now();
      await handleAgentRefreshTask(task, { notify });
      const row = (await artifactRefreshRepository.get(a.id))!;
      expect(row.consecutiveFailures).toBe(i);
      if (i < MAX_SCHEDULE_FAILURES) {
        expect(row.nextRunAt!.getTime() - before).toBeGreaterThanOrEqual(nextScheduleDelayMs(60, i) - 1000);
      }
    }
    expect(nextScheduleDelayMs(60, 1)).toBe(2 * 60 * 60_000);
    expect(nextScheduleDelayMs(60, 10)).toBe(24 * 60 * 60_000);
    const s = await state(a.id);
    expect(s.intervalMinutes).toBeNull();
    expect(s.nextRunAt).toBeNull();
    expect(s.scheduleDisabledReason).toMatch(/5 scheduled refreshes in a row.*upstream down 5/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(alice, 'artifact_refresh_disabled', expect.stringContaining('flaky'), expect.any(String), { artifactId: a.id });
    // The old chain's next task ends without running.
    await handleAgentRefreshTask(task, { notify });
    expect(script.calls).toHaveLength(MAX_SCHEDULE_FAILURES);
    // The current version was never replaced.
    expect(await current(a.id)).toEqual({ versionId: a.versionId, versions: 1 });
  });

  test('retention expiry cancels the schedule, and its queued task runs nothing', async () => {
    const a = await seed('expiring');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const { handleAgentRefreshTask, setAgentRefreshSchedule } = await import('./agent-refresh');
    await setAgentRefreshSchedule(a.id, 60);
    const chain = (await artifactRefreshRepository.get(a.id))!.scheduleChain!;
    const { getDb } = await import('@/db/postgres');
    const { artifacts } = await import('@/db/schema/artifacts');
    const { eq } = await import('drizzle-orm');
    await getDb().update(artifacts).set({ updatedAt: new Date(Date.now() - 100 * DAY) }).where(eq(artifacts.id, a.id));

    policy.retentionDays = 90;
    const { runArtifactCleanup } = await import('./cleanup');
    expect((await runArtifactCleanup()).expiredArtifacts).toBeGreaterThanOrEqual(1);
    const row = (await artifactRefreshRepository.get(a.id))!;
    expect(row.scheduleChain).toBeNull();
    expect(row.intervalMinutes).toBeNull();
    expect(row.scheduleDisabledReason).toMatch(/expired after 90 days/);

    script.steps.push({ reply: PAGE });
    await handleAgentRefreshTask({ payload: { artifactId: a.id, chain } } as unknown as import('@/core/scheduler').ScheduledTask);
    expect(script.calls).toHaveLength(0);
    // And a manual request has nothing to refresh.
    const { startAgentRefresh } = await import('./agent-refresh');
    expect(await startAgentRefresh(a.id, 'user')).toEqual({ status: 'unavailable', error: 'Artifact not found' });
  });

  test('a deleted artifact stops its schedule at the next fire', async () => {
    const a = await seed('deleted-scheduled');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const { handleAgentRefreshTask, setAgentRefreshSchedule } = await import('./agent-refresh');
    await setAgentRefreshSchedule(a.id, 60);
    const chain = (await artifactRefreshRepository.get(a.id))!.scheduleChain!;
    expect((await call('DELETE', `/api/artifacts/${a.id}`)).status).toBe(200);
    await handleAgentRefreshTask({ payload: { artifactId: a.id, chain } } as unknown as import('@/core/scheduler').ScheduledTask);
    expect(script.calls).toHaveLength(0);
    expect((await artifactRefreshRepository.get(a.id))?.scheduleDisabledReason).toBe('The artifact was deleted');
  });
});

describe('the real runner', () => {
  test('runs an unattended worker of the owner on read-only tools, given only the stored instruction', async () => {
    const a = await seed('real-runner', 'Top 3 headlines from example.org');
    const spawn = vi.fn(async () => '```html\n<p>new</p>\n```');
    worker.spawn = spawn;
    const actual = await vi.importActual<typeof import('./agent-refresh-runner')>('./agent-refresh-runner');
    const sessions: string[] = [];
    const out = await actual.runRefreshAgent({
      artifactId: a.id,
      workspaceId: a.workspaceId,
      ownerUserId: alice,
      title: 'real-runner',
      instruction: 'Top 3 headlines from example.org',
      trigger: 'schedule',
      sessionId: null,
      signal: new AbortController().signal,
      onSession: async (id) => { sessions.push(id); },
    });
    expect(out).toContain('<p>new</p>');
    expect(sessions).toHaveLength(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [role, task, input, parent, opts] = spawn.mock.calls[0] as unknown as [string, string, string, import('@/core/types').AgentContext, { toolIds: string[]; exactTools: boolean }];
    expect(role).toBe('research');
    expect(input).toBe('');
    expect(task).toBe(actual.buildRefreshTask('real-runner', 'Top 3 headlines from example.org'));
    expect(task).not.toContain('<p>old</p>');
    expect(parent).toMatchObject({ userId: alice, sessionId: sessions[0], workspaceId: a.workspaceId, attended: false, trigger: 'schedule', funding: 'own' });
    expect(opts.exactTools).toBe(true);
    expect(opts.toolIds).toEqual([...actual.REFRESH_AGENT_TOOLS]);
    expect(opts.toolIds.some((t) => t.startsWith('artifacts'))).toBe(false);
  });
});
