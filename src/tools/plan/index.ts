import type { ToolManifest } from '@/core/types';
import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import { toolLogger } from '@/utils/logger';
import { BaseTool, createParameterSchema } from '../base-tool';

/**
 * plan — read and revise the plan of the pipeline the caller is running in.
 *
 * The plan is the list a `foreach` node iterates, and it is deliberately LIVE:
 * a planner writes the initial items, and any later node may append what it
 * discovers instead of either doing that work out of turn or dropping it. The
 * loop re-reads the list every pass, so an appended item is picked up in the
 * same run.
 *
 * Scoping is not negotiable: every call resolves the pipeline from the caller's
 * own context, never from an argument. A worker that could name the pipeline
 * could name someone else's.
 */
export class PlanTool extends BaseTool {
  readonly id = 'plan';
  readonly name = 'Plan';
  readonly version = '1.0.0';
  readonly description =
    "Read and revise the running pipeline's plan — the list of work items the pipeline loops over.";

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: "Read the running pipeline's plan", defaultLevel: 'ALLOW' },
        { action: 'write', description: "Add or update items on the running pipeline's plan", defaultLevel: 'ALLOW' },
      ],
      tools: [
        {
          name: 'add_items',
          description: 'Append work items to the running pipeline plan.',
          parameters: {
            items: { type: 'array', description: 'Items to append', required: true },
          },
          returns: 'The appended items',
        },
        {
          name: 'list_items',
          description: 'List the running pipeline plan with each item’s status.',
          parameters: {},
          returns: 'The plan items in iteration order',
        },
        {
          name: 'update_item',
          description: 'Change one plan item’s title, detail, or status.',
          parameters: {
            id: { type: 'string', description: 'Plan item id', required: true },
          },
          returns: 'The updated item',
        },
      ],
    };
  }

  /**
   * The pipeline this caller belongs to. Injected by the pipeline manager into
   * the worker context; absent for anything not running inside a pipeline,
   * which is a refusal rather than a fallback.
   */
  private pipelineIdOf(context: { metadata?: Record<string, unknown> | unknown }): string | null {
    const meta = (context.metadata ?? {}) as Record<string, unknown>;
    const id = meta.pipelineId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  private nodeKeyOf(context: { metadata?: Record<string, unknown> | unknown }): string | null {
    const meta = (context.metadata ?? {}) as Record<string, unknown>;
    const key = meta.nodeKey;
    return typeof key === 'string' && key.length > 0 ? key : null;
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'add_items',
      'Append work items to the plan of the pipeline you are running in. Use this when you are the ' +
        'planning step, and use it again whenever you DISCOVER work that is out of scope for the item ' +
        'you were given — the loop picks up appended items in the same run. Each item should be one ' +
        'independently completable piece of work.',
      createParameterSchema({
        items: {
          type: 'array',
          description:
            'Items to append. Each is `{ "title": string, "detail"?: string }`. A plain string is ' +
            'accepted and read as the title.',
          required: true,
          items: { type: 'object' },
        },
      }),
      async (args, context) => {
        const pipelineId = this.pipelineIdOf(context);
        if (!pipelineId) return { error: 'Not running inside a pipeline — there is no plan to add to.' };

        const raw = Array.isArray(args.items) ? args.items : [];
        const parsed = raw
          .map((item) => {
            if (typeof item === 'string') return { title: item.trim(), detail: undefined };
            const rec = (item ?? {}) as Record<string, unknown>;
            return {
              title: String(rec.title ?? '').trim(),
              detail: rec.detail == null ? undefined : String(rec.detail),
            };
          })
          .filter((item) => item.title.length > 0);

        if (parsed.length === 0) return { error: 'No items with a title were provided.' };

        const start = await pipelineRepository.nextPlanOrdinal(pipelineId);
        const created = await pipelineRepository.addPlanItems(
          parsed.map((item, i) => ({
            pipelineId,
            ordinal: start + i,
            title: item.title,
            detail: item.detail,
            createdByNodeKey: this.nodeKeyOf(context),
          })),
        );
        toolLogger.info({ pipelineId, added: created.length }, 'Plan items appended');
        return { added: created.length, items: created.map((i) => ({ id: i.id, ordinal: i.ordinal, title: i.title })) };
      },
      { permissionAction: 'write' },
    );

    this.registerTool(
      'list_items',
      'List the plan of the pipeline you are running in, with each item’s status. Use it to check ' +
        'what is already planned before appending something that is a duplicate.',
      createParameterSchema({}),
      async (_args, context) => {
        const pipelineId = this.pipelineIdOf(context);
        if (!pipelineId) return { error: 'Not running inside a pipeline — there is no plan to read.' };
        const items = await pipelineRepository.getPlanItems(pipelineId);
        return items.map((i) => ({ id: i.id, ordinal: i.ordinal, title: i.title, detail: i.detail, status: i.status }));
      },
      { permissionAction: 'read' },
    );

    this.registerTool(
      'update_item',
      'Change one plan item — its title, its detail, or its status. Mark an item `skipped` when it ' +
        'turns out to be unnecessary; do NOT mark an item `done` yourself, the pipeline does that when ' +
        'the item has actually been carried through the loop.',
      createParameterSchema({
        id: { type: 'string', description: 'Plan item id (from list_items)', required: true },
        title: { type: 'string', description: 'New title' },
        detail: { type: 'string', description: 'New detail' },
        status: { type: 'string', description: "New status: 'pending' or 'skipped'", enum: ['pending', 'skipped'] },
      }),
      async (args, context) => {
        const pipelineId = this.pipelineIdOf(context);
        if (!pipelineId) return { error: 'Not running inside a pipeline — there is no plan to update.' };

        const id = String(args.id ?? '');
        const items = await pipelineRepository.getPlanItems(pipelineId);
        // Scope check: an id from another pipeline must not resolve here.
        const item = items.find((i) => i.id === id);
        if (!item) return { error: `No plan item '${id}' on this pipeline.` };
        // A settled item stays settled. Flipping `done` back to `pending` hands
        // the loop the same item again on the next pass, forever.
        if (item.status === 'done' || item.status === 'failed') {
          return { error: `Plan item '${id}' is already ${item.status} and cannot be reopened.` };
        }

        const patch: Record<string, unknown> = {};
        if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
        if (typeof args.detail === 'string') patch.detail = args.detail;
        // `done` and `failed` are the pipeline's to set — a worker claiming an
        // item is finished is exactly the self-report the evidence gates exist
        // to stop counting as proof.
        if (args.status === 'pending' || args.status === 'skipped') patch.status = args.status;
        if (Object.keys(patch).length === 0) return { error: 'Nothing to update.' };

        const updated = await pipelineRepository.updatePlanItem(id, patch);
        return updated ? { id: updated.id, title: updated.title, status: updated.status } : { error: 'Update failed.' };
      },
      { permissionAction: 'write' },
    );
  }
}

export default PlanTool;
