import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';
import { getDb, initializeDb, closeDb } from '@/db/postgres';
import { runMigrations } from '@/db/migrate';
import { skills } from '@/db/schema/skills';
import { skillSelections } from '@/db/schema/skill-selections';
import { skillSelectionRepository } from '@/db/repositories/skill-selection-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { buildSelectedSkillPrompt } from '@/skills/selection';
import { getSkillRegistry } from '@/skills/registry';
import { flushSkillUsage } from '@/skills/usage-tracker';
import { seedUsers, seedSession } from '@/test-helpers/multiuser-fixtures';
import { principalFromUser } from '@/security/principal';
import { skillRoutes } from './skills';

vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({
  getModelByModelId: async (model: string) => ({ provider: model.startsWith('cli/') ? 'cli' : 'openai', contextWindow: 32000 }),
}) }));
vi.mock('@/security/quotas', () => ({ getQuotaManager: () => ({ willExceed: async () => ({ allowed: true }) }) }));

process.env.MASTER_KEY ??= `test-${randomUUID()}`;
process.env.JWT_SECRET ??= `test-${randomUUID()}`;
process.env.SESSION_SECRET ??= `test-${randomUUID()}`;
process.env.LOG_LEVEL = 'error';
process.env.STORAGE_MODE = 'embedded';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skill-usage-'));
const alice = randomUUID();
const bob = randomUUID();
let sessionA: string;
let sessionB: string;
let otherSession: string;
let mountedId: string;
let app: { handle(req: Request): Promise<Response> };

beforeAll(async () => {
  await initializeDb();
  await runMigrations();
  await seedUsers([{ id: alice, username: 'alice' }, { id: bob, username: 'bob' }]);
  sessionA = (await seedSession({ userId: alice })).id;
  sessionB = (await seedSession({ userId: alice })).id;
  otherSession = (await seedSession({ userId: bob })).id;
  await getDb().insert(skills).values([
    { id: 'selected', name: 'Selected', description: 'SHORT DESCRIPTION', content: 'COMPLETE INSTRUCTIONS: retain this entire body.', isSystem: true },
    { id: 'private', name: 'Private', description: 'secret', content: 'BOB ONLY', userId: bob },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'octipus-mounted-skill-'));
  mkdirSync(join(dir, 'sample'));
  writeFileSync(join(dir, 'sample', 'SKILL.md'), '---\nname: Mounted test\ndescription: Mounted skill\n---\nMOUNTED FULL INSTRUCTIONS');
  getSkillRegistry().loadExternal({ configuredDirs: [dir], home: dir, cwd: dir, enabled: true });
  mountedId = getSkillRegistry().getExternalSkills().find(skill => skill.name === 'Mounted test')!.id;
  const user = { id: alice, username: 'alice', isAdmin: false };
  app = new Elysia().derive(() => ({ user, principal: principalFromUser(user) })).use(skillRoutes);
}, 60000);

beforeEach(async () => { await getDb().delete(skillSelections); });
afterAll(async () => { await flushSkillUsage(); await closeDb(); });

async function request(method: 'GET' | 'PATCH', path: string, body?: unknown) {
  const response = await app.handle(new Request(`http://localhost/skills/${path}`, {
    method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }));
  return { status: response.status, body: await response.json() as any };
}

test('Always loads full content for this user across sessions; Automatic is a session override', async () => {
  expect((await request('PATCH', 'usage', { skillId: 'selected', mode: 'always' })).status).toBe(200);
  expect(await buildSelectedSkillPrompt(alice, sessionA)).toContain('COMPLETE INSTRUCTIONS');
  expect(await buildSelectedSkillPrompt(alice, sessionB)).toContain('COMPLETE INSTRUCTIONS');
  expect(await buildSelectedSkillPrompt(bob, otherSession)).toBe('');
  await request('PATCH', 'usage', { skillId: 'selected', mode: 'automatic', sessionId: sessionA });
  expect(await buildSelectedSkillPrompt(alice, sessionA)).toBe('');
  expect(await buildSelectedSkillPrompt(alice, sessionB)).toContain('COMPLETE INSTRUCTIONS');
  await request('PATCH', 'usage', { skillId: 'selected', mode: 'always', sessionId: sessionA });
  expect((await buildSelectedSkillPrompt(alice, sessionA)).match(/COMPLETE INSTRUCTIONS/g)).toHaveLength(1);
  await request('PATCH', 'usage', { skillId: 'selected', mode: 'automatic' });
  expect(await buildSelectedSkillPrompt(alice, sessionB)).toBe('');
});

test('session selection survives checkpoint changes and clear, without reaching another session', async () => {
  await request('PATCH', 'usage', { skillId: 'selected', mode: 'session', sessionId: sessionA });
  await sessionRepository.setContextKey(sessionA, ['compactedSummary'], 'compressed history');
  expect(await buildSelectedSkillPrompt(alice, sessionA)).toContain('COMPLETE INSTRUCTIONS');
  await sessionRepository.clearContext(sessionA);
  expect(await buildSelectedSkillPrompt(alice, sessionA)).toContain('COMPLETE INSTRUCTIONS');
  expect(await buildSelectedSkillPrompt(alice, sessionB)).toBe('');
  const result = await request('GET', `usage?sessionId=${sessionA}`);
  expect(result.body.skills.find((skill: any) => skill.id === 'selected').mode).toBe('session');
});

test('foreign sessions and private skills cannot be selected or listed', async () => {
  expect((await request('GET', `usage?sessionId=${otherSession}`)).status).toBe(404);
  expect((await request('PATCH', 'usage', { skillId: 'selected', mode: 'always', sessionId: otherSession })).status).toBe(404);
  expect((await request('PATCH', 'usage', { skillId: 'private', mode: 'always' })).status).toBe(404);
  expect((await request('GET', 'usage')).body.skills.some((skill: any) => skill.id === 'private')).toBe(false);
  expect((await request('PATCH', 'usage', { skillId: 'selected', mode: 'session' })).status).toBe(400);
  expect((await request('PATCH', 'usage', { skillId: 'selected', mode: 'invalid' })).status).toBe(422);
  // An admin can open bob's chat but must not rewrite bob's defaults.
  const admin = { id: alice, username: 'alice', isAdmin: true };
  const adminApp = new Elysia().derive(() => ({ user: admin, principal: principalFromUser(admin) })).use(skillRoutes);
  const response = await adminApp.handle(new Request('http://localhost/skills/usage', { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skillId: 'selected', mode: 'always', sessionId: otherSession }) }));
  expect(response.status).toBe(403);
  expect(await buildSelectedSkillPrompt(bob)).toBe('');
});

test('mounted skill content is fully loaded; missing selections fail visibly and can be removed', async () => {
  expect((await request('PATCH', 'usage', { skillId: mountedId, mode: 'session', sessionId: sessionA })).status).toBe(200);
  expect(await buildSelectedSkillPrompt(alice, sessionA)).toContain('MOUNTED FULL INSTRUCTIONS');
  await skillSelectionRepository.set(alice, 'missing', 'always');
  await expect(buildSelectedSkillPrompt(alice, sessionA)).rejects.toThrow('Selected skills unavailable: missing');
  expect((await request('GET', 'usage')).body.skills.find((skill: any) => skill.id === 'missing').available).toBe(false);
  await request('PATCH', 'usage', { skillId: 'missing', mode: 'automatic' });
  expect(await buildSelectedSkillPrompt(alice, sessionA)).toContain('MOUNTED FULL INSTRUCTIONS');
});

test('native root, native child and CLI child receive full selected system instructions', async () => {
  const { AgentManager } = await import('@/core/agent-manager');
  const { slidingWindowCompact } = await import('@/utils/context-compaction');
  const manager = new AgentManager();
  await skillSelectionRepository.set(alice, 'selected', 'session', sessionA);
  for (const options of [{ role: 'general', root: true, model: 'test' }, { role: 'coding', model: 'test' }, { role: 'coding', model: 'cli/claude' }]) {
    const worker = await manager.spawn({ sessionId: sessionA, userId: alice, systemPrompt: 'BASE', ...options });
    const messages = (worker as unknown as { messages: import('@/core/types').AgentMessage[] }).messages;
    expect(messages.filter(message => message.role === 'system').map(message => message.content).join('\n')).toContain('COMPLETE INSTRUCTIONS');
    expect(slidingWindowCompact(messages, 1).some(message => message.content.includes('COMPLETE INSTRUCTIONS'))).toBe(true);
    manager.remove(worker.getContext().id);
  }
});

test('web chat and both TUI gateway clients share selection commands, including before the first message', async () => {
  await import('@/core/commands/skills');
  const { getCommand } = await import('@/core/commands/registry');
  const { CommandRegistry, registerBuiltinCommands } = await import('@/core/gateway/commands');
  const gateway = new CommandRegistry();
  registerBuiltinCommands(gateway);
  const result = await getCommand('skills')!.execute({ userId: alice, sessionId: sessionA, args: 'Selected session' });
  expect(result.response).toContain('This session');
  expect(await buildSelectedSkillPrompt(alice, sessionA)).toContain('COMPLETE INSTRUCTIONS');
  for (const clientType of ['tui', 'tui-editor']) {
    const freshSession = randomUUID();
    const context = { userId: alice, sessionId: freshSession, clientType, trustLevel: 'user' as const };
    expect((await gateway.execute('/skills selected session', context))?.text).toContain('This session');
    expect(await buildSelectedSkillPrompt(alice, freshSession)).toContain('COMPLETE INSTRUCTIONS');
    expect((await gateway.execute('/skills selected auto', context))?.text).toContain('Automatic (this session)');
    expect(await buildSelectedSkillPrompt(alice, freshSession)).toBe('');
    expect((await gateway.execute('/skills private always', context))?.text).toContain('Skill not found');
    expect((await gateway.execute('/skills selected session', { ...context, sessionId: otherSession }))?.text).toContain('Session not found');
  }
  // Channel clients carry non-uuid session ids.
  expect((await gateway.execute('/skills', { userId: alice, sessionId: 'telegram-123', clientType: 'telegram', trustLevel: 'user' }))?.text).toContain('selected — Selected');
});
