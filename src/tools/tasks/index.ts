import { auditTaskMutation, changedTaskFields, type TaskMutationOp } from '@/core/tasks/audit';
import { addBacklog, parseBacklog } from '@/core/tasks/backlog';
import { nextActions } from '@/core/tasks/next';
import { dateOnlyToEndOfDay } from '@/core/tasks/rank';
import { ACTIVE_TASK_STATUSES, assigneePatch, TASK_ASSIGNEE_KINDS, TASK_STATUSES } from '@/core/tasks/status';
import { type Nested, nestTasks, normalizeEstimate, toLookup, waitingOn, waitingReason } from '@/core/tasks/structure';
import { resolveUserTimezone } from '@/core/tasks/timezone';
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
        { name: 'list_tasks', description: 'List the user\'s tasks (filter by status / due-today / category, or view "next" for next-action order with a reason each); sub-tasks come nested under their parent', parameters: {}, returns: 'Array of tasks' },
        { name: 'create_task', description: 'Create a new task', parameters: {}, returns: 'The created task' },
        { name: 'add_tasks', description: 'Add a whole backlog at once — phases, sub-tasks, estimates and dependencies', parameters: {}, returns: 'The created tasks' },
        { name: 'update_task', description: 'Update a task\'s fields', parameters: {}, returns: 'The updated task' },
        { name: 'complete_task', description: 'Mark a task as done', parameters: {}, returns: 'The completed task' },
        { name: 'checkout_task', description: 'Claim a task so no other agent works it (or release the claim)', parameters: {}, returns: 'The claimed task, or who holds it' },
        { name: 'add_task_comment', description: 'Leave a comment (progress, hand-off, question) on a task', parameters: {}, returns: 'The comment' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list_tasks',
      'List the user\'s tasks. Optional: status ("open"|"in_progress"|"done"|"archived"; default: open and in progress) and dueToday (only tasks due by end of today). Sub-tasks are nested under their parent as `children`; a task that cannot start yet says why in `waiting` (blocked by an open task, or sub-tasks still open). view "next" returns active tasks ranked in next-action order (in progress → overdue → due today → high priority → new from email/research → due this week → backlog → waiting), each with a one-line reason.',
      createParameterSchema({
        status: { type: 'string', description: 'Filter by status; "all" for every status', enum: [...TASK_STATUSES, 'all'] },
        dueToday: { type: 'boolean', description: 'Only tasks due by end of today' },
        category: { type: 'string', description: 'Filter to a category/list (e.g. "Shopping"); "none" for uncategorized' },
        view: { type: 'string', description: '"next" = open tasks in next-action order with a reason each', enum: ['next'] },
        assigneeKind: { type: 'string', description: 'Only tasks assigned to this kind of assignee', enum: [...TASK_ASSIGNEE_KINDS] },
        assigneeRef: { type: 'string', description: 'Only tasks assigned to this user / role / node id' },
        limit: { type: 'number', description: 'Max tasks to return for view "next" (default 10)' },
      }),
      async (args, context) => {
        const principal = this.principalFor(context);
        if (args.view === 'next') {
          const limit = Math.max(1, Math.min(50, Math.trunc(Number(args.limit) || 10)));
          const { timezone, ranked } = await nextActions(principal, { category: args.category as string | undefined, limit });
          return { timezone, tasks: ranked.map((r) => ({ ...summarize(r.task), bucket: r.bucket, reason: r.reason })) };
        }
        let dueBefore: Date | undefined;
        if (args.dueToday) {
          dueBefore = new Date();
          dueBefore.setHours(23, 59, 59, 999);
        }
        const repo = scopedRepos(principal).tasks;
        const status = args.status as string | undefined;
        const [tasks, active] = await Promise.all([
          repo.listOwn({
            status: status && status !== 'all' ? status : undefined,
            statuses: status ? undefined : [...ACTIVE_TASK_STATUSES],
            dueBefore,
            category: args.category as string | undefined,
            assigneeKind: args.assigneeKind as string | undefined,
            assigneeRef: args.assigneeRef as string | undefined,
          }),
          repo.listOwn({ statuses: [...ACTIVE_TASK_STATUSES], limit: 5000 }),
        ]);
        const lookup = toLookup(active);
        return { tasks: nestTasks(tasks).map((t) => summarizeTree(t, lookup)) };
      },
      { requiresPermission: true, permissionAction: 'read' },
    );

    this.registerTool(
      'create_task',
      'Create a new task for the user. Set source to record where it came from (e.g. "agent", "reader", "research", "email"). Set category to file it under a user list (e.g. "Shopping", "House work"). For a whole plan (phases, sub-tasks, dependencies) use add_tasks instead.',
      createParameterSchema({
        title: { type: 'string', description: 'Task title', required: true },
        notes: { type: 'string', description: 'Optional details' },
        priority: { type: 'number', description: 'Priority 0 (none) to 3 (high)' },
        category: { type: 'string', description: 'Optional user category/list, e.g. "Shopping" or "Car"' },
        dueAt: { type: 'string', description: 'Due date/time, ISO 8601' },
        estimate: { type: 'string', description: 'Effort estimate in the user\'s unit, e.g. "S", "M", "L", "XL" or "3h"' },
        parentId: { type: 'string', description: 'Id of the task this is a sub-task of (a phase, an epic)' },
        blockedBy: { type: 'array', description: 'Ids of tasks that must be done before this one can start', items: { type: 'string' } },
        assigneeKind: { type: 'string', description: 'Assign to a user, a role (any agent of it) or a swarm node', enum: [...TASK_ASSIGNEE_KINDS] },
        assigneeRef: { type: 'string', description: 'The user / role / node id the task is assigned to (with assigneeKind)' },
        source: { type: 'string', description: 'Provenance', enum: ['user', 'agent', 'reader', 'research', 'email'], default: 'agent' },
      }),
      async (args, context) => {
        const principal = this.principalFor(context);
        try {
          const values = {
            title: args.title as string,
            notes: (args.notes as string | undefined) ?? null,
            priority: clampPriority(args.priority),
            category: normalizeCategory(args.category),
            dueAt: await parseDueAt(args.dueAt, principal.userId),
            estimate: normalizeEstimate(args.estimate),
            parentId: idOrNull(args.parentId),
            blockedBy: idList(args.blockedBy),
            ...assigneePatch(args.assigneeKind, args.assigneeRef),
            source: normalizeSource(args.source),
            sourceRef: context.sessionId ? { sessionId: context.sessionId } : undefined,
          };
          const task = await scopedRepos(principal).tasks.create(values);
          await auditAgentTaskMutation(context, task.id, 'create', changedTaskFields(values));
          return { created: true, task: summarize(task) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'add_tasks',
      'Add a whole backlog in one call — the way a plan is written, not one create_task per row. Each item is ' +
        '`{ "title", "detail"?, "category"?, "estimate"?, "priority"?, "dueAt"?, "blockedBy"?, "children"? }`; a plain string is a title. ' +
        'Use `category` for the phase (children inherit it), `children` for sub-tasks, `estimate` for size ("S"/"M"/"L"/"XL" or hours), and ' +
        '`blockedBy` for dependencies named by another item\'s title, its "#n" position in the flattened list, or an existing task id. ' +
        'Items are numbered top to bottom, parents before children. A dependency that resolves to nothing fails the whole call and nothing is written.',
      createParameterSchema({
        items: { type: 'array', description: 'Items to add, in plan order', required: true, items: { type: 'object' } },
        source: { type: 'string', description: 'Provenance', enum: ['user', 'agent', 'reader', 'research', 'email'], default: 'agent' },
      }),
      async (args, context) => {
        const principal = this.principalFor(context);
        const parsed = parseBacklog(args.items);
        if (!parsed.ok) return { error: parsed.error };
        // addBacklog writes as it goes, so a failure partway still leaves rows:
        // collect every create as it lands and audit them all either way.
        const created: Array<{ taskId: string; change: string[] }> = [];
        try {
          const added = await addBacklog(principal, parsed.items, {
            source: normalizeSource(args.source),
            sourceRef: context.sessionId ? { sessionId: context.sessionId } : undefined,
            onCreated: (task, values) => created.push({ taskId: task.id, change: changedTaskFields(values) }),
          });
          return { added: added.length, tasks: added.map((a) => ({ index: a.index, ...summarize(a.task) })) };
        } catch (err) {
          return { error: (err as Error).message };
        } finally {
          await Promise.all(created.map((c) => auditAgentTaskMutation(context, c.taskId, 'create', c.change)));
        }
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'update_task',
      'Update a task\'s title, notes, status, priority, category, due date, estimate, parent, blockers, or assignee. Set status "in_progress" when work on it starts.',
      createParameterSchema({
        id: { type: 'string', description: 'Task id', required: true },
        title: { type: 'string', description: 'New title' },
        notes: { type: 'string', description: 'New notes' },
        status: { type: 'string', description: 'open|in_progress|done|archived', enum: [...TASK_STATUSES] },
        priority: { type: 'number', description: 'Priority 0..3' },
        category: { type: 'string', description: 'User category/list; empty string clears it' },
        dueAt: { type: 'string', description: 'Due date/time, ISO 8601' },
        estimate: { type: 'string', description: 'Effort estimate; empty string clears it' },
        parentId: { type: 'string', description: 'Id of the parent task; empty string makes it top-level' },
        blockedBy: { type: 'array', description: 'Ids of tasks that block this one (replaces the list; empty clears it)', items: { type: 'string' } },
        assigneeKind: { type: 'string', description: 'user|role|node; empty string unassigns', enum: [...TASK_ASSIGNEE_KINDS, ''] },
        assigneeRef: { type: 'string', description: 'The user / role / node id (with assigneeKind)' },
      }),
      async (args, context) => {
        const principal = this.principalFor(context);
        const repo = scopedRepos(principal).tasks;
        const existing = await repo.findById(args.id as string);
        if (!existing) return { error: 'Task not found' };
        const status = args.status as string | undefined;
        try {
          const patch = {
            title: args.title as string | undefined,
            notes: args.notes as string | undefined,
            status,
            priority: args.priority !== undefined ? clampPriority(args.priority) : undefined,
            category: args.category !== undefined ? normalizeCategory(args.category) : undefined,
            // `!== undefined` (not truthiness): an explicit "" clears the due date;
            // absent leaves it unchanged. parseDueAt('') → null (clear).
            dueAt: args.dueAt !== undefined ? await parseDueAt(args.dueAt, principal.userId) : undefined,
            estimate: args.estimate !== undefined ? normalizeEstimate(args.estimate) : undefined,
            parentId: args.parentId !== undefined ? idOrNull(args.parentId) : undefined,
            blockedBy: args.blockedBy !== undefined ? idList(args.blockedBy) : undefined,
            ...assigneePatch(args.assigneeKind, args.assigneeRef),
            ...completionPatch(status, Boolean(existing.completedAt)),
          };
          const task = await repo.update(args.id as string, patch, { asActor: agentActor(context) });
          if (!task) return refusal(await repo.findById(args.id as string));
          const change = changedTaskFields(patch, existing);
          if (change.length > 0) {
            const op = status === 'done' && existing.status !== 'done' ? 'complete' : 'update';
            await auditAgentTaskMutation(context, task.id, op, change);
          }
          return { updated: true, task: summarize(task) };
        } catch (err) {
          return { error: (err as Error).message };
        }
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
        const patch = { status: 'done', ...completionPatch('done', Boolean(existing.completedAt)) };
        const task = await repo.update(args.id as string, patch, { asActor: agentActor(context) });
        if (!task) return refusal(await repo.findById(args.id as string));
        // Already done: nothing changed, nothing to audit (same rule as PATCH).
        if (existing.status !== 'done') {
          await auditAgentTaskMutation(context, task.id, 'complete', changedTaskFields(patch, existing));
        }
        return { completed: true, task: summarize(task) };
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'checkout_task',
      'Claim a task before working on it so no other agent picks it up; it moves to in_progress. Fails with the current holder if another agent has it, or with what it waits on if it is blocked. The claim lapses after 30 minutes unless renewed: claiming a task you already hold is fine and renews it, so check out again on long work. complete_task ends the claim; release: true gives it back unfinished (the task returns to open). While another agent holds a task, update_task and complete_task refuse it.',
      createParameterSchema({
        id: { type: 'string', description: 'Task id', required: true },
        release: { type: 'boolean', description: 'Give the claim back instead of taking it' },
      }),
      async (args, context) => {
        const repo = scopedRepos(this.principalFor(context)).tasks;
        const actor = agentActor(context);
        if (args.release) {
          const released = await repo.release(args.id as string, actor);
          if (released.ok) return { released: true, task: summarize(released.task) };
          if (released.reason === 'not_found') return { error: 'Task not found' };
          return { error: `Task is checked out by ${released.holder}`, holder: released.holder };
        }
        const result = await repo.checkout(args.id as string, actor, context.id || null);
        if (result.ok) return { checkedOut: true, task: summarize(result.task) };
        if (result.reason === 'not_found') return { error: 'Task not found' };
        if (result.reason === 'blocked') return { error: `Task is blocked: ${waitingReason(result.waiting)}`, blocked: true };
        return {
          error: result.holder ? `Task is checked out by ${result.holder}` : `Task is ${result.status}`,
          holder: result.holder,
        };
      },
      { requiresPermission: true, permissionAction: 'write' },
    );

    this.registerTool(
      'add_task_comment',
      'Comment on a task — progress, a hand-off note for the next agent, or a question for the user. Comments are kept on the task in order.',
      createParameterSchema({
        id: { type: 'string', description: 'Task id', required: true },
        body: { type: 'string', description: 'The comment', required: true },
      }),
      async (args, context) => {
        const body = typeof args.body === 'string' ? args.body.trim().slice(0, 10_000) : '';
        if (!body) return { error: 'Comment body is required' };
        const comment = await scopedRepos(this.principalFor(context)).tasks.addComment(args.id as string, {
          authorKind: 'agent',
          authorRef: agentActor(context),
          body,
        });
        if (!comment) return { error: 'Task not found' };
        return { commented: true, comment: { id: comment.id, body: comment.body, createdAt: comment.createdAt } };
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

/**
 * Audit a task mutation made by an agent. The run is the root session, the
 * same id `run_events.run_id` carries for this agent's tool calls.
 */
function auditAgentTaskMutation(context: AgentContext, taskId: string, op: TaskMutationOp, change: string[]): Promise<void> {
  return auditTaskMutation({
    userId: context.userId,
    taskId,
    op,
    change,
    actor: { kind: 'agent', id: context.id },
    runId: context.sessionId ?? null,
  });
}

/**
 * Who the calling agent is on the board — an identity that survives across
 * turns, so the same logical agent can renew, release or finish its own claim
 * later. `context.id` is not it: every spawned agent gets a fresh id. A
 * pipeline stage is `pipeline:<pipelineId>/<nodeKey>` (both inherited by the
 * stage worker and stable across resumes); anything else is
 * `<role>@<sessionId>`, where `sessionId` is the ROOT session (workers inherit
 * it, see worker-spawner). The run-specific `context.id` goes in
 * `checkoutRunId` instead. Two parallel workers of one role in one session
 * share an identity — the price of a stable one without a durable agent id.
 */
function agentActor(context: AgentContext): string {
  const { pipelineId, nodeKey } = (context.metadata ?? {}) as Record<string, unknown>;
  if (typeof pipelineId === 'string' && typeof nodeKey === 'string') return `pipeline:${pipelineId}/${nodeKey}`;
  if (context.sessionId) return `${context.role || 'agent'}@${context.sessionId}`;
  return 'agent';
}

/**
 * Why a tool write came back empty: the task is gone, or another agent holds
 * a live checkout (the repo's UPDATE refused it atomically, see `asActor`).
 * Only the tool enforces the holder; the user's routes override.
 */
function refusal(current: { checkedOutBy: string | null } | null): { error: string; holder?: string } {
  if (!current) return { error: 'Task not found' };
  if (current.checkedOutBy) return { error: `Task is checked out by ${current.checkedOutBy}`, holder: current.checkedOutBy };
  return { error: 'Task changed while updating; try again' };
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

/** Trim an optional category; empty/absent → null (uncategorized). */
function normalizeCategory(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.trim();
  return c === '' ? null : c.slice(0, 100);
}

/**
 * Parse an optional due date; returns null on absent/garbage rather than NaN.
 * A bare `YYYY-MM-DD` means the end of that day in the user's timezone.
 */
async function parseDueAt(v: unknown, userId: string): Promise<Date | null> {
  if (!v || typeof v !== 'string') return null;
  const dateOnly = dateOnlyToEndOfDay(v, await resolveUserTimezone(userId));
  if (dateOnly) return dateOnly;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** An optional id argument: empty/absent → null (clears the link). */
function idOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** An optional id-list argument: strings only, trimmed, de-duplicated. */
function idList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))];
}

function completionPatch(nextStatus: string | undefined, wasCompleted: boolean): { completedAt?: Date | null } {
  if (nextStatus === 'done' && !wasCompleted) return { completedAt: new Date() };
  if (nextStatus && nextStatus !== 'done' && wasCompleted) return { completedAt: null };
  return {};
}

interface SummarizableTask {
  id: string; title: string; status: string; priority: number;
  category: string | null; dueAt: Date | null; completedAt: Date | null; source: string; notes: string | null;
  estimate?: string | null; parentId?: string | null; blockedBy?: string[] | null;
  assigneeKind?: string | null; assigneeRef?: string | null; checkedOutBy?: string | null;
}

function summarize(t: SummarizableTask) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    category: t.category,
    dueAt: t.dueAt,
    completedAt: t.completedAt,
    source: t.source,
    notes: t.notes,
    estimate: t.estimate ?? null,
    parentId: t.parentId ?? null,
    blockedBy: t.blockedBy ?? [],
    assigneeKind: t.assigneeKind ?? null,
    assigneeRef: t.assigneeRef ?? null,
    checkedOutBy: t.checkedOutBy ?? null,
  };
}

type TaskSummary = ReturnType<typeof summarize> & { waiting: string | null; children: TaskSummary[] };

/**
 * A nested task with its `waiting` reason, judged against the active set.
 * Top-level order is the list's (priority, due, newest first); sub-tasks
 * read in the order they were added, which for a plan is the plan's order.
 */
function summarizeTree(node: Nested<SummarizableTask & { createdAt: Date }>, lookup: ReadonlyMap<string, SummarizableTask>): TaskSummary {
  const children = [...node.children].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return {
    ...summarize(node),
    waiting: waitingReason(waitingOn(node, lookup)),
    children: children.map((c) => summarizeTree(c, lookup)),
  };
}

export const tasksTool = new TasksTool();
