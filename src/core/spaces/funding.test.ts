/**
 * Sponsor, budgets and the team surface (docs/plans/coworking-spec.md §9.1–
 * §9.3, tests of §9.6):
 *
 *   - the funding table per trigger, through `resolveAgentScope` on a real
 *     space (and `fundingFor` for every cell);
 *   - sponsor removal, downgrade and leave clear the sponsor in the same
 *     transaction, audit it and stop sponsored agents;
 *   - a member at the per-member cap is paused without pausing the others;
 *   - the space budget counts only sponsored rows of the space;
 *   - install background work is never refused by a space budget, and its
 *     rows say `install` in a sponsored turn (the toolshim row included);
 *   - a sponsored turn never moves a personal budget, nor the token quota;
 *   - sponsored model resolution: the sponsor's models, never the requester's;
 *   - routes: funding, budget, My work, task assignment notices and
 *     `task.changed`, room modes and the room listen gate;
 *   - the review fixes: no CLI sponsor model, the sponsor's consent to pay
 *     for more, sponsored work re-reading its funding, the sponsor's
 *     account deletion, probes as install work of the space, read-only
 *     listen turns, the feedback slowdown, the cross-process probe claim,
 *     `task.changed` to non-guest members only.
 *
 * Backed by ephemeral PGlite, driven through the real `createServer()`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const owner = randomUUID();
const editor = randomUUID();
const member = randomUUID();
const commenter = randomUUID();
const outsider = randomUUID();
const guest = randomUUID();
const viewer = randomUUID();

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};

// biome-ignore lint/suspicious/noExplicitAny: raw rows
type Row = any;
async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

async function call(who: string, method: string, path: string, body?: unknown, workspace?: string): Promise<{ status: number; body: Row }> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[who]}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (workspace) headers['x-octipus-workspace'] = workspace;
  const res = await app.handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  let parsed: Row = text;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-funding-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: owner, username: 'owner' },
    { id: editor, username: 'editor' },
    { id: member, username: 'member' },
    { id: commenter, username: 'commenter' },
    { id: outsider, username: 'outsider' },
    { id: guest, username: 'guest' },
    { id: viewer, username: 'viewer' },
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of [['owner', owner], ['editor', editor], ['member', member], ['commenter', commenter], ['outsider', outsider], ['viewer', viewer]]) {
    tokens[name] = (await getSessionManager().create(id)).token;
  }
  const { getModelRegistry } = await import('@/models/model-registry');
  await getModelRegistry().registerModel({
    name: 'install-main', provider: 'openai', modelId: 'install-id', isDefault: true,
    topicRoles: { build: 'primary', everyday: 'primary', background: 'primary' }, costPerInputToken: 1, costPerOutputToken: 1,
  });
  const { createPersonalModel } = await import('@/services/personal-models');
  await createPersonalModel(owner, { slug: 'paid', provider: 'openai', modelId: 'owner-paid', key: 'sk-owner', topics: ['build'] });
  await createPersonalModel(editor, { slug: 'mine', provider: 'openai', modelId: 'editor-own', key: 'sk-editor', topics: ['build'] });
  const { createServer } = await import('@/api/server');
  app = createServer();
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  const { _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
  _resetSpendBudgetsForTests();
});

const OWNER_MODEL = `u/${owner}/paid`;
const EDITOR_MODEL = `u/${editor}/mine`;

/** A space owned by `owner`, editor and member as editors, commenter as commenter. */
async function space(funding?: { mode: 'own' | 'unattended' | 'sponsored'; sponsor?: boolean }): Promise<string> {
  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  const id = await spaceWith(owner, [[editor, 'editor'], [member, 'editor'], [commenter, 'commenter']]);
  if (funding) {
    const { setSpaceFunding } = await import('./funding');
    await setSpaceFunding({ userId: owner }, id, { mode: funding.mode, ...(funding.sponsor ? { sponsor: 'me' as const } : {}) });
  }
  return id;
}

/**
 * Every `task.changed` broadcast, with who it reaches: the broadcast's
 * filter is applied to a connection of each user subscribed to the space.
 */
async function captureTaskChanged() {
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const sent: Array<{ payload: Row; reaches: (userId: string, workspaceId: string) => boolean }> = [];
  const spy = vi.spyOn(getGatewayHub().connectionManager, 'broadcast').mockImplementation((message: Row, filter?: (ctx: Row) => boolean) => {
    if (message.event?.type !== 'task.changed') return;
    sent.push({
      payload: message.event.payload,
      reaches: (userId, workspaceId) => !!filter?.({ userId, resources: new Set([`space:${workspaceId}`]) }),
    });
  });
  return Object.assign(sent, { restore: () => spy.mockRestore() });
}

async function cost(userId: string, usd: number, opts: { workspaceId?: string | null; funding?: 'own' | 'sponsor' | 'install' } = {}): Promise<void> {
  await q(
    `INSERT INTO cost_log (user_id, model_name, input_tokens, output_tokens, total_cost, workspace_id, funding) VALUES ($1, 'm', 1, 1, $2, $3, $4)`,
    [userId, usd, opts.workspaceId ?? null, opts.funding ?? 'own'],
  );
}

describe('the funding table (§9.1)', () => {
  test('fundingFor: every cell', async () => {
    const { fundingFor } = await import('@/core/agent/context');
    const space = { workspaceId: randomUUID(), role: 'editor' as const, scope: null };
    const settings = (mode: 'own' | 'unattended' | 'sponsored', sponsor = true) => ({ mode, sponsorUserId: sponsor ? owner : null, sponsorModels: [] });
    // Outside a space: always own.
    for (const t of ['user', 'room', 'schedule', 'monitor', 'listen', 'remote'] as const) expect(fundingFor(t, null)).toBe('own');
    const cell = (t: 'user' | 'room' | 'listen' | 'remote', mode: 'own' | 'unattended' | 'sponsored', sponsor = true) => {
      try {
        return fundingFor(t, space, settings(mode, sponsor));
      } catch (err) {
        expect((err as { code?: string }).code).toBe('funding_off');
        return 'off';
      }
    };
    expect([cell('user', 'own'), cell('room', 'own'), cell('listen', 'own'), cell('remote', 'own')]).toEqual(['own', 'own', 'off', 'off']);
    expect([cell('user', 'unattended'), cell('room', 'unattended'), cell('listen', 'unattended'), cell('remote', 'unattended')])
      .toEqual(['own', 'own', 'sponsor', 'sponsor']);
    expect([cell('user', 'sponsored'), cell('room', 'sponsored'), cell('listen', 'sponsored'), cell('remote', 'sponsored')])
      .toEqual(['sponsor', 'sponsor', 'sponsor', 'sponsor']);
    // A sponsored cell without a sponsor is off, never somebody else's money.
    expect([cell('user', 'sponsored', false), cell('listen', 'unattended', false)]).toEqual(['off', 'off']);
    // `schedule` and `monitor` have no producer in a space.
    expect(() => fundingFor('schedule', space, settings('sponsored'))).toThrow();
  });

  test('resolveAgentScope reads the space: own, sponsored with the sponsor, listen off without one', async () => {
    const { resolveAgentScope } = await import('@/core/agent/context');
    const unattended = await space({ mode: 'unattended', sponsor: true });
    const s1 = { id: randomUUID() };
    const own = await resolveAgentScope({ session: { id: s1.id, userId: member, workspaceId: unattended }, userId: member, trigger: 'user' });
    expect(own).toMatchObject({ funding: 'own', sponsor: null });

    const sponsored = await space({ mode: 'sponsored', sponsor: true });
    const s2 = { id: randomUUID() };
    const paid = await resolveAgentScope({ session: { id: s2.id, userId: member, workspaceId: sponsored }, userId: member, trigger: 'user' });
    expect(paid).toMatchObject({ funding: 'sponsor', sponsor: { userId: owner, models: [] } });

    const { createRoom } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: owner }, sponsored, { title: 'Ops', visibility: 'space' });
    const listen = await resolveAgentScope({ session: { id: room.id, userId: owner, workspaceId: sponsored, kind: 'room' }, userId: member, trigger: 'listen' });
    expect(listen.funding).toBe('sponsor');

    const ownMode = await space({ mode: 'own' });
    const room2 = await createRoom({ userId: owner }, ownMode, { title: 'Quiet', visibility: 'space' });
    await expect(resolveAgentScope({ session: { id: room2.id, userId: owner, workspaceId: ownMode, kind: 'room' }, userId: member, trigger: 'listen' }))
      .rejects.toMatchObject({ code: 'funding_off' });
  });
});

describe('funding settings (§9.1)', () => {
  test('owners only; a sponsor names themselves; only the sponsor picks sponsor models, their own', async () => {
    const id = await space();
    expect((await call('editor', 'PUT', `/api/spaces/${id}/funding`, { mode: 'sponsored' })).status).toBe(403);
    expect((await call('outsider', 'PUT', `/api/spaces/${id}/funding`, { mode: 'sponsored' })).status).toBe(404);
    const set = await call('owner', 'PUT', `/api/spaces/${id}/funding`, { mode: 'sponsored', sponsor: 'me', sponsorModels: [OWNER_MODEL] });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ mode: 'sponsored', sponsorUserId: owner, sponsorModels: [OWNER_MODEL] });
    // Someone else's model is refused.
    expect((await call('owner', 'PUT', `/api/spaces/${id}/funding`, { sponsorModels: [EDITOR_MODEL] })).status).toBe(400);
    const got = await call('member', 'GET', `/api/spaces/${id}`);
    expect(got.body).toMatchObject({ funding: 'sponsored', sponsorUserId: owner, sponsorModels: [OWNER_MODEL] });
    const [audit] = await q(`SELECT details FROM audit_log WHERE workspace_id = $1 AND action = 'space_updated' AND details->>'field' = 'funding'`, [id]);
    expect(audit.details.changes.sponsor).toEqual({ previousValue: null, newValue: owner });
  });

  test('sponsored resolution: the sponsor models, never the requester\'s own rows', async () => {
    const { resolveModel } = await import('@/models/resolve-model');
    const sponsor = { userId: owner, models: [OWNER_MODEL] };
    expect((await resolveModel({ userId: editor, topic: 'build' }))?.name).toBe(EDITOR_MODEL);
    expect((await resolveModel({ userId: editor, topic: 'build', sponsor }))?.name).toBe(OWNER_MODEL);
    expect((await resolveModel({ userId: editor, topic: 'build', sponsor: { userId: owner, models: [] } }))?.name).toBe('install-main');
    expect(await resolveModel({ userId: editor, name: EDITOR_MODEL, sponsor })).toBeNull();
    expect((await resolveModel({ userId: editor, name: OWNER_MODEL, sponsor }))?.name).toBe(OWNER_MODEL);
    expect(await resolveModel({ userId: editor, name: OWNER_MODEL })).toBeNull();
  });
});

describe('sponsor removal (§9.1)', () => {
  async function sponsoredSpace(): Promise<string> {
    const id = await space();
    const { setRole } = await import('./service');
    await setRole({ userId: owner }, id, editor, { role: 'owner' });
    const { setSpaceFunding } = await import('./funding');
    await setSpaceFunding({ userId: editor }, id, { mode: 'sponsored', sponsor: 'me' });
    return id;
  }

  async function sponsorOf(id: string): Promise<Row> {
    const [row] = await q(`SELECT sponsor_user_id, sponsor_models FROM workspaces WHERE id = $1`, [id]);
    return row;
  }

  test('a downgrade, a removal and leaving clear the sponsor, audit it and stop sponsored agents', async () => {
    const { getAgentManager } = await import('@/core/agent-manager');
    const stop = vi.spyOn(getAgentManager(), 'stopWorkspace');
    const { leaveSpace, removeMember, setRole } = await import('./service');

    const a = await sponsoredSpace();
    expect((await sponsorOf(a)).sponsor_user_id).toBe(editor);
    await setRole({ userId: owner }, a, editor, { role: 'editor' });
    expect(await sponsorOf(a)).toEqual({ sponsor_user_id: null, sponsor_models: [] });
    expect(stop).toHaveBeenCalledWith(a, undefined, { funding: 'sponsor' });
    const [audit] = await q(`SELECT details FROM audit_log WHERE workspace_id = $1 AND details->>'reason' = 'sponsor_downgraded'`, [a]);
    expect(audit.details.changes.sponsor.previousValue).toBe(editor);

    const b = await sponsoredSpace();
    await removeMember({ userId: owner }, b, editor);
    expect((await sponsorOf(b)).sponsor_user_id).toBeNull();
    expect(await q(`SELECT 1 FROM audit_log WHERE workspace_id = $1 AND details->>'reason' = 'sponsor_removed'`, [b])).toHaveLength(1);

    const c = await sponsoredSpace();
    await leaveSpace({ userId: editor }, c);
    expect((await sponsorOf(c)).sponsor_user_id).toBeNull();

    // Another member's change leaves the sponsor alone.
    const d = await sponsoredSpace();
    await removeMember({ userId: owner }, d, member);
    expect((await sponsorOf(d)).sponsor_user_id).toBe(editor);
    stop.mockRestore();
  });

  test('with the sponsor gone, sponsored work no longer starts', async () => {
    const id = await sponsoredSpace();
    const { setRole } = await import('./service');
    await setRole({ userId: owner }, id, editor, { role: 'editor' });
    const { resolveAgentScope } = await import('@/core/agent/context');
    const s = { id: randomUUID() };
    await expect(resolveAgentScope({ session: { id: s.id, userId: member, workspaceId: id }, userId: member, trigger: 'user' }))
      .rejects.toMatchObject({ code: 'funding_off' });
  });
});

describe('space budgets (§9.2)', () => {
  test('owners write them; members read them, the member cap with their own share', async () => {
    const id = await space({ mode: 'sponsored', sponsor: true });
    expect((await call('editor', 'PUT', `/api/spaces/${id}/budget`, { kind: 'space', period: 'day', limitUsd: 10 })).status).toBe(403);
    expect((await call('owner', 'PUT', `/api/spaces/${id}/budget`, { kind: 'space', period: 'day', limitUsd: -1 })).status).toBe(400);
    expect((await call('owner', 'PUT', `/api/spaces/${id}/budget`, { kind: 'space', period: 'day', limitUsd: 10 })).status).toBe(200);
    const set = await call('owner', 'PUT', `/api/spaces/${id}/budget`, { kind: 'space_member', period: 'day', limitUsd: 2 });
    expect(set.body.budgets.map((b: Row) => b.scopeKind)).toEqual(['space', 'space_member']);
    await cost(member, 1.5, { workspaceId: id, funding: 'sponsor' });
    // Spend sums are cached for 30s (the PUT above read them): start fresh.
    const { _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    _resetSpendBudgetsForTests();
    const mine = await call('member', 'GET', `/api/spaces/${id}/budget`);
    expect(mine.body.budgets.find((b: Row) => b.scopeKind === 'space_member').spentUsd).toBeCloseTo(1.5);
    const theirs = await call('editor', 'GET', `/api/spaces/${id}/budget`);
    expect(theirs.body.budgets.find((b: Row) => b.scopeKind === 'space_member').spentUsd).toBe(0);
    expect(theirs.body.budgets.find((b: Row) => b.scopeKind === 'space').spentUsd).toBeCloseTo(1.5);
    expect((await call('outsider', 'GET', `/api/spaces/${id}/budget`)).status).toBe(404);
    // Space budgets never show in the admin's personal lists.
    const { listBudgets } = await import('@/security/spend-budgets');
    expect((await listBudgets()).some((b) => b.scopeRef === id)).toBe(false);
    // Removing one.
    const gone = await call('owner', 'PUT', `/api/spaces/${id}/budget`, { kind: 'space', period: 'day', limitUsd: null });
    expect(gone.body.budgets.map((b: Row) => b.scopeKind)).toEqual(['space_member']);
    // Filed under its author (the account deletion is below).
    const [row] = await q(`SELECT user_id FROM spend_budgets WHERE scope_ref = $1`, [id]);
    expect(row.user_id).toBe(owner);
  });

  test('a member at the cap is paused without pausing the others', async () => {
    const id = await space({ mode: 'sponsored', sponsor: true });
    const { checkSpend, setSpaceBudget } = await import('@/security/spend-budgets');
    await setSpaceBudget({ workspaceId: id, authorId: owner, kind: 'space_member', period: 'day', limitUsd: 1 });
    await cost(member, 1.2, { workspaceId: id, funding: 'sponsor' });
    const sponsored = (userId: string) => checkSpend({ userId, funding: 'sponsor', spaceId: id });
    await expect(sponsored(member)).rejects.toMatchObject({ name: 'SpendBudgetExceededError' });
    expect(await sponsored(editor)).toEqual([expect.objectContaining({ state: 'ok' })]);
    // No shared pause on the row; the member's notice is theirs alone.
    const [budget] = await q(`SELECT paused_at FROM spend_budgets WHERE scope_ref = $1 AND scope_kind = 'space_member'`, [id]);
    expect(budget.paused_at).toBeNull();
    expect(await q(`SELECT user_id FROM space_member_notices WHERE workspace_id = $1 AND paused_at IS NOT NULL`, [id])).toEqual([{ user_id: member }]);
    const notices = await q(`SELECT user_id, workspace_id FROM notifications WHERE type = 'spend_budget_paused' AND workspace_id = $1`, [id]);
    expect(notices).toEqual([{ user_id: member, workspace_id: id }]);
    // The member's own (unsponsored) work is not refused.
    expect(await checkSpend({ userId: member, funding: 'own', spaceId: null })).toEqual([]);
  });

  test('the space budget counts only sponsored rows of the space', async () => {
    const id = await space({ mode: 'sponsored', sponsor: true });
    const other = await space({ mode: 'sponsored', sponsor: true });
    const { checkSpend, setSpaceBudget } = await import('@/security/spend-budgets');
    await setSpaceBudget({ workspaceId: id, authorId: owner, kind: 'space', period: 'day', limitUsd: 1 });
    await cost(member, 5, { workspaceId: id, funding: 'own' });
    await cost(member, 5, { workspaceId: id, funding: 'install' });
    await cost(member, 5, { workspaceId: other, funding: 'sponsor' });
    await cost(member, 0.5, { workspaceId: id, funding: 'sponsor' });
    const [status] = await checkSpend({ userId: member, funding: 'sponsor', spaceId: id });
    expect(status.spentUsd).toBeCloseTo(0.5);
    await cost(editor, 0.6, { workspaceId: id, funding: 'sponsor' });
    const { _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    _resetSpendBudgetsForTests();
    await expect(checkSpend({ userId: member, funding: 'sponsor', spaceId: id })).rejects.toMatchObject({ name: 'SpendBudgetExceededError' });
    // The whole space's sponsored work pauses, the sponsor is told.
    await expect(checkSpend({ userId: editor, funding: 'sponsor', spaceId: id })).rejects.toMatchObject({ name: 'SpendBudgetExceededError' });
    expect(await q(`SELECT user_id FROM notifications WHERE type = 'spend_budget_paused' AND workspace_id = $1`, [id])).toEqual([{ user_id: owner }]);
  });

  test('a sponsored turn never moves a personal budget, nor the token quota; install work still counts for its user', async () => {
    const id = await space({ mode: 'sponsored', sponsor: true });
    const { checkSpend, upsertBudget, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    await upsertBudget({ userId: commenter, scopeKind: 'user', period: 'day', limitUsd: 1 });
    await upsertBudget({ userId: commenter, scopeKind: 'workspace', scopeRef: id, period: 'day', limitUsd: 1 });
    await cost(commenter, 50, { workspaceId: id, funding: 'sponsor' });
    const statuses = await checkSpend({ userId: commenter, funding: 'own', spaceId: null, workspaceId: id });
    expect(statuses.map((s) => s.spentUsd)).toEqual([0, 0]);
    await q(`INSERT INTO agents (id, session_id, user_id, role, model, topic, status, workspace_id, funding, billable_tokens, total_tokens)
             VALUES ($1, $2, $3, 'general', 'm', 'build', 'completed', $4, 'sponsor', 900000, 900000)`, [randomUUID(), randomUUID(), commenter, id]);
    const { getQuotaManager } = await import('@/security/quotas');
    expect((await getQuotaManager().getUsage(commenter)).tokensToday).toBe(0);
    // Install background work keeps counting for the user it is attributed to…
    await cost(commenter, 2, { workspaceId: id, funding: 'install' });
    _resetSpendBudgetsForTests();
    await expect(checkSpend({ userId: commenter, funding: 'own', spaceId: null })).rejects.toMatchObject({ name: 'SpendBudgetExceededError' });
  });

  test('install background work is never refused by a used-up space budget', async () => {
    const id = await space({ mode: 'sponsored', sponsor: true });
    const { checkSpend, setSpaceBudget } = await import('@/security/spend-budgets');
    await setSpaceBudget({ workspaceId: id, authorId: owner, kind: 'space', period: 'day', limitUsd: 0.1 });
    await cost(editor, 1, { workspaceId: id, funding: 'sponsor' });
    await expect(checkSpend({ userId: editor, funding: 'sponsor', spaceId: id })).rejects.toMatchObject({ name: 'SpendBudgetExceededError' });
    // An install call made in a sponsored turn is stamped `install` and logged;
    // no space budget stands in its way (only agent spawns and iterations check).
    const { withAgentUsage } = await import('@/core/agent/context');
    const { recordProviderUsage, withInstallUsage } = await import('@/models/providers/instrumented');
    const scope = { workspaceId: id, space: { workspaceId: id, role: 'editor' as const, scope: null }, trigger: 'user' as const, funding: 'sponsor' as const, sponsor: { userId: owner, models: [] } };
    const usage = { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, available: true }, model: 'install-id' };
    await withAgentUsage(editor, scope, async () => {
      await withInstallUsage(() => recordProviderUsage({ model: 'install-id', messages: [], requestType: 'learning-review' }, 'openai', usage));
      // The toolshim's call inside the sponsored turn (agent-worker): `install`.
      await recordProviderUsage({ model: 'install-id', messages: [], requestType: 'toolshim' }, 'openai', usage);
      // The turn's own call: `sponsor`.
      await recordProviderUsage({ model: 'install-id', messages: [], requestType: 'chat' }, 'openai', usage);
    });
    const rows = await q(`SELECT request_type, funding, workspace_id FROM cost_log WHERE user_id = $1 AND workspace_id = $2 AND model_name <> 'm' ORDER BY request_type`, [editor, id]);
    expect(rows).toEqual([
      { request_type: 'chat', funding: 'sponsor', workspace_id: id },
      { request_type: 'learning-review', funding: 'install', workspace_id: id },
      { request_type: 'toolshim', funding: 'install', workspace_id: id },
    ]);
  });
});

describe('team surface (§9.3)', () => {
  test('assigning a space task notifies the assignee once, with the space; the board hears task.changed', async () => {
    const id = await space();
    const published = await captureTaskChanged();
    const created = await call('editor', 'POST', '/api/tasks', { title: 'Ship the release notes', assigneeKind: 'user', assigneeRef: member }, id);
    expect(created.status).toBe(200);
    const taskId = created.body.id;
    await vi.waitFor(async () => {
      expect(await q(`SELECT user_id, workspace_id, metadata->>'taskId' AS task FROM notifications WHERE type = 'task_assigned' AND workspace_id = $1`, [id]))
        .toEqual([{ user_id: member, workspace_id: id, task: taskId }]);
    });
    expect(published.map((p) => p.payload)).toContainEqual({ taskId, workspaceId: id });
    // An edit that keeps the assignee notifies nobody again; assigning oneself notifies nobody.
    expect((await call('editor', 'PATCH', `/api/tasks/${taskId}`, { title: 'Ship the notes' }, id)).status).toBe(200);
    expect((await call('member', 'PATCH', `/api/tasks/${taskId}`, { assigneeKind: 'user', assigneeRef: member }, id)).status).toBe(200);
    await call('member', 'POST', `/api/tasks/${taskId}/comments`, { body: 'on it' }, id);
    await vi.waitFor(() => expect(published.filter((p) => p.payload?.taskId === taskId).length).toBeGreaterThanOrEqual(3));
    expect(await q(`SELECT 1 FROM notifications WHERE type = 'task_assigned' AND workspace_id = $1`, [id])).toHaveLength(1);
    // A non-member is never an assignee.
    expect((await call('editor', 'PATCH', `/api/tasks/${taskId}`, { assigneeKind: 'user', assigneeRef: outsider }, id)).status).toBe(400);
    published.restore();
  });

  test('GET /api/me/work: my open tasks across my spaces and my personal workspace, grouped', async () => {
    const a = await space();
    const b = await space();
    await call('editor', 'POST', '/api/tasks', { title: 'A for member', assigneeKind: 'user', assigneeRef: member }, a);
    await call('editor', 'POST', '/api/tasks', { title: 'B for editor', assigneeKind: 'user', assigneeRef: editor }, b);
    const done = await call('editor', 'POST', '/api/tasks', { title: 'B done', assigneeKind: 'user', assigneeRef: member }, b);
    await call('editor', 'PATCH', `/api/tasks/${done.body.id}`, { status: 'done' }, b);
    await call('member', 'POST', '/api/tasks', { title: 'My own', assigneeKind: 'user', assigneeRef: member });
    await call('member', 'POST', '/api/tasks', { title: 'Unassigned' });
    const work = await call('member', 'GET', '/api/me/work');
    expect(work.status).toBe(200);
    const titles = Object.fromEntries(work.body.groups.map((g: Row) => [g.kind === 'shared' ? g.workspaceId : 'personal', g.tasks.map((t: Row) => t.title)]));
    expect(titles[a]).toEqual(['A for member']);
    expect(titles[b]).toBeUndefined();
    expect(titles.personal).toEqual(['My own']);
    // Another member's work is theirs.
    const theirs = await call('editor', 'GET', '/api/me/work');
    expect(theirs.body.groups.flatMap((g: Row) => g.tasks.map((t: Row) => t.title))).toContain('B for editor');
    expect(theirs.body.groups.flatMap((g: Row) => g.tasks.map((t: Row) => t.title))).not.toContain('A for member');
  });

  test('room modes: the room\'s creator or an owner changes them; members read them', async () => {
    const id = await space({ mode: 'unattended', sponsor: true });
    const { createRoom } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: editor }, id, { title: 'Help', visibility: 'space' });
    expect((await call('member', 'PUT', `/api/spaces/${id}/rooms/${room.id}/mode`, { mode: 'listen' })).status).toBe(403);
    const set = await call('editor', 'PUT', `/api/spaces/${id}/rooms/${room.id}/mode`, { mode: 'listen', quietHoursStart: 22, quietHoursEnd: 7, maxUnpromptedPerDay: 3 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ mode: 'listen', quietHoursStart: 22, quietHoursEnd: 7, maxUnpromptedPerDay: 3, feedback: { up: 0, down: 0 } });
    expect((await call('member', 'GET', `/api/spaces/${id}/rooms/${room.id}/mode`)).body.mode).toBe('listen');
    expect((await call('outsider', 'GET', `/api/spaces/${id}/rooms/${room.id}/mode`)).status).toBe(404);
    expect((await call('editor', 'PUT', `/api/spaces/${id}/rooms/${room.id}/mode`, { timezone: 'Mars/Olympus' })).status).toBe(400);
  });

  test('a listen room: the gate probes, posts an offer, members rate it', async () => {
    const id = await space({ mode: 'unattended', sponsor: true });
    const { createRoom, postRoomMessage } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: owner }, id, { title: 'Help', visibility: 'space' });
    const { setRoomMode, roomListenDeps } = await import('@/core/rooms/listen');
    await setRoomMode({ userId: owner }, id, room.id, { mode: 'listen' });
    const question = await postRoomMessage({ userId: member }, room.id, { content: 'Does anyone know why the staging DB is slow today?' });
    await q(`UPDATE messages SET created_at = now() - interval '20 minutes' WHERE id = $1`, [question.message.id]);
    // A space that pays for nothing unprompted is not probed.
    const quiet = await space({ mode: 'own' });
    const quietRoom = await createRoom({ userId: owner }, quiet, { title: 'Quiet', visibility: 'space' });
    await setRoomMode({ userId: owner }, quiet, quietRoom.id, { mode: 'listen' });

    const { probeGroup, resetListenState } = await import('@/channels/group-listen');
    resetListenState();
    const real = roomListenDeps();
    const targets = await real.listGroups();
    expect(targets.map((t) => t.id)).toContain(room.id);
    expect(targets.map((t) => t.id)).not.toContain(quietRoom.id);
    const target = targets.find((t) => t.id === room.id);
    if (!target) throw new Error('room not listed');
    expect(target.ownerUserId).toBe(owner);

    const complete = vi.fn(async () => 'I could look into why the staging DB is slow.');
    const outcome = await probeGroup(target, { ...real, modelReady: async () => true, complete });
    expect(outcome).toBe('posted');
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: owner, sessionId: room.id }));
    const [post] = await q(`SELECT id, content, metadata FROM messages WHERE session_id = $1 AND role = 'assistant'`, [room.id]);
    expect(post.content).toContain('Mention @octipus');
    expect(post.metadata).toMatchObject({ unprompted: true, replyTo: question.message.id });
    // Never twice in a row: the agent spoke last.
    expect(await probeGroup({ ...target, lastUnpromptedAt: null }, { ...real, modelReady: async () => true, complete })).toBe('no_candidate');

    const rated = await call('member', 'PUT', `/api/spaces/${id}/rooms/${room.id}/messages/${post.id}/feedback`, { value: -1 });
    expect(rated.body.feedback).toEqual({ up: 0, down: 1 });
    expect((await call('member', 'PUT', `/api/spaces/${id}/rooms/${room.id}/messages/${question.message.id}/feedback`, { value: 1 })).status).toBe(400);
  });
});

// ── Review fixes ────────────────────────────────────────────────────

const OWNER_CLI = `u/${owner}/claude-cli`;

async function spaceFundingOf(id: string): Promise<Row> {
  const [row] = await q(`SELECT agent_funding, sponsor_user_id, sponsor_models FROM workspaces WHERE id = $1`, [id]);
  return row;
}

describe('sponsor models and their keys (§9.1)', () => {
  test('a CLI row is never a sponsor model, and never runs or releases its credential for a member', async () => {
    const { getModelRegistry } = await import('@/models/model-registry');
    await getModelRegistry().registerModel({ name: OWNER_CLI, provider: 'cli', modelId: 'cli/claude', ownerUserId: owner });
    const id = await space({ mode: 'sponsored', sponsor: true });
    expect((await call('owner', 'PUT', `/api/spaces/${id}/funding`, { sponsorModels: [OWNER_CLI] })).status).toBe(400);
    expect((await spaceFundingOf(id)).sponsor_models).toEqual([]);

    // Even listed (a row from before this rule): a member's sponsored turn
    // neither resolves it nor gets its credential; the sponsor's own may.
    const { personalRowAllowed, resolveModel } = await import('@/models/resolve-model');
    const row = { name: OWNER_CLI, ownerUserId: owner, provider: 'cli' };
    const sponsor = { userId: owner, models: [OWNER_CLI] };
    expect(personalRowAllowed(row, member, sponsor)).toBe(false);
    expect(personalRowAllowed(row, owner, sponsor)).toBe(true);
    expect(await resolveModel({ userId: member, name: OWNER_CLI, sponsor })).toBeNull();
    const { assertModelRowOwner } = await import('@/models/model-key');
    const { withSponsor } = await import('@/models/providers/instrumented');
    expect(() => withSponsor(sponsor, () => assertModelRowOwner(row, member))).toThrow(/personal model/);
  });

  test('an API sponsor model\'s key: released inside the sponsored turn only, and only for a listed row', async () => {
    const { getModelRegistry } = await import('@/models/model-registry');
    const row = await getModelRegistry().getModel(OWNER_MODEL);
    if (!row) throw new Error('no sponsor row');
    const { resolveModelKey } = await import('@/models/model-key');
    const { withSponsor } = await import('@/models/providers/instrumented');
    await expect(resolveModelKey(row, member)).rejects.toThrow(/personal model/);
    expect(await withSponsor({ userId: owner, models: [OWNER_MODEL] }, () => resolveModelKey(row, member))).toBe('sk-owner');
    await expect(withSponsor({ userId: owner, models: [] }, () => resolveModelKey(row, member))).rejects.toThrow(/personal model/);
    await expect(withSponsor({ userId: editor, models: [OWNER_MODEL] }, () => resolveModelKey(row, member))).rejects.toThrow(/personal model/);
  });
});

describe('who may make the sponsor pay for more (§9.1)', () => {
  test('only the sponsor raises the mode or picks the sponsor models; another owner lowers it or clears the sponsor', async () => {
    const id = await space({ mode: 'unattended', sponsor: true });
    const { setRole } = await import('./service');
    await setRole({ userId: owner }, id, editor, { role: 'owner' });
    // Another owner: not more of the sponsor's money, nor the sponsor's models.
    expect((await call('editor', 'PUT', `/api/spaces/${id}/funding`, { mode: 'sponsored' })).status).toBe(403);
    expect((await call('editor', 'PUT', `/api/spaces/${id}/funding`, { sponsorModels: [EDITOR_MODEL] })).status).toBe(403);
    expect(await spaceFundingOf(id)).toMatchObject({ agent_funding: 'unattended', sponsor_user_id: owner });
    // Less is fine; back up again is the sponsor's to do.
    expect((await call('editor', 'PUT', `/api/spaces/${id}/funding`, { mode: 'own' })).status).toBe(200);
    expect((await call('editor', 'PUT', `/api/spaces/${id}/funding`, { mode: 'unattended' })).status).toBe(403);
    expect((await call('owner', 'PUT', `/api/spaces/${id}/funding`, { mode: 'sponsored' })).status).toBe(200);
    // Naming oneself the sponsor while raising it is one's own consent.
    expect((await call('editor', 'PUT', `/api/spaces/${id}/funding`, { mode: 'own' })).status).toBe(200);
    expect((await call('editor', 'PUT', `/api/spaces/${id}/funding`, { mode: 'sponsored', sponsor: 'me' })).status).toBe(200);
    expect(await spaceFundingOf(id)).toMatchObject({ agent_funding: 'sponsored', sponsor_user_id: editor });
    // An admin acting as an owner gives no consent for them.
    const { setSpaceFunding } = await import('./funding');
    await expect(setSpaceFunding({ userId: owner, impersonatedBy: outsider }, id, { sponsor: 'me' })).rejects.toMatchObject({ code: 'forbidden_role' });
    await setSpaceFunding({ userId: editor }, id, { mode: 'own' });
    await expect(setSpaceFunding({ userId: editor, impersonatedBy: outsider }, id, { mode: 'unattended' })).rejects.toMatchObject({ code: 'forbidden_role' });
  });
});

describe('sponsored work re-reads its funding (§9.1)', () => {
  async function editorSponsored(): Promise<string> {
    const id = await space();
    const { setRole } = await import('./service');
    await setRole({ userId: owner }, id, editor, { role: 'owner' });
    const { setSpaceFunding } = await import('./funding');
    await setSpaceFunding({ userId: editor }, id, { mode: 'sponsored', sponsor: 'me' });
    return id;
  }

  test('a turn scoped before the sponsor left does not spawn; a new sponsor is not the one it started under', async () => {
    const id = await editorSponsored();
    const { recheckSponsor, resolveAgentScope } = await import('@/core/agent/context');
    const scope = await resolveAgentScope({ session: { id: randomUUID(), userId: member, workspaceId: id }, userId: member, trigger: 'user' });
    expect(await recheckSponsor(scope)).toEqual({ userId: editor, models: [] });
    const { setRole } = await import('./service');
    await setRole({ userId: owner }, id, editor, { role: 'editor' });
    await expect(recheckSponsor(scope)).rejects.toMatchObject({ code: 'funding_off' });
    const { getAgentManager } = await import('@/core/agent-manager');
    await expect(getAgentManager().spawn({
      sessionId: randomUUID(), userId: member, workspaceId: id, space: scope.space, trigger: 'user', funding: 'sponsor', sponsor: scope.sponsor,
      model: 'install-id', modelName: 'install-main', topic: 'build',
    })).rejects.toMatchObject({ code: 'funding_off' });
    const { setSpaceFunding } = await import('./funding');
    await setSpaceFunding({ userId: owner }, id, { sponsor: 'me' });
    await expect(recheckSponsor(scope)).rejects.toMatchObject({ code: 'funding_off' });
  });

  test('deleting the sponsor\'s account clears the sponsor, audits it, stops sponsored work; their space budget outlives them', async () => {
    const leaver = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: leaver, username: `leaver-${leaver.slice(0, 6)}` }]);
    const { spaceWith } = await import('@/test-helpers/space-fixtures');
    const id = await spaceWith(owner, [[leaver, 'editor'], [member, 'editor']]);
    const { setRole } = await import('./service');
    await setRole({ userId: owner }, id, leaver, { role: 'owner' });
    const { setSpaceFunding } = await import('./funding');
    await setSpaceFunding({ userId: leaver }, id, { mode: 'sponsored', sponsor: 'me' });
    const { setSpaceBudget, upsertBudget, checkSpend } = await import('@/security/spend-budgets');
    await setSpaceBudget({ workspaceId: id, authorId: leaver, kind: 'space', period: 'day', limitUsd: 0.5 });
    await upsertBudget({ userId: leaver, scopeKind: 'user', period: 'day', limitUsd: 3 });

    const { getAgentManager } = await import('@/core/agent-manager');
    const stop = vi.spyOn(getAgentManager(), 'stopWorkspace');
    const { userRepository } = await import('@/db/repositories/user-repository');
    expect(await userRepository.delete(leaver)).toBe(true);
    expect(await spaceFundingOf(id)).toMatchObject({ sponsor_user_id: null, sponsor_models: [] });
    expect(stop).toHaveBeenCalledWith(id, undefined, { funding: 'sponsor' });
    stop.mockRestore();
    const [audit] = await q(`SELECT details FROM audit_log WHERE workspace_id = $1 AND details->>'reason' = 'sponsor_account_deleted'`, [id]);
    expect(audit.details.changes.sponsor).toEqual({ previousValue: leaver, newValue: null });
    // The space budget survives (author SET NULL); the personal one went with the account.
    expect(await q(`SELECT user_id FROM spend_budgets WHERE scope_ref = $1`, [id])).toEqual([{ user_id: null }]);
    expect(await q(`SELECT 1 FROM spend_budgets WHERE user_id = $1`, [leaver])).toEqual([]);
    // Used up with neither a sponsor nor an author, it still pauses — and tells nobody.
    await cost(member, 1, { workspaceId: id, funding: 'sponsor' });
    await expect(checkSpend({ userId: member, funding: 'sponsor', spaceId: id })).rejects.toMatchObject({ name: 'SpendBudgetExceededError' });
    expect(await q(`SELECT 1 FROM notifications WHERE workspace_id = $1 AND type = 'spend_budget_paused'`, [id])).toEqual([]);
  });

  test('a budget\'s author who left the space is not told its spend', async () => {
    const id = await space();
    const { setRole, leaveSpace } = await import('./service');
    await setRole({ userId: owner }, id, editor, { role: 'owner' });
    const { setSpaceBudget, checkSpend } = await import('@/security/spend-budgets');
    await setSpaceBudget({ workspaceId: id, authorId: editor, kind: 'space', period: 'day', limitUsd: 0.5 });
    await leaveSpace({ userId: editor }, id);
    await cost(member, 1, { workspaceId: id, funding: 'sponsor' });
    await expect(checkSpend({ userId: member, funding: 'sponsor', spaceId: id })).rejects.toMatchObject({ name: 'SpendBudgetExceededError' });
    expect(await q(`SELECT 1 FROM notifications WHERE workspace_id = $1 AND type = 'spend_budget_paused'`, [id])).toEqual([]);
  });
});

describe('budget writes (§9.2)', () => {
  test('the same values again change nothing; a change is audited with the previous value', async () => {
    const id = await space({ mode: 'sponsored', sponsor: true });
    const put = (limitUsd: number) => call('owner', 'PUT', `/api/spaces/${id}/budget`, { kind: 'space', period: 'day', limitUsd });
    expect((await put(5)).status).toBe(200);
    await q(`UPDATE spend_budgets SET warned_at = now() WHERE scope_ref = $1`, [id]);
    expect((await put(5)).status).toBe(200);
    // The warning already sent this period stays sent.
    expect((await q(`SELECT warned_at FROM spend_budgets WHERE scope_ref = $1`, [id]))[0].warned_at).not.toBeNull();
    expect((await put(8)).status).toBe(200);
    expect((await q(`SELECT warned_at FROM spend_budgets WHERE scope_ref = $1`, [id]))[0].warned_at).toBeNull();
    const audits = await q(`SELECT details FROM audit_log WHERE workspace_id = $1 AND details->>'field' = 'budget' ORDER BY created_at`, [id]);
    expect(audits.map((a: Row) => [a.details.previousValue, a.details.newValue])).toEqual([[null, 5], [5, 8]]);
  });
});

describe('every spend check passes the funding and the space (D13)', () => {
  async function usedUp(): Promise<{ id: string; scope: Row }> {
    const id = await space({ mode: 'sponsored', sponsor: true });
    const { setSpaceBudget } = await import('@/security/spend-budgets');
    await setSpaceBudget({ workspaceId: id, authorId: owner, kind: 'space', period: 'day', limitUsd: 0.1 });
    await cost(editor, 1, { workspaceId: id, funding: 'sponsor' });
    const { resolveAgentScope } = await import('@/core/agent/context');
    const scope = await resolveAgentScope({ session: { id: randomUUID(), userId: member, workspaceId: id }, userId: member, trigger: 'user' });
    return { id, scope };
  }

  test('agent-manager spawn', async () => {
    const { id, scope } = await usedUp();
    const { getAgentManager } = await import('@/core/agent-manager');
    await expect(getAgentManager().spawn({
      sessionId: randomUUID(), userId: member, workspaceId: id, space: scope.space, trigger: 'user', funding: 'sponsor', sponsor: scope.sponsor,
      model: 'install-id', modelName: 'install-main', topic: 'build',
    })).rejects.toMatchObject({ name: 'SpendBudgetExceededError' });
  });

  test('agent-worker, before each model call; cli-agent-worker, before the CLI starts', async () => {
    const { scope } = await usedUp();
    const { buildAgentContext } = await import('@/core/agent/context');
    const ctx = buildAgentContext({ sessionId: randomUUID(), userId: member, scope, topic: 'build', model: 'install-id', modelName: 'install-main', role: 'general' });
    const { AgentWorker } = await import('@/core/agent-worker');
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const llm = vi.spyOn(getLiteLLMClient(), 'complete');
    await expect(new AgentWorker(ctx, { maxIterations: 2, maxTokenBudget: 1_000_000, contextWindowSize: 200_000, timeout: 30_000 } as never).run('hello'))
      .rejects.toMatchObject({ name: 'SpendBudgetExceededError' });
    expect(llm).not.toHaveBeenCalled();
    llm.mockRestore();
    const cliCtx = buildAgentContext({ sessionId: randomUUID(), userId: member, scope, topic: 'build', model: 'cli/claude', role: 'general' });
    const { CLIAgentWorker } = await import('@/core/cli-agent-worker');
    const cli = new CLIAgentWorker(cliCtx, { maxIterations: 1, timeout: 1000 } as never) as unknown as { executeCLI(): Promise<string> };
    await expect(cli.executeCLI()).rejects.toMatchObject({ name: 'SpendBudgetExceededError' });
  });
});

describe('unprompted room work (§9.3)', () => {
  async function proactiveRoom(): Promise<{ id: string; roomId: string; ask: (who: string, text: string) => Promise<string> }> {
    const { spaceWith } = await import('@/test-helpers/space-fixtures');
    const id = await spaceWith(owner, [[member, 'editor'], [viewer, 'viewer']]);
    const { setSpaceFunding } = await import('./funding');
    await setSpaceFunding({ userId: owner }, id, { mode: 'unattended', sponsor: 'me' });
    const { createRoom, postRoomMessage } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: owner }, id, { title: 'Desk', visibility: 'space' });
    const { setRoomMode } = await import('@/core/rooms/listen');
    await setRoomMode({ userId: owner }, id, room.id, { mode: 'proactive', minMinutesBetween: 0 });
    const ask = async (who: string, text: string): Promise<string> => {
      // A viewer may not post through the service; their row is written directly.
      const messageId = who === viewer
        ? (await q(`INSERT INTO messages (session_id, role, content, author_user_id) VALUES ($1, 'user', $2, $3) RETURNING id`, [room.id, text, who]))[0].id
        : (await postRoomMessage({ userId: who }, room.id, { content: text })).message.id;
      await q(`UPDATE messages SET created_at = now() - interval '20 minutes' WHERE id = $1`, [messageId]);
      return messageId;
    };
    return { id, roomId: room.id, ask };
  }

  test('a proactive probe: install work of the space, claimed once across processes, then the listen turn as the author', async () => {
    const { id, roomId, ask } = await proactiveRoom();
    const question = await ask(member, 'Does anyone know why the nightly build failed?');
    const { probeGroup, resetListenState } = await import('@/channels/group-listen');
    const { roomListenDeps } = await import('@/core/rooms/listen');
    resetListenState();
    const real = roomListenDeps();
    const target = (await real.listGroups()).find((t) => t.id === roomId);
    if (!target) throw new Error('room not listed');

    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const { recordProviderUsage, SYSTEM_USAGE_USER } = await import('@/models/providers/instrumented');
    const llm = vi.spyOn(getLiteLLMClient(), 'complete').mockImplementation(async (options) => {
      const usage = { inputTokens: 5, outputTokens: 1, totalTokens: 6, available: true };
      await recordProviderUsage({ ...options, messages: [] }, 'test', { model: 'install-id', usage });
      return { content: 'yes', model: 'install-id', usage, finishReason: 'stop' } as never;
    });
    const { getAgentService } = await import('@/core/agent');
    const listen = vi.spyOn(getAgentService(), 'handleRoomListen').mockResolvedValue({ kind: 'queued', position: 0 });
    try {
      expect(await probeGroup(target, { ...real, modelReady: async () => true })).toBe('posted');
      expect(listen).toHaveBeenCalledWith(roomId, member, question);
      // Attributed to the space and to nobody: no personal budget, no member cap.
      expect(await q(`SELECT user_id, funding, workspace_id, session_id FROM cost_log WHERE session_id = $1`, [roomId]))
        .toEqual([{ user_id: SYSTEM_USAGE_USER, funding: 'install', workspace_id: id, session_id: roomId }]);
      // Another process (its own throttles empty) does not pay for it again.
      resetListenState();
      expect(await probeGroup({ ...target, lastUnpromptedAt: null }, { ...real, modelReady: async () => true })).toBe('throttled');
      expect(llm).toHaveBeenCalledTimes(1);
    } finally {
      llm.mockRestore();
      listen.mockRestore();
    }
  });

  test('a viewer\'s question is not probed (their turn could not run), nor while the space budget is used up', async () => {
    const { id, roomId, ask } = await proactiveRoom();
    await ask(viewer, 'Could someone tell me where the release checklist lives?');
    const { probeGroup, resetListenState } = await import('@/channels/group-listen');
    const { roomListenDeps } = await import('@/core/rooms/listen');
    resetListenState();
    const real = roomListenDeps();
    const target = (await real.listGroups()).find((t) => t.id === roomId);
    if (!target) throw new Error('room not listed');
    const complete = vi.fn(async () => 'yes');
    expect(await probeGroup(target, { ...real, modelReady: async () => true, complete })).toBe('budget');
    expect(complete).not.toHaveBeenCalled();

    await ask(member, 'And does anyone know who owns the staging database?');
    const { setSpaceBudget, _resetSpendBudgetsForTests } = await import('@/security/spend-budgets');
    await setSpaceBudget({ workspaceId: id, authorId: owner, kind: 'space', period: 'day', limitUsd: 0.1 });
    await cost(member, 1, { workspaceId: id, funding: 'sponsor' });
    _resetSpendBudgetsForTests();
    resetListenState();
    expect(await probeGroup(target, { ...real, modelReady: async () => true, complete })).toBe('budget');
    expect(complete).not.toHaveBeenCalled();
  });

  test('a listen turn only reads: its writing tools are withheld and its writes refused', async () => {
    const { id, roomId } = await proactiveRoom();
    const { writesWithheld } = await import('@/core/agent/context');
    const editorSpace = { workspaceId: id, role: 'editor' as const, scope: null };
    expect(writesWithheld(editorSpace, 'room')).toBe(false);
    expect(writesWithheld(editorSpace, 'listen')).toBe(true);
    const { routeApprovalFor } = await import('@/security/approval-route');
    const caller = { userId: member, sessionId: roomId, workspaceId: id, space: editorSpace, attended: true, root: true };
    const write = { toolId: 'notes', action: 'write', toolName: 'create_note' };
    const read = { toolId: 'notes', action: 'read', toolName: 'read_note' };
    expect((await routeApprovalFor({ ...caller, trigger: 'room' }, write, { level: 'ALLOW' })).route).toBe('execute');
    expect((await routeApprovalFor({ ...caller, trigger: 'listen' }, write, { level: 'ALLOW' })).route).toBe('deny');
    expect((await routeApprovalFor({ ...caller, trigger: 'listen' }, read, { level: 'ALLOW' })).route).toBe('execute');
  });

  test('members\' 👎 slow the gate down; 👍 bring it back', async () => {
    const { feedbackSlowdown, probeGroup, resetListenState } = await import('@/channels/group-listen');
    expect(feedbackSlowdown({ up: 0, down: 0 })).toBe(1);
    expect(feedbackSlowdown({ up: 2, down: 1 })).toBe(1);
    expect(feedbackSlowdown({ up: 1, down: 3 })).toBe(4);
    expect(feedbackSlowdown({ up: 0, down: 30 })).toBe(16);
    const { roomListenDeps } = await import('@/core/rooms/listen');
    const { id, roomId, ask } = await proactiveRoom();
    const real = roomListenDeps();
    const target = (await real.listGroups()).find((t) => t.id === roomId);
    if (!target) throw new Error('room not listed');
    // An earlier unprompted post, rated 👎 twice: with the configured gap of 0
    // the gate would probe 3 hours later; two net 👎 make the gap 4 hours.
    const [post] = await q(`INSERT INTO messages (session_id, role, content, metadata) VALUES ($1, 'assistant', 'An earlier offer', '{"unprompted": true}') RETURNING id`, [roomId]);
    await q(`UPDATE messages SET created_at = now() - interval '4 hours' WHERE id = $1`, [post.id]);
    await ask(member, 'Does anyone remember the VPN settings for the lab?');
    const rate = (who: string, value: 1 | -1) => call(who, 'PUT', `/api/spaces/${id}/rooms/${roomId}/messages/${post.id}/feedback`, { value });
    expect((await rate('member', -1)).status).toBe(200);
    expect((await rate('viewer', -1)).status).toBe(200);
    const recent = { ...target, lastUnpromptedAt: new Date(Date.now() - 3 * 60 * 60_000) };
    const complete = vi.fn(async () => 'none');
    const deps = { ...real, modelReady: async () => true, complete };
    resetListenState();
    expect(await probeGroup(recent, deps)).toBe('capped');
    expect(complete).not.toHaveBeenCalled();
    await rate('member', 1);
    await rate('owner', 1);
    resetListenState();
    expect(await probeGroup(recent, deps)).toBe('none');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('task.changed and My work (§9.3)', () => {
  test('task.changed reaches non-guest members only: not a guest, not a removed member, not an outsider', async () => {
    const { spaceWith } = await import('@/test-helpers/space-fixtures');
    const id = await spaceWith(owner, [[member, 'editor'], [editor, 'editor'], [guest, 'guest']]);
    const published = await captureTaskChanged();
    try {
      const created = await call('owner', 'POST', '/api/tasks', { title: 'Rotate the keys' }, id);
      expect(created.status).toBe(200);
      await vi.waitFor(() => expect(published.some((p) => p.payload.taskId === created.body.id)).toBe(true));
      const first = published.find((p) => p.payload.taskId === created.body.id);
      expect([owner, member, editor, guest, outsider].map((u) => first?.reaches(u, id))).toEqual([true, true, true, false, false]);
      const { removeMember } = await import('./service');
      await removeMember({ userId: owner }, id, editor);
      const before = published.length;
      await call('owner', 'PATCH', `/api/tasks/${created.body.id}`, { title: 'Rotate the API keys' }, id);
      await vi.waitFor(() => expect(published.length).toBeGreaterThan(before));
      expect(published.at(-1)?.reaches(editor, id)).toBe(false);
      expect(published.at(-1)?.reaches(member, id)).toBe(true);
    } finally {
      published.restore();
    }
  });

  test('My work leaves out a space the user left and an archived space', async () => {
    const left = await space();
    const archived = await space();
    await call('editor', 'POST', '/api/tasks', { title: 'In the left space', assigneeKind: 'user', assigneeRef: commenter }, left);
    await call('editor', 'POST', '/api/tasks', { title: 'In the archived space', assigneeKind: 'user', assigneeRef: commenter }, archived);
    const titles = async (): Promise<string[]> => (await call('commenter', 'GET', '/api/me/work')).body.groups.flatMap((g: Row) => g.tasks.map((t: Row) => t.title));
    expect(await titles()).toEqual(expect.arrayContaining(['In the left space', 'In the archived space']));
    const { archiveSpace, leaveSpace } = await import('./service');
    await leaveSpace({ userId: commenter }, left);
    await archiveSpace({ userId: owner }, archived);
    const now = await titles();
    expect(now).not.toContain('In the left space');
    expect(now).not.toContain('In the archived space');
  });
});
