import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import { buildSkillResourceHandlers } from './skill-runtime';
import { runSkillScript } from '@/skills/script-runner';
import { readSkillResource } from '@/skills/resources';
const check = vi.hoisted(() => vi.fn(async () => ({ level: 'DENY', reason: 'disabled by operator' })));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check }) }));
vi.mock('@/skills/script-runner', () => ({ runSkillScript: vi.fn() }));
vi.mock('@/skills/resources', () => ({ readSkillResource: vi.fn() }));

describe('skill framework tool permissions', () => {
  it.each(['read_skill_resource', 'run_skill_script'])('honors explicit policy denial for %s', async name => {
    const tool = buildSkillResourceHandlers().find(tool => tool.name === name)!;
    const context = { id: 'a', userId: 'u', sessionId: 's', role: 'research', status: 'running' } as AgentContext;
    await expect(tool.execute({ skill_id: 'skill', path: 'schema.json', script: 'run.mjs' }, context))
      .rejects.toThrow('Permission denied for skill_runtime');
    expect(check).toHaveBeenCalled();
    expect(runSkillScript).not.toHaveBeenCalled();
    expect(readSkillResource).not.toHaveBeenCalled();
  });
});
