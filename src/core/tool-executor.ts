import { getPermissionManager } from '@/security/permissions';
import { auditRepository } from '@/db/repositories/audit-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { agentLogger } from '@/utils/logger';
import { sanitizeToolOutput } from '@/utils/sanitize';
import type { AgentContext, AgentMessage, ToolCall, ToolResult } from './types';
import type { ToolHandler, AgentEvent } from './agent-base';

const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

export class ToolExecutor {
  private tools: Map<string, ToolHandler> = new Map();
  private consecutiveToolErrors: number = 0;
  private _toolsDisabled: boolean = false;

  constructor(
    private context: AgentContext,
    private emitFn: (type: AgentEvent['type'], data: unknown) => void,
  ) {}

  get toolsDisabled(): boolean {
    return this._toolsDisabled;
  }

  registerTool(tool: ToolHandler): void {
    this.tools.set(tool.name, tool);
    agentLogger.debug({ agentId: this.context.id, tool: tool.name }, 'Tool registered');
  }

  registerTools(tools: ToolHandler[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  getTools(): Map<string, ToolHandler> {
    return this.tools;
  }

  /**
   * Handle tool calls from the LLM with permission gating.
   * Returns tool result messages to append to the conversation.
   */
  async handleToolCalls(toolCalls: ToolCall[]): Promise<AgentMessage[]> {
    this.emitFn('action', {
      toolCalls: toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        argsSummary: Object.entries(tc.arguments)
          .map(([k, v]) => {
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            return `${k}: ${s.length > 60 ? s.slice(0, 57) + '...' : s}`;
          })
          .join(', ')
          .slice(0, 120),
      })),
    });

    const permissionManager = getPermissionManager();
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      const tool = this.tools.get(toolCall.name);

      if (!tool) {
        results.push({
          toolCallId: toolCall.id,
          result: null,
          error: `Unknown tool: ${toolCall.name}`,
        });
        continue;
      }

      const skillId = tool.skillId || 'agent';

      // Internal orchestrator meta-tools are always allowed
      if (skillId === 'agent') {
        try {
          const toolExecStart = Date.now();
          const result = await tool.execute(toolCall.arguments, this.context);
          const toolExecMs = Date.now() - toolExecStart;

          agentLogger.info({
            agentId: this.context.id, sessionId: this.context.sessionId,
            tool: toolCall.name, skillId, durationMs: toolExecMs,
          }, 'Tool executed');

          results.push({ toolCallId: toolCall.id, result });

          if (tool.final) {
            this._toolsDisabled = true;
            agentLogger.info(
              { agentId: this.context.id, tool: toolCall.name },
              'Final tool executed — disabling tools for remaining iterations',
            );
          }
        } catch (error) {
          results.push({ toolCallId: toolCall.id, result: null, error: (error as Error).message });
        }
        continue;
      }

      // Permission check
      const permResult = await permissionManager.check(
        this.context.userId,
        skillId,
        toolCall.name,
        toolCall.arguments
      );

      if (permResult.level === 'DENY') {
        agentLogger.info(
          { agentId: this.context.id, tool: toolCall.name, reason: permResult.reason },
          'Tool call denied by permission policy'
        );

        results.push({
          toolCallId: toolCall.id,
          result: null,
          error: `Permission denied: ${permResult.reason || 'action is not allowed'}`,
        });

        await auditRepository.logToolDenied(
          this.context.userId,
          this.context.sessionId,
          toolCall.name,
          skillId,
          { args: toolCall.arguments, reason: permResult.reason }
        );
        continue;
      }

      if (permResult.level === 'ASK') {
        const requestId = await permissionManager.requestApproval(
          this.context.userId,
          this.context.id,
          skillId,
          toolCall.name,
          toolCall.arguments,
          this.context.sessionId
        );

        this.emitFn('permission_request', {
          requestId,
          toolName: toolCall.name,
          args: toolCall.arguments,
          skillId,
        });

        const approved = await permissionManager.waitForApproval(requestId);

        if (!approved) {
          agentLogger.info(
            { agentId: this.context.id, tool: toolCall.name, requestId },
            'Tool call denied by user'
          );

          results.push({
            toolCallId: toolCall.id,
            result: null,
            error: 'Permission denied: user rejected the request',
          });

          await auditRepository.logToolDenied(
            this.context.userId,
            this.context.sessionId,
            toolCall.name,
            skillId,
            { args: toolCall.arguments, reason: 'user_denied', requestId }
          );
          continue;
        }
      }

      // ALLOW path (or approved ASK) — execute tool
      try {
        const toolExecStart = Date.now();
        const result = await tool.execute(toolCall.arguments, this.context);
        const toolExecMs = Date.now() - toolExecStart;

        agentLogger.info({
          agentId: this.context.id, sessionId: this.context.sessionId,
          tool: toolCall.name, skillId, durationMs: toolExecMs,
        }, 'Tool executed');

        results.push({ toolCallId: toolCall.id, result });

        if (tool.final) {
          this._toolsDisabled = true;
          agentLogger.info(
            { agentId: this.context.id, tool: toolCall.name },
            'Final tool executed — disabling tools for remaining iterations',
          );
        }

        const resultStr = sanitizeToolOutput(result);
        await auditRepository.logToolExecuted(
          this.context.userId,
          this.context.sessionId,
          toolCall.name,
          skillId,
          { args: toolCall.arguments, result: resultStr.slice(0, 10_000), durationMs: toolExecMs }
        );
      } catch (error) {
        agentLogger.error(
          { error, agentId: this.context.id, tool: toolCall.name },
          'Tool execution failed'
        );

        results.push({
          toolCallId: toolCall.id,
          result: null,
          error: (error as Error).message,
        });
      }
    }

    this.emitFn('observation', { results });

    // Track consecutive tool failures
    const allFailed = results.length > 0 && results.every(r => r.error);
    const toolMessages: AgentMessage[] = [];

    if (allFailed) {
      this.consecutiveToolErrors++;
      if (this.consecutiveToolErrors >= MAX_CONSECUTIVE_TOOL_ERRORS) {
        agentLogger.warn(
          { agentId: this.context.id, consecutiveErrors: this.consecutiveToolErrors },
          'Too many consecutive tool failures — disabling tools'
        );
        this._toolsDisabled = true;
        toolMessages.push({
          role: 'system',
          content: 'The tools have failed multiple times in a row and are now unavailable. Provide the best response you can with the information you already have. Explain to the user which tools failed and why.',
          timestamp: new Date(),
        });
      }
    } else {
      this.consecutiveToolErrors = 0;
    }

    // Build tool result messages
    for (const result of results) {
      toolMessages.push({
        role: 'tool',
        content: result.error || sanitizeToolOutput(result.result),
        toolCallId: result.toolCallId,
        timestamp: new Date(),
      });

      // Persist tool result (skip for orchestrator)
      if (this.context.role !== 'orchestrator') {
        await messageRepository.create({
          sessionId: this.context.sessionId,
          role: 'tool',
          content: result.error || sanitizeToolOutput(result.result),
          toolCallId: result.toolCallId,
          agentId: this.context.id,
        });
      }
    }

    return toolMessages;
  }
}
