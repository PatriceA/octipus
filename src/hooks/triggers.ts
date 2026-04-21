import type { AgentContext, Hook, TriggerType, UnifiedMessage } from '@/core/types';
import { safeRegExp } from '@/utils/sanitize';

export interface TriggerEvent {
  type: TriggerType;
  data: unknown;
  timestamp: Date;
}

export interface TriggerContext {
  message?: UnifiedMessage;
  agent?: AgentContext;
  tool?: {
    name: string;
    toolId: string;
    args: Record<string, unknown>;
    result?: unknown;
  };
  webhook?: {
    path: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  };
  schedule?: {
    cronExpression: string;
    scheduledTime: Date;
    hookName?: string;
  };
}

/**
 * Check if a hook's trigger matches the event
 */
export function matchesTrigger(hook: Hook, event: TriggerEvent, context: TriggerContext): boolean {
  if (hook.trigger !== event.type) {
    return false;
  }

  const config = hook.triggerConfig;

  switch (event.type) {
    case 'message_received':
      return matchesMessageTrigger(config, context.message);

    case 'agent_started':
    case 'agent_completed':
    case 'agent_failed':
      return matchesAgentTrigger(config, context.agent);

    case 'tool_executed':
      return matchesToolTrigger(config, context.tool);

    case 'webhook': {
      // If hookId is specified in event data, only match that specific hook
      const webhookData = event.data as { hookId?: string } | undefined;
      if (webhookData?.hookId) {
        return hook.id === webhookData.hookId;
      }
      return matchesWebhookTrigger(config, context.webhook);
    }

    case 'schedule': {
      // Only match the specific hook targeted by the cron-runner
      const scheduleData = event.data as { hookId?: string } | undefined;
      if (scheduleData?.hookId) {
        return hook.id === scheduleData.hookId;
      }
      return true;
    }

    case 'permission_requested':
      return true; // All permission requests match

    default:
      return false;
  }
}

function matchesMessageTrigger(
  config: Hook['triggerConfig'],
  message?: UnifiedMessage
): boolean {
  if (!message) return false;

  // Check channel type filter
  if (config.channelTypes?.length) {
    if (!config.channelTypes.includes(message.channelType)) {
      return false;
    }
  }

  // Check message patterns
  if (config.messagePatterns?.length) {
    const matchesAny = config.messagePatterns.some((pattern: string) => {
      const regex = safeRegExp(pattern, 'i');
      if (!regex) return false;
      return regex.test(message.content);
    });
    if (!matchesAny) return false;
  }

  // Check session filter
  if (config.sessionFilter?.userIds?.length) {
    if (!config.sessionFilter.userIds.includes(message.userId)) {
      return false;
    }
  }

  return true;
}

function matchesAgentTrigger(
  config: Hook['triggerConfig'],
  agent?: AgentContext
): boolean {
  if (!agent) return false;

  // Check topic filter
  if (config.sessionFilter?.topics?.length) {
    if (!config.sessionFilter.topics.includes(agent.topic)) {
      return false;
    }
  }

  // Check user filter
  if (config.sessionFilter?.userIds?.length) {
    if (!config.sessionFilter.userIds.includes(agent.userId)) {
      return false;
    }
  }

  return true;
}

function matchesToolTrigger(
  config: Hook['triggerConfig'],
  tool?: TriggerContext['tool']
): boolean {
  if (!tool) return false;

  // Check tool filter
  if (config.toolIds?.length) {
    if (!config.toolIds.includes(tool.toolId)) {
      return false;
    }
  }

  // Check tool name filter
  if (config.toolNames?.length) {
    if (!config.toolNames.includes(tool.name)) {
      return false;
    }
  }

  return true;
}

function matchesWebhookTrigger(
  config: Hook['triggerConfig'],
  webhook?: TriggerContext['webhook']
): boolean {
  if (!webhook) return false;

  // Check path
  if (config.webhookPath && webhook.path !== config.webhookPath) {
    return false;
  }

  return true;
}

/**
 * Check hook conditions
 */
export function checkConditions(
  conditions: Hook['conditions'],
  context: TriggerContext
): boolean {
  if (!conditions || conditions.length === 0) {
    return true;
  }

  for (const condition of conditions) {
    const value = getFieldValue(condition.field, context);

    if (!evaluateCondition(condition.operator, value, condition.value)) {
      return false;
    }
  }

  return true;
}

function getFieldValue(field: string, context: TriggerContext): unknown {
  const parts = field.split('.');
  let value: unknown = context;

  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = (value as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return value;
}

function evaluateCondition(
  operator: string,
  value: unknown,
  expected: unknown
): boolean {
  switch (operator) {
    case 'equals':
      return value === expected;

    case 'contains':
      if (typeof value === 'string' && typeof expected === 'string') {
        return value.includes(expected);
      }
      return false;

    case 'matches':
      if (typeof value === 'string' && typeof expected === 'string') {
        const regex = safeRegExp(expected);
        if (!regex) return false;
        return regex.test(value);
      }
      return false;

    case 'gt':
      return typeof value === 'number' && typeof expected === 'number' && value > expected;

    case 'lt':
      return typeof value === 'number' && typeof expected === 'number' && value < expected;

    case 'in':
      return Array.isArray(expected) && expected.includes(value);

    default:
      return false;
  }
}
