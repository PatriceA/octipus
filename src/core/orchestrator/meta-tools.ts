import type { ToolHandler } from '@/core/agent-worker';
import type { OrchestratorService } from './service';
import { createHandoffContext, formatHandoff } from './handoff';

/**
 * Create meta-tools for the orchestrator agent.
 * These are ToolHandlers that the orchestrator LLM can call via function calling.
 * Instead of filesystem/shell/git, these control the orchestration flow.
 *
 * A unified `delegationDone` guard prevents the orchestrator from spawning
 * multiple workers or pipelines.  After a delegation tool returns, the
 * orchestrator MUST respond with plain text — any further delegation calls
 * are rejected with an error telling the LLM to just answer.
 */
export function createMetaTools(orchestrator: OrchestratorService): ToolHandler[] {
  // Unified guard: once ANY delegation tool (spawn_worker / spawn_team / create_pipeline)
  // has been called, no further delegation is allowed.
  let delegationDone = false;

  const ALREADY_DELEGATED_MSG =
    'A worker/team/pipeline has already completed for this request. ' +
    'You MUST now respond to the user with a plain-text summary of the result. ' +
    'Do NOT call any more tools. Just write your final answer.';

  return [
    {
      name: 'spawn_worker',
      final: true,
      description:
        'Spawn a specialist worker agent to perform a specific task. ' +
        'The worker runs autonomously and returns its result. ' +
        'You may only delegate ONCE per request (spawn_worker OR create_pipeline, not both). ' +
        'After receiving the result, respond to the user directly with plain text.',
      parameters: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: ['research', 'coding', 'review', 'qa', 'communication', 'design', 'devops', 'security', 'data', 'ai', 'finance', 'automation', 'pm', 'writing', 'general'],
            description:
              'The specialist role. research=web browsing/search, coding=filesystem/shell/git, review=code analysis, qa=browser testing, communication=email/calendar/contacts, design=UI/UX, devops=CI/CD/infra/containers/docker, security=security analysis, data=databases/data engineering, ai=ML/AI tasks, finance=financial analysis, automation=workflows, pm=project management, writing=documentation, general=basic tasks including real browser interaction',
          },
          task: {
            type: 'string',
            description: 'Clear description of what the worker should accomplish',
          },
          input: {
            type: 'string',
            description: 'Optional context, data, or previous results to pass to the worker',
          },
        },
        required: ['role', 'task'],
      },
      execute: async (args, context) => {
        if (delegationDone) throw new Error(ALREADY_DELEGATED_MSG);
        delegationDone = true;
        const result = await orchestrator.spawnWorker(
          args.role as string,
          args.task as string,
          (args.input as string) || '',
          context,
        );

        // Generate a brief structured handoff summary for the orchestrator
        const resultStr = String(result || '');
        try {
          const handoff = await createHandoffContext({
            from: { role: args.role as string },
            to: { role: 'orchestrator' },
            originalRequest: args.task as string,
            stageOutput: resultStr,
          });
          return `${resultStr}\n\n---\n${formatHandoff(handoff)}`;
        } catch {
          return result;
        }
      },
    },
    {
      name: 'spawn_team',
      final: true,
      description:
        'Spawn multiple specialist workers in parallel to handle a task that needs simultaneous expertise. ' +
        'Each member runs concurrently and results are merged into a structured report. ' +
        'Use this ONLY when the task genuinely needs multiple specialists working at the same time. ' +
        'You may only delegate ONCE per request (spawn_worker, spawn_team, OR create_pipeline). ' +
        'After receiving the result, respond to the user directly with plain text.',
      parameters: {
        type: 'object',
        properties: {
          members: {
            type: 'array',
            description: 'Team members to spawn in parallel',
            minItems: 2,
            maxItems: 5,
            items: {
              type: 'object',
              properties: {
                role: {
                  type: 'string',
                  enum: ['research', 'coding', 'review', 'qa', 'communication', 'general'],
                  description: 'The specialist role for this team member',
                },
                task: {
                  type: 'string',
                  description: 'Clear description of what this member should accomplish',
                },
                input: {
                  type: 'string',
                  description: 'Optional context or data to pass to this member',
                },
              },
              required: ['role', 'task'],
            },
          },
        },
        required: ['members'],
      },
      execute: async (args, context) => {
        if (delegationDone) throw new Error(ALREADY_DELEGATED_MSG);
        delegationDone = true;
        const result = await orchestrator.spawnTeam(
          args.members as Array<{ role: string; task: string; input?: string }>,
          context,
        );

        // Generate a brief structured handoff summary for the orchestrator
        const resultStr = String(result || '');
        try {
          const members = args.members as Array<{ role: string; task: string }>;
          const handoff = await createHandoffContext({
            from: { role: members.map(m => m.role).join('+') },
            to: { role: 'orchestrator' },
            originalRequest: members.map(m => m.task).join('; '),
            stageOutput: resultStr,
          });
          return `${resultStr}\n\n---\n${formatHandoff(handoff)}`;
        } catch {
          return result;
        }
      },
    },
    {
      name: 'create_pipeline',
      final: true,
      description:
        'Create a multi-stage pipeline for complex tasks (e.g., development projects). ' +
        'Each stage runs a specialist worker in sequence, with optional approval checkpoints. ' +
        'Use this ONLY for tasks that explicitly need multiple stages (research → plan → code → review → test). ' +
        'For simple single-role tasks, prefer spawn_worker instead. ' +
        'You may only delegate ONCE per request.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short title for the pipeline',
          },
          type: {
            type: 'string',
            enum: ['development', 'research', 'general'],
            description:
              'Pipeline template type. development=full dev cycle (research→plan→code→review→qa), research=investigation+analysis, general=single worker',
          },
          description: {
            type: 'string',
            description: 'Detailed description of what the pipeline should achieve',
          },
        },
        required: ['title', 'type', 'description'],
      },
      execute: async (args, context) => {
        if (delegationDone) throw new Error(ALREADY_DELEGATED_MSG);
        delegationDone = true;
        return orchestrator.createAndRunPipeline(
          args.title as string,
          args.type as string,
          args.description as string,
          context,
        );
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
        'Send a progress update to the user. Use this to keep the user informed about long-running tasks.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Status message to display to the user',
          },
          stage: {
            type: 'string',
            description: 'Current stage name (e.g., "Research", "Implementation")',
          },
          progress: {
            type: 'number',
            description: 'Progress percentage (0-100)',
          },
        },
        required: ['message'],
      },
      execute: async (args, context) => {
        return orchestrator.sendStatusUpdate(
          args.message as string,
          context,
          args.stage as string | undefined,
          args.progress as number | undefined,
        );
      },
    },
  ];
}
