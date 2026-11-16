import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { COMPANION_REPORT_DAILY_CAP, decideCompanionReport } from './reports';

process.env.STORAGE_MODE = 'embedded';
const dir = mkdtempSync(join(tmpdir(), 'octipus-companion-reports-'));
process.env.DATA_DIR = dir;
process.env.LOG_LEVEL = 'error';
const publish = vi.hoisted(() => vi.fn());
vi.mock('@/core/agent/service', () => ({ getAgentService: () => ({ publishResponse: publish }) }));

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

  test('refuses sessions that are not the owner\'s Companion conversation', async () => {
    const { fileCompanionReport } = await import('./reports');
    const { getDb } = await import('@/db/postgres');
    const { sessions } = await import('@/db/schema/sessions');
    const plain = (await getDb().insert(sessions).values({ userId: owner, workspaceId, channelType: 'webchat', channelId: randomUUID() }).returning())[0].id;
    await expect(fileCompanionReport({ userId: owner, workspaceId }, plain, { matter: 'x', impact: 'high', evidence: 'strong', message: 'hi' })).rejects.toThrow('Companion conversation only');
  });
});
