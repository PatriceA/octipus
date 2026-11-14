import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from './types';

const fixture = vi.hoisted(() => ({ adapter: 'Claude Code', ids: [] as string[], delayMs: 0, fail: false }));

vi.mock('./cli-agent-factory', async importOriginal => ({
  ...(await importOriginal<typeof import('./cli-agent-factory')>()),
  getCLIToolConfig: () => ({ name: fixture.adapter }),
}));
vi.mock('@/skills/discovery', () => ({
  fetchActiveSkillIdsForTopic: async (topic: string) => (topic === 'general'
    ? ['fintus-release-tagging', 'external:claude-user:fintus-mcp:SKILL', 'external:codex-user:.system:imagegen:SKILL']
    : []),
}));
vi.mock('@/skills/registry', () => ({
  getSkillRegistry: () => ({
    buildPromptSummary: async (ids: string[]) => {
      if (fixture.delayMs) await new Promise(resolve => setTimeout(resolve, fixture.delayMs));
      if (fixture.fail) throw new Error('database unavailable');
      fixture.ids = ids;
      return ids.length ? `Available skills (call \`get_skill\` with the id to load the full spec):\n${ids.map(id => `- \`${id}\``).join('\n')}` : '';
    },
  }),
}));

const { CLIAgentWorker } = await import('./cli-agent-worker');

// The index is cached per (user, role, CLI family): a test that needs a cold
// cache uses a user of its own.
const index = (adapter: string, userId = 'u') => {
  fixture.adapter = adapter;
  const context = { id: 'a', sessionId: 's', userId, workspaceId: 'w', root: true, model: 'cli/x', role: 'general', topic: 'general', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {} } as AgentContext;
  const worker = new CLIAgentWorker(context, { maxIterations: 5, maxTokenBudget: 10000, timeout: 10000, contextWindowSize: 10000 });
  return { worker, text: () => (worker as unknown as { cliSkillIndex(): Promise<string> }).cliSkillIndex() };
};

afterEach(() => {
  fixture.delayMs = 0;
  fixture.fail = false;
  vi.restoreAllMocks();
});

describe('CLI skill index', () => {
  it('waits for a slow first build on a CLI that resumes its session: the index is fingerprinted', async () => {
    fixture.delayMs = 500;
    expect(await index('Claude Code', 'slow-claude').text()).toContain('fintus-release-tagging');
    expect(await index('Codex CLI', 'slow-codex').text()).toContain('fintus-release-tagging');
    expect(await index('Antigravity', 'slow-agy').text()).toContain('fintus-release-tagging');
  });

  it('never holds a CLI that does not resume more than 300 ms', async () => {
    fixture.delayMs = 500;
    const started = Date.now();
    expect(await index('Mistral Vibe', 'slow-vibe').text()).toBe('');
    expect(Date.now() - started).toBeLessThan(450);
  });

  it('keeps serving the last index when a refresh fails, rather than dropping it for a TTL', async () => {
    const first = await index('Claude Code', 'refresh').text();
    expect(first).toContain('fintus-release-tagging');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    fixture.fail = true;
    expect(await index('Claude Code', 'refresh').text()).toBe(first); // stale value while the refresh runs
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await index('Claude Code', 'refresh').text()).toBe(first); // and after it failed
  });

  it('lists the skills assigned to the role with a load-on-match rule, minus the ones the CLI loads natively', async () => {
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
