/**
 * How often agents of a session read the knowledge base or notes themselves:
 * the counter the context-hook measurement reads at the start and end of a
 * turn. Every Octipus tool call goes through the ToolExecutor in this
 * process, a CLI agent's bridge calls included, so a counter here sees them
 * all. Process-local and bounded: a restart mid-turn loses that turn's
 * count, nothing else.
 */
export interface ToolUseCount {
  knowledge: number;
  notes: number;
}

const READ_ACTION = /search|read|query|list|backlink|graph|traverse|get|find/i;
const MAX_SESSIONS = 5_000;
const counters = new Map<string, ToolUseCount>();

function bump(key: string, toolId: 'knowledge' | 'notes'): void {
  const current = counters.get(key) ?? { knowledge: 0, notes: 0 };
  counters.delete(key);
  counters.set(key, { ...current, [toolId]: current[toolId] + 1 });
  if (counters.size > MAX_SESSIONS) counters.delete(counters.keys().next().value as string);
}

/** The counter of one agent, as opposed to its whole session (a root turn and every worker it spawned). */
export const agentUsageKey = (agentId: string) => `agent:${agentId}`;

/**
 * Record one successful call, under the session and under the agent that made
 * it. Only reads count: writing a note is not looking something up.
 */
export function noteToolUse(sessionId: string | undefined, toolId: string, toolName: string, agentId?: string): void {
  if (!sessionId || (toolId !== 'knowledge' && toolId !== 'notes')) return;
  const action = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
  if (!READ_ACTION.test(action)) return;
  bump(sessionId, toolId);
  if (agentId) bump(agentUsageKey(agentId), toolId);
}

/** The counts so far under a session id or an `agentUsageKey`. */
export function toolUseSnapshot(key: string): ToolUseCount {
  return { ...(counters.get(key) ?? { knowledge: 0, notes: 0 }) };
}

export function resetToolUse(): void {
  counters.clear();
}
