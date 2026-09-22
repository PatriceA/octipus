import { z } from 'zod';
import type { AgentContext } from './types';
import type { AgentEvent, ToolHandler } from './agent-base';
import { getPermissionManager } from '@/security/permissions';
import { routeApproval } from '@/security/approval-policy';
import { getConfig } from '@/config';

const requestSchema = z.object({
  type: z.literal('control_request'), request_id: z.string(),
  request: z.object({ subtype: z.literal('can_use_tool'), tool_name: z.string(),
    input: z.record(z.string(), z.unknown()).default({}), tool_use_id: z.string().default('') }),
});

/** Translate Claude's permission control protocol to Octipus's approval surface. */
export async function answerCliPermissionRequest(
  raw: unknown, context: AgentContext, emit: (type: AgentEvent['type'], data: unknown) => void, signal?: AbortSignal,
  octipusBridgeTools?: () => ToolHandler[],
): Promise<unknown> {
  const { request_id, request } = requestSchema.parse(raw);
  // Only the run-local Octipus bridge can defer to our ToolExecutor. Do not
  // trust an MCP server name alone: external/unconnected servers retain the
  // vendor policy below. The callback comes from the worker's current tool set.
  if (octipusBridgeTools && request.tool_name.startsWith('mcp__octipus__')) {
    const name = request.tool_name.slice('mcp__octipus__'.length);
    const discovered = name === 'call_discovered_tool'
      ? z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}) }).strict().safeParse(request.input)
      : undefined;
    const target = discovered ? (discovered.success ? discovered.data.name : undefined) : name;
    let allowed = context.status === 'running' && !signal?.aborted && target !== undefined
      && octipusBridgeTools().some(tool => tool.name === target);
    // Preserve explicit legacy vendor denials; an unknown synthetic action's
    // fallback ASK is not a second permission for a registered Octipus tool.
    if (allowed) {
      const legacy = await getPermissionManager().check(context.userId,
        `cli-native:${request.tool_name}`, request.tool_name, request.input, context, { revalidate: true });
      if (legacy.level === 'DENY') allowed = false;
    }
    if (context.status !== 'running' || signal?.aborted) allowed = false;
    // This authorizes transport only. The bridge rechecks exact membership and
    // invokes ToolExecutor, which resolves toolId + permissionAction (including
    // argument-dependent actions) and enforces ALLOW/ASK/DENY under the original
    // user/session. Asking here too would create a duplicate approval before
    // the real permission check, and miss argument rewrites in BaseTool.
    return { type: 'control_response', response: { subtype: 'success', request_id, response: allowed
      ? { behavior: 'allow', updatedInput: request.input, toolUseID: request.tool_use_id }
      : { behavior: 'deny', message: 'Octipus tool is not available to this active agent. Do not bypass this decision.' } } };
  }
  const manager = getPermissionManager();
  // One toolId per vendor tool so rules/grants can target `cli-native:Read` vs `cli-native:Bash`.
  const toolId = `cli-native:${request.tool_name}`;
  const permission = await manager.check(context.userId, toolId, request.tool_name, request.input, context);
  const decision = routeApproval({ level: permission.level, role: context.role, root: context.root,
    attended: context.attended, toolId, action: request.tool_name,
    unattendedDenyActions: getConfig().multiuser?.unattendedDenyActions });
  let allowed = decision.route === 'execute';
  if (decision.route === 'ask_human' && context.status === 'running' && !signal?.aborted) {
    const id = await manager.requestApproval(context.userId, context.id, toolId, request.tool_name,
      request.input, context.sessionId, `CLI: ${request.tool_name}`, signal);
    if (context.status !== 'running' || signal?.aborted) manager.cancelWaits(context.id);
    emit('permission_request', { requestId: id, toolName: `CLI: ${request.tool_name}`, args: request.input, toolId });
    allowed = await manager.waitForApproval(id, { agentId: context.id });
  }
  if (allowed) {
    const current = await manager.check(context.userId, toolId, request.tool_name, request.input, context, { revalidate: true });
    if (current.level === 'DENY') allowed = false;
  }
  if (context.status !== 'running' || signal?.aborted) allowed = false;
  return { type: 'control_response', response: { subtype: 'success', request_id, response: allowed
    ? { behavior: 'allow', updatedInput: request.input, toolUseID: request.tool_use_id }
    : { behavior: 'deny', message: 'Octipus permission was denied or not granted. Do not bypass this decision.' } } };
}
