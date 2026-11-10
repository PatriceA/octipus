/**
 * `model:complete` of the plugin host API (host-model.ts): no CLI model
 * unless the package's model.trustedInput is approved, the
 * call runs as part of the calling session at the level the package call has
 * read, the space role reaches the lane, and cost is bounded before the call
 * (a per-package bucket, a per-user daily token cap, spend budgets), with the
 * cost row tagged by the plugin.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Principal } from '@/security/principal';
import type { HostTokenGrant } from './host-api';

const h = vi.hoisted(() => ({
  usedToday: 0,
  cap: 200_000,
  spendError: null as Error | null,
  model: { name: 'everyday-api', modelId: 'test/model', provider: 'openai' } as { name: string; modelId: string; provider: string } | null,
  resolved: [] as unknown[],
  calls: [] as Array<{ options: Record<string, any>; level: number | undefined }>,
  routingError: false,
}));

vi.mock('@/config', () => ({ getConfig: () => ({ plugins: { hostModelDailyTokens: h.cap } }) }));
vi.mock('@/db/postgres', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: async () => [{ total: String(h.usedToday) }] }) }) }),
}));
vi.mock('@/security/spend-budgets', () => ({ checkSpend: async () => { if (h.spendError) throw h.spendError; return []; } }));
vi.mock('@/models/resolve-model', () => ({ resolveModel: async (req: unknown) => { h.resolved.push(req); return h.model; } }));
vi.mock('@/models/litellm-client', async () => {
  const { currentContentLevel } = await import('@/core/protection/session-level');
  return {
    getLiteLLMClient: () => ({
      complete: async (options: Record<string, any>) => {
        h.calls.push({ options, level: currentContentLevel() });
        if (h.routingError) {
          const err = new Error('level 3 content stays on local models');
          err.name = 'ProtectionRoutingError';
          throw err;
        }
        return { content: ' the answer ' };
      },
    }),
  };
});

const { MODEL_CALLS_PER_MINUTE, pluginModelComplete } = await import('./host-model');

let n = 0;
function grant(over: Partial<HostTokenGrant> = {}): HostTokenGrant {
  n += 1;
  return {
    plugin: `pkg-${n}`, userId: '11111111-1111-4111-8111-111111111111', workspaceId: null, sessionId: '22222222-2222-4222-8222-222222222222',
    scopes: ['model:complete'], maxProtection: 1, tool: 'summarize', expiresAt: Date.now() + 30_000, ...over,
  };
}
const personal = { kind: 'user', userId: '11111111-1111-4111-8111-111111111111', workspaceId: 'ws-1', workspaceKind: 'personal' } as unknown as Principal;
const req = { prompt: 'Summarize this.', maxTokens: 100 };

beforeEach(() => {
  h.usedToday = 0;
  h.cap = 200_000;
  h.spendError = null;
  h.model = { name: 'everyday-api', modelId: 'test/model', provider: 'openai' };
  h.resolved = [];
  h.calls = [];
  h.routingError = false;
});

describe('model:complete', () => {
  test('runs in the calling session, at the level the call has read, tagged with the plugin', async () => {
    const g = grant({ readLevel: 3 });
    expect(await pluginModelComplete(g, personal, req)).toEqual({ ok: true, output: 'the answer', model: 'everyday-api' });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].level).toBe(3);
    expect(h.calls[0].options).toMatchObject({
      sessionId: g.sessionId, userId: g.userId, workspaceId: 'ws-1', requestType: `plugin:${g.plugin}`, accountingMetadata: { plugin: g.plugin, tool: 'summarize' },
    });
    // Nothing read above 1: level 1.
    await pluginModelComplete(grant(), personal, req);
    expect(h.calls[1].level).toBe(1);
  });

  test('a refusal by protection routing is answered, not thrown', async () => {
    h.routingError = true;
    expect(await pluginModelComplete(grant({ readLevel: 4 }), personal, req)).toMatchObject({ ok: false, status: 409, code: 'protection_level' });
  });

  test('a CLI model on the lane is refused before any call', async () => {
    h.model = { name: 'everyday-cli', modelId: 'cli/antigravity', provider: 'cli' };
    expect(await pluginModelComplete(grant(), personal, req)).toMatchObject({ ok: false, status: 409, code: 'cli_model' });
    expect(h.calls).toEqual([]);
    h.model = null;
    expect(await pluginModelComplete(grant(), personal, req)).toMatchObject({ ok: false, status: 409, code: 'no_model' });
  });

  test('a CLI lane: refused without model.trustedInput approved; allowed with it, with allowCliTools and the audit details', async () => {
    h.model = { name: 'everyday-agy', modelId: 'cli/antigravity', provider: 'cli' };
    // No flag: refused, naming the flag and the approval.
    const refused = await pluginModelComplete(grant(), personal, req);
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'cli_model' });
    expect(refused.ok ? '' : refused.error).toMatch(/model\.trustedInput.*model:cli-tools/);
    // The flag declared but not approved never reaches the grant (issueHostCallMeta sets it only when approved): refused the same.
    expect(await pluginModelComplete(grant({ modelCliTools: undefined }), personal, req)).toMatchObject({ code: 'cli_model' });
    expect(h.calls).toEqual([]);
    // Declared and approved: the call goes through, with allowCliTools, and the audit details say so.
    const details: Record<string, unknown> = {};
    const g = grant({ modelCliTools: true });
    expect(await pluginModelComplete(g, personal, req, details)).toEqual({ ok: true, output: 'the answer', model: 'everyday-agy', cliTools: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].options).toMatchObject({
      model: 'cli/antigravity', allowCliTools: true, requestType: `plugin:${g.plugin}`, accountingMetadata: { plugin: g.plugin, tool: 'summarize', cliTools: true },
    });
    expect(details).toEqual({ model: 'everyday-agy', cliTools: true });
  });

  test('an API lane never gets allowCliTools, approved or not', async () => {
    const details: Record<string, unknown> = {};
    await pluginModelComplete(grant({ modelCliTools: true }), personal, req, details);
    expect(h.calls[0].options).not.toHaveProperty('allowCliTools');
    expect(details).toEqual({ model: 'everyday-api' });
  });

  test('the caps still apply to an approved CLI call', async () => {
    h.model = { name: 'everyday-agy', modelId: 'cli/antigravity', provider: 'cli' };
    h.usedToday = 199_990;
    expect(await pluginModelComplete(grant({ modelCliTools: true }), personal, req)).toMatchObject({ ok: false, code: 'token_cap' });
    h.usedToday = 0;
    const g = grant({ modelCliTools: true });
    const outcomes = [];
    for (let i = 0; i < MODEL_CALLS_PER_MINUTE + 1; i++) outcomes.push(await pluginModelComplete(g, personal, req));
    expect(outcomes.at(-1)).toMatchObject({ ok: false, code: 'rate_limited' });
    h.routingError = true;
    expect(await pluginModelComplete(grant({ modelCliTools: true, readLevel: 4 }), personal, req)).toMatchObject({ ok: false, code: 'protection_level' });
  });

  test('in a space the lane is resolved with the space and the user\'s role there', async () => {
    const inSpace = { ...personal, workspaceKind: 'shared', spaceRole: 'commenter' } as unknown as Principal;
    await pluginModelComplete(grant(), inSpace, req);
    expect(h.resolved.at(-1)).toMatchObject({ topic: 'everyday', inSpace: true, spaceRole: 'commenter' });
    await pluginModelComplete(grant(), personal, req);
    expect(h.resolved.at(-1)).not.toHaveProperty('inSpace');
  });

  test(`at most ${MODEL_CALLS_PER_MINUTE} calls a minute per package and user`, async () => {
    const g = grant();
    const outcomes = [];
    for (let i = 0; i < MODEL_CALLS_PER_MINUTE + 2; i++) outcomes.push(await pluginModelComplete(g, personal, req));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(MODEL_CALLS_PER_MINUTE);
    expect(outcomes.at(-1)).toMatchObject({ ok: false, status: 429, code: 'rate_limited' });
    // Another package of the same user has its own bucket.
    expect((await pluginModelComplete(grant(), personal, req)).ok).toBe(true);
  });

  test('the daily token cap and the spend budgets are checked before the call', async () => {
    h.usedToday = 199_990;
    expect(await pluginModelComplete(grant(), personal, req)).toMatchObject({ ok: false, status: 429, code: 'token_cap' });
    h.usedToday = 0;
    h.cap = 0;
    expect(await pluginModelComplete(grant(), personal, req)).toMatchObject({ ok: false, status: 403, code: 'model_off' });
    h.cap = 200_000;
    const spent = new Error('Spend budget exceeded');
    spent.name = 'SpendBudgetExceededError';
    h.spendError = spent;
    expect(await pluginModelComplete(grant(), personal, req)).toMatchObject({ ok: false, status: 429, code: 'spend_budget' });
    expect(h.calls).toEqual([]);
  });
});
