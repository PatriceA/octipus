import type { AgentContext } from '@/core/types';
import { auditRepository } from '@/db/repositories/audit-repository';
import { routeApprovalFor } from './approval-route';
import { ApprovalBlockedError, consumeDispatchAuthorization } from './dispatch-authorization';
import type { PluginToolEffect } from '@/shared/plugin-package';
import { getPermissionManager } from './permissions';

/** MCP has no BaseTool middleware; enforce authorization at the transport boundary. */
export async function authorizeMcpDispatch(context: AgentContext, action: string, args: Record<string, unknown>): Promise<void> {
  if (!context?.userId) throw new ApprovalBlockedError('MCP requires an authenticated execution context');
  const prior = consumeDispatchAuthorization(context, 'mcp', action, args);
  const pm = getPermissionManager();
  // Lazy handlers wrap arguments; resource conditions apply to the actual remote arguments.
  const toolArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments as Record<string, unknown> : args;
  const effect = await pluginEffectOf(action);
  if (effect === 'undeclared') throw new Error(`Permission denied for mcp.${action}: the plugin package does not declare this tool`);
  const checked = await pm.check(context.userId, 'mcp', action, toolArgs, context, {
    revalidate: !!prior,
    ...(effect ? { defaultLevel: effect === 'read' ? 'ALLOW' : 'ASK' } : {}),
  });
  // An external effect is always asked: a rule may deny it, never wave it through.
  const check = effect === 'external' && checked.level === 'ALLOW'
    ? { ...checked, level: 'ASK' as const, allowed: false, requiresApproval: true, reason: 'The plugin package declares an external effect' }
    : checked;
  const decision = await routeApprovalFor({ ...context, attended: context.attended ?? false },
    { toolId: 'mcp', action, toolName: action }, check);
  let source = decision.source ?? 'policy';
  if (decision.route === 'deny') throw new Error(`Permission denied for mcp.${action}${decision.source === 'space-role' ? `: ${decision.reason}` : ''}`);
  if (decision.level === 'ASK') {
    if (prior?.startsWith('approval:')) source = prior;
    else {
      if (decision.route === 'blocked') throw new ApprovalBlockedError(`mcp.${action}: ${decision.reason}`);
      const id = await pm.requestApproval(context.userId, context.id, 'mcp', action, toolArgs, context.sessionId, undefined, undefined, context.workspaceId);
      if (!await pm.waitForApproval(id, { agentId: context.id })) throw new Error('MCP approval was not granted');
      if ((await pm.check(context.userId, 'mcp', action, toolArgs, context, { revalidate: true })).level === 'DENY') {
        throw new Error('MCP permission was revoked while awaiting approval');
      }
      source = `approval:${id}`;
    }
  }
  if (context.status === 'stopped' || context.status === 'failed') throw new Error('Agent stopped before MCP execution');
  await auditRepository.log({ userId: context.userId, action: 'permission_granted', resourceType: 'tool',
    resourceId: `mcp.${action}`, details: { authorizationSource: source, agentId: context.id, action, toolId: 'mcp' } });
}

/**
 * What the plugin package behind `serverId.tool` declares the tool does
 * (docs/PLUGIN-PACKAGES.md); null for an operator-configured MCP server.
 */
async function pluginEffectOf(action: string): Promise<PluginToolEffect | 'undeclared' | null> {
  const dot = action.indexOf('.');
  if (dot <= 0) return null;
  const { getMCPBridge } = await import('@/mcp/bridge');
  const tool = action.slice(dot + 1);
  const effect = getMCPBridge().pluginToolEffect(action.slice(0, dot), tool);
  // Reading a resource or fetching a prompt is a read, not a tool the manifest lists.
  if (effect === 'undeclared' && (tool === 'resources/read' || tool === 'prompts/get')) return 'read';
  return effect;
}
