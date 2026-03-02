import { createParameterSchema } from '../base-skill';
import type { AgentContext } from '@/core/types';

type RegisterFn = (name: string, desc: string, params: any, exec: (args: any, ctx: AgentContext) => Promise<any>, opts?: any) => void;
type ApiFn = (userId: string, method: string, path: string, body?: unknown) => Promise<unknown>;

export function registerTodoTools(registerTool: RegisterFn, graphApi: ApiFn): void {
  // --- todo_lists ---
  registerTool(
    'todo_lists',
    'List all Microsoft To Do task lists',
    createParameterSchema({}),
    async (_args: Record<string, unknown>, ctx: AgentContext) => {
      return graphApi(
        ctx.userId,
        'GET',
        '/me/todo/lists?$select=id,displayName,isOwner'
      );
    },
    { permissionAction: 'tasks_read' }
  );

  // --- todo_tasks ---
  registerTool(
    'todo_tasks',
    'List tasks in a Microsoft To Do list',
    createParameterSchema({
      listId: { type: 'string', description: 'The To Do list ID', required: true },
      limit: { type: 'number', description: 'Maximum number of tasks to return (default 20)', default: 20 },
    }),
    async (args: { listId: string; limit?: number }, ctx: AgentContext) => {
      const limit = args.limit ?? 20;
      return graphApi(
        ctx.userId,
        'GET',
        `/me/todo/lists/${args.listId}/tasks?$select=id,title,status,importance,dueDateTime,body&$top=${limit}`
      );
    },
    { permissionAction: 'tasks_read' }
  );

  // --- todo_task_get ---
  registerTool(
    'todo_task_get',
    'Get a specific task from a To Do list',
    createParameterSchema({
      listId: { type: 'string', description: 'The To Do list ID', required: true },
      taskId: { type: 'string', description: 'The task ID', required: true },
    }),
    async (args: { listId: string; taskId: string }, ctx: AgentContext) => {
      return graphApi(
        ctx.userId,
        'GET',
        `/me/todo/lists/${args.listId}/tasks/${args.taskId}`
      );
    },
    { permissionAction: 'tasks_read' }
  );

  // --- todo_task_create ---
  registerTool(
    'todo_task_create',
    'Create a new task in a To Do list',
    createParameterSchema({
      listId: { type: 'string', description: 'The To Do list ID', required: true },
      title: { type: 'string', description: 'Task title', required: true },
      body: { type: 'string', description: 'Task body/description' },
      dueDateTime: { type: 'string', description: 'Due date and time (ISO 8601, e.g. 2025-06-15T09:00:00)' },
      timeZone: { type: 'string', description: 'Time zone for due date (e.g. UTC)', default: 'UTC' },
      importance: { type: 'string', description: 'Task importance', enum: ['low', 'normal', 'high'] },
    }),
    async (args: {
      listId: string;
      title: string;
      body?: string;
      dueDateTime?: string;
      timeZone?: string;
      importance?: string;
    }, ctx: AgentContext) => {
      const task: Record<string, unknown> = {
        title: args.title,
      };

      if (args.body) {
        task.body = { content: args.body, contentType: 'text' };
      }

      if (args.dueDateTime) {
        task.dueDateTime = {
          dateTime: args.dueDateTime,
          timeZone: args.timeZone ?? 'UTC',
        };
      }

      if (args.importance) {
        task.importance = args.importance;
      }

      return graphApi(ctx.userId, 'POST', `/me/todo/lists/${args.listId}/tasks`, task);
    },
    { permissionAction: 'tasks_write' }
  );

  // --- todo_task_complete ---
  registerTool(
    'todo_task_complete',
    'Mark a task as completed in a To Do list',
    createParameterSchema({
      listId: { type: 'string', description: 'The To Do list ID', required: true },
      taskId: { type: 'string', description: 'The task ID to complete', required: true },
    }),
    async (args: { listId: string; taskId: string }, ctx: AgentContext) => {
      return graphApi(
        ctx.userId,
        'PATCH',
        `/me/todo/lists/${args.listId}/tasks/${args.taskId}`,
        { status: 'completed' }
      );
    },
    { permissionAction: 'tasks_write' }
  );
}
