import type { AgentContext, ToolManifest } from '@/core/types';
import { scopedRepos } from '@/db/repositories/scoped';
import type { Principal } from '@/security/principal';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * Personal tasks tool (feature #6). Lets the agent read, create, and complete
 * the calling user's tasks — "remind me to…", action items from reader/research,
 * "what's due today". Operates STRICTLY on the caller's own tasks via the scoped
 * repo (a non-admin principal built from the execution context), so there is no
 * cross-tenant path. Writes default to ASK; listing is ALLOW.
 */
export class TasksTool extends BaseTool {
  // id stays 'tasks' (route /tasks, role allowlists) — only the user-facing
  // name is the "To-Do List" concept.
  readonly id = 'tasks';
  readonly name = 'To-Do List';
  readonly version = '1.0.0';
  readonly description = 'Manage the user\'s to-do list — create, list, update, and complete to-do items.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'List the user\'s own tasks', defaultLevel: 'ALLOW' },
        { action: 'write', description: 'Create, update, or complete the user\'s tasks', defaultLevel: 'ASK' },
      ],
      tools: [
        { name: 'list_tasks', description: 'List the user\'s tasks (optionally filter by status or due-today)', parameters: {}, returns: 'Array of tasks' },
        { name: 'create_task', description: 'Create a new task', parameters: {}, returns: 'The created task' },
        { name: 'update_task', description: 'Update a task\'s fields', parameters: {}, returns: 'The updated task' },
        { name: 'complete_task', description: 'Mark a task as done', parameters: {}, returns: 'The completed task' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list_tasks',
      'List the user\'s tasks. Optional: status ("open"|"done"|"archived") and dueToday (only tasks due by end of today).',
      createParameterSchema({
        status: { type: 'string', description: 'Filter by status', enum: ['open', 'done', 'archived'] },
        dueToday: { type: 'boolean', description: 'Only tasks due by end of today' },
      }),
      async (args, context) => {
        const principal = this.principalFor(context);
        let dueBefore: Date | undefined;
        if (args.dueToday) {
          dueBefore = new Date();
          dueBefore.setHours(23, 59, 59, 999);
        }
        const tasks = await scopedRepos(principal).tasks.listOwn({
          status: args.status as string | undefined,
          dueBefore,
        });
        return { tasks: tasks.map(summarize) };
      },
      { requiresPermission: true, permissionAction: 'read' },
    );

    this.registerTool(
      'create_task',
      'Create a new task for the user. Set source to record where it came from (e.g. "agent", "reader", "research", "email").',
      createParameterSchema({
        title: { type: 'string', description: 'Task title', required: true },
        notes: { type: 'string', description: 'Optional details' },
        priority: { type: 'number', description: 'Priority 0 (none) to 3 (high)' },
        dueAt: { type: 'string', description: 'Due date/time, ISO 8601' },
        source: { type: 'string', description: 'Provenance', enum: ['user', 'agent', 'reader', 'research', 'email'], default: 'agent' },
      }),
      async (args, context) => {
        const principal = this.principalFor(context);
        const task = await scopedRepos(principal).tasks.create({
          title: args.title as string,
          notes: (args.notes as string | undefined) ?? null,
          priority: clampPriority(args.priority),
          dueAt: parseDueAt(args.dueAt),
          source: normalizeSource(args.source),
          sourceRef: context.sessionId ? { sessionId: context.sessionId } : undefined,
        });
        return { created: true, task: summarize(task) };
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'update_task',
      'Update a task\'s title, notes, status, priority, or due date.',
      createParameterSchema({
        id: { type: 'string', description: 'Task id', required: true },
        title: { type: 'string', description: 'New title' },
        notes: { type: 'string', description: 'New notes' },
        status: { type: 'string', description: 'open|done|archived', enum: ['open', 'done', 'archived'] },
        priority: { type: 'number', description: 'Priority 0..3' },
        dueAt: { type: 'string', description: 'Due date/time, ISO 8601' },
      }),
      async (args, context) => {
        const principal = this.principalFor(context);
        const repo = scopedRepos(principal).tasks;
        const existing = await repo.findById(args.id as string);
        if (!existing) return { error: 'Task not found' };
        const status = args.status as string | undefined;
        const task = await repo.update(args.id as string, {
          title: args.title as string | undefined,
          notes: args.notes as string | undefined,
          status,
          priority: args.priority !== undefined ? clampPriority(args.priority) : undefined,
          dueAt: args.dueAt ? parseDueAt(args.dueAt) : undefined,
          ...completionPatch(status, Boolean(existing.completedAt)),
        });
        return { updated: true, task: task ? summarize(task) : null };
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'complete_task',
      'Mark a task as done.',
      createParameterSchema({
        id: { type: 'string', description: 'Task id', required: true },
      }),
      async (args, context) => {
        const principal = this.principalFor(context);
        const repo = scopedRepos(principal).tasks;
        const existing = await repo.findById(args.id as string);
        if (!existing) return { error: 'Task not found' };
        // Idempotent: keep the original completedAt if already done.
        const task = await repo.update(args.id as string, {
          status: 'done',
          ...completionPatch('done', Boolean(existing.completedAt)),
        });
        if (!task) return { error: 'Task not found' };
        return { completed: true, task: summarize(task) };
      },
      { requiresPermission: true, permissionAction: 'write' },
    );
  }

  /** Build a non-admin principal scoped to the calling user. Own tasks only. */
  private principalFor(context: AgentContext): Principal {
    if (!context.userId) {
      throw new Error('Tasks tool requires an authenticated user context (userId missing)');
    }
    return {
      kind: 'user',
      userId: context.userId,
      username: context.userId,
      isAdmin: false,
      sessionToken: null,
      roles: ['user'],
      workspaceId: context.workspaceId ?? null,
    };
  }
}

function clampPriority(p: unknown): number {
  const n = typeof p === 'number' ? p : Number.parseInt(String(p ?? 0), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(3, Math.trunc(n)));
}

const TASK_SOURCES = new Set(['user', 'agent', 'reader', 'research', 'email']);
/** Constrain the LLM-supplied source to the canonical set. */
function normalizeSource(s: unknown): string {
  return typeof s === 'string' && TASK_SOURCES.has(s) ? s : 'agent';
}

/** Parse an optional ISO due-date; returns null on absent/garbage rather than NaN. */
function parseDueAt(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

function completionPatch(nextStatus: string | undefined, wasCompleted: boolean): { completedAt?: Date | null } {
  if (nextStatus === 'done' && !wasCompleted) return { completedAt: new Date() };
  if (nextStatus && nextStatus !== 'done' && wasCompleted) return { completedAt: null };
  return {};
}

function summarize(t: {
  id: string; title: string; status: string; priority: number;
  dueAt: Date | null; completedAt: Date | null; source: string; notes: string | null;
}) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueAt: t.dueAt,
    completedAt: t.completedAt,
    source: t.source,
    notes: t.notes,
  };
}

export const tasksTool = new TasksTool();
