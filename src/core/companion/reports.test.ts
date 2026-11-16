import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { COMPANION_REPORT_DAILY_CAP, decideCompanionReport, quietHoursEnd } from './reports';

process.env.STORAGE_MODE = 'embedded';
const dir = mkdtempSync(join(tmpdir(), 'octipus-companion-reports-'));
process.env.DATA_DIR = dir;
process.env.LOG_LEVEL = 'error';
const publish = vi.hoisted(() => vi.fn());
const approval = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/core/agent/service', () => ({ getAgentService: () => ({ publishResponse: publish, requestApproval: approval.request }) }));

describe('decideCompanionReport', () => {
  const base = { impact: 'normal' as const, evidence: 'strong' as const, materialChange: 'none' as const, textHash: 'a' };
  test('only strong, non-low reports interrupt the owner', () => {
    expect(decideCompanionReport(base, undefined, 0).deliver).toBe(true);
    expect(decideCompanionReport({ ...base, evidence: 'uncertain' }, undefined, 0).deliver).toBe(false);
    expect(decideCompanionReport({ ...base, impact: 'low' }, undefined, 0).deliver).toBe(false);
  });
  test('a reported matter needs a material change, never repetition', () => {
    const previous = { deadline: new Date('2026-12-01T00:00:00Z'), textHash: 'old' };
    expect(decideCompanionReport({ ...base, textHash: 'new' }, previous, 0).deliver).toBe(false);
    expect(decideCompanionReport({ ...base, materialChange: 'condition_changed', textHash: 'old' }, previous, 0).deliver).toBe(false);
    expect(decideCompanionReport({ ...base, materialChange: 'condition_changed', textHash: 'new' }, previous, 0).deliver).toBe(true);
    expect(decideCompanionReport({ ...base, materialChange: 'deadline_advanced', deadline: new Date('2026-12-05T00:00:00Z'), textHash: 'new' }, previous, 0).deliver).toBe(false);
    expect(decideCompanionReport({ ...base, materialChange: 'deadline_advanced', deadline: new Date('2026-11-25T00:00:00Z'), textHash: 'new' }, previous, 0).deliver).toBe(true);
  });
  test('the daily cap holds back all but high impact', () => {
    expect(decideCompanionReport(base, undefined, COMPANION_REPORT_DAILY_CAP).deliver).toBe(false);
    expect(decideCompanionReport({ ...base, impact: 'high' }, undefined, COMPANION_REPORT_DAILY_CAP).deliver).toBe(true);
  });
});

describe('quietHoursEnd', () => {
  test('finds the end of overnight quiet hours in the owner\'s timezone', () => {
    const settings = { quietHoursStart: 22, quietHoursEnd: 7, timezone: 'UTC' };
    expect(quietHoursEnd(settings, new Date('2026-11-16T12:00:00Z'))).toBeNull();
    expect(quietHoursEnd(settings, new Date('2026-11-16T23:30:00Z'))?.toISOString()).toBe('2026-11-17T07:00:00.000Z');
    expect(quietHoursEnd({ ...settings, timezone: 'Europe/Paris' }, new Date('2026-11-16T22:30:00Z'))?.toISOString()).toBe('2026-11-17T06:00:00.000Z');
    expect(quietHoursEnd({ ...settings, quietHoursEnd: 22 }, new Date('2026-11-16T23:30:00Z'))).toBeNull();
  });
});

describe('fileCompanionReport', () => {
  const owner = randomUUID();
  let workspaceId: string, supervisor: string;
  beforeAll(async () => {
    const { initializeDb, getDb } = await import('@/db/postgres');
    await initializeDb();
    await (await import('@/db/migrate')).runMigrations();
    await (await import('@/test-helpers/multiuser-fixtures')).seedUsers([{ id: owner, username: 'reports-owner' }]);
    workspaceId = (await (await import('@/security/orgs')).getOrgWorkspaceManager().ensureDefaultWorkspace(owner)).id;
    const { sessions } = await import('@/db/schema/sessions');
    supervisor = (await getDb().insert(sessions).values({ userId: owner, workspaceId, channelType: 'webchat', channelId: randomUUID(), title: 'Companion',
      context: { companionSupervisor: { modelName: 'fixture' } } }).returning())[0].id;
    // No quiet hours unless a test sets them: delivery must not depend on the wall clock.
    const { CompanionSupervisionRepository } = await import('@/db/repositories/companion-supervision-repository');
    await new CompanionSupervisionRepository({ userId: owner, workspaceId }).saveSettings({ quietHoursStart: 0, quietHoursEnd: 0 }, 0);
  }, 120000);
  afterAll(async () => { await (await import('@/db/postgres')).closeDb(); rmSync(dir, { recursive: true, force: true }); });

  test('delivers a new matter once as a visible message, then records repeats', async () => {
    const { fileCompanionReport } = await import('./reports');
    const { getDb } = await import('@/db/postgres');
    const { messages } = await import('@/db/schema/messages');
    const { eq } = await import('drizzle-orm');
    const scope = { userId: owner, workspaceId };
    const report = { matter: 'Deploy blocked', impact: 'high', evidence: 'strong', message: 'The deploy is blocked: the server rejects the new key. Should I roll back?' };
    expect(await fileCompanionReport(scope, supervisor, report)).toMatchObject({ delivered: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await fileCompanionReport(scope, supervisor, { ...report, message: 'Still blocked: the server rejects the new key.' })).toMatchObject({ delivered: false, reason: expect.stringContaining('nothing material') });
    expect(await fileCompanionReport(scope, supervisor, { ...report, matter: 'deploy  BLOCKED', materialChange: 'condition_changed', message: 'The deploy now fails at a different step: migrations time out.' })).toMatchObject({ delivered: true });
    expect(await fileCompanionReport(scope, supervisor, { ...report, matter: 'tests', evidence: 'uncertain', message: 'Tests might be flaky.' })).toMatchObject({ delivered: false });
    const visible = await getDb().select().from(messages).where(eq(messages.sessionId, supervisor));
    expect(visible.map(row => row.content)).toEqual(['The deploy is blocked: the server rejects the new key. Should I roll back?', 'The deploy now fails at a different step: migrations time out.']);
    expect(visible.every(row => row.role === 'assistant' && row.metadata?.visibility !== 'internal' && row.metadata?.companionReport)).toBe(true);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  test('a report whose message was not posted stays recorded and does not block the next one', async () => {
    const { fileCompanionReport } = await import('./reports');
    const { messageRepository } = await import('@/db/repositories/message-repository');
    const scope = { userId: owner, workspaceId };
    const report = { matter: 'review ready', impact: 'normal', evidence: 'strong', message: 'The review is ready for you.' };
    const spy = vi.spyOn(messageRepository, 'createForGeneration').mockResolvedValueOnce(null);
    expect(await fileCompanionReport(scope, supervisor, report)).toMatchObject({ delivered: false, reason: expect.stringContaining('cleared') });
    spy.mockRestore();
    expect(await fileCompanionReport(scope, supervisor, report)).toMatchObject({ delivered: true });
  });

  test('matters in any script keep distinct keys', async () => {
    const { fileCompanionReport } = await import('./reports');
    const scope = { userId: owner, workspaceId };
    expect(await fileCompanionReport(scope, supervisor, { matter: 'デプロイ失敗', impact: 'normal', evidence: 'strong', message: 'デプロイが失敗しました。' })).toMatchObject({ delivered: true });
    expect(await fileCompanionReport(scope, supervisor, { matter: 'レビュー準備完了', impact: 'normal', evidence: 'strong', message: 'レビューの準備ができました。' })).toMatchObject({ delivered: true });
  });

  test('quiet hours hold reports until they end, except high impact with an earlier deadline', async () => {
    const { fileCompanionReport, deliverDeferredCompanionReports } = await import('./reports');
    const { CompanionSupervisionRepository } = await import('@/db/repositories/companion-supervision-repository');
    const repo = new CompanionSupervisionRepository({ userId: owner, workspaceId });
    const { settingsId: _id, supervisorSessionId: _sid, revision, ...current } = await repo.readSettings();
    await repo.saveSettings({ ...current, quietHoursStart: 22, quietHoursEnd: 7, timezone: 'UTC' }, revision);
    const night = new Date(); night.setUTCHours(23, 30, 0, 0);
    const scope = { userId: owner, workspaceId };
    publish.mockClear();
    const held = await fileCompanionReport(scope, supervisor, { matter: 'nightly build', impact: 'normal', evidence: 'strong', message: 'The nightly build is green again.' }, night);
    expect(held).toMatchObject({ delivered: false, reason: expect.stringContaining('quiet hours') });
    const deadline = new Date(night.getTime() + 2 * 3600_000).toISOString();
    expect(await fileCompanionReport(scope, supervisor, { matter: 'cert expiry', impact: 'high', evidence: 'strong', deadline, message: 'The TLS certificate expires in two hours.' }, night)).toMatchObject({ delivered: true });
    await deliverDeferredCompanionReports(new Date(night.getTime() + 3600_000));
    expect(publish).toHaveBeenCalledTimes(1);
    const morning = new Date(night.getTime() + 8 * 3600_000);
    await deliverDeferredCompanionReports(morning);
    expect(publish).toHaveBeenCalledTimes(2);
    const { getDb } = await import('@/db/postgres');
    const { companionReports } = await import('@/db/schema/companion-supervision');
    const { eq } = await import('drizzle-orm');
    expect((await getDb().select().from(companionReports).where(eq(companionReports.id, held.reportId)))[0]).toMatchObject({ decision: 'delivered', deferredUntil: null });
    const { settingsId: _i2, supervisorSessionId: _s2, revision: after, ...saved } = await repo.readSettings();
    await repo.saveSettings({ ...saved, quietHoursStart: 0, quietHoursEnd: 0 }, after);
  });

  test('an escalated incident is asked once per revision and a yes retries exactly that revision', async () => {
    const { getDb } = await import('@/db/postgres');
    const { sessions } = await import('@/db/schema/sessions');
    const { companionIncidents } = await import('@/db/schema/companion-supervision');
    const { CompanionSupervisionRepository } = await import('@/db/repositories/companion-supervision-repository');
    const { CompanionService } = await import('./service');
    const { raiseIncidentDecisions, COMPANION_RETRY_OPTION, retryAnswer } = await import('./decisions');
    const repo = new CompanionSupervisionRepository({ userId: owner, workspaceId });
    const goal = await repo.create({ requestKey: randomUUID(), title: 'Ship', request: 'Ship the release', outcome: 'Released', acceptanceCriteria: ['Live'] });
    const [project] = await getDb().insert(sessions).values({ userId: owner, workspaceId, channelType: 'webchat', channelId: randomUUID() }).returning();
    const [incident] = await getDb().insert(companionIncidents).values({ goalId: goal.id, sessionId: project.id, fingerprint: randomUUID(), category: 'runtime',
      summary: 'The SDK mount is missing', state: 'escalated', strategies: ['remount', 'reinstall'], revision: 3 }).returning();
    const reopen = vi.spyOn(CompanionService.prototype, 'reopenIncident').mockResolvedValue(incident);
    approval.request.mockImplementation(async (_s: string, _q: string, _c: unknown, _o: string[], _k: string, onCreated: (id: string) => Promise<void>) => {
      const requestId = randomUUID(); await onCreated(requestId); return { approved: true, response: COMPANION_RETRY_OPTION, requestId };
    });
    const scope = { userId: owner, workspaceId, supervisorSessionId: supervisor };
    await raiseIncidentDecisions(scope, [incident], new Set([goal.id]));
    await raiseIncidentDecisions(scope, [incident], new Set([goal.id]));
    await vi.waitFor(() => expect(reopen).toHaveBeenCalledTimes(1));
    expect(approval.request).toHaveBeenCalledTimes(1);
    expect(approval.request.mock.calls[0][3]).toEqual([COMPANION_RETRY_OPTION, 'Leave it']);
    expect(reopen).toHaveBeenCalledWith(goal.id, incident.id, 3, expect.stringMatching(/^approval:/));
    expect((await getDb().select().from(companionIncidents).where((await import('drizzle-orm')).eq(companionIncidents.id, incident.id)))[0]).toMatchObject({ decisionRevision: 3, decisionRequestId: expect.any(String) });
    expect(retryAnswer('Leave it')).toBe(false);
    expect(retryAnswer('yes')).toBe(true);
    expect(retryAnswer('no, leave it alone')).toBe(false);
    expect(retryAnswer('stop')).toBe(false);
    reopen.mockRestore();
  });

  test('refuses sessions that are not the owner\'s Companion conversation', async () => {
    const { fileCompanionReport } = await import('./reports');
    const { getDb } = await import('@/db/postgres');
    const { sessions } = await import('@/db/schema/sessions');
    const plain = (await getDb().insert(sessions).values({ userId: owner, workspaceId, channelType: 'webchat', channelId: randomUUID() }).returning())[0].id;
    await expect(fileCompanionReport({ userId: owner, workspaceId }, plain, { matter: 'x', impact: 'high', evidence: 'strong', message: 'hi' })).rejects.toThrow('Companion conversation only');
  });
});
