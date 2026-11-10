/**
 * How a contribution calls its package's tool: through the bridge's
 * `callTool`, the same door an agent's call goes through, so the declared
 * effect, permission rules, approvals, the protection level and the circuit
 * breaker all apply. Nothing here waves a call through.
 */
import { buildAgentContext, resolveAgentScope, type AgentScope } from '@/core/agent/context';
import { withExecutionSignal } from '@/core/execution-scope';
import type { AgentContext } from '@/core/types';
import { getMCPBridge, PLUGIN_SERVER_PREFIX } from '@/mcp/bridge';
import { generateId } from '@/utils/crypto';

/** The longest text a contribution's tool result is cut to. */
export const MAX_RESULT_CHARS = 8_000;

export function serverIdOf(pkg: string): string {
  return `${PLUGIN_SERVER_PREFIX}${pkg}`;
}

/** The text of an MCP tool result, and whether the tool reported an error. */
export function resultText(result: unknown): { text: string; isError: boolean } {
  if (result && typeof result === 'object') {
    const r = result as { content?: unknown; isError?: unknown };
    const isError = r.isError === true;
    if (Array.isArray(r.content)) {
      const text = r.content
        .filter((c): c is { type: 'text'; text: string } => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
        .map((c) => c.text)
        .join('\n');
      return { text: text.slice(0, MAX_RESULT_CHARS), isError };
    }
    return { text: '', isError };
  }
  return { text: typeof result === 'string' ? result.slice(0, MAX_RESULT_CHARS) : '', isError: false };
}

export interface ActingAs {
  pkg: string;
  /** Whose call it is: a real user id (permission rules and approvals are per user). */
  userId: string;
  /** What runs it, for the context id and the audit row. */
  kind: 'command' | 'schedule' | 'event' | 'context';
  /** A person is waiting and can answer an approval prompt. */
  attended: boolean;
  /** The session the call is about (its protection level applies), or none. */
  sessionId?: string;
  /** The scope, when the caller already resolved it (a turn); otherwise the user's own, resolved here. */
  scope?: AgentScope;
  /** Only with no `scope`: the session row (a command typed in a session). */
  session?: { id?: string; userId: string; workspaceId?: string | null; kind?: string | null } | null;
  /** Only with no `scope` and no session: the workspace to run in. */
  workspaceId?: string | null;
  role?: string;
}

/** The agent context a contribution's call runs under. */
export async function actingContext(as: ActingAs): Promise<AgentContext> {
  const scope = as.scope ?? await resolveAgentScope({
    session: as.session ?? null,
    userId: as.userId,
    trigger: as.kind === 'command' || as.kind === 'context' ? 'user' : 'schedule',
    ...(as.workspaceId !== undefined ? { workspaceId: as.workspaceId } : {}),
  });
  return buildAgentContext({
    id: `plugin:${as.pkg}:${as.kind}:${generateId().slice(0, 12)}`,
    sessionId: as.sessionId ?? '',
    userId: as.userId,
    scope,
    topic: 'plugin',
    model: 'plugin',
    role: as.role ?? 'general',
    root: false,
    attended: as.attended,
    status: 'running',
    metadata: { source: 'plugin-contribution', plugin: as.pkg, contribution: as.kind },
  });
}

/**
 * Call `tool` of package `pkg` under `context`. With `timeoutMs`, the request
 * is cancelled when it runs out (the call then throws `timeout`).
 */
export async function callPluginTool(
  pkg: string, tool: string, args: Record<string, unknown>, context: AgentContext, timeoutMs?: number,
): Promise<{ text: string; isError: boolean }> {
  const bridge = getMCPBridge();
  const call = () => bridge.callTool(serverIdOf(pkg), tool, args, context);
  if (timeoutMs === undefined) return resultText(await call());
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    return resultText(await Promise.race([withExecutionSignal(context, controller.signal, call), deadline]));
  } finally {
    clearTimeout(timer);
  }
}

/** Replace every string value `"$args"` in `template` (nested too) by `args`. */
export function expandInput(template: Record<string, unknown>, args: string): Record<string, unknown> {
  const expand = (v: unknown): unknown => {
    if (v === '$args') return args;
    if (Array.isArray(v)) return v.map(expand);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
    return v;
  };
  return expand(template) as Record<string, unknown>;
}
