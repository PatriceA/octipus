/**
 * `complete_taken_task`: offered to the root agent only while its group
 * thread has open taken tasks, and it closes only those
 * (docs/plans/group-chat-bot.md §5).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const fx = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@/core/channels/taken-tasks', () => ({ completeTakenTask: fx.complete }));
import { createMetaTools } from './meta-tools';
import type { AgentService } from './service';

const context = { id: 'agent-1', userId: 'u-anna', sessionId: 'thread-session' } as AgentContext;
const open = [{ id: 'task-1', title: 'Draft the "notes"' }];
const service = {} as AgentService;
const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);

beforeEach(() => fx.complete.mockReset());

describe('complete_taken_task', () => {
  test('offered only while the thread has open taken tasks, and to small models too', () => {
    expect(names(createMetaTools(service))).not.toContain('complete_taken_task');
    expect(names(createMetaTools(service, { takenTasks: [] }))).not.toContain('complete_taken_task');
    expect(names(createMetaTools(service, { takenTasks: open }))).toContain('complete_taken_task');
    expect(names(createMetaTools(service, { takenTasks: open, lite: true }))).toContain('complete_taken_task');
  });

  test('lists the open task ids (no member text in the schema), and closes one through completeTakenTask for this session', async () => {
    const tool = createMetaTools(service, { takenTasks: open }).find((t) => t.name === 'complete_taken_task')!;
    expect(tool.description).toContain('Open task ids: task-1.');
    expect(tool.description).not.toContain('Draft');
    fx.complete.mockResolvedValue({ ok: true, title: 'Draft the notes' });
    const done = await tool.execute({ taskId: 'task-1', result: 'Posted the draft.' }, context);
    expect(fx.complete).toHaveBeenCalledWith({ userId: 'u-anna', sessionId: 'thread-session', taskId: 'task-1', result: 'Posted the draft.', agentId: 'agent-1' });
    expect(done).toMatchObject({ completed: true });

    fx.complete.mockResolvedValue({ ok: false, error: 'No open task with that id was taken on in this thread.' });
    expect(await tool.execute({ taskId: 'other', result: 'x' }, context)).toEqual({ error: 'No open task with that id was taken on in this thread.' });
  });
});
