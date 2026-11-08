import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentContext } from '@/core/types';
import { getAgentHooks } from '@/core/agent/hooks';
import { GatewayEventBus } from '@/core/gateway/event-bus';
import { ToolExecutor } from '@/core/tool-executor';
import { getPermissionRuleEngine } from '@/security/permission-rules';
import { getToolRegistry } from '@/tools/registry';
import { buildExtensionContext } from './api';

/**
 * An extension tool goes through the real middleware and executor: the
 * permission action its `effect` maps to decides, and a `tool:after`
 * redaction is what the model, the UI event and the audit row receive.
 */

const userId = '33333333-3333-3333-3333-333333333333';
const sessionId = '44444444-4444-4444-4444-444444444444';

function context(): AgentContext {
  return { space: null, trigger: 'user', funding: 'own', id: randomUUID(), sessionId, userId, workspaceId: null, attended: false,
    role: 'coding', model: 'fixture', topic: 'coding', status: 'running',
    createdAt: new Date(), updatedAt: new Date(), metadata: {} };
}

const calls: string[] = [];
let dispose: () => Promise<void>;

beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'octipus-ext-dispatch-'));
  process.env.STORAGE_MODE = 'embedded'; process.env.DATA_DIR = join(directory, 'db');
  const { initializeDb } = await import('@/db/postgres'); await initializeDb();
  const { runMigrations } = await import('@/db/migrate'); await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'ext-dispatch' }]);
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  await sessionRepository.create({ id: sessionId, userId, channelType: 'webchat', channelId: 'ext-dispatch' });

  const { api, loaded } = buildExtensionContext('vault', '/trusted/vault/index.ts', new GatewayEventBus(), true);
  const params = { type: 'object' as const, properties: { key: { type: 'string', description: 'Key' } }, required: ['key'] };
  api.registerTool({ id: 'peek', description: 'Read a value', effect: 'read', parameters: params,
    handler: (args) => { calls.push('peek'); return { value: `${args.key}=sk-live-123` }; } });
  api.registerTool({ id: 'put', description: 'Store a value', effect: 'write', parameters: params,
    handler: () => { calls.push('put'); return { ok: true }; } });
  api.registerTool({ id: 'send', description: 'Send a value out', effect: 'external', parameters: params,
    handler: () => { calls.push('send'); return { ok: true }; } });
  dispose = () => loaded.dispose();
  await vi.waitFor(() => expect(getToolRegistry().isInitialized('ext_vault')).toBe(true));
});

afterAll(async () => {
  await dispose();
  const { closeDb } = await import('@/db/postgres'); await closeDb();
});

afterEach(() => {
  calls.length = 0;
  getAgentHooks()._clearForTesting();
  getPermissionRuleEngine().load({});
});

async function run(name: string, emitted: Array<[string, unknown]> = []) {
  const executor = new ToolExecutor(context(), (type, data) => { emitted.push([type, data]); });
  executor.registerTool(getToolRegistry().findTool(name)!);
  const messages = await executor.handleToolCalls([{ id: randomUUID(), name, arguments: { key: 'k' } }]);
  return messages.find((m) => m.role === 'tool')?.content ?? '';
}

describe('extension tools through the executor', () => {
  test('read is allowed by default and runs', async () => {
    expect(await run('ext_vault__peek')).toContain('k=sk-live-123');
    expect(calls).toEqual(['peek']);
  });

  test('write asks by default: an unattended call is blocked before the handler runs', async () => {
    expect(await run('ext_vault__put')).toContain('Approval required');
    expect(calls).toEqual([]);
  });

  test('external asks even under a broad allow rule (dangerous)', async () => {
    getPermissionRuleEngine().load({ allow: ['ext_vault(*)'] });
    expect(await run('ext_vault__send')).toContain('Approval required');
    expect(calls).toEqual([]);
    // The same rule does lift a write.
    expect(await run('ext_vault__put')).not.toContain('Approval required');
    expect(calls).toEqual(['put']);
  });

  test('a tool:after redaction is what the model and the UI event get', async () => {
    getAgentHooks().register('tool:after', (ctx) => {
      ctx.result = JSON.parse(JSON.stringify(ctx.result).replace(/sk-[\w-]+/g, '[redacted]'));
    });
    const emitted: Array<[string, unknown]> = [];
    const content = await run('ext_vault__peek', emitted);
    expect(content).toContain('k=[redacted]');
    expect(content).not.toContain('sk-live-123');
    expect(JSON.stringify(emitted)).not.toContain('sk-live-123');
    const { auditRepository } = await import('@/db/repositories/audit-repository');
    // The newest audit row for this call (an earlier test ran it unredacted).
    const row = (await auditRepository.findBySession(sessionId))
      .find((r) => r.action === 'tool_executed' && r.resourceId === 'ext_vault__peek');
    expect(JSON.stringify(row?.details)).toContain('k=[redacted]');
    expect(JSON.stringify(row?.details)).not.toContain('sk-live-123');
  });

  test('a tool:after handler that throws withholds the result', async () => {
    getAgentHooks().register('tool:after', () => { throw new Error('redactor offline'); });
    const content = await run('ext_vault__peek');
    expect(calls).toEqual(['peek']);
    expect(content).toContain('tool:after hook failed: redactor offline');
    expect(content).not.toContain('sk-live-123');
  });
});
