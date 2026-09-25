import { describe, expect, it } from 'vitest';
import { LEVEL_DEFAULT } from '@/core/swarm/types';
import { defaultConfig } from './defaults';
import { agentConfigSchema, swarmConfigSchema } from './schema';
import { SETTINGS_REGISTRY } from './settings-registry';

/**
 * Children get 1 h, the root 10 h — and every source of the default agrees,
 * or the one that loads last silently wins.
 */
const HOUR = 3_600_000;
const EXPECTED: Record<string, number> = {
  'agent.defaultTimeout': HOUR,
  'agent.turnTimeoutMs': 10 * HOUR,
  'agent.hookTurnTimeoutMs': 10 * HOUR,
  'swarm.levelDefaults.root.wallMs': 10 * HOUR,
  'swarm.levelDefaults.agent.wallMs': HOUR,
  'swarm.levelDefaults.subagent.wallMs': HOUR,
};

const pick = (obj: unknown, path: string) =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

describe('timeout defaults', () => {
  const parsed = { agent: agentConfigSchema.parse({}), swarm: swarmConfigSchema.parse({}) };

  it.each(Object.entries(EXPECTED))('%s', (key, value) => {
    expect(pick(defaultConfig, key)).toBe(value);
    expect(pick(parsed, key)).toBe(value);
    expect(SETTINGS_REGISTRY.find((s) => s.key === key)?.defaultValue).toBe(value);
  });

  it('LEVEL_DEFAULT fallback matches', () => {
    expect([LEVEL_DEFAULT[0].wallMs, LEVEL_DEFAULT[1].wallMs, LEVEL_DEFAULT[2].wallMs]).toEqual([10 * HOUR, HOUR, HOUR]);
  });

  it('an explicit override still wins', () => {
    expect(agentConfigSchema.parse({ turnTimeoutMs: 60_000 }).turnTimeoutMs).toBe(60_000);
    expect(swarmConfigSchema.parse({ levelDefaults: { agent: { tokens: 1_000, wallMs: 20_000, fanOut: 1 } } })
      .levelDefaults.agent.wallMs).toBe(20_000);
  });
});
