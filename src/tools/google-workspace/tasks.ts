import { createParameterSchema } from '../base-tool';
import type { AgentContext } from '@/core/types';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, url: string, body?: unknown) => Promise<unknown>;

const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';

export function registerTasksTools(registerTool: RegisterFn, googleApi: ApiFn): void {
  // --- tasks_lists ---
  registerTool('tasks_lists', 'List all Google Tasks task lists', createParameterSchema({}), async (_args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(context.userId, 'GET', `${TASKS_BASE}/users/@me/lists`);
  }, { permissionAction: 'tasks_read' });

  // --- tasks_list ---
  registerTool('tasks_list', 'List tasks in a specific task list', createParameterSchema({
    listId: { type: 'string', description: 'Task list ID (use tasks_lists to find available lists)', required: true },
    limit: { type: 'number', description: 'Maximum number of tasks (default 25)', default: 25 },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const maxResults = (args.limit as number) || 25;
    return googleApi(
      context.userId,
      'GET',
      `${TASKS_BASE}/lists/${args.listId}/tasks?maxResults=${maxResults}`
    );
  }, { permissionAction: 'tasks_read' });

  // --- tasks_get ---
  registerTool('tasks_get', 'Get details of a specific task', createParameterSchema({
    listId: { type: 'string', description: 'Task list ID', required: true },
    taskId: { type: 'string', description: 'Task ID', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(
      context.userId,
      'GET',
      `${TASKS_BASE}/lists/${args.listId}/tasks/${args.taskId}`
    );
  }, { permissionAction: 'tasks_read' });

  // --- tasks_create ---
  registerTool('tasks_create', 'Create a new task in a task list', createParameterSchema({
    listId: { type: 'string', description: 'Task list ID', required: true },
    title: { type: 'string', description: 'Task title', required: true },
    notes: { type: 'string', description: 'Task notes/description' },
    due: { type: 'string', description: 'Due date in ISO 8601 format (e.g. "2025-06-15T00:00:00Z")' },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    const task: Record<string, unknown> = { title: args.title };
    if (args.notes) task.notes = args.notes;
    if (args.due) task.due = args.due;

    return googleApi(
      context.userId,
      'POST',
      `${TASKS_BASE}/lists/${args.listId}/tasks`,
      task
    );
  }, { permissionAction: 'tasks_write' });

  // --- tasks_complete ---
  registerTool('tasks_complete', 'Mark a task as completed', createParameterSchema({
    listId: { type: 'string', description: 'Task list ID', required: true },
    taskId: { type: 'string', description: 'Task ID to mark as completed', required: true },
  }), async (args: Record<string, unknown>, context: AgentContext) => {
    return googleApi(
      context.userId,
      'PATCH',
      `${TASKS_BASE}/lists/${args.listId}/tasks/${args.taskId}`,
      { status: 'completed' }
    );
  }, { permissionAction: 'tasks_write' });
}
