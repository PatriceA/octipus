import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from './types';

const fixture = vi.hoisted(() => ({ adapter: 'Claude Code', ids: [] as string[] }));

vi.mock('./cli-agent-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('./cli-agent-factory')>()),
  getCLIToolConfig: () => ({ name: fixture.adapter }),
}));
vi.mock('@/skills/registry', () => ({
  getSkillRegistry: () => ({
    getAll: async () => [
      { id: 'fintus-release-tagging' },
      { id: 'external:claude-user:fintus-mcp:SKILL' },
      { id: 'external:codex-user:.system:imagegen:SKILL' },
    ],
    buildPromptSummary: async (ids: string[]) => {
      fixture.ids = ids;
      return ids.length ? `Available skills (call \`get_skill\` with the id to load the full spec):\n${ids.map(id => `- \`${id}\``).join('\n')}` : '';
    },
  }),
}));

const { CLIAgentWorker } = await import('./cli-agent-worker');

const index = (adapter: string) => {
  fixture.adapter = adapter;
  const context = { id: 'a', sessionId: 's', userId: 'u', workspaceId: 'w', root: true, model: 'cli/x', role: 'general', topic: 'general', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {} } as AgentContext;
  const worker = new CLIAgentWorker(context, { maxIterations: 5, maxTokenBudget: 10000, timeout: 10000, contextWindowSize: 10000 });
  return { worker, text: () => (worker as unknown as { cliSkillIndex(): Promise<string> }).cliSkillIndex() };
};

describe('CLI skill index', () => {
  it('lists Octipus skills with a load-on-match rule, minus the ones the CLI loads natively', async () => {
    const text = await index('Claude Code').text();
    expect(text).toContain('fintus-release-tagging');
    expect(text).toContain('load it with get_skill');
    expect(fixture.ids).toEqual(['fintus-release-tagging', 'external:codex-user:.system:imagegen:SKILL']);

    await index('Codex CLI').text();
    expect(fixture.ids).toEqual(['fintus-release-tagging', 'external:claude-user:fintus-mcp:SKILL']);
  });

  it('adds nothing when the prompt already carries a skill index (spawned children)', async () => {
    const { worker, text } = index('Claude Code');
    worker.addSystemMessage('Available skills (call `get_skill` with the id to load the full spec):\n- `x`');
    expect(await text()).toBe('');
  });
});
