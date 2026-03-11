import type { ActionType, Hook } from '@/core/types';
import { getAgentManager } from '@/core/agent-manager';
import { getUMI } from '@/channels/interface';
import { coreLogger } from '@/utils/logger';
import type { TriggerContext } from './triggers';

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Execute a hook action
 */
export async function executeAction(
  hook: Hook,
  context: TriggerContext
): Promise<ActionResult> {
  const config = hook.actionConfig;

  try {
    switch (hook.action) {
      case 'notify':
        return await executeNotify(config, context, hook);

      case 'spawn_agent':
        return await executeSpawnAgent(config, context);

      case 'webhook':
        return await executeWebhook(config, context);

      case 'n8n_workflow':
        return await executeN8NWorkflow(config, context);

      case 'execute_tool':
        return await executeTool(config, context);

      default:
        return { success: false, error: `Unknown action type: ${hook.action}` };
    }
  } catch (error) {
    coreLogger.error({ error, hookId: hook.id, action: hook.action }, 'Action execution failed');
    return { success: false, error: (error as Error).message };
  }
}

async function executeNotify(
  config: Hook['actionConfig'],
  context: TriggerContext,
  hook?: Hook,
): Promise<ActionResult> {
  const message = interpolateTemplate(config.notifyMessage || 'Hook triggered', context);

  // Resolve target channels
  const resolvedChannels: { type: string; id: string; label: string }[] = [];

  // If notifyOwner is set, resolve from the hook owner's channel bindings
  if (config.notifyOwner && hook?.userId) {
    const { userRepository } = await import('@/db/repositories/user-repository');
    const user = await userRepository.findById(hook.userId);
    const bindings = (user?.channelBindings as import('@/db/schema/users').ChannelBinding[]) || [];

    if (bindings.length === 0) {
      return { success: false, error: 'No channels linked to your account. Link a channel in Settings → Channels.' };
    }

    for (const binding of bindings) {
      if (binding.isVerified) {
        resolvedChannels.push({
          type: binding.channelType,
          id: binding.channelUserId,
          label: `${binding.channelType}:${binding.channelUserName || binding.channelUserId}`,
        });
      }
    }
  }

  // Also add explicitly configured channels (type:id format)
  const explicitChannels = config.notifyChannels || [];
  if (Array.isArray(explicitChannels)) {
    for (const channelSpec of explicitChannels) {
      const [channelType, channelId] = String(channelSpec).split(':');
      if (channelType && channelId) {
        resolvedChannels.push({ type: channelType, id: channelId, label: String(channelSpec) });
      }
    }
  }

  if (resolvedChannels.length === 0) {
    return { success: false, error: 'No notification channels configured. Enable "Notify me" or add explicit channels.' };
  }

  const umi = getUMI();
  const results: { channel: string; success: boolean; error?: string }[] = [];

  for (const ch of resolvedChannels) {
    try {
      await umi.send(ch.type as any, ch.id, { content: message });
      results.push({ channel: ch.label, success: true });
    } catch (error) {
      results.push({ channel: ch.label, success: false, error: (error as Error).message });
    }
  }

  const anySuccess = results.some((r) => r.success);
  const errorSummary = results.filter(r => !r.success).map(r => `${r.channel}: ${r.error}`).join('; ');

  return {
    success: anySuccess,
    data: { results },
    error: anySuccess ? undefined : errorSummary || 'All notification channels failed',
  };
}

async function executeSpawnAgent(
  config: Hook['actionConfig'],
  context: TriggerContext
): Promise<ActionResult> {
  // Get session info from context — generate a UUID for hook-triggered sessions
  const sessionId = (context.message?.metadata?.sessionId as string | undefined) ||
                    context.agent?.sessionId ||
                    crypto.randomUUID();
  const userId = context.message?.userId || context.agent?.userId || 'system';

  const prompt = interpolateTemplate(config.agentPrompt || '', context);
  const message = context.message?.content || prompt;

  // If orchestrated, route through the orchestrator instead of bare spawn
  if (config.orchestrated) {
    const { getOrchestratorService } = await import('@/core/orchestrator');
    const orchestrator = getOrchestratorService();

    const result = await orchestrator.handleMessage(sessionId, userId, message, 'hook');

    return {
      success: true,
      data: { agentId: result.agentId, response: result.response, orchestrated: true },
    };
  }

  // Direct spawn (non-orchestrated)
  const agentManager = getAgentManager();

  const agent = await agentManager.spawn({
    sessionId,
    userId,
    topic: config.agentTopic,
    model: config.agentModel,
    systemPrompt: prompt,
  });

  // Run the agent if there's a message
  if (message) {
    agent.run(message).catch((error) => {
      coreLogger.error({ error, agentId: agent.getContext().id }, 'Spawned agent failed');
    });
  }

  return { success: true, data: { agentId: agent.getContext().id } };
}

async function executeWebhook(
  config: Hook['actionConfig'],
  context: TriggerContext
): Promise<ActionResult> {
  const url = config.webhookUrl;
  if (!url) {
    return { success: false, error: 'Webhook URL not configured' };
  }

  const { validateExternalUrl } = await import('@/utils/sanitize');
  const validation = await validateExternalUrl(url);
  if (!validation.valid) {
    return { success: false, error: `Webhook URL blocked: ${validation.reason}` };
  }

  const method = config.webhookMethod || 'POST';
  const headers = config.webhookHeaders || {};
  const body = config.webhookBody
    ? interpolateTemplate(config.webhookBody, context)
    : JSON.stringify(context);

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: method !== 'GET' ? body : undefined,
  });

  const responseData = await response.text();

  return {
    success: response.ok,
    data: {
      status: response.status,
      body: responseData,
    },
  };
}

async function executeN8NWorkflow(
  config: Hook['actionConfig'],
  context: TriggerContext
): Promise<ActionResult> {
  const { getConfig } = await import('@/config');
  const n8nConfig = getConfig().n8n;

  if (!n8nConfig?.url) {
    return { success: false, error: 'N8N not configured' };
  }

  const workflowId = config.workflowId;
  if (!workflowId) {
    return { success: false, error: 'Workflow ID not specified' };
  }

  const url = `${n8nConfig.url}/api/v1/workflows/${workflowId}/execute`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(n8nConfig.apiKey && { 'X-N8N-API-KEY': n8nConfig.apiKey }),
    },
    body: JSON.stringify({
      ...config.workflowData,
      triggerContext: context,
    }),
  });

  const responseData = await response.json();

  return {
    success: response.ok,
    data: responseData,
  };
}

async function executeTool(
  config: Hook['actionConfig'],
  context: TriggerContext
): Promise<ActionResult> {
  const { getToolRegistry } = await import('@/tools/registry');
  const registry = getToolRegistry();

  const toolId = config.toolId;
  const action = config.toolAction;

  if (!toolId || !action) {
    return { success: false, error: 'Tool ID and action required' };
  }

  const toolModule = registry.get(toolId);
  if (!toolModule) {
    return { success: false, error: `Tool not found: ${toolId}` };
  }

  const tool = toolModule.getTool(action);
  if (!tool) {
    return { success: false, error: `Tool not found: ${toolId}.${action}` };
  }

  // Interpolate parameters
  const params: Record<string, unknown> = {};
  if (config.toolParams) {
    for (const [key, value] of Object.entries(config.toolParams as Record<string, unknown>)) {
      if (typeof value === 'string') {
        params[key] = interpolateTemplate(value, context);
      } else {
        params[key] = value;
      }
    }
  }

  // Create a synthetic agent context
  const agentContext = context.agent || {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    userId: context.message?.userId || 'system',
    topic: 'hook',
    model: 'default',
    role: 'general',
    status: 'running' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
  };

  const result = await tool.execute(params, agentContext);

  return { success: true, data: result };
}

/**
 * Interpolate template strings with context values
 * Supports {{field.path}} syntax
 */
function interpolateTemplate(template: string, context: TriggerContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const value = getNestedValue(context, path.trim());
    return value !== undefined ? String(value) : match;
  });
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let value = obj;

  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = (value as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return value;
}
