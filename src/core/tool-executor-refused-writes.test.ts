import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { messageRepository } from '@/db/repositories/message-repository';
import type { ToolHandler } from './agent-base';
import { FILE_CHANGE_TOOLS, FILE_CHANGES_REFUSED_KEY, ToolExecutor } from './tool-executor';
import type { AgentContext } from './types';

/**
 * Plan mode and a space turn that may not write keep the root's file-changing
 * handlers DECLARED, so flipping the mode leaves the cached tool list intact,
 * and refuse every call to one here instead. A refusal that only lived in the
 * prompt would be a request; this is the boundary, so it is pinned on both the
 * model's path and a codemode script's.
 */

function makeContext(metadata: Record<string, unknown>): AgentContext {
  return {
    space: null, trigger: 'user', funding: 'own',
    id: 'agent-refused-writes',
    sessionId: '00000000-0000-0000-0000-000000000000',
    userId: 'user-test',
    model: 'test',
    topic: '',
    role: 'general',
    root: true,
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata,
  };
}

// `toolId: 'agent'` skips permission gating, so a call that is refused is
// refused by the overlay and by nothing else.
const handler = (name: string, execute: ToolHandler['execute']): ToolHandler => ({
  name, toolId: 'agent', description: name, parameters: {}, execute,
});

beforeEach(() => {
  vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('file changes refused on a turn that may not make them', () => {
  test.each(['plan_mode', 'space_role'] as const)('%s: every file-changing handler is refused before it runs; reads run', async (reason) => {
    const ran: string[] = [];
    const exec = new ToolExecutor(makeContext({ [FILE_CHANGES_REFUSED_KEY]: reason }), () => {});
    const names = [...FILE_CHANGE_TOOLS, 'filesystem__read_file'];
    for (const name of names) exec.registerTool(handler(name, async () => { ran.push(name); return 'ok'; }));

    const messages = await exec.handleToolCalls(names.map((name, i) => ({ id: String(i), name, arguments: { path: 'a.txt' } })));

    expect(ran).toEqual(['filesystem__read_file']);
    expect(messages).toHaveLength(names.length);
    const refusals = messages.slice(0, FILE_CHANGE_TOOLS.size).map((m) => String(m.content));
    for (const text of refusals) expect(text).toMatch(reason === 'plan_mode' ? /Plan mode is on/ : /may not change files/);
    expect(exec.getSideEffectCounters().filesChanged).toBe(0);
    // The handlers stay declared: the tool list is what the cache is keyed on.
    for (const name of FILE_CHANGE_TOOLS) expect(exec.getTools().has(name)).toBe(true);
  });

  test('a codemode script cannot write around the refusal', async () => {
    const write = vi.fn(async () => 'ok');
    const exec = new ToolExecutor(makeContext({ [FILE_CHANGES_REFUSED_KEY]: 'plan_mode' }), () => {});
    exec.registerTool(handler('filesystem__write_file', write));
    const result = await exec.runNestedCall({ id: 'n1', name: 'filesystem__write_file', arguments: { path: 'a.txt', content: 'x' } });
    expect(write).not.toHaveBeenCalled();
    expect(result).toMatchObject({ errorCode: 'permission_denied', error: expect.stringMatching(/Plan mode is on/) });
  });

  test('without the key, writes run as before', async () => {
    const write = vi.fn(async () => 'ok');
    const exec = new ToolExecutor(makeContext({}), () => {});
    exec.registerTool(handler('filesystem__write_file', write));
    await exec.handleToolCalls([{ id: '1', name: 'filesystem__write_file', arguments: { path: 'a.txt', content: 'x' } }]);
    expect(write).toHaveBeenCalledOnce();
  });
});

describe('plan mode also refuses repository writes', () => {
  const repoTool = (name: string, toolId: string, permissionAction: string, replaySafety?: 'read_only'): ToolHandler => ({
    name, toolId, description: name, parameters: {}, permissionAction, ...(replaySafety ? { replaySafety } : {}),
    execute: async () => 'ran',
  });

  test.each([
    ['git__commit', 'git', 'write'],
    ['git__push', 'git', 'push'],
    ['github__create_pull_request', 'github', 'write'],
  ])('%s (%s/%s) is refused before it runs', async (name, toolId, action) => {
    const execute = vi.fn(async () => 'ran');
    const exec = new ToolExecutor(makeContext({ [FILE_CHANGES_REFUSED_KEY]: 'plan_mode' }), () => {});
    exec.registerTool({ ...repoTool(name, toolId, action), execute });
    const [msg] = await exec.handleToolCalls([{ id: '1', name, arguments: {} }]);
    expect(execute).not.toHaveBeenCalled();
    expect(String(msg.content)).toMatch(/Plan mode is on: .* changes a repository/);
  });

  test('an action computed from the arguments is refused when it writes (git branch with a name)', async () => {
    const execute = vi.fn(async () => 'ran');
    const exec = new ToolExecutor(makeContext({ [FILE_CHANGES_REFUSED_KEY]: 'plan_mode' }), () => {});
    exec.registerTool({ name: 'git__branch', toolId: 'git', description: 'b', parameters: {}, execute,
      permissionAction: (args: Record<string, unknown>) => (args.name ? 'write' : 'read') });
    const [msg] = await exec.handleToolCalls([{ id: '1', name: 'git__branch', arguments: { name: 'feat', checkout: true } }]);
    expect(execute).not.toHaveBeenCalled();
    expect(String(msg.content)).toMatch(/Plan mode is on/);
  });
});
