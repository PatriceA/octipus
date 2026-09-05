/**
 * The `orchestrator.*` namespace moved into `agent.*` when the routing hop it
 * was named after stopped existing. Every install in the field carries the old
 * names in its `settings` table and its `.env`, so both have to keep working —
 * a rename that fails a boot is not a rename, it is an outage.
 */
import { describe, expect, test } from 'vitest';
import { agentConfigSchema, normalizeRetiredConfigValues } from './schema';

describe('retired orchestrator config', () => {
  test('old keys are carried into agent.* and the old namespace is dropped', () => {
    const merged = normalizeRetiredConfigValues({
      agent: { maxIterations: 50 },
      orchestrator: {
        mode: 'lite',
        liteMaxIterations: 12,
        routerSmallModelMaxParams: 9_000_000_000,
        orchestratorTimeoutMs: 111,
        orchestratorHookTimeoutMs: 222,
      },
    } as Record<string, unknown>) as {
      agent: Record<string, unknown>;
      orchestrator?: unknown;
    };

    expect(merged.agent.promptTier).toBe('lite');
    expect(merged.agent.liteMaxIterations).toBe(12);
    expect(merged.agent.smallModelMaxParams).toBe(9_000_000_000);
    expect(merged.agent.turnTimeoutMs).toBe(111);
    expect(merged.agent.hookTurnTimeoutMs).toBe(222);
    expect(merged.agent.maxIterations).toBe(50); // untouched
    expect(merged.orchestrator).toBeUndefined();
  });

  test('a value already set under the new name wins over the retired one', () => {
    const merged = normalizeRetiredConfigValues({
      agent: { promptTier: 'full' },
      orchestrator: { mode: 'lite' },
    } as Record<string, unknown>) as { agent: Record<string, unknown> };
    expect(merged.agent.promptTier).toBe('full');
  });

  test("the deleted 'router' tier becomes lite instead of failing the boot", () => {
    const merged = normalizeRetiredConfigValues({
      orchestrator: { mode: 'router' },
    } as Record<string, unknown>) as { agent: Record<string, unknown> };
    expect(merged.agent.promptTier).toBe('lite');
  });

  test('swarm.levelDefaults.orchestrator follows the renamed node kind', () => {
    const merged = normalizeRetiredConfigValues({
      swarm: { levelDefaults: { orchestrator: { tokens: 1234, wallMs: 600_000, fanOut: 6 } } },
    } as Record<string, unknown>) as {
      swarm: { levelDefaults: Record<string, { tokens: number } | undefined> };
    };
    expect(merged.swarm.levelDefaults.root?.tokens).toBe(1234);
    expect(merged.swarm.levelDefaults.orchestrator).toBeUndefined();
  });

  test('the normalized result validates — the retired shape cannot fail a boot', () => {
    const normalized = normalizeRetiredConfigValues({
      orchestrator: { mode: 'router', liteMaxIterations: 5 },
    } as Record<string, unknown>) as { agent: Record<string, unknown> };
    // Only the section that moved: `configSchema` also demands database,
    // security and the rest, which this migration has nothing to do with.
    const parsed = agentConfigSchema.safeParse(normalized.agent);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.promptTier).toBe('lite');
      expect(parsed.data.liteMaxIterations).toBe(5);
    }
  });
});

describe('retired orchestrator config — against the REAL merged shape', () => {
  // The first version of these tests handed in a bare object and passed while
  // the migration was inert in production: `defaultConfig` supplies every key
  // the retired namespace maps onto, so after `deepMerge` the "is the new key
  // unset?" guard was never true and the carry-over loop copied nothing.
  // Reachability has to be asserted through the same merge the loaders do.
  test('a retired value survives the merge with defaults', async () => {
    const { defaultConfig } = await import('./defaults');
    const { deepMerge } = await import('./utils');

    const settingsPartial = { orchestrator: { liteMaxIterations: 17 } } as Record<string, unknown>;
    normalizeRetiredConfigValues(settingsPartial);
    const merged = deepMerge(defaultConfig, settingsPartial) as unknown as {
      agent: { liteMaxIterations: number };
    };
    expect(merged.agent.liteMaxIterations).toBe(17);
    expect(defaultConfig.agent?.liteMaxIterations).not.toBe(17); // not just the default

    // And pin the ORDER, which is the whole bug: normalizing AFTER the merge
    // silently drops the value, because the default has already filled the key
    // the carry-over guard tests for. This assertion fails the moment someone
    // moves the call back to where it was.
    const mergedFirst = deepMerge(defaultConfig, { orchestrator: { liteMaxIterations: 17 } } as never) as Record<string, unknown>;
    normalizeRetiredConfigValues(mergedFirst);
    expect((mergedFirst as { agent: { liteMaxIterations: number } }).agent.liteMaxIterations).toBe(
      defaultConfig.agent?.liteMaxIterations,
    );
  });

  test('`router` from the env loader does not fail the boot', async () => {
    // `loadConfig()` caches, so this replays exactly what it does rather than
    // calling it. The failure this guards: the legacy loader maps
    // ORCHESTRATOR_MODE straight onto `agent.promptTier`, so 'router' reached
    // the enum without ever passing through `cfg.orchestrator` — and a boot
    // that throws is a worse outcome than any value could justify.
    const { defaultConfig } = await import('./defaults');
    const { deepMerge } = await import('./utils');
    const { loadFromEnvLegacy } = await import('./legacy-loader');
    const { configSchema } = await import('./schema');

    const saved = { ...process.env };
    try {
      process.env.ORCHESTRATOR_MODE = 'router';
      delete process.env.AGENT_PROMPT_TIER;
      const envConfig = normalizeRetiredConfigValues(loadFromEnvLegacy());
      const merged = normalizeRetiredConfigValues(deepMerge(defaultConfig, envConfig));
      const parsed = configSchema.safeParse(merged);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.agent.promptTier).toBe('lite');
    } finally {
      process.env = saved;
    }
  });
});

describe('retired orchestrator env vars', () => {
  test('the retired ORCHESTRATOR_* names still set the value the new ones name', async () => {
    const { loadFromEnvLegacy } = await import('./legacy-loader');
    const saved = { ...process.env };
    try {
      delete process.env.AGENT_PROMPT_TIER;
      delete process.env.AGENT_TURN_TIMEOUT_MS;
      process.env.ORCHESTRATOR_MODE = 'lite';
      process.env.ORCHESTRATOR_TIMEOUT_MS = '999';
      const cfg = loadFromEnvLegacy();
      expect(cfg.agent?.promptTier).toBe('lite');
      expect(cfg.agent?.turnTimeoutMs).toBe(999);
    } finally {
      process.env = saved;
    }
  });

  test('the new name wins when both are set', async () => {
    const { loadFromEnvLegacy } = await import('./legacy-loader');
    const saved = { ...process.env };
    try {
      process.env.ORCHESTRATOR_MODE = 'lite';
      process.env.AGENT_PROMPT_TIER = 'full';
      expect(loadFromEnvLegacy().agent?.promptTier).toBe('full');
    } finally {
      process.env = saved;
    }
  });
});
