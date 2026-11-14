/**
 * A tool's image (view_image, a screenshot): taken off the result text and
 * shown in one user message after the batch's tool results — only to a model
 * that is shown images after a tool result (`see`, set per request).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { messageRepository } from '@/db/repositories/message-repository';
import { withToolMedia } from './media/tool-media';
import type { ToolHandler } from './agent-base';
import { ToolExecutor } from './tool-executor';
import type { AgentContext } from './types';

const ctx = (): AgentContext => ({
  space: null, trigger: 'user', funding: 'own', id: 'agent-media', sessionId: '00000000-0000-0000-0000-000000000000',
  userId: 'user-test', model: 'test', topic: '', role: 'general', root: true, status: 'running',
  createdAt: new Date(), updatedAt: new Date(), metadata: {},
});
const ref = { kind: 'image' as const, path: '/w/.octipus/media/cache/a.png', mimeType: 'image/png', source: 'user' as const };
const shot: ToolHandler = { name: 'shot', toolId: 'agent', description: 'shot', parameters: {}, execute: async () => withToolMedia({ path: 'a.png' }, [ref]) };
const plain: ToolHandler = { name: 'plain', toolId: 'agent', description: 'plain', parameters: {}, execute: async () => 'ok' };

beforeEach(() => { vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never); });
afterEach(() => { vi.restoreAllMocks(); });

describe('tool media', () => {
  test('a model shown images gets one user message with the images after all tool results; no media key in the text', async () => {
    const exec = new ToolExecutor(ctx(), () => {});
    exec.registerTool(shot); exec.registerTool(plain);
    exec.setOwnCapabilities({ see: true });
    const out = await exec.handleToolCalls([{ id: '1', name: 'shot', arguments: {} }, { id: '2', name: 'plain', arguments: {} }]);
    const tools = out.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools.some((m) => m.content.includes('__showModel'))).toBe(false);
    const lastTool = out.lastIndexOf(tools[1]);
    const shown = out.findIndex((m) => m.role === 'user' && m.media?.length);
    expect(shown).toBeGreaterThan(lastTool);
    expect(out[shown].media).toEqual([{ ...ref, source: 'tool' }]);
  });

  test('a model that is not shown images gets the path only', async () => {
    const exec = new ToolExecutor(ctx(), () => {});
    exec.registerTool(shot);
    exec.setOwnCapabilities({ see: false });
    const out = await exec.handleToolCalls([{ id: '1', name: 'shot', arguments: {} }]);
    expect(out.some((m) => m.media?.length)).toBe(false);
    expect(out.find((m) => m.role === 'tool')?.content).toContain('a.png');
  });
});
