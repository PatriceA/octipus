import type { AgentWorker, ToolHandler } from '@/core/agent-worker';
import { createCollectChildrenTool } from '@/core/swarm/collect-tool';
import { createSpawnChildTool } from '@/core/swarm/swarm-tool';
import {
  type AgentNode,
  getLevelDefault,
  type PendingChild,
} from '@/core/swarm/types';
import type { OrchestratorService } from './service';

/**
 * Hook refs the orchestrator passes in so we can wire `spawn_child`'s
 * detach hooks and `collect_children` BEFORE the worker is created. The
 * service populates both refs after `agentManager.spawn` returns.
 */
export interface OrchestratorSwarmRefs {
  /** Hooks slot wired to the worker's pending-child map. Tools read this lazily. */
  detachHookRef: {
    current: {
      registerPendingChild: (pc: PendingChild) => void;
      pendingDetachedCount: () => number;
    } | null;
  };
  /** Worker handle for `collect_children` to await pending detached results. */
  workerRef: { current: AgentWorker | null };
}

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
  options?: { parentNode?: AgentNode; swarmRefs?: OrchestratorSwarmRefs; lite?: boolean },
): ToolHandler[] {
  // Lite mode (small models): expose only `spawn_child` (flat schema) +
  // `remember_this`. Detach/collect/pipeline/pii/reflect/status are dropped —
  // a small model can't juggle them, and single-step delegation doesn't need
  // them. Built below, then filtered just before return.
  const lite = options?.lite === true;
  // Pipeline gate: once `create_pipeline` runs, further delegation is blocked.
  // `spawn_child` is NOT gated — multiple swarm calls per turn are explicitly
  // allowed (swarm-design.md §Spawn Mechanics).
  let pipelineCreated = false;

  const PIPELINE_ALREADY_CREATED_MSG =
    'A pipeline has already been created for this request. ' +
    'You MUST now respond to the user with a plain-text summary of the result. ' +
    'Do NOT call any more tools. Just write your final answer.';

  const tools: ToolHandler[] = [];

  // Swarm: register `spawn_child` on the Orchestrator (depth 0). With
  // `swarmRefs` we also enable detach mode + `collect_children`, so the
  // orchestrator can fire-and-forget parallel children, narrate while they
  // run, and pick up their results before its final reply. Without the
  // refs (legacy unit-test callers) the tool stays in await-only mode.
  if (options?.parentNode) {
    const refs = options.swarmRefs;
    if (refs && !lite) {
      const detachHookRef = refs.detachHookRef;
      tools.push(
        createSpawnChildTool(options.parentNode, undefined, {
          registerPending: (pc) => detachHookRef.current?.registerPendingChild(pc),
          pendingCount: () => detachHookRef.current?.pendingDetachedCount() ?? 0,
          maxPendingDetached: () => getLevelDefault(0).maxPendingDetached,
        }),
      );
      tools.push(createCollectChildrenTool(options.parentNode, refs.workerRef));
      options.parentNode.allowedToolIds.add('collect_children');
    } else {
      // Lite (or no refs): await-only single spawn. Lite uses the flat schema.
      tools.push(createSpawnChildTool(options.parentNode, undefined, undefined, lite ? { lite: true } : undefined));
    }
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
        const userId = context.userId;
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
        const userId = context.userId;
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
      name: 'reflect',
      description:
        'Answer "what are you doing?" / "what\'s happening?" / "status?" without spawning. Reads the live swarm tree for this session and returns a persona-flavored summary of which arms are running, completed, or idle. Use this when the user asks about CURRENT state, NOT when they want new work done. Free — no LLM call, no spawn.',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async (_args, context) => {
        try {
          const { swarmNodeRepository } = await import('@/core/swarm/node-repository');
          const { resolvePersonaForUser } = await import('@/core/personas/resolver');
          const persona = await resolvePersonaForUser(context.userId);
          const sessionId = context.sessionId;
          if (!sessionId) {
            return `${persona.name} has no session — nothing to reflect on.`;
          }
          const nodes = await swarmNodeRepository.findByRootSession(sessionId);

          const running = nodes.filter(n => n.status === 'running');
          const completed = nodes.filter(n => n.status === 'completed' || n.status === 'cache_hit');
          const failedStatuses: Array<typeof nodes[number]['status']> = [
            'cancelled', 'tool_error', 'provider_error', 'budget', 'timeout', 'denied', 'concurrency_limit',
          ];
          const failed = nodes.filter(n => failedStatuses.includes(n.status));

          if (nodes.length === 0) {
            return `${persona.name} has not dispatched any arms yet in this session.`;
          }

          const lines: string[] = [];
          if (running.length > 0) {
            const roles = running.map(n => `${n.role}${n.subtopic ? `(${n.subtopic})` : ''}`).join(', ');
            lines.push(`Running: ${roles}`);
          }
          if (completed.length > 0) {
            lines.push(`Completed this session: ${completed.length} arm${completed.length === 1 ? '' : 's'}.`);
          }
          if (failed.length > 0) {
            lines.push(`Failed: ${failed.length}. Octipus has not papered over them.`);
          }
          if (running.length === 0 && completed.length > 0) {
            lines.push(`No arms are running right now. ${persona.name} is waiting on you.`);
          }
          return lines.join(' ');
        } catch (err) {
          return `Reflection failed: ${(err as Error).message}`;
        }
      },
    },
    {
      name: 'remember_about_self',
      description:
        'Promote one durable fact about YOURSELF (the orchestrator persona) into the user\'s persona profile. Use ONLY when the user explicitly tells you to change how YOU behave, sound, or refer to yourself ("don\'t apologize for slow responses", "summarize in bullets", "stop saying \\"sure\\""). Do NOT use for facts about the user (those go to `remember_this`). The fact must be one short sentence describing how you should behave going forward. Stored on the per-user assistant profile and re-injected into your prompt next turn.',
      parameters: {
        type: 'object',
        properties: {
          fact: {
            type: 'string',
            description: 'One sentence describing how you (the persona) should behave. Example: "Always summarize in bullets." or "Stop apologizing for slow responses."',
          },
        },
        required: ['fact'],
      },
      execute: async (args, context) => {
        const fact = String(args.fact || '').trim();
        if (fact.length < 4) return { stored: false, reason: 'fact too short' };
        if (fact.length > 280) return { stored: false, reason: 'fact too long (max 280 chars)' };
        try {
          const { getPersonaProfileRepository } = await import('@/core/personas/repository');
          const { getPersonaRegistry } = await import('@/core/personas/registry');
          const repo = getPersonaProfileRepository();
          let profile = await repo.findForUser(context.userId);
          if (!profile) {
            await getPersonaRegistry().ensureLoaded();
            const base = getPersonaRegistry().getDefault();
            profile = await repo.create(context.userId, base.name, {
              presetId: base.id,
              pronouns: base.pronouns,
              tone: base.tone,
              narration: base.defaults.narration,
              extras: [],
            });
          }
          const updated = await repo.addExtraFact(profile.id, fact);
          return {
            stored: !!updated,
            persona_profile_id: profile.id,
            fact,
          };
        } catch (err) {
          return { stored: false, error: (err as Error).message };
        }
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

  if (lite) {
    return tools.filter((t) => t.name === 'spawn_child' || t.name === 'remember_this');
  }
  return tools;
}
