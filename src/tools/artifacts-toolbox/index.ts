/**
 * Agent-facing toolbox discovery tools. The catalog itself
 * (`src/core/artifacts/toolbox/`) is too large to inline in a prompt —
 * mirror the skill-discovery pattern instead: list (compact index) →
 * search (ranked match) → describe (full schema + example) → validate
 * (dry-run wiring before publish).
 *
 * The collectors / transforms / widgets these tools point at do NOT
 * appear in the agent's tool space directly. The agent only NAMES them
 * inside an artifact pipeline; refresh / render code dispatches them.
 */

import type { ToolManifest } from '@/core/types';
import {
  ensureToolboxLoaded,
  getToolboxRegistry,
  validatePipeline,
  type PipelineSpec,
  type ToolboxFamily,
} from '@/core/artifacts/toolbox';
import { BaseTool, createParameterSchema } from '../base-tool';

const FAMILY_VALUES: readonly ToolboxFamily[] = ['collect', 'transform', 'widget', 'export'];

const LIST_DESCRIPTION =
  'List artifact-toolbox tools (collectors, transforms, widgets, exporters) as a compact ' +
  'one-line-per-tool index. Optional `family` filter. Pair with `art_toolbox_describe` to ' +
  'get parameters / examples once you have a candidate id.';

const SEARCH_DESCRIPTION =
  'Search the toolbox by free-form query (substring + keyword match against id + ' +
  'description + keywords). Returns up to `k` ranked entries. Use this before ' +
  'authoring a pipeline so you do not invent tool ids that do not exist.';

const DESCRIBE_DESCRIPTION =
  'Get the full manifest for one toolbox tool: parameter schema, return shape, worked ' +
  'examples, default permission tier, common gotchas. Call after `art_toolbox_search` ' +
  'narrows the candidate down to one.';

const VALIDATE_DESCRIPTION =
  'Dry-run a pipeline spec (sources only in Phase 1) against the registry: checks tool ids ' +
  'exist, required parameters present, types match, source names unique. Returns ' +
  '`{ ok, errors[], warnings[] }`. Call before `create_live_artifact` / `update_live_artifact`.';

export class ArtifactsToolboxTool extends BaseTool {
  readonly id = 'artifacts_toolbox';
  readonly name = 'Live Artifacts Toolbox';
  readonly version = '1.0.0';
  readonly description =
    'Discover the catalogue of reusable artifact building blocks (collectors / transforms / widgets / exporters) and validate pipeline wiring before publishing.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        {
          action: 'discover',
          description: 'Read-only access to the toolbox catalogue (list / search / describe / validate).',
          defaultLevel: 'ALLOW',
        },
      ],
      tools: [
        {
          name: 'list',
          description: 'List toolbox tools as a compact index.',
          parameters: {
            family: {
              type: 'string',
              description: 'Filter by family: collect | transform | widget | export.',
              required: false,
            },
          },
          returns: 'Array of `{ id, family, description }`.',
        },
        {
          name: 'search',
          description: 'Hybrid keyword search over toolbox tools.',
          parameters: {
            query: { type: 'string', description: 'Free-form search query.', required: true },
            k: { type: 'number', description: 'Max results. Default 8.', required: false },
          },
          returns: 'Up to k ranked `{ id, family, description }` entries.',
        },
        {
          name: 'describe',
          description: 'Full manifest for one tool (params, examples, tips).',
          parameters: {
            id: { type: 'string', description: 'Tool id, e.g. `art_collect_http_json`.', required: true },
          },
          returns: 'Full `ToolboxDescription` or `null` if unknown.',
        },
        {
          name: 'validate',
          description: 'Dry-run a pipeline spec against the registry.',
          parameters: {
            sources: {
              type: 'array',
              description: 'Array of `{ name, toolId, params, refreshSeconds? }`.',
              required: true,
            },
          },
          returns: '`{ ok, errors[], warnings[] }`.',
        },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'list',
      LIST_DESCRIPTION,
      createParameterSchema({
        family: {
          type: 'string',
          description: 'Optional family filter: collect | transform | widget | export.',
          enum: FAMILY_VALUES as unknown as unknown[],
        },
      }),
      async (args) => {
        await ensureToolboxLoaded();
        const family = typeof args.family === 'string' ? (args.family as ToolboxFamily) : undefined;
        return { tools: getToolboxRegistry().list({ family }) };
      },
      { permissionAction: 'discover' },
    );

    this.registerTool(
      'search',
      SEARCH_DESCRIPTION,
      createParameterSchema({
        query: { type: 'string', description: 'Free-form query.', required: true },
        k: { type: 'number', description: 'Max results.', default: 8 },
      }),
      async (args) => {
        await ensureToolboxLoaded();
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('art_toolbox_search: `query` is required');
        const k = typeof args.k === 'number' && args.k > 0 ? Math.min(args.k, 50) : 8;
        return { tools: getToolboxRegistry().search(query, k) };
      },
      { permissionAction: 'discover' },
    );

    this.registerTool(
      'describe',
      DESCRIBE_DESCRIPTION,
      createParameterSchema({
        id: { type: 'string', description: 'Tool id to describe.', required: true },
      }),
      async (args) => {
        await ensureToolboxLoaded();
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error('art_toolbox_describe: `id` is required');
        const description = getToolboxRegistry().describe(id);
        if (!description) {
          throw new Error(`art_toolbox_describe: unknown tool "${id}" — try art_toolbox_search`);
        }
        return description;
      },
      { permissionAction: 'discover' },
    );

    this.registerTool(
      'validate',
      VALIDATE_DESCRIPTION,
      createParameterSchema({
        sources: {
          type: 'array',
          description: 'Array of `{ name, toolId, params, refreshSeconds? }`.',
          required: true,
        },
        transforms: {
          type: 'array',
          description: 'Array of `{ name, toolId, inputName, params, position? }`.',
        },
        widgets: {
          type: 'array',
          description: 'Array of `{ slot, toolId, bind: { paramName: dataBusPath }, params?, position? }`.',
        },
        exports: {
          type: 'array',
          description: 'Array of `{ exportId, toolId, bind, params? }`.',
        },
      }),
      async (args) => {
        await ensureToolboxLoaded();
        if (!Array.isArray(args.sources)) {
          throw new Error('art_toolbox_validate: `sources` must be an array');
        }
        const spec: PipelineSpec = {
          sources: args.sources as PipelineSpec['sources'],
          transforms: Array.isArray(args.transforms)
            ? (args.transforms as PipelineSpec['transforms'])
            : undefined,
          widgets: Array.isArray(args.widgets)
            ? (args.widgets as PipelineSpec['widgets'])
            : undefined,
          exports: Array.isArray(args.exports)
            ? (args.exports as PipelineSpec['exports'])
            : undefined,
        };
        return validatePipeline(spec);
      },
      { permissionAction: 'discover' },
    );
  }
}

export const artifactsToolboxTool = new ArtifactsToolboxTool();
