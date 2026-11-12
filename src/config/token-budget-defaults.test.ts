import { describe, expect, test, vi } from 'vitest';
import { LEVEL_DEFAULT } from '@/core/swarm/types';
import { defaultConfig } from './defaults';
import { loadFromEnvLegacy } from './legacy-loader';
import { agentConfigSchema, swarmConfigSchema, configSchema } from './schema';
import { SETTINGS_REGISTRY } from './settings-registry';

const expected: Record<string, number> = {
  'agent.maxTokenBudget': 10_000_000, 'agent.pipelineTokenBudget': 10_000_000,
  'swarm.levelDefaults.root.tokens': 2_000_000, 'swarm.levelDefaults.agent.tokens': 800_000,
  'swarm.levelDefaults.subagent.tokens': 300_000, 'plugins.hostModelDailyTokens': 10_000_000,
  'plugins.hostAgentRunTokens': 1_000_000,
};
const pick = (value: unknown, key: string): unknown => key.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], value);

describe('out-of-box token budgets', () => {
  test.each(Object.entries(expected))('%s agrees across schema, defaults, registry and legacy loader', (key, value) => {
    vi.stubEnv('AGENT_MAX_TOKEN_BUDGET', ''); vi.stubEnv('PIPELINE_TOKEN_BUDGET', '');
    try {
      const parsed = { agent: agentConfigSchema.parse({}), swarm: swarmConfigSchema.parse({}), plugins: configSchema.shape.plugins.parse({}) };
      for (const config of [parsed, defaultConfig, { ...defaultConfig, ...loadFromEnvLegacy() }]) expect(pick(config, key)).toBe(value);
      expect(SETTINGS_REGISTRY.find(s => s.key === key)?.defaultValue).toBe(value);
    } finally { vi.unstubAllEnvs(); }
  });
  test('fallback swarm levels agree with the configured hierarchy', () => {
    expect([LEVEL_DEFAULT[0].tokens, LEVEL_DEFAULT[1].tokens, LEVEL_DEFAULT[2].tokens]).toEqual([2_000_000, 800_000, 300_000]);
  });
  test('explicit lower caps and zero/unlimited stay intact', () => {
    expect(agentConfigSchema.parse({ maxTokenBudget: 50_000 }).maxTokenBudget).toBe(50_000);
    expect(agentConfigSchema.parse({ maxTokenBudget: 0 }).maxTokenBudget).toBe(0);
    expect(swarmConfigSchema.parse({ levelDefaults: { root: { tokens: 5_000, wallMs: 10_000, fanOut: 1 } } }).levelDefaults.root.tokens).toBe(5_000);
    vi.stubEnv('AGENT_MAX_TOKEN_BUDGET', '0');
    try { expect(loadFromEnvLegacy().agent?.maxTokenBudget).toBe(0); } finally { vi.unstubAllEnvs(); }
  });
});
