import type { ToolHandler } from '@/core/agent-worker';
import { createSpawnChildTool } from '@/core/swarm/swarm-tool';
import type { AgentNode } from '@/core/swarm/types';
import type { OrchestratorService } from './service';

/**
 * Create meta-tools for the orchestrator agent.
 * These are ToolHandlers that the orchestrator LLM can call via function calling.
 * Instead of filesystem/shell/git, these control the orchestration flow.
 *
 * `spawn_child` is the primary delegation mechanism (see swarm-design.md);
 * `create_pipeline` is a last-resort tool for user-requested staged handover.
 * Pipelines are single-shot — once one is created, no further delegation is
 * allowed in this turn.
 */
export function createMetaTools(
  orchestrator: OrchestratorService,
  options?: { parentNode?: AgentNode },
): ToolHandler[] {
  // Pipeline gate: once `create_pipeline` runs, further delegation is blocked.
  // `spawn_child` is NOT gated — multiple swarm calls per turn are explicitly
  // allowed (swarm-design.md §Spawn Mechanics).
  let pipelineCreated = false;

  const PIPELINE_ALREADY_CREATED_MSG =
    'A pipeline has already been created for this request. ' +
    'You MUST now respond to the user with a plain-text summary of the result. ' +
    'Do NOT call any more tools. Just write your final answer.';

  const tools: ToolHandler[] = [];

  // Swarm: register `spawn_child` on the Orchestrator (depth 0). Only
  // available when the service has built a parent node — it's a no-op hook
  // in contexts where the swarm wiring hasn't been threaded (e.g. legacy
  // unit tests that call createMetaTools directly).
  if (options?.parentNode) {
    tools.push(createSpawnChildTool(options.parentNode));
  }

  tools.push(
    {
      name: 'create_pipeline',
      final: true,
      description:
        'LAST RESORT delegation. Create a multi-stage sequential pipeline with handover between stages. ' +
        'Use ONLY when the user EXPLICITLY asks for staged execution with handover ' +
        '(e.g., "first research, then implement, then review"). ' +
        'DO NOT use for analysis/audit/review/quality-check requests — use multiple spawn_child calls instead. ' +
        'DO NOT use because you think it will be "more thorough" — pipelines lose context between stages and are slow. ' +
        'For any single- or parallel-role task, use spawn_child (multiple calls per turn allowed). ' +
        'create_pipeline may only be invoked ONCE per request. ' +
        'IMPORTANT: You MUST call list_pipeline_templates first to get valid template names. Do NOT invent template names.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short title for the pipeline',
          },
          templateName: {
            type: 'string',
            description:
              'Exact name or ID of an existing pipeline template. Call list_pipeline_templates first to see available templates.',
          },
          description: {
            type: 'string',
            description: 'Detailed description of what the pipeline should achieve',
          },
          maxRetries: {
            type: 'number',
            description: 'Max QA retry attempts before escalating (default 3)',
          },
        },
        required: ['title', 'templateName', 'description'],
      },
      execute: async (args, context) => {
        if (pipelineCreated) throw new Error(PIPELINE_ALREADY_CREATED_MSG);

        // Validate template exists before creating pipeline
        const templateName = args.templateName as string;
        const { listAvailableTemplates } = await import('./templates');
        const userId = (context as any).userId;
        const templates = await listAvailableTemplates(userId);
        const templateNames = templates.map(t => t.name);
        const match = templates.find(t =>
          t.name.toLowerCase() === templateName.toLowerCase() || t.id === templateName
        );
        if (!match) {
          return `Template "${templateName}" not found. Available templates: ${templateNames.join(', ') || 'none'}. ` +
            (templateNames.length === 0
              ? 'No templates exist. Use spawn_child for any delegation needs, or ask the user to create a pipeline template.'
              : 'Use one of the listed templates, or use spawn_child for simpler tasks.');
        }

        pipelineCreated = true;
        return orchestrator.createAndRunPipeline(
          args.title as string,
          match.name,
          args.description as string,
          context,
          { maxRetries: args.maxRetries as number | undefined },
        );
      },
    },
    {
      name: 'list_pipeline_templates',
      description:
        'List available pipeline templates that can be used with create_pipeline. ' +
        'Returns template names, descriptions, and stage counts.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args, context) => {
        const { listAvailableTemplates } = await import('./templates');
        const userId = (context as any).userId;
        const templates = await listAvailableTemplates(userId);
        if (templates.length === 0) {
          return 'No pipeline templates configured. Ask the user to create pipeline templates in the Pipelines page.';
        }
        return templates.map(t =>
          `- **${t.name}**${t.isPreset ? ' (preset)' : ''}: ${t.description || 'No description'} (${t.stageCount} stages)`
        ).join('\n');
      },
    },
    {
      name: 'filter_pii',
      description:
        'Filter personally identifiable information (emails, phone numbers, API keys, etc.) from text before forwarding to external models. Use this before passing user content to non-local models.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to filter PII from',
          },
        },
        required: ['text'],
      },
      execute: async (args) => {
        return orchestrator.filterPIIText(args.text as string);
      },
    },
    {
      name: 'remember_this',
      description:
        'Promote one durable fact about the user into long-term memory. Use SPARINGLY — only when the user states something the next session genuinely needs to recall (preference, profile fact, recurring workflow note). Do NOT use for one-shot intents, transient task state, or facts about anyone other than the user. The fact must be one sentence, third-person about the user. PII is auto-redacted; do not pre-redact.',
      parameters: {
        type: 'object',
        properties: {
          fact: {
            type: 'string',
            description: 'One sentence, third-person about the user. Example: "The user prefers tabs over spaces for indentation."',
          },
          fact_type: {
            type: 'string',
            enum: ['preference', 'profile', 'relationship', 'skill_observation', 'workflow_note'],
            description: 'Canonical fact category. Pick the closest match.',
          },
          confidence: {
            type: 'number',
            description: 'Confidence 0.5–1.0. Use 1.0 for explicit statements ("I always use tabs"), 0.5 for inferred.',
          },
        },
        required: ['fact', 'fact_type'],
      },
      execute: async (args, context) => {
        const fact = String(args.fact).trim();
        if (fact.length < 5) {
          return { stored: false, reason: 'fact too short' };
        }
        const factType = String(args.fact_type);
        const confidence = typeof args.confidence === 'number'
          ? Math.max(0.5, Math.min(1.0, args.confidence as number))
          : 1.0;

        const { judgeAndApply } = await import('@/core/memory');
        const outcomes = await judgeAndApply(
          [{ factType, content: fact, confidence }],
          {
            userId: context.userId,
            workspaceId: (context.workspaceId ?? null) as string | null,
            agentScope: null,
            sourceMessageId: null,
          },
        );
        const outcome = outcomes[0];
        if (!outcome) return { stored: false, reason: 'judge returned no outcome' };
        return {
          stored: outcome.action !== 'NOOP',
          action: outcome.action,
          memory_id: outcome.memoryId,
          fact: outcome.candidate.content, // PII-redacted form
        };
      },
    },
    {
      name: 'request_user_approval',
      description:
        'Pause execution and ask the user for approval before proceeding. Use this at important decision points (e.g., before starting implementation after a plan is created).',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Summary of what has been done so far',
          },
          question: {
            type: 'string',
            description: 'The specific question or decision for the user',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of choices for the user',
          },
        },
        required: ['summary', 'question'],
      },
      execute: async (args, context) => {
        return orchestrator.requestApproval(
          args.summary as string,
          args.question as string,
          context,
          args.options as string[] | undefined,
        );
      },
    },
    {
      name: 'send_status_update',
      description:
        'Send an OPTIONAL progress update to the user during a long-running task. ' +
        'DO NOT use this to deliver the final answer — the final answer is your plain-text ' +
        'reply in the next LLM turn after all tool calls return. ' +
        'NEVER call send_status_update as your terminal action: after a child returns, respond directly. ' +
        'This tool is for mid-flight heartbeat messages only, and must NOT be called more than 2 times per request.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Short progress message (e.g., "Spawning research agent…", "Compiling results…"). Not the final answer.',
          },
          stage: {
            type: 'string',
            description: 'Current stage name (e.g., "Research", "Synthesis")',
          },
          progress: {
            type: 'number',
            description: 'Progress percentage (0-100)',
          },
        },
        required: ['message'],
      },
      execute: async (args, context) => {
        const message = args.message as string;
        // Safety net: some LLMs use `send_status_update` as their terminal
        // action instead of returning plain text. Stash the last message on
        // the agent context — if the worker ends with empty content, the
        // orchestrator service falls back to this so the user sees SOMETHING
        // instead of a blank reply.
        const meta = context.metadata as Record<string, unknown>;
        meta.lastStatusMessage = message;
        if (typeof args.progress === 'number') meta.lastStatusProgress = args.progress;
        return orchestrator.sendStatusUpdate(
          message,
          context,
          args.stage as string | undefined,
          args.progress as number | undefined,
        );
      },
    },
  );

  return tools;
}
