import { z } from 'zod';
import type { ToolManifest } from '@/core/types';
import { BaseTool, createParameterSchema } from '../base-tool';
import { createMonitorSchema } from '@/core/monitors/types';
import { monitorService } from '@/core/monitors/service';
import { monitorRepository } from '@/db/repositories/monitor-repository';

export class MonitorTool extends BaseTool {
  readonly id = 'monitor';
  readonly name = 'Session monitors';
  readonly version = '1.0.0';
  readonly description = 'Persist a condition that wakes this session to continue later. Use for background jobs, browser pipelines, events, state changes, and deadlines. End the turn after arming; do not sleep or poll in the agent loop.';
  getManifest(): ToolManifest {
    return { id: this.id, name: this.name, version: this.version, description: this.description,
      permissions: [{ action: 'read', description: 'List session monitors', defaultLevel: 'ALLOW' }, { action: 'write', description: 'Manage session continuation monitors', defaultLevel: 'ALLOW' }],
      tools: ['create', 'list', 'pause', 'resume', 'cancel'].map(name => ({ name, description: `${name} session monitor`, parameters: {}, returns: 'Monitor status' })),
    };
  }
  protected async registerTools() {
    this.registerTool('create', `${this.description} source.kind=browser requires tabId, exact url, selector, condition {path:"text",operator:"in",value:["Succeeded","Failed","Cancelled"]}. Tool probes require a declared read-only action and a field condition. Event types are gateway event names (e.g. agent.completed); filter by payload identity, optionally add a tool fallback. changed establishes a baseline on the first successful check. Always save a precise continuation and timeout.`, z.toJSONSchema(createMonitorSchema, { io: 'input' }),
      (args, context) => monitorService.create(args, context), { permissionAction: 'write', injectSecrets: false });
    this.registerTool('list', 'List this session’s monitors, status, last check, next check, deadline and errors.', createParameterSchema({}),
      (_args, context) => monitorRepository.list(context.userId, context.sessionId), { permissionAction: 'read' });
    for (const action of ['pause', 'resume', 'cancel'] as const) {
      this.registerTool(action, `${action} a monitor in this session. Cancellation cannot undo a continuation that already started. Pausing does not extend its deadline.`, createParameterSchema({ id: { type: 'string', description: 'Monitor ID', required: true } }),
        (args, context) => monitorService.control(args.id as string, context.userId, context.sessionId, action), { permissionAction: 'write' });
    }
  }
}
export const monitorTool = new MonitorTool();
