import { getUMI } from '@/channels/interface';
import { getAgentManager } from '@/core/agent-manager';
import type { Hook } from '@/core/types';
import { coreLogger } from '@/utils/logger';
import type { TriggerContext } from './triggers';
import { summarizeWebhookPayload } from './webhook-summary';

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
        return await executeSpawnAgent(config, context, hook);

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
  // Use rendered message from incoming webhook template if no explicit notifyMessage
  let messageTemplate = config.notifyMessage || 'Hook triggered';
  if (!config.notifyMessage && context.webhook) {
    const webhookBody = context.webhook.body as Record<string, unknown> | undefined;
    const renderedMessage = webhookBody?._renderedMessage as string | undefined;
    if (renderedMessage) {
      messageTemplate = renderedMessage;
    }
  }
  const message = interpolateTemplate(messageTemplate, context);

  // Resolve target channels
  const resolvedChannels: { type: string; id: string; label: string }[] = [];

  // If notifyOwner is set, resolve from the hook owner's channel bindings
  if (config.notifyOwner && hook?.userId) {
    const { userRepository } = await import('@/db/repositories/user-repository');
    const user = await userRepository.findById(hook.userId);
    let rawBindings = user?.channelBindings as import('@/db/schema/users').ChannelBinding[] | string;
    if (typeof rawBindings === 'string') {
      try { rawBindings = JSON.parse(rawBindings); } catch { rawBindings = []; }
    }
    const bindings = (rawBindings as import('@/db/schema/users').ChannelBinding[]) || [];

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

  // Support simple channelType + channelId pair (e.g. from incoming webhook hooks)
  if (config.channelType && config.channelId) {
    resolvedChannels.push({
      type: config.channelType,
      id: config.channelId,
      label: `${config.channelType}:${config.channelId}`,
    });
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

/**
 * Resolve which chat session a `spawn_agent` action should run in.
 *
 * Precedence:
 *  1. An inbound trigger session (message_received / agent_* events carry the
 *     originating session) — per-trigger, never persisted.
 *  2. The hook's own persisted `sessionId` — so scheduled/webhook hooks (which
 *     have no inbound session) append to ONE session across every run instead
 *     of spawning a brand-new session each time.
 *  3. A freshly minted id — the first run of such a hook.
 *
 * `minted` is true only when a new id was generated for a hook; the caller
 * persists it back to the hook row so subsequent runs reuse it.
 */
export function resolveHookSessionId(
  context: TriggerContext,
  hook?: Hook,
): { sessionId: string; minted: boolean } {
  // metadata is Record<string, unknown>, so guard the type rather than casting —
  // a non-string sessionId must not be treated as a usable session id.
  const msgSession = context.message?.metadata?.sessionId;
  const fromTrigger =
    (typeof msgSession === 'string' ? msgSession : undefined) || context.agent?.sessionId || undefined;
  if (fromTrigger) return { sessionId: fromTrigger, minted: false };
  if (hook?.sessionId) return { sessionId: hook.sessionId, minted: false };
  return { sessionId: crypto.randomUUID(), minted: Boolean(hook) };
}

/** Persist a freshly-minted session id back to the hook so later runs reuse it. */
async function persistHookSessionId(hookId: string, sessionId: string): Promise<void> {
  const { getDb } = await import('@/db/postgres');
  const { hooks: hooksTable } = await import('@/db/schema/hooks');
  const { eq } = await import('drizzle-orm');
  await getDb().update(hooksTable).set({ sessionId }).where(eq(hooksTable.id, hookId));
}

async function executeSpawnAgent(
  config: Hook['actionConfig'],
  context: TriggerContext,
  hook?: Hook,
): Promise<ActionResult> {
  // Reuse the hook's session across runs (see resolveHookSessionId) so a
  // scheduled/webhook hook appends to one session instead of spawning a new
  // one every run. A freshly minted id is persisted back to the hook row.
  const { sessionId, minted } = resolveHookSessionId(context, hook);
  if (minted && hook) {
    hook.sessionId = sessionId; // keep this run consistent with what we persist
    try {
      await persistHookSessionId(hook.id, sessionId);
    } catch (err) {
      coreLogger.error({ err, hookId: hook.id }, 'Failed to persist reusable hook sessionId; this run still proceeds');
    }
  }
  // Use the hook owner's userId so notifications and permissions resolve correctly
  const userId = hook?.userId || context.message?.userId || context.agent?.userId || 'system';

  let prompt = interpolateTemplate(config.agentPrompt || '', context);

  // The away digest is deterministic — read it here and hand the agent the
  // facts, rather than spending a model turn asking it to collect them.
  // Fail-soft: a digest that cannot be built must not stop the hook. It is
  // applied to whatever the agent will actually receive (see `message`
  // below): a message-triggered hook runs on the message, not the prompt.
  let digestBlock = '';
  const digestHours = Number(config.awayDigestHours);
  if (Number.isFinite(digestHours) && digestHours > 0 && userId !== 'system') {
    try {
      const { collectAwayDigest, defaultSince, renderAwayDigest } = await import('@/core/digest/away');
      const { backgroundUserPrincipal } = await import('@/core/tasks/sourced');
      const digest = await collectAwayDigest(backgroundUserPrincipal(userId), defaultSince(new Date(), digestHours));
      digestBlock = renderAwayDigest(digest);
    } catch (err) {
      coreLogger.warn({ err, hookId: hook?.id }, 'away digest unavailable for this hook run; proceeding without it');
    }
  }

  // Embed trigger context (webhook payload, tool result, etc.) into the prompt
  if (context.webhook) {
    // If a rendered message template is available (from incoming webhook), use it
    const webhookBody = context.webhook.body as Record<string, unknown> | undefined;
    const renderedMessage = webhookBody?._renderedMessage as string | undefined;
    if (renderedMessage) {
      prompt += `\n\n${renderedMessage}`;
    } else {
      // Summarize the payload instead of dumping the full JSON, which flooded
      // the user-visible message with repo metadata (see webhook-summary.ts).
      prompt += `\n\n${summarizeWebhookPayload(context.webhook.body)}`;
    }
    if (context.webhook.headers) {
      const eventType = context.webhook.headers['x-github-event'] || context.webhook.headers['x-gitlab-event'] || '';
      if (eventType) prompt += `\nEvent type: ${eventType}`;
    }
  } else if (context.tool) {
    prompt += `\n\n--- Tool Context ---\n${JSON.stringify(context.tool, null, 2)}`;
  }

  const withDigest = (text: string) => (digestBlock ? `${digestBlock}\n\n${text}` : text);
  prompt = withDigest(prompt);
  const message = context.message?.content ? withDigest(context.message.content) : prompt;

  // If orchestrated, route through the root agent instead of bare spawn
  if (config.orchestrated) {
    const { getAgentService } = await import('@/core/agent');
    const rootAgent = getAgentService();

    // A heartbeat hook routes on the 'heartbeat' channel so the run is tagged
    // origin='heartbeat' (RunContext) for auditability; everything else is 'hook'.
    const channel = hook?.trigger === 'heartbeat' ? 'heartbeat' : 'hook';
    const result = await rootAgent.handleMessage(sessionId, userId, message, channel);

    // For orchestrated hooks, notify the owner with the result if either:
    // - notifyRoot is true (scheduled tasks that should deliver results)
    // - notifyOwner is true (explicit owner notification)
    if ((config.notifyRoot || config.notifyOwner) && userId && result.response) {
      notifyOwnerWithResult(userId, result.response).catch((err) => {
        coreLogger.error({ error: err }, 'Failed to notify owner with orchestrated result');
      });
    }

    return {
      success: true,
      data: { agentId: result.agentId, response: result.response, orchestrated: true },
    };
  }

  // Direct spawn (non-orchestrated) — use longer timeout for hook-triggered agents
  const agentManager = getAgentManager();
  const { getConfig } = await import('@/config');
  const agentConfig = getConfig().agent;
  const hookTimeout = Math.max(agentConfig.defaultTimeout * 2, 1800000); // At least 30 min for hooks

  const agent = await agentManager.spawn({
    sessionId,
    userId,
    topic: config.agentTopic,
    model: config.agentModel,
    systemPrompt: prompt,
    timeout: hookTimeout,
  });

  // Run the agent and optionally notify owner with the result
  if (message) {
    agent.run(message).then(async (result) => {
      if (config.notifyOwner && userId && result) {
        try {
          await notifyOwnerWithResult(userId, result);
        } catch (err) {
          coreLogger.error({ error: err, agentId: agent.getContext().id }, 'Failed to notify owner with agent result');
        }
      }
    }).catch((error) => {
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

  const method = config.webhookMethod || 'POST';
  const headers = config.webhookHeaders || {};
  const body = config.webhookBody
    ? interpolateTemplate(config.webhookBody, context)
    : JSON.stringify(context);

  // fetchGuarded validates the URL against SSRF *and* pins the connection to the
  // vetted IP so a rebinding resolver can't swap in a private address between
  // the check and the connect.
  const { fetchGuarded } = await import('@/utils/sanitize');
  let response: Response;
  try {
    response = await fetchGuarded(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: method !== 'GET' ? body : undefined,
    });
  } catch (err) {
    return { success: false, error: `Webhook URL blocked: ${(err as Error).message}` };
  }

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
 * Send agent result to the owner's linked channels (Telegram, etc.)
 */
async function notifyOwnerWithResult(userId: string, result: string): Promise<void> {
  const { userRepository } = await import('@/db/repositories/user-repository');
  const user = await userRepository.findById(userId);
  let rawBindings = user?.channelBindings as import('@/db/schema/users').ChannelBinding[] | string;
  if (typeof rawBindings === 'string') {
    try { rawBindings = JSON.parse(rawBindings); } catch { rawBindings = []; }
  }
  const bindings = (rawBindings as import('@/db/schema/users').ChannelBinding[]) || [];
  const verified = bindings.filter(b => b.isVerified);

  if (verified.length === 0) return;

  const umi = getUMI();
  // Truncate very long results for messaging
  const truncated = result.length > 3000 ? result.slice(0, 3000) + '\n\n…(truncated)' : result;

  for (const binding of verified) {
    try {
      await umi.send(binding.channelType as any, binding.channelUserId, { content: truncated });
    } catch (err) {
      coreLogger.warn({ error: err, channel: binding.channelType }, 'Failed to notify owner channel');
    }
  }
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
