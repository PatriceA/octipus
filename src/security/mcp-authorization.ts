import type { AgentContext } from '@/core/types';
import { auditRepository } from '@/db/repositories/audit-repository';
import { routeApproval } from './approval-policy';
import { ApprovalBlockedError, consumeDispatchAuthorization } from './dispatch-authorization';
import { getPermissionManager } from './permissions';

/** MCP has no BaseTool middleware; enforce authorization at the transport boundary. */
export async function authorizeMcpDispatch(context: AgentContext, action: string, args: Record<string, unknown>): Promise<void> {
  if (!context?.userId) throw new ApprovalBlockedError('MCP requires an authenticated execution context');
  const prior = consumeDispatchAuthorization(context, 'mcp', action, args);
  const pm = getPermissionManager();
  // Lazy handlers wrap arguments; resource conditions apply to the actual remote arguments.
  const toolArgs = args.arguments && typeof args.arguments === 'object' ? args.arguments as Record<string, unknown> : args;
  const check = await pm.check(context.userId, 'mcp', action, toolArgs, context, { revalidate: !!prior });
  const decision = routeApproval({ level: check.level, attended: context.attended ?? false,
    role: context.role, toolId: 'mcp', action });
  let source = check.source ?? 'policy';
  if (decision.route === 'deny') throw new Error(`Permission denied for mcp.${action}`);
  if (check.level === 'ASK') {
    if (prior?.startsWith('approval:')) source = prior;
    else {
      if (decision.route === 'blocked') throw new ApprovalBlockedError(`mcp.${action}: ${decision.reason}`);
      const id = await pm.requestApproval(context.userId, context.id, 'mcp', action, toolArgs, context.sessionId);
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
