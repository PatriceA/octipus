import type { ToolHandler } from '@/core/agent-worker';
import type { OrchestratorService } from './service';
import { createHandoffContext, formatHandoff } from './handoff';
import { coreLogger } from '@/utils/logger';

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
        const role = args.role as string;
        const task = args.task as string;
        const result = await orchestrator.spawnWorker(
          role, task, (args.input as string) || '', context,
        );

        // Generate a brief structured handoff summary for the orchestrator
        const resultStr = String(result || '');
        coreLogger.info({
          role, task: task.slice(0, 100),
          resultLength: resultStr.length,
          agentId: context.id,
        }, 'Worker result received by orchestrator');

        try {
          const handoff = await createHandoffContext({
            from: { role },
            to: { role: 'orchestrator' },
            originalRequest: task,
            stageOutput: resultStr,
          });

          // Cap result size to prevent context overflow in orchestrator's next LLM call.
          // The handoff summary contains the essential structured info.
          const MAX_RESULT_FOR_ORCHESTRATOR = 6000;
          let cappedResult = resultStr;
          if (resultStr.length > MAX_RESULT_FOR_ORCHESTRATOR) {
            coreLogger.info({
              role, originalLength: resultStr.length,
              cappedLength: MAX_RESULT_FOR_ORCHESTRATOR,
              agentId: context.id,
            }, 'Capping worker result for orchestrator context');
            cappedResult = resultStr.slice(0, MAX_RESULT_FOR_ORCHESTRATOR)
              + `\n\n[... result truncated from ${resultStr.length} chars — see handoff summary below for key details ...]`;
          }

          return `${cappedResult}\n\n---\n${formatHandoff(handoff)}`;
        } catch {
          // Still cap even without handoff
          if (resultStr.length > 8000) {
            return resultStr.slice(0, 8000) + `\n\n[... truncated from ${resultStr.length} chars]`;
          }
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
        const members = args.members as Array<{ role: string; task: string; input?: string }>;
        const result = await orchestrator.spawnTeam(members, context);

        const resultStr = String(result || '');
        coreLogger.info({
          members: members.map(m => m.role),
          resultLength: resultStr.length,
          agentId: context.id,
        }, 'Team result received by orchestrator');

        try {
          const handoff = await createHandoffContext({
            from: { role: members.map(m => m.role).join('+') },
            to: { role: 'orchestrator' },
            originalRequest: members.map(m => m.task).join('; '),
            stageOutput: resultStr,
          });

          const MAX_RESULT_FOR_ORCHESTRATOR = 8000;
          let cappedResult = resultStr;
          if (resultStr.length > MAX_RESULT_FOR_ORCHESTRATOR) {
            coreLogger.info({
              originalLength: resultStr.length,
              cappedLength: MAX_RESULT_FOR_ORCHESTRATOR,
              agentId: context.id,
            }, 'Capping team result for orchestrator context');
            cappedResult = resultStr.slice(0, MAX_RESULT_FOR_ORCHESTRATOR)
              + `\n\n[... result truncated from ${resultStr.length} chars — see handoff summary below ...]`;
          }
          return `${cappedResult}\n\n---\n${formatHandoff(handoff)}`;
        } catch {
          if (resultStr.length > 10000) {
            return resultStr.slice(0, 10000) + `\n\n[... truncated from ${resultStr.length} chars]`;
          }
          return result;
        }
      },
    },
    {
      name: 'create_pipeline',
      final: true,
      description:
        'LAST RESORT delegation. Create a multi-stage sequential pipeline with handover between stages. ' +
        'Use ONLY when the user EXPLICITLY asks for staged execution with handover ' +
        '(e.g., "first research, then implement, then review"). ' +
        'DO NOT use for analysis/audit/review/quality-check requests — use spawn_team instead. ' +
        'DO NOT use because you think it will be "more thorough" — pipelines lose context between stages and are slow. ' +
        'If multiple roles are needed in parallel without handover, use spawn_team. ' +
        'If a single role can do it, use spawn_worker. ' +
        'You may only delegate ONCE per request. ' +
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
        if (delegationDone) throw new Error(ALREADY_DELEGATED_MSG);

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
              ? 'No templates exist. Use spawn_worker instead, or ask the user to create a pipeline template.'
              : 'Use one of the listed templates, or use spawn_worker for simpler tasks.');
        }

        delegationDone = true;
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
