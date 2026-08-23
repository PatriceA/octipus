/**
 * Built-in skill loader (list_skills / get_skill) — the MCP-independent path
 * for loading full skill content. See skill-loader.ts.
 */
import { describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import type { Skill } from '@/db/schema/skills';
import { getSkillRegistry } from '@/skills/registry';
import { buildSkillLoaderHandlers } from './skill-loader';

const ctx = { userId: 'u1' } as AgentContext;
const handlers = () => buildSkillLoaderHandlers();
const tool = (name: string) => handlers().find((h) => h.name === name)!;

const skill = (over: Partial<Skill>): Skill =>
  ({ id: 'x', name: 'X', description: 'd', content: '', principles: [], bestPractices: [], antiPatterns: [], frameworks: [], ...over }) as Skill;

describe('buildSkillLoaderHandlers', () => {
  test('exposes list_skills + get_skill with no toolId (stay core under lazy discovery)', () => {
    const hs = handlers();
    expect(hs.map((h) => h.name).sort()).toEqual(['get_skill', 'list_skills']);
    for (const h of hs) expect(h.toolId).toBeUndefined();
  });

  test('list_skills returns id + name + capped description, no body', async () => {
    const reg = getSkillRegistry();
    const spy = vi.spyOn(reg, 'getAll').mockResolvedValue([
      skill({ id: 'a', name: 'Alpha', description: '  multi   space ', content: 'FULL BODY' }),
    ]);
    const result = (await tool('list_skills').execute({}, ctx)) as Array<Record<string, unknown>>;
    expect(spy).toHaveBeenCalledWith('u1');
    expect(result).toEqual([{ id: 'a', name: 'Alpha', description: 'multi space' }]);
    expect(result[0]).not.toHaveProperty('content');
    spy.mockRestore();
  });

  test('get_skill returns the rendered body for a known id', async () => {
    const reg = getSkillRegistry();
    const spy = vi.spyOn(reg, 'renderSkill').mockResolvedValue('## Alpha\n\nFULL BODY');
    const out = await tool('get_skill').execute({ skill_id: 'a' }, ctx);
    expect(spy).toHaveBeenCalledWith('a');
    expect(out).toBe('## Alpha\n\nFULL BODY');
    spy.mockRestore();
  });

  test('get_skill throws a helpful error for an unknown id', async () => {
    const spy = vi.spyOn(getSkillRegistry(), 'renderSkill').mockResolvedValue(null);
    await expect(tool('get_skill').execute({ skill_id: 'nope' }, ctx)).rejects.toThrow(/list_skills/);
    spy.mockRestore();
  });

  test('get_skill rejects a non-string skill_id', async () => {
    await expect(tool('get_skill').execute({ skill_id: 5 }, ctx)).rejects.toThrow(/must be a string/);
  });
});
