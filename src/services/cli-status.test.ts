import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ tools: vi.fn(), statuses: vi.fn() }));
vi.mock('@/models/providers', () => ({ getProviderRouter: () => ({ getCLIProvider: () => ({ getAvailableTools: fixture.tools }) }) }));
vi.mock('@/models/quota-tracker', () => ({ getQuotaTracker: () => ({ getAllStatuses: fixture.statuses }) }));
import { getCliStatus } from './model-service';
it('attaches CLI quota blocks by the real provider ID, regardless of display name', async () => {
  const tools = [
    { name: 'Claude Code (z.ai GLM)', quotaProvider: 'zai-cli' },
    { name: 'Claude Code (Moonshot Kimi)', quotaProvider: 'moonshot-cli' },
    { name: 'Grok Build', quotaProvider: 'grok-build' },
  ];
  fixture.tools.mockResolvedValue(tools);
  fixture.statuses.mockResolvedValue(tools.map(tool => ({ provider: tool.quotaProvider, exhausted: true })));
  const result = await getCliStatus();
  expect(result.tools).toEqual(tools.map(tool => ({ ...tool, quota: { provider: tool.quotaProvider, exhausted: true } })));
  expect(fixture.tools).toHaveBeenCalledWith(true);
});
