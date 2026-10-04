import {
  deliver,
  loadNotifyScope,
  type NotifyScope,
  ownerTargets,
  parseChannelTarget,
  resolveTarget,
} from '@/channels/ownership';
import { getAgentManager } from '@/core/agent-manager';
import type { AgentContext, Hook } from '@/core/types';
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
        return await executeTool(config, context, hook);

      default:
        return { success: false, error: `Unknown action type: ${hook.action}` };
    }
  } catch (error) {
    coreLogger.error({ error, hookId: hook.id, action: hook.action }, 'Action execution failed');
    return { success: false, error: (error as Error).message };
  }
}

/**
 * The channel targets a notify config names explicitly: every `type:id` in
 * `notifyChannels`, plus the `channelType` / `channelId` pair. Malformed
 * entries (no type or no id) are dropped.
 */
export function explicitNotifyTargets(config: unknown): { channelType: string; channelId: string }[] {
  if (!config || typeof config !== 'object') return [];
  const c = config as Record<string, unknown>;
  const targets: { channelType: string; channelId: string }[] = [];
  if (Array.isArray(c.notifyChannels)) {
    for (const spec of c.notifyChannels) {
      const parsed = parseChannelTarget(String(spec));
      if (parsed) targets.push(parsed);
    }
  }
  if (c.channelType && c.channelId) {
    targets.push({ channelType: String(c.channelType), channelId: String(c.channelId) });
  }
  return targets;
}

const TEMPLATE_RE = /\{\{[^}]+\}\}/;

type Target = { channelType: string; channelId: string };
const targetKey = (t: Target) => `${t.channelType}:${t.channelId}`;

/**
 * The outbound targets an `execute_tool` hook on the messaging tool names
 * literally. Templated values (`{{…}}`) are only known at run time, where
 * the messaging tool checks them itself.
 */
function messagingToolTargets(config: Record<string, unknown>): { targets: Target[]; sendToUser?: string } {
  const targets: Target[] = [];
  if (config.toolId !== 'messaging') return { targets };
  const params = (config.toolParams && typeof config.toolParams === 'object' ? config.toolParams : {}) as Record<string, unknown>;
  if (config.toolAction === 'send_message') {
    const channel = params.channel;
    const target = params.target;
    if (typeof channel === 'string' && typeof target === 'string' && !TEMPLATE_RE.test(channel) && !TEMPLATE_RE.test(target)) {
      targets.push({ channelType: channel, channelId: target });
    }
    return { targets };
  }
  if (config.toolAction === 'send_to_user' && typeof params.user_id === 'string' && !TEMPLATE_RE.test(params.user_id)) {
    return { targets, sendToUser: params.user_id };
  }
  return { targets };
}

/** Every literal outbound target a hook action config names. */
export function hookConfigTargets(config: unknown): Target[] {
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  return [...explicitNotifyTargets(c), ...messagingToolTargets(c).targets];
}

/**
 * The targets in `config` the user may not send to, with the reason.
 * Loads the user's scope once.
 */
export async function invalidHookTargets(
  userId: string,
  config: unknown,
  opts?: { scope?: NotifyScope; only?: (t: Target) => boolean },
): Promise<{ target: string; error: string }[]> {
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  const out: { target: string; error: string }[] = [];
  const toUser = messagingToolTargets(c).sendToUser;
  if (toUser !== undefined && toUser !== userId) {
    out.push({ target: `user:${toUser}`, error: 'A send_to_user hook can only message you; set user_id to your own id or use a notify hook' });
  }
  const targets = hookConfigTargets(c).filter((t) => !opts?.only || opts.only(t));
  if (targets.length === 0) return out;
  const scope = opts?.scope ?? await loadNotifyScope(userId);
  for (const t of targets) {
    const r = await resolveTarget(scope, t.channelType, t.channelId);
    if (!r.allowed) out.push({ target: r.target, error: r.error });
  }
  return out;
}

/**
 * Validate a hook action config before it is stored: every explicit notify
 * target (and every literal messaging-tool target of an execute_tool hook)
 * must be a chat linked to `userId` or an admin-approved shared destination.
 *
 * With `previousConfig` (an edit), only targets that are new compared with
 * the stored config are checked, so a hook that already holds a now-invalid
 * target stays editable; the send paths skip such targets at run time.
 *
 * Returns an error message naming the rejected targets, or null.
 */
export async function notifyTargetsError(userId: string, config: unknown, previousConfig?: unknown): Promise<string | null> {
  const before = previousConfig === undefined ? null : new Set(hookConfigTargets(previousConfig).map(targetKey));
  const prevToUser = previousConfig === undefined
    ? undefined
    : messagingToolTargets((previousConfig && typeof previousConfig === 'object' ? previousConfig : {}) as Record<string, unknown>).sendToUser;
  const invalid = (await invalidHookTargets(userId, config, before ? { only: (t) => !before.has(targetKey(t)) } : undefined))
    .filter((i) => !(before && i.target === `user:${prevToUser}`));
  if (invalid.length === 0) return null;
  return invalid.map((i) => i.error).join('; ');
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

  if (!hook?.userId) return { success: false, error: 'Notify hook has no owner' };
  // Loaded once: the owner's identities, legacy bindings and approved shared
  // destinations; each target below is resolved against it exactly once.
  const scope = await loadNotifyScope(hook.userId);

  const targets: { type: string; id: string; label: string }[] = [];

  // notifyOwner: the owner's own verified identities (canonical resolution,
  // so a channel linked via /api/auth/channel-bindings/redeem counts).
  if (config.notifyOwner) {
    const own = ownerTargets(scope);
    if (own.length === 0) {
      return { success: false, error: 'No channels linked to your account. Link a channel in Settings → Channels.' };
    }
    for (const t of own) targets.push({ type: t.channelType, id: t.channelId, label: t.label });
  }

  // Explicitly configured channels (type:id format, and the simple
  // channelType + channelId pair used by incoming webhook hooks) are chosen
  // by the hook's author: deliver() sends only to the owner's own chats and
  // approved shared destinations.
  for (const t of explicitNotifyTargets(config)) {
    targets.push({ type: t.channelType, id: t.channelId, label: `${t.channelType}:${t.channelId}` });
  }

  if (targets.length === 0) {
    return { success: false, error: 'No notification channels configured. Enable "Notify me" or add explicit channels.' };
  }

  const results: { channel: string; success: boolean; error?: string }[] = [];
  const skipped: string[] = [];
  const skipErrors: string[] = [];

  for (const ch of targets) {
    const r = await deliver(scope, ch.type, ch.id, { content: message });
    if (r.ok) {
      results.push({ channel: ch.label, success: true });
    } else if (r.reason === 'not_allowed') {
      skipped.push(ch.label);
      skipErrors.push(r.error);
      coreLogger.warn(
        { hookId: hook.id, userId: hook.userId, channelType: ch.type, channelId: ch.id },
        'Notify hook target is not linked to the hook owner nor an approved shared destination; skipping it',
      );
    } else {
      results.push({ channel: ch.label, success: false, error: r.error });
    }
  }

  const anySuccess = results.some((r) => r.success);
  if (!anySuccess && results.length === 0) {
    return { success: false, data: { skipped }, error: skipErrors.join('; ') };
  }
  const errorSummary = [
    ...results.filter(r => !r.success).map(r => `${r.channel}: ${r.error}`),
    ...skipErrors,
  ].join('; ');

  return {
    success: anySuccess,
    data: skipped.length > 0 ? { results, skipped } : { results },
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

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `sessionId` names an existing session owned by someone other
 * than `userId`. Non-UUID ids are channel keys that resolveSession scopes by
 * user, and a UUID with no row yet becomes a new session owned by `userId`,
 * so neither can reach another user's session.
 */
async function isForeignSession(sessionId: string, userId: string): Promise<boolean> {
  if (!SESSION_UUID_RE.test(sessionId)) return false;
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const session = await sessionRepository.findById(sessionId);
  return Boolean(session && session.userId !== userId);
}

/**
 * resolveHookSessionId, restricted to sessions the hook owner owns. The
 * trigger context (message metadata / agent) may name any session id; one
 * that belongs to another user falls back to the hook's own session, and
 * failing that to a fresh, unpersisted id. Without this a user's own
 * spawn_agent hook could be pointed at another user's session and read and
 * write their transcript.
 */
export async function resolveOwnedHookSessionId(
  context: TriggerContext,
  hook: Hook,
): Promise<{ sessionId: string; minted: boolean }> {
  const resolved = resolveHookSessionId(context, hook);
  if (resolved.minted || !(await isForeignSession(resolved.sessionId, hook.userId))) return resolved;

  coreLogger.warn(
    { hookId: hook.id, userId: hook.userId, sessionId: resolved.sessionId },
    'Hook trigger named a session owned by another user; using the hook session instead',
  );
  const own = resolveHookSessionId({}, hook);
  if (own.minted || !(await isForeignSession(own.sessionId, hook.userId))) return own;
  return { sessionId: crypto.randomUUID(), minted: false };
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
  // A role heartbeat (triggerConfig.role) runs only when the heartbeat gate
  // let it through on the cron path — quiet hours, the per-user daily cap,
  // quota, board permission, one turn at a time. Anything else that reaches
  // here (a manual trigger, a test fire) is refused before it mints a session.
  let heartbeatRole: string | null = null;
  if (hook?.trigger === 'heartbeat') {
    const heartbeat = await import('@/core/heartbeat');
    heartbeatRole = heartbeat.heartbeatRole(hook);
    if (heartbeatRole && !heartbeat.heartbeatGatePassed(context)) {
      return { success: false, error: 'A role heartbeat runs only from the heartbeat schedule, after its gate' };
    }
  }

  // Reuse the hook's session across runs (see resolveHookSessionId) so a
  // scheduled/webhook hook appends to one session instead of spawning a new
  // one every run. A freshly minted id is persisted back to the hook row.
  // Only sessions the hook owner owns are accepted (resolveOwnedHookSessionId).
  const { sessionId, minted } = hook
    ? await resolveOwnedHookSessionId(context, hook)
    : resolveHookSessionId(context, hook);
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

  // A role heartbeat (triggerConfig.role) is that role's agent working the
  // board, so it runs AS the role whatever `orchestrated` says: the root
  // agent always runs as `general`. See spawnRoleHeartbeat.
  if (heartbeatRole) return runRoleHeartbeat(heartbeatRole, config, sessionId, userId, prompt, message);

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

  // The hook session's workspace (the user's default when the session has
  // none or does not exist yet), as the orchestrated and heartbeat paths do.
  // A hook with no user behind it (`'system'`) has no workspace.
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const { turnWorkspaceId } = await import('@/core/agent/session-resolver');
  const { isRealUserId } = await import('@/security/principal');
  const workspaceId = isRealUserId(userId)
    ? await turnWorkspaceId(userId, (await sessionRepository.findById(sessionId))?.workspaceId)
    : undefined;

  const agent = await agentManager.spawn({
    sessionId,
    userId,
    workspaceId,
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

/**
 * Run a role heartbeat's turn as a worker of that role, through the same
 * `spawnWorker` pipeline stages use: the role's prompt (lite on a small
 * model), critical rules, persona, skills, connector tools and plan-mode
 * stripping all apply, the run is unattended (`attended: false`: nothing is
 * asked, an ASK is refused), and `tasks` is granted on top of the role's
 * tools because the turn exists to work the board.
 *
 * The worker inherits the hook's session (reused across runs), so the board
 * knows it as `<role>@<hook session>` every run: a later turn can renew or
 * finish a claim an earlier one left. Two turns of one hook never overlap
 * (the gate's in-flight guard), and a user has one hook per role, so that
 * identity is never held by two live turns in this process. A per-run actor
 * would break exactly that renewal and is not used.
 *
 * Awaited, unlike the direct spawn below: the heartbeat keeps the hook in
 * flight until this returns.
 */
async function runRoleHeartbeat(
  role: string,
  config: Hook['actionConfig'],
  sessionId: string,
  userId: string,
  prompt: string,
  message: string,
): Promise<ActionResult> {
  const { ROLE_CONFIGS } = await import('@/core/agent/roles');
  if (!Object.hasOwn(ROLE_CONFIGS, role)) return { success: false, error: `Unknown role "${role}" on heartbeat hook` };
  // The hook session's workspace (the user's default when the session has
  // none or does not exist yet), owned by the user; never unscoped.
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const { turnWorkspaceId } = await import('@/core/agent/session-resolver');
  const session = await sessionRepository.findById(sessionId);
  const workspaceId = await turnWorkspaceId(userId, session?.workspaceId);
  const now = new Date();
  const parent: import('@/core/types').AgentContext = {
    id: `heartbeat:${role}:${sessionId}`,
    sessionId,
    userId,
    workspaceId,
    topic: config.agentTopic || role,
    model: '',
    role,
    root: false,
    attended: false,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    metadata: {},
  };
  const { getAgentService } = await import('@/core/agent');
  const task = [prompt, message].filter(Boolean).join('\n\n');
  const result = await getAgentService().spawnWorker(role, task, '', parent, {
    extraToolIds: ['tasks'],
    ...(config.agentModel ? { model: config.agentModel } : {}),
  });
  if (result && typeof result === 'object' && 'error' in result) {
    return { success: false, error: String((result as { error: unknown }).error) };
  }
  return { success: true, data: { role, response: typeof result === 'string' ? result : undefined } };
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
  context: TriggerContext,
  hook: Hook,
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

  // Always run the tool as the hook owner, with a server-built context. Never
  // reuse the trigger's agent context (caller-supplied on a test fire, and
  // carrying role/root/workspace/session we must not inherit) and never run
  // as 'system'. The hook's own session is used when it is the owner's.
  const ownSession = hook.sessionId && !(await isForeignSession(hook.sessionId, hook.userId))
    ? hook.sessionId
    : null;
  const agentContext: AgentContext = {
    id: crypto.randomUUID(),
    sessionId: ownSession ?? crypto.randomUUID(),
    userId: hook.userId,
    topic: 'hook',
    model: 'default',
    role: 'general',
    // Nobody is there to approve anything: an ASK is refused, and tools that
    // reach outside (messaging) apply their unattended rules.
    attended: false,
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
  const scope = await loadNotifyScope(userId);
  const targets = ownerTargets(scope);
  if (targets.length === 0) return;

  // Truncate very long results for messaging
  const truncated = result.length > 3000 ? result.slice(0, 3000) + '\n\n…(truncated)' : result;

  for (const t of targets) {
    const r = await deliver(scope, t.channelType, t.channelId, { content: truncated });
    if (!r.ok) coreLogger.warn({ error: r.error, reason: r.reason, channel: t.channelType }, 'Failed to notify owner channel');
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

/**
 * One-time startup report: hooks holding outbound targets their owner may
 * no longer send to (saved before targets were checked, or unlinked since).
 * They keep working for their valid targets; the invalid ones are skipped at
 * send time and flagged in the hooks UI. Logged as counts per user.
 */
export async function reportInvalidHookTargets(): Promise<{ userId: string; hooks: number; targets: number }[]> {
  const { getDb } = await import('@/db/postgres');
  const { hooks } = await import('@/db/schema/hooks');
  const { inArray } = await import('drizzle-orm');
  const rows = await getDb()
    .select({ id: hooks.id, userId: hooks.userId, actionConfig: hooks.actionConfig })
    .from(hooks)
    .where(inArray(hooks.action, ['notify', 'execute_tool']));
  const byUser = new Map<string, typeof rows>();
  for (const r of rows) {
    if (hookConfigTargets(r.actionConfig).length === 0) continue;
    byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  }
  const report: { userId: string; hooks: number; targets: number }[] = [];
  for (const [userId, userHooks] of byUser) {
    const scope = await loadNotifyScope(userId);
    let hookCount = 0;
    let targetCount = 0;
    for (const h of userHooks) {
      const invalid = await invalidHookTargets(userId, h.actionConfig, { scope });
      if (invalid.length > 0) { hookCount++; targetCount += invalid.length; }
    }
    if (hookCount > 0) report.push({ userId, hooks: hookCount, targets: targetCount });
  }
  if (report.length > 0) {
    coreLogger.warn(
      { users: report },
      'Hooks with notification targets their owner may no longer send to (skipped at send time; ask an admin to approve shared destinations under Admin → Notification destinations)',
    );
  }
  return report;
}
