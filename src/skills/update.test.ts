import { beforeEach, expect, test, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  findSkill: vi.fn(), update: vi.fn(), findUser: vi.fn(),
}));
const OWNER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000aa');
vi.mock('@/db/repositories/user-repository', () => ({ userRepository: { findById: fixture.findUser } }));
vi.mock('@/db/repositories/skill-repository', () => ({ skillRepository: { findById: fixture.findSkill, update: fixture.update } }));
vi.mock('@/api/context', async () => ({
  apiContext: new (await import('@/api/http')).App().derive(() => ({ user: { id: OWNER } })),
}));
import { updateSkill } from './update';
import { buildSkillLoaderHandlers } from '@/tools/skill-loader';
import type { AgentContext } from '@/core/types';
import { App } from '@/api/http';
import { skillRoutes } from '@/api/routes/skills';

beforeEach(() => {
  vi.resetAllMocks();
  fixture.findUser.mockResolvedValue({ id: OWNER, isAdmin: false });
  fixture.findSkill.mockResolvedValue({ id: 'skill', userId: OWNER, isSystem: false });
  fixture.update.mockImplementation(async (id, patch) => ({ id, ...patch }));
});

test('agent updates content in place and never forwards ownership or omitted fields', async () => {
  const tool = buildSkillLoaderHandlers().find(tool => tool.name === 'update_skill')!;
  await expect(tool.execute({ skill_id: 'skill', content: 'Updated instructions', userId: 'attacker' }, { userId: OWNER } as AgentContext))
    .resolves.toEqual({ id: 'skill', content: 'Updated instructions' });
  expect(fixture.update).toHaveBeenCalledWith('skill', { content: 'Updated instructions' });
});

test('a user id that is not a uuid is a bug and throws before any lookup', async () => {
  for (const id of ['system', 'local', 'alice']) {
    await expect(updateSkill('skill', { content: 'x' }, id)).rejects.toThrow('Expected a user id (uuid)');
  }
  expect(fixture.findUser).not.toHaveBeenCalled();
  expect(fixture.update).not.toHaveBeenCalled();
});

test('clears markdown and structured arrays deliberately', async () => {
  await updateSkill('skill', { content: '', principles: [] }, OWNER);
  expect(fixture.update).toHaveBeenCalledWith('skill', { content: '', principles: [] });
});

test('refuses another owner but permits an administrator', async () => {
  fixture.findSkill.mockResolvedValue({ userId: 'other', isSystem: false });
  await expect(updateSkill('skill', { content: 'x' }, OWNER)).rejects.toMatchObject({ status: 403 });
  expect(fixture.update).not.toHaveBeenCalled();
  fixture.findUser.mockResolvedValue({ isAdmin: true });
  await updateSkill('skill', { content: 'x' }, OWNER);
  expect(fixture.update).toHaveBeenCalledOnce();
});

test('only an administrator edits a system skill', async () => {
  fixture.findSkill.mockResolvedValue({ userId: null, isSystem: true });
  await expect(updateSkill('skill', { description: 'New description' }, OWNER)).rejects.toMatchObject({ status: 403 });
  expect(fixture.update).not.toHaveBeenCalled();
  // Not even a system skill row that happens to carry the user's id.
  fixture.findSkill.mockResolvedValue({ userId: OWNER, isSystem: true });
  await expect(updateSkill('skill', { description: 'New description' }, OWNER)).rejects.toMatchObject({ status: 403 });
  fixture.findUser.mockResolvedValue({ id: OWNER, isAdmin: true });
  await updateSkill('skill', { description: 'New description' }, OWNER);
  expect(fixture.update).toHaveBeenCalledOnce();
});

test('mounted skills give actionable instructions without writing', async () => {
  await expect(updateSkill('external:claude:example', { content: 'x' }, OWNER)).rejects.toThrow('Reload mounted skills');
  expect(fixture.update).not.toHaveBeenCalled();
});

test('missing user and missing skill are errors', async () => {
  fixture.findUser.mockResolvedValueOnce(undefined);
  await expect(updateSkill('skill', { content: 'x' }, OWNER)).rejects.toMatchObject({ status: 401 });
  fixture.findSkill.mockResolvedValueOnce(undefined);
  await expect(updateSkill('missing', { content: 'x' }, OWNER)).rejects.toMatchObject({ status: 404 });
});

test.each([{}, { content: null }, { principles: [42] }, { name: ' ' }, { isSystem: true }])('invalid patch is not saved: %j', async fields => {
  await expect(updateSkill('skill', fields, OWNER)).rejects.toMatchObject({ status: 400 });
  expect(fixture.update).not.toHaveBeenCalled();
});

test('REST used by MCP saves a partial update and returns real HTTP errors', async () => {
  const app = new App().use(skillRoutes);
  const request = () => app.handle(new Request('http://test/skills/skill', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'New body' }),
  }));
  const saved = await request();
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ id: 'skill', content: 'New body' });
  fixture.findSkill.mockResolvedValue({ userId: 'other', isSystem: false });
  expect((await request()).status).toBe(403);
  fixture.findSkill.mockResolvedValue(undefined);
  expect((await request()).status).toBe(404);
  expect(fixture.update).toHaveBeenCalledOnce();
});
