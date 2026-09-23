import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from '@/api/http';
import { getDb, initializeDb, closeDb } from '@/db/postgres';
import { runMigrations } from '@/db/migrate';
import { skills } from '@/db/schema/skills';
import { skillSelections } from '@/db/schema/skill-selections';
import { hiddenSkills } from '@/db/schema/hidden-skills';
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
let mountedDir: string;
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
  mountedDir = dir;
  mkdirSync(join(dir, 'sample'));
  writeFileSync(join(dir, 'sample', 'SKILL.md'), '---\nname: Mounted test\ndescription: Mounted skill\n---\nMOUNTED FULL INSTRUCTIONS');
  getSkillRegistry().loadExternal({ configuredDirs: [dir, dir], home: dir, cwd: dir, enabled: true });
  mountedId = getSkillRegistry().getExternalSkills().find(skill => skill.name === 'Mounted test')!.id;
  const user = { id: alice, username: 'alice', isAdmin: false };
  app = new Elysia().derive(() => ({ user, principal: principalFromUser(user) })).use(skillRoutes);
}, 60000);

beforeEach(async () => { await getDb().delete(skillSelections); await getDb().delete(hiddenSkills); });
afterAll(async () => { await flushSkillUsage(); await closeDb(); });

async function request(method: 'GET' | 'PATCH' | 'DELETE', path: string, body?: unknown) {
  const response = await app.handle(new Request(`http://localhost/skills/${path}`, {
    method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }));
  return { status: response.status, body: await response.json() as any };
}

test('duplicate source ids retain pins, resolve to one full skill and can be turned off', async () => {
  const registry = getSkillRegistry();
  const alias = registry.sourceIds(mountedId).find(id => id !== mountedId)!;
  expect(alias).toBeTruthy();
  await skillSelectionRepository.set(alice, alias, 'always');
  expect(await registry.get(alias, alice)).toMatchObject({ id: mountedId });
  const prompt = await buildSelectedSkillPrompt(alice, sessionA);
  expect(prompt.match(/MOUNTED FULL INSTRUCTIONS/g)).toHaveLength(1);
  await request('PATCH', 'usage', { skillId: mountedId, mode: 'automatic' });
  expect(await buildSelectedSkillPrompt(alice, sessionA)).toBe('');
});

test('removing mounted skills survives rescan, preserves source files and clears all personal pins', async () => {
  const registry = getSkillRegistry();
  const alias = registry.sourceIds(mountedId).find(id => id !== mountedId)!;
  await skillSelectionRepository.set(alice, alias, 'always');
  await skillSelectionRepository.set(alice, mountedId, 'session', sessionB);
  expect((await request('DELETE', encodeURIComponent(alias))).body).toMatchObject({ deleted: true, removal: 'personal' });
  registry.loadExternal({ configuredDirs: [mountedDir, mountedDir], home: mountedDir, cwd: mountedDir, enabled: true });
  expect(existsSync(join(mountedDir, 'sample', 'SKILL.md'))).toBe(true);
  expect((await request('GET', '')).body.skills.some((skill: any) => skill.id === mountedId)).toBe(false);
  expect((await request('GET', 'usage')).body.skills.some((skill: any) => skill.id === mountedId)).toBe(false);
  expect(await registry.renderSkill(alias, alice)).toBeNull();
  expect(await registry.buildPromptSummary([mountedId, alias], alice)).toBe('');
  expect(await buildSelectedSkillPrompt(alice, sessionB)).toBe('');
  expect(await registry.renderSkill(alias, bob)).toContain('MOUNTED FULL INSTRUCTIONS');
});

test('system skills can be personally removed; private owned skills are actually deleted', async () => {
  expect((await request('DELETE', 'selected')).body).toMatchObject({ deleted: true, removal: 'personal' });
  expect(await getSkillRegistry().renderSkill('selected', alice)).toBeNull();
  expect(await getSkillRegistry().renderSkill('selected', bob)).toContain('COMPLETE INSTRUCTIONS');
  await getDb().insert(skills).values({ id: 'owned', name: 'Owned', description: 'Own skill', userId: alice });
  await skillSelectionRepository.set(alice, 'owned', 'always');
  expect((await request('DELETE', 'owned')).body).toMatchObject({ deleted: true, removal: 'deleted' });
  expect(await getSkillRegistry().get('owned')).toBeUndefined();
  expect(await buildSelectedSkillPrompt(alice, sessionA)).toBe('');
  expect((await request('DELETE', 'private')).status).toBe(404);
  expect((await request('DELETE', 'missing')).status).toBe(404);
});

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
