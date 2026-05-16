import { getTaskStateRepository } from '@/db/repositories/task-state-repository';
import type { ToolManifest } from '@/core/types';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * Memory-redesign Phase B — sibling-agent discovery.
 *
 * Reads `task_state` rows so a spawned specialist can see what its
 * peers in the same session have produced. Replaces the
 * pre-redesign pattern where sibling outputs were retrieved via
 * cosine similarity over RAG `agent_output` rows.
 *
 * Two tools:
 *   - list_recent_session_tasks: discovery — what peers have done
 *   - read_task_state: details — full inputs/outputs of one task
 *
 * Permission: ALLOW by default. The data is session-scoped and lives
 * in the same DB the agents already share; no extra trust surface.
 */
export class TaskStateTool extends BaseTool {
  readonly id = 'task_state';
  readonly name = 'Task State';
  readonly version = '1.0.0';
  readonly description = 'Read sibling-agent outputs and workflow state for the current session.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'Read task_state rows for the current session', defaultLevel: 'ALLOW' },
      ],
      tools: [
        {
          name: 'list_recent_session_tasks',
          description: 'List recent task_state rows in this session (newest first).',
          parameters: {
            limit: { type: 'number', description: 'Max rows to return (default 20)' },
            status: { type: 'string', description: 'Filter: pending | in_progress | done | cancelled | failed' },
            owner_agent: { type: 'string', description: 'Filter by role id (e.g. "coding", "research")' },
          },
          returns: 'Array of {id, owner_agent, task_kind, status, updated_at, output_preview}',
        },
        {
          name: 'read_task_state',
          description: 'Read full inputs/outputs of one task_state row by id.',
          parameters: {
            id: { type: 'string', description: 'task_state.id from list_recent_session_tasks', required: true },
          },
          returns: 'Full task_state row including inputs and outputs payloads',
        },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list_recent_session_tasks',
      'Discover what sibling agents have produced in this session. Use this BEFORE re-doing work a peer already finished — task_kind="agent_output" rows from role X mean role X already ran. Returns newest first; output is a preview only, call read_task_state for the full payload. Returns [] when no peers have completed (you may be the first specialist).',
      createParameterSchema({
        limit: { type: 'number', description: 'Max rows to return (default 20, max 100)', default: 20 },
        status: { type: 'string', description: 'Filter to a single status. Omit for all.' },
        owner_agent: { type: 'string', description: 'Filter to one role id. Omit for all.' },
      }),
      async (args, context) => {
        const repo = getTaskStateRepository();
        const requestedLimit = (args.limit as number) || 20;
        const limit = Math.min(Math.max(requestedLimit, 1), 100);
        const rows = await repo.listSessionRecent(context.sessionId, limit);
        const status = args.status as string | undefined;
        const ownerAgent = args.owner_agent as string | undefined;
        const filtered = rows.filter((r) =>
          (!status || r.status === status) && (!ownerAgent || r.ownerAgent === ownerAgent),
        );
        return {
          count: filtered.length,
          tasks: filtered.map((r) => {
            const out = r.outputs as Record<string, unknown>;
            const text = typeof out?.text === 'string' ? out.text : JSON.stringify(out);
            return {
              id: r.id,
              owner_agent: r.ownerAgent,
              task_kind: r.taskKind,
              status: r.status,
              updated_at: r.updatedAt,
              output_preview: text.length > 240 ? `${text.slice(0, 240)}…` : text,
            };
          }),
        };
      },
      { permissionAction: 'read' },
    );

    this.registerTool(
      'read_task_state',
      'Read the full inputs and outputs of a single task_state row. Use this after list_recent_session_tasks identifies a sibling result worth examining in depth.',
      createParameterSchema({
        id: { type: 'string', description: 'The task_state.id from list_recent_session_tasks', required: true },
      }),
      async (args, context) => {
        const repo = getTaskStateRepository();
        const row = await repo.getById(args.id as string);
        if (!row) return { error: 'Task not found.' };
        // Session isolation: an agent must not read tasks from another
        // session. Cheap defence-in-depth alongside the role-level allow.
        if (row.sessionId !== context.sessionId) {
          return { error: 'Task is not in the current session.' };
        }
        return {
          id: row.id,
          owner_agent: row.ownerAgent,
          task_kind: row.taskKind,
          status: row.status,
          inputs: row.inputs,
          outputs: row.outputs,
          error: row.error,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        };
      },
      { permissionAction: 'read' },
    );
  }
}

export const taskStateTool = new TaskStateTool();
