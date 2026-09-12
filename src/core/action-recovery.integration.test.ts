import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { initializeDb, closeDb } from '@/db/postgres';
import { runMigrations } from '@/db/migrate';
import { seedUsers } from '@/test-helpers/multiuser-fixtures';
import { ToolActionRepository, toolActionRepository } from '@/db/repositories/tool-action-repository';
import { ActionRecovery } from './action-recovery';
import { getPermissionManager } from '@/security/permissions';
import { BaseTool } from '@/tools/base-tool';
import { getToolRegistry } from '@/tools/registry';
import { ToolExecutor } from './tool-executor';
import type { AgentContext, ToolManifest } from './types';

const userId = randomUUID();
let directory: string;
const context = (): AgentContext => ({ id: randomUUID(), userId, sessionId: randomUUID(), attended: true,
  root: true, role: 'general', model: 'fixture', topic: '', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} });
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'octipus-action-recovery-'));
  process.env.STORAGE_MODE = 'embedded'; process.env.DATA_DIR = join(directory, 'db');
  await initializeDb(); await runMigrations();
  await seedUsers([{ id: userId, username: 'action-recovery' }]);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await closeDb(); });

describe('action evidence survives a database reopen', () => {
  test('a side effect with missing completion evidence is not silently repeated after restart', async () => {
    const ctx = context(); const repository = new ToolActionRepository();
    const recovery = new ActionRecovery(repository); const file = join(directory, 'sent.txt');
    const finish = vi.spyOn(repository, 'finish').mockRejectedValue(new Error('connection lost after remote success'));
    const send = async () => { appendFileSync(file, 'sent\n'); return 'delivered'; };
    expect(await recovery.run(ctx, 'mail', 'mail__send', { secret: 'must-not-be-stored' }, send)).toBe('delivered');
    finish.mockRestore();
    await closeDb(); await initializeDb();
    const pending = await repository.pending(userId, ctx.sessionId);
    expect(pending).toHaveLength(1); expect(pending[0].status).toBe('started');
    expect(JSON.stringify(pending)).not.toContain('must-not-be-stored');
    const manager = getPermissionManager();
    const unsubscribe = manager.onRequest(request => { void manager.deny(request.requestId, userId); });
    try {
      await expect(new ActionRecovery(repository).run(ctx, 'mail', 'mail__send', { secret: 'changed' }, send)).rejects.toThrow('not granted');
    } finally { unsubscribe(); }
    expect(readFileSync(file, 'utf8')).toBe('sent\n');
    expect((await repository.pending(userId, ctx.sessionId))[0].reviewedAt).toBeNull();
  });

  test('repository acknowledgement cannot cross user or session boundaries', async () => {
    const repository = new ToolActionRepository(); const ctx = context(); const id = randomUUID();
    await repository.start({ id, userId, sessionId: ctx.sessionId, agentId: ctx.id, toolId: 'mail', toolName: 'send', argumentHash: 'hash', status: 'started' });
    await repository.acknowledge(randomUUID(), ctx.sessionId, [id], 'wrong-user');
    await repository.acknowledge(userId, randomUUID(), [id], 'wrong-session');
    expect((await repository.pending(userId, ctx.sessionId))[0].reviewedAt).toBeNull();
    await repository.acknowledge(userId, ctx.sessionId, [id], 'correct-review');
    expect(await repository.pending(userId, ctx.sessionId)).toEqual([]);
  });
});

class FixtureTool extends BaseTool {
  readonly id = `recovery-fixture-${randomUUID()}`; readonly name = 'Recovery fixture'; readonly description = ''; readonly version = '1';
  calls = 0;
  getManifest(): ToolManifest { return { id: this.id, name: this.name, description: '', version: '1',
    permissions: [{ action: 'write', description: 'Write', defaultLevel: 'ALLOW' }], tools: [] }; }
  protected async registerTools() {
    this.registerTool('send', 'Simulated external action', { type: 'object', properties: {} }, async () => { this.calls++; return 'sent'; },
      { permissionAction: 'write', injectSecrets: false });
    this.registerTool('inspect', 'Read only reconciliation', { type: 'object', properties: {} }, async () => 'observed',
      { permissionAction: 'read', injectSecrets: false });
  }
}

test('executor and BaseTool journal once; read-only reconciliation remains available', async () => {
  const tool = new FixtureTool(); await getToolRegistry().register(tool);
  const ctx = context(); const manager = getPermissionManager();
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  await sessionRepository.create({ id: ctx.sessionId, userId, channelType: 'webchat', channelId: 'recovery-test' });
  await manager.setPermission(userId, tool.id, 'write', 'ALLOW');
  await manager.setPermission(userId, tool.id, 'read', 'ALLOW');
  const executor = new ToolExecutor(ctx, () => {}); executor.registerTools(tool.getToolHandlers());
  const start = vi.spyOn(toolActionRepository, 'start');
  const finish = vi.spyOn(toolActionRepository, 'finish').mockRejectedValueOnce(new Error('completion write lost'));
  const result = await executor.handleToolCalls([{ id: 'first', name: `${tool.id}__send`, arguments: {} }]);
  expect(result[0].content).toBe('sent'); expect(tool.calls).toBe(1); expect(start).toHaveBeenCalledTimes(1);
  expect(await toolActionRepository.pending(userId, ctx.sessionId)).toHaveLength(1);
  const read = await executor.handleToolCalls([{ id: 'read', name: `${tool.id}__inspect`, arguments: {} }]);
  expect(read[0].content).toBe('observed'); expect(start).toHaveBeenCalledTimes(1);
  finish.mockRestore();
  const unsubscribe = manager.onRequest(request => { void manager.deny(request.requestId, userId); });
  try { await executor.handleToolCalls([{ id: 'retry', name: `${tool.id}__send`, arguments: {} }]); }
  finally { unsubscribe(); }
  expect(tool.calls).toBe(1);
});

test('a shell timeout after a side effect remains uncertain and cannot silently run again', async () => {
  const { LocalShellOperations } = await import('@/tools/shell/local-operations');
  const ctx = context(); const repo = new ToolActionRepository(); const recovery = new ActionRecovery(repo);
  const file = join(directory, 'timeout-effect.txt');
  const command = 'echo sent >> timeout-effect.txt; sleep 2';
  const execute = () => new LocalShellOperations().exec(command, directory, { unsafe: true, timeout: 100 });
  const result = await recovery.run(ctx, 'shell', 'shell__run', { command }, execute);
  expect(result.timedOut).toBe(true);
  expect((await repo.pending(userId, ctx.sessionId))[0].status).toBe('uncertain');
  const manager = getPermissionManager();
  const unsubscribe = manager.onRequest(request => { void manager.deny(request.requestId, userId); });
  try { await expect(recovery.run(ctx, 'shell', 'shell__run', { command }, execute)).rejects.toThrow('not granted'); }
  finally { unsubscribe(); }
  expect(readFileSync(file, 'utf8')).toBe('sent\n');
});

test('revoking normal tool permission during recovery consent still prevents the action', async () => {
  const tool = new FixtureTool(); await getToolRegistry().register(tool);
  const ctx = context(); const manager = getPermissionManager();
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  await sessionRepository.create({ id: ctx.sessionId, userId, channelType: 'webchat', channelId: 'revoke-recovery' });
  await manager.setPermission(userId, tool.id, 'write', 'ALLOW');
  await toolActionRepository.start({ id: randomUUID(), userId, sessionId: ctx.sessionId, agentId: 'old',
    toolId: 'mail', toolName: 'send', argumentHash: 'hash', status: 'uncertain' });
  const unsubscribe = manager.onRequest(request => {
    void manager.setPermission(userId, tool.id, 'write', 'DENY').then(() => manager.approve(request.requestId, userId));
  });
  const executor = new ToolExecutor(ctx, () => {}); executor.registerTools(tool.getToolHandlers());
  try {
    const result = await executor.handleToolCalls([{ id: 'revoked', name: `${tool.id}__send`, arguments: {} }]);
    expect(result[0].content).toContain('Permission changed');
  } finally { unsubscribe(); }
  expect(tool.calls).toBe(0);
  expect(await toolActionRepository.pending(userId, ctx.sessionId)).toEqual([]);
});

test('deleting a session removes its recovery evidence', async () => {
  const ctx = context();
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  await sessionRepository.create({ id: ctx.sessionId, userId, channelType: 'webchat', channelId: 'delete-recovery' });
  await toolActionRepository.start({ id: randomUUID(), userId, sessionId: ctx.sessionId, agentId: ctx.id,
    toolId: 'mail', toolName: 'send', argumentHash: 'hash', status: 'started' });
  expect(await sessionRepository.delete(ctx.sessionId)).toBe(true);
  expect(await toolActionRepository.pending(userId, ctx.sessionId)).toEqual([]);
});
