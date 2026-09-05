import type { ToolHandler } from '@/core/agent-worker';
import { getAgentHooks } from '@/core/agent/hooks';
import { isCancellationError } from '@/core/swarm/errors';
import { recordToolExecution } from '@/core/telemetry';
import type { AgentContext, ToolManifest, } from '@/core/types';
import { canPromptHuman, isListedAction, routeApproval } from '@/security/approval-policy';
import { getPermissionManager } from '@/security/permissions';
import { injectSecrets, redactSecretValues } from '@/security/secret-injector';
import { toolLogger } from '@/utils/logger';

export interface ToolContext extends AgentContext {
  toolId: string;
}

export interface ToolExecutionOptions {
  requiresPermission?: boolean;
  /**
   * Permission action to check. A string is resolved once at registration;
   * a function is resolved per call against the live args, which lets a tool
   * escalate to a more dangerous action (e.g. `execute_elevated`) based on the
   * command being run.
   */
  permissionAction?: string | ((args: Record<string, unknown>) => string);
  injectSecrets?: boolean;
}

export interface ToolAvailability {
  available: boolean;
  degraded?: boolean;
  reason?: string;
}

export abstract class BaseTool {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly version: string;
  abstract readonly description: string;

  protected tools: Map<string, ToolHandler> = new Map();

  /**
   * Get the tool manifest
   */
  abstract getManifest(): ToolManifest;

  /**
   * Check if this tool's external dependencies are satisfied.
   * Override in subclasses that require OAuth tokens, CLI binaries, etc.
   */
  async checkAvailability(): Promise<ToolAvailability> {
    return { available: true };
  }

  /**
   * Initialize the tool
   */
  async initialize(): Promise<void> {
    toolLogger.debug({ toolId: this.id }, 'Tool initializing');
    await this.registerTools();
    toolLogger.info({ toolId: this.id, toolCount: this.tools.size }, 'Tool initialized');
  }

  /**
   * Register all tools provided by this tool
   */
  protected abstract registerTools(): Promise<void>;

  /**
   * Register a single tool
   */
  protected registerTool(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (args: Record<string, unknown>, context: AgentContext) => Promise<unknown>,
    options?: ToolExecutionOptions
  ): void {
    const handler: ToolHandler = {
      name: `${this.id}__${name}`,
      // The swarm's permission intersection (SwarmSpawner.resolveChildTools)
      // looks up `handler.toolId` in the parent's allowedToolIds set — which
      // stores container IDs like 'profiles', 'filesystem'. Without this
      // field set, the intersection falls back to `handler.name`
      // ('profiles__search_profiles') which never matches → the child
      // gets ZERO tools. Must be set.
      toolId: this.id,
      // The agent loop checks permissions before it dispatches, and resolves
      // the action from the handler. Without this it looks up the namespaced
      // call name, matches no manifest permission, and falls back to ASK —
      // turning a declared ALLOW into an approval prompt nobody can answer.
      permissionAction: options?.permissionAction,
      description,
      parameters,
      execute: async (args, context) => {
        // Enforce the `required` list the parameter schema already declares.
        // Nothing used to: a model that omitted a required argument reached the
        // tool body, where an ad-hoc guard let it through (`SLUG_RE.test(
        // undefined)` tests the string "undefined" and passes) and the failure
        // surfaced as a raw Postgres NOT NULL violation the model could not act
        // on. One check here covers every tool instead of every tool body.
        const missing = missingRequiredParams(parameters, args);
        if (missing.length > 0) {
          // Logged rather than silently returned: rejecting before the
          // middleware keeps a malformed call out of the approval queue and the
          // audit trail, so without this line a model repeatedly omitting an
          // argument would be invisible everywhere.
          toolLogger.warn({ toolId: this.id, tool: name, missing }, 'Tool call missing required parameters');
          return { error: `Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` };
        }
        return this.executeWithMiddleware(name, args, context, execute, options);
      },
    };

    this.tools.set(name, handler);
  }

  /**
   * Execute tool with permission checking and secret injection
   */
  private async executeWithMiddleware(
    toolName: string,
    args: Record<string, unknown>,
    context: AgentContext,
    execute: (args: Record<string, unknown>, context: AgentContext) => Promise<unknown>,
    options?: ToolExecutionOptions
  ): Promise<unknown> {
    const toolContext: ToolContext = { ...context, toolId: this.id };
    const hooks = getAgentHooks();
    const hookAgent = {
      userId: context.userId,
      sessionId: context.sessionId,
      role: context.role,
      workspaceId: (context as { workspaceId?: string | null }).workspaceId ?? null,
      metadata: context.metadata as Record<string, unknown> | undefined,
    };

    // ── Dispatch waterfall: `tool:before` ────────────────────────────
    // Around-middleware for every tool call. Subscribers may rewrite args or
    // short-circuit (deny / substitute a result). Fail-closed by design — see
    // `fireWaterfall`. Zero-subscriber cost is one Map lookup.
    const before = await hooks.fireWaterfall('tool:before', {
      toolId: this.id,
      toolName,
      args,
      agent: hookAgent,
    });
    if (before.shortCircuit) {
      const sc = before.shortCircuit;
      const denied = 'deny' in sc;
      await hooks.fire('tool:after', {
        toolId: this.id,
        toolName,
        args: before.args,
        agent: hookAgent,
        status: denied ? 'denied' : 'success',
        result: denied ? undefined : sc.result,
        durationMs: 0,
      });
      // A denial is an error, never an empty success — the model must see that
      // the work did not happen.
      if (denied) throw new Error(`Tool ${this.id}.${toolName} denied by policy: ${sc.deny}`);
      return sc.result;
    }
    // A `tool:before` handler may have rewritten the arguments.
    args = before.args;

    // Permission check.
    //
    // Phase 1c: the legacy `isSystemUser` bypass is honored only when
    // `multiuser.enforcePermissions` is false. With enforcement on,
    // every tool dispatch is gated — system pseudo-users (MCP, API
    // bridges) that need to skip the prompt must instead carry a real
    // user identity and rely on policy/allowlist.
    const isSystemUser = (context.metadata as Record<string, unknown>)?.isSystemUser === true;
    let enforce = false;
    let unattendedDenyActions: string[] | undefined;
    try {
      const { getConfig } = await import('@/config');
      const mu = getConfig().multiuser;
      enforce = !!mu?.enforcePermissions;
      unattendedDenyActions = mu?.unattendedDenyActions;
    } catch { /* config not loaded — fall through to legacy behavior */ }

    const skipForSystem = isSystemUser && !enforce;
    // An unattended caller cannot be asked anything, so unless the operator has
    // named actions to refuse in that case, the whole check is a DB round-trip
    // whose only possible outcome is "carry on" — skipped here on the tool hot
    // path, exactly as before. When the list IS set, we pay for the check and
    // let the shared policy decide. (The agent loop checks every call anyway,
    // so a stored DENY is still enforced there.)
    //
    // Keyed on THIS action, not on whether the list is non-empty. The list
    // stopped being empty by default (`shell.execute_destructive`,
    // `filesystem.delete`), and a mere length test would have re-armed the
    // round-trip for every unattended call to every tool in the system — the
    // hot path this skip exists to protect — to guard two actions.
    const action =
      typeof options?.permissionAction === 'function'
        ? options.permissionAction(args)
        : options?.permissionAction || toolName;
    const skipForUnattended =
      !canPromptHuman(context) && !isListedAction(unattendedDenyActions, this.id, action);
    if (options?.requiresPermission !== false && !skipForSystem && !skipForUnattended) {
      const permissionManager = getPermissionManager();

      const check = await permissionManager.check(context.userId, this.id, action, args);

      // One shared policy with the agent loop — see `security/approval-policy.ts`.
      // The rule this replaces (an inline "not the root agent ⇒ skip the
      // check entirely") lived here as a copy of the one in
      // `tool-executor.ts`, and is the reason a worker's approval request used
      // to hang forever: nobody relays it. Asking the policy also means an
      // operator's `unattendedDenyActions` is honoured on THIS path too, where
      // the old skip could not express a refusal at all.
      const decision = routeApproval({
        level: check.allowed ? 'ALLOW' : check.requiresApproval ? 'ASK' : 'DENY',
        role: context.role,
        toolId: this.id,
        action,
        unattendedDenyActions,
      });

      if (decision.route === 'deny') {
        throw new Error(
          `Permission denied for ${this.id}.${action}: ${check.reason ?? decision.reason}`,
        );
      }

      if (decision.route === 'ask_human') {
        // Request approval
        const requestId = await permissionManager.requestApproval(
          context.userId,
          context.id,
          this.id,
          action,
          args,
          context.sessionId,
          toolName,
        );

        toolLogger.info(
          { toolId: this.id, tool: toolName, requestId },
          'Awaiting permission approval'
        );

        // Wait for approval (this will block until approved/denied/timeout)
        const approved = await permissionManager.waitForApproval(requestId);

        if (!approved) {
          throw new Error(`Permission denied for ${this.id}.${action}`);
        }
      }
    }

    // Inject secrets if needed
    let processedArgs = args;
    const resolvedSecretValues: string[] = [];
    if (options?.injectSecrets !== false) {
      processedArgs = await this.injectSecretsInArgs(args, context.userId, resolvedSecretValues);
    }

    // Execute the tool
    toolLogger.debug({ toolId: this.id, tool: toolName }, 'Executing tool');

    // WS4 observability — count + time every dispatch. `finally` fires on both
    // the success returns (incl. the secret-redaction branch) and the throw.
    const execStart = Date.now();
    let execStatus: 'success' | 'error' | 'cancelled' = 'success';
    let execResult: unknown;
    let execError: unknown;
    try {
      const result = await execute(processedArgs, toolContext);
      execResult = result;
      toolLogger.debug({ toolId: this.id, tool: toolName }, 'Tool executed successfully');

      // Egress control (M2): scrub any resolved secret value from the result so
      // a resolved {{secret:NAME}} cannot be echoed back to the model or logs.
      // No-op when nothing was resolved; non-serializable results are left as-is
      // (they aren't stringified into model context here).
      if (resolvedSecretValues.length > 0) {
        try {
          const serialized = JSON.stringify(result);
          const redacted = redactSecretValues(serialized, resolvedSecretValues);
          if (redacted !== serialized) {
            toolLogger.warn(
              { toolId: this.id, tool: toolName },
              'Redacted resolved secret value(s) from tool output'
            );
            // Keep the hook payload in sync with what the model gets — a
            // `tool:after` subscriber must never see the unredacted secret.
            execResult = JSON.parse(redacted);
            return execResult;
          }
        } catch {
          /* non-serializable result — nothing to redact */
        }
      }
      return result;
    } catch (error) {
      execError = error;
      if (isCancellationError(error)) {
        // Aborted by the agent's cancellation — not a real failure.
        execStatus = 'cancelled';
        toolLogger.info(
          { toolId: this.id, tool: toolName, reason: (error as Error).message },
          'Tool execution cancelled'
        );
      } else {
        execStatus = 'error';
        toolLogger.error({ err: error, toolId: this.id, tool: toolName }, 'Tool execution failed');
      }
      throw error;
    } finally {
      const durationMs = Date.now() - execStart;
      recordToolExecution(toolName, execStatus, durationMs / 1000);
      // ── Dispatch waterfall: `tool:after` ──────────────────────────
      // Observational, so it uses `fire` (a bad subscriber is logged and
      // swallowed): a metrics or tracing hook must never turn a successful
      // tool call into a failure. `result` is read-only here: the return value
      // is already committed by the time this `finally` runs.
      await hooks.fire('tool:after', {
        toolId: this.id,
        toolName,
        args,
        agent: hookAgent,
        status: execStatus,
        result: execResult,
        error: execError,
        durationMs,
      });
    }
  }

  /**
   * Inject secrets in tool arguments.
   *
   * Walks arbitrarily nested objects/arrays. Arrays must be detected before
   * the generic object branch — `typeof [] === 'object'` is true, so without
   * the explicit `Array.isArray` check the old code rebuilt arrays as plain
   * objects keyed by numeric strings. That mangling silently turned every
   * array param into `{ "0": ..., "1": ... }`, so downstream validators
   * (e.g. `art_toolbox_validate`'s `sources must be an array` guard) saw a
   * non-array and rejected the call.
   */
  private async injectSecretsInArgs(
    args: Record<string, unknown>,
    userId: string,
    resolvedValues?: string[]
  ): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(args)) {
      result[key] = await this.injectIntoValue(value, userId, resolvedValues);
    }

    return result;
  }

  private async injectIntoValue(
    value: unknown,
    userId: string,
    resolvedValues?: string[]
  ): Promise<unknown> {
    if (typeof value === 'string') {
      const { content, resolvedValues: resolved } = await injectSecrets(value, { userId, toolId: this.id });
      if (resolvedValues && resolved.length > 0) resolvedValues.push(...resolved);
      return content;
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.injectIntoValue(item, userId, resolvedValues)));
    }
    if (typeof value === 'object' && value !== null) {
      return this.injectSecretsInArgs(value as Record<string, unknown>, userId, resolvedValues);
    }
    return value;
  }

  /**
   * Get all tool handlers
   */
  getToolHandlers(): ToolHandler[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a specific tool handler
   */
  getTool(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  /**
   * Shutdown the tool
   */
  async shutdown(): Promise<void> {
    toolLogger.debug({ toolId: this.id }, 'Tool shutting down');
  }
}

/**
 * Names declared `required` by a tool's parameter schema that the call did not
 * supply. Empty string counts as supplied — a tool may legitimately want one —
 * but null/undefined does not.
 */
function missingRequiredParams(parameters: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const required = (parameters as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter((name): name is string => typeof name === 'string' && args?.[name] == null);
}

/**
 * Helper to create JSON schema for tool parameters
 */
export function createParameterSchema(params: Record<string, {
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
  /**
   * Element schema for `type: 'array'`. REQUIRED for Gemini compatibility —
   * the gemini-envelope sanitizer will inject a `{ type: 'string' }` default
   * if you omit it, but authors should set it explicitly when the element
   * shape is known (object, number, etc.).
   */
  items?: Record<string, unknown>;
  /** Nested property schema for `type: 'object'`. */
  properties?: Record<string, unknown>;
}>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, config] of Object.entries(params)) {
    const prop: Record<string, unknown> = {
      type: config.type,
      description: config.description,
    };
    if (config.default !== undefined) prop.default = config.default;
    if (config.enum) prop.enum = config.enum;
    if (config.items) prop.items = config.items;
    if (config.properties) prop.properties = config.properties;
    properties[name] = prop;

    if (config.required) {
      required.push(name);
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}
