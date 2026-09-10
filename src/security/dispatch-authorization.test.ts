import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentContext, ToolManifest } from '@/core/types';
import { BaseTool } from '@/tools/base-tool';
import { getToolRegistry } from '@/tools/registry';
import { getPermissionManager } from './permissions';
import { getPermissionRuleEngine } from './permission-rules';
import { ToolExecutor } from '@/core/tool-executor';
import { getAgentHooks } from '@/core/agent/hooks';

const userId = '11111111-1111-1111-1111-111111111111';
const sessionId = '22222222-2222-2222-2222-222222222222';
let directory: string;
class WriteTool extends BaseTool {
  readonly id = 'acceptance-write'; readonly name = 'Acceptance writer';
  readonly description = 'Write an isolated fixture'; readonly version = '1';
  getManifest(): ToolManifest { return { id: this.id, name: this.name, description: this.description,
    version: this.version, permissions: [{ action: 'write', description: 'Write', defaultLevel: 'ASK' }], tools: [] }; }
  protected async registerTools() {
    this.registerTool('write', 'Write fixture', { type: 'object', required: ['path', 'content'] },
      async args => { writeFileSync(String(args.path), String(args.content)); return { path: args.path }; },
      { permissionAction: 'write', injectSecrets: false });
  }
}
const writer = new WriteTool();
function context(attended = false): AgentContext {
  return { id: randomUUID(), sessionId, userId, workspaceId: null, attended,
    role: 'coding', model: 'fixture', topic: 'coding', status: 'running',
    createdAt: new Date(), updatedAt: new Date(), metadata: {} };
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'octipus-dispatch-'));
  process.env.STORAGE_MODE = 'embedded'; process.env.DATA_DIR = join(directory, 'db');
  const { initializeDb } = await import('@/db/postgres'); await initializeDb();
  const { runMigrations } = await import('@/db/migrate'); await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'dispatch' }]);
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  await sessionRepository.create({ id: sessionId, userId, channelType: 'webchat', channelId: 'acceptance' });
  await getToolRegistry().register(writer);
});
afterAll(async () => { const { closeDb } = await import('@/db/postgres'); await closeDb(); });
beforeEach(async () => {
  getPermissionRuleEngine().load({});
  await getPermissionManager().setPermission(userId, writer.id, 'write', 'ASK');
});
function args() { return { path: join(directory, randomUUID() + '.txt'), content: 'verified outside the agent' }; }
function run(ctx: AgentContext, input: Record<string, unknown>) {
  const executor = new ToolExecutor(ctx, () => {});
  executor.registerTool(writer.getToolHandlers()[0]);
  return executor.handleToolCalls([{ id: randomUUID(), name: `${writer.id}__write`, arguments: input }]);
}

describe('real middleware and executor authorization', () => {
  test('direct unattended call cannot write on ASK', async () => {
    const input = args();
    await expect(writer.getToolHandlers()[0].execute(input, context())).rejects.toMatchObject({ code: 'approval_required' });
    expect(existsSync(input.path)).toBe(false);
  });
  test('child executor reports blocked, with no filesystem side effect', async () => {
    const input = args(); const result = await run(context(), input);
    expect(result.find(m => m.role === 'tool')?.content).toContain('Approval required'); expect(existsSync(input.path)).toBe(false);
  });
  test('stored denial wins over a broad allow rule in both paths', async () => {
    getPermissionRuleEngine().load({ allow: [`${writer.id}(*)`] });
    await getPermissionManager().setPermission(userId, writer.id, 'write', 'DENY');
    const input = args();
    await expect(writer.getToolHandlers()[0].execute(input, context())).rejects.toThrow('denied');
    expect((await run(context(), input)).find(m => m.role === 'tool')?.content).toContain('denied');
    expect(existsSync(input.path)).toBe(false);
  });
  test('an attended child prompts exactly once and writes only after approval', async () => {
    const input = args(); let prompts = 0;
    const pm = getPermissionManager();
    const stop = pm.onRequest(request => { prompts++; expect(existsSync(input.path)).toBe(false); void pm.approve(request.requestId, userId); });
    try { expect((await run(context(true), input)).find(m => m.role === 'tool')?.content).not.toContain('Error:'); }
    finally { stop(); }
    expect(prompts).toBe(1); expect(readFileSync(input.path, 'utf8')).toBe(input.content);
  });
  test('session grant is enforced again in middleware and cannot broaden to another session', async () => {
    const pm = getPermissionManager();
    await pm.setPermission(userId, writer.id, 'write', 'ALLOW', {
      conditions: [{ type: 'session', value: sessionId }], expiresAt: new Date(Date.now() + 60_000),
    });
    const input = args(); expect((await run(context(), input)).find(m => m.role === 'tool')?.content).not.toContain('Error:');
    expect(readFileSync(input.path, 'utf8')).toBe(input.content);
    const outside = args();
    await expect(writer.getToolHandlers()[0].execute(outside, { ...context(), sessionId: randomUUID() })).rejects.toMatchObject({ code: 'approval_required' });
    expect(existsSync(outside.path)).toBe(false);
  });
  test('expired and revoked grants cannot execute', async () => {
    const pm = getPermissionManager();
    await pm.setPermission(userId, writer.id, 'write', 'ALLOW', { expiresAt: new Date(Date.now() - 1) });
    const input = args(); expect((await run(context(), input)).find(m => m.role === 'tool')?.content).toContain('Approval required');
    await pm.setPermission(userId, writer.id, 'write', 'DENY');
    expect((await run(context(), input)).find(m => m.role === 'tool')?.content).toContain('Permission denied'); expect(existsSync(input.path)).toBe(false);
  });
  test('cancelled approval never executes and duplicate approval does not revive it', async () => {
    const pm = getPermissionManager(); const ctx = context(true); const input = args();
    let requestId = '';
    const stop = pm.onRequest(request => { requestId = request.requestId; pm.cancelWaits(ctx.id); });
    try { await expect(run(ctx, input)).rejects.toThrow('not granted'); } finally { stop(); }
    expect(existsSync(input.path)).toBe(false);
    expect(await pm.approve(requestId, userId)).toBe(false);
  });
  test('argument rewriting cannot reuse approval for a different file', async () => {
    const pm = getPermissionManager(); const input = args(); const changed = args();
    let prompts = 0;
    const stop = pm.onRequest(request => {
      prompts++;
      if (prompts === 1) void pm.approve(request.requestId, userId);
      else void pm.deny(request.requestId, userId);
    });
    const unhook = getAgentHooks().register('tool:before', async event => {
      event.args = { ...event.args, path: changed.path };
    });
    try { await run(context(true), input); } finally { stop(); unhook(); }
    expect(prompts).toBe(2); expect(existsSync(input.path)).toBe(false); expect(existsSync(changed.path)).toBe(false);
  });
  test('approval received before waitForApproval is retained', async () => {
    const pm = getPermissionManager();
    const id = await pm.requestApproval(userId, randomUUID(), writer.id, 'write', args(), sessionId);
    expect(await pm.approve(id, userId)).toBe(true);
    expect(await pm.approve(id, userId)).toBe(false);
    expect(await pm.waitForApproval(id)).toBe(true);
  });
  test('MCP direct and lazy executor paths refuse ASK before reaching transport', async () => {
    const { MCPBridge } = await import('@/mcp/bridge');
    const bridge = new MCPBridge(); let calls = 0;
    const connections = (bridge as unknown as { connections: Map<string, unknown> }).connections;
    connections.set('fixture', { id: 'fixture', status: 'connected', server: { name: 'Fixture' },
      tools: [{ name: 'write', description: 'Write', inputSchema: {} }],
      transport: { send: () => { calls++; } }, protocol: { sendRequest: async () => { calls++; return { ok: true }; } } });
    await expect(bridge.callTool('fixture', 'write', args(), context())).rejects.toMatchObject({ code: 'approval_required' });
    const executor = new ToolExecutor(context(), () => {});
    executor.registerTool(bridge.getLazyToolHandlers().find(t => t.name === 'mcp_call_tool')!);
    const result = await executor.handleToolCalls([{ id: randomUUID(), name: 'mcp_call_tool', arguments: { server_id: 'fixture', tool_name: 'write', arguments: args() } }]);
    expect(result.find(m => m.role === 'tool')?.content).toContain('Approval required'); expect(calls).toBe(0);
    await getPermissionManager().setPermission(userId, 'mcp', 'fixture.write', 'ALLOW', {
      conditions: [{ type: 'session', value: sessionId }], expiresAt: new Date(Date.now() + 60_000),
    });
    await bridge.callTool('fixture', 'write', args(), context()); expect(calls).toBe(1);
    await getPermissionManager().setPermission(userId, 'mcp', 'fixture.write', 'DENY');
    await expect(bridge.callTool('fixture', 'write', args(), context())).rejects.toThrow('denied'); expect(calls).toBe(1);
  });

});
