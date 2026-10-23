/**
 * Run a user's context hooks before an agent starts, and record what they
 * injected and what the agent then did (docs/CONTEXT-HOOKS.md).
 *
 * Hooks run together and share one token budget (`contextHooks.maxTokens`),
 * spent in list order. A hook that fails or takes longer than HOOK_TIMEOUT_MS
 * costs the turn its block, never the turn: the agent starts without it.
 */
import { isJobOn } from '@/core/modules/registry';
import { eq } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { type ContextHookRunRecord, contextTurns } from '@/db/schema/context-hooks';
import { coreLogger } from '@/utils/logger';
import { KIND_RUNNERS } from './kinds';
import { listContextHooks } from './store';
import { agentUsageKey, toolUseSnapshot, type ToolUseCount } from './tool-usage';
import type { ContextHookInput, ContextHookItem, ContextHookResult } from './types';

export const HOOK_TIMEOUT_MS = 4_000;

/** A recorded turn, handed back to `finishContextTurn` when the agent is done. */
export interface ContextTurnHandle {
  id: string;
  /** Whose tool calls count: the session (a root turn and its workers) or one agent (`bindTurnToAgent`). */
  usageKey: string;
  startUse: ToolUseCount;
  /** What the answer can cite: recall passages and context notes, not the index. */
  citable: ContextHookItem[];
}

export interface ContextHooksOutcome {
  text: string;
  turn: ContextTurnHandle | null;
}

const NONE: ContextHooksOutcome = { text: '', turn: null };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The hooks' blocks for this agent start, and the turn record to finish.
 * Never throws.
 */
export async function runContextHooks(
  input: Omit<ContextHookInput, 'tokenBudget'> & { role?: string; channel?: string },
): Promise<ContextHooksOutcome> {
  const settings = getConfig().contextHooks;
  // Recall is the `recall` module (docs/MODULES.md): off, no hook runs.
  if (!settings?.enabled || !isJobOn('context-hooks')) return NONE;
  const started = Date.now();
  let hooks;
  try {
    hooks = (await listContextHooks(input.userId)).filter((h) => h.enabled && h.events.includes(input.event));
  } catch (err) {
    coreLogger.warn({ err, userId: input.userId }, 'context hooks: could not list hooks — agent starts without them');
    return NONE;
  }
  if (hooks.length === 0) return NONE;

  // All hooks at once, under one deadline: a slow embedding provider costs the
  // turn HOOK_TIMEOUT_MS at most, however many hooks the user has. The shared
  // budget is applied afterwards, in list order: a block that no longer fits
  // is left out.
  const results = await Promise.all(hooks.map(async (hook) => {
    const hookStart = Date.now();
    let result: ContextHookResult;
    try {
      result = await withTimeout(KIND_RUNNERS[hook.kind]({ ...input, tokenBudget: settings.maxTokens }, hook.config), HOOK_TIMEOUT_MS);
    } catch (err) {
      const reason = (err as Error)?.message === 'timeout' ? 'timeout' : 'failed';
      coreLogger.warn({ err, hook: hook.name, userId: input.userId }, 'context hook failed — skipped for this turn');
      result = { status: 'error', reason, text: '', items: [], tokens: 0 };
    }
    return { hook, result, latencyMs: Date.now() - hookStart };
  }));

  let budget = settings.maxTokens;
  const texts: string[] = [];
  const records: ContextHookRunRecord[] = [];
  const citable: ContextHookItem[] = [];
  for (const { hook, latencyMs, result: ran } of results) {
    let result = ran;
    if (result.status === 'injected' && result.tokens > budget) {
      result = { status: 'skipped', reason: 'budget_spent', text: '', items: [], tokens: 0 };
    }
    if (result.status === 'injected' && result.text) {
      texts.push(result.text);
      budget -= result.tokens;
      if (hook.kind !== 'notes_index') citable.push(...result.items);
    }
    records.push({
      id: hook.id,
      hook: hook.name,
      kind: hook.kind,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      // The index lists many titles and is not something to cite; its count is enough.
      items: hook.kind === 'notes_index' ? [] : result.items,
      tokens: result.tokens,
      latencyMs,
    });
  }

  const text = texts.join('');
  let turn: ContextTurnHandle | null = null;
  try {
    const [row] = await getDb().insert(contextTurns).values({
      userId: input.userId,
      sessionId: input.sessionId,
      event: input.event,
      role: input.role ?? null,
      channel: input.channel ?? null,
      hooks: records,
      injectedItems: citable.length,
      tokens: records.reduce((n, r) => n + r.tokens, 0),
      latencyMs: Date.now() - started,
    }).returning({ id: contextTurns.id });
    turn = { id: row.id, usageKey: input.sessionId, startUse: toolUseSnapshot(input.sessionId), citable };
  } catch (err) {
    coreLogger.warn({ err, userId: input.userId }, 'context hooks: turn record not saved (measurement only)');
  }
  return { text, turn };
}

/**
 * Count only this agent's own calls from here on: a worker shares its root's
 * session, whose counter also moves with the root's and its siblings' calls.
 */
export function bindTurnToAgent(turn: ContextTurnHandle | null, agentId: string): void {
  if (!turn) return;
  turn.usageKey = agentUsageKey(agentId);
  turn.startUse = toolUseSnapshot(turn.usageKey);
}

/** The citable items the answer names: by title (four characters or more) or by id. */
export function citedItems(response: string, items: ContextHookItem[]): number {
  if (!response) return 0;
  const text = response.toLowerCase();
  return items.filter((item) => {
    const title = item.title.trim().toLowerCase();
    const bare = title.replace(/\.(md|markdown|txt|pdf|docx?)$/, '');
    return (bare.length >= 4 && text.includes(bare)) || text.includes(item.id.toLowerCase()) || text.includes(item.sourceId.toLowerCase());
  }).length;
}

async function describeModel(agentId: string | undefined): Promise<{ model: string | null; cli: boolean | null }> {
  if (!agentId) return { model: null, cli: null };
  const { agentRepository } = await import('@/db/repositories/agent-repository');
  const agent = await agentRepository.findById(agentId);
  const model = agent?.model || null;
  if (!model) return { model: null, cli: null };
  const { modelConfig } = await import('@/db/schema/models');
  const { or } = await import('drizzle-orm');
  const [row] = await getDb().select({ provider: modelConfig.provider }).from(modelConfig)
    .where(or(eq(modelConfig.name, model), eq(modelConfig.modelId, model))).limit(1);
  if (row) return { model, cli: row.provider === 'cli' };
  const { getCLIToolConfig } = await import('@/core/cli-agent-factory');
  return { model, cli: Boolean(getCLIToolConfig(model)) };
}

/** Close a turn record: what the agent looked up itself, and which injected sources its answer named. Never throws. */
export async function finishContextTurn(
  turn: ContextTurnHandle | null,
  done: { agentId?: string; response?: string; outcome?: string },
): Promise<void> {
  if (!turn) return;
  try {
    const end = toolUseSnapshot(turn.usageKey);
    const { model, cli } = await describeModel(done.agentId).catch(() => ({ model: null, cli: null }));
    await getDb().update(contextTurns).set({
      agentId: done.agentId ?? null,
      model,
      cli,
      knowledgeToolCalls: Math.max(0, end.knowledge - turn.startUse.knowledge),
      notesToolCalls: Math.max(0, end.notes - turn.startUse.notes),
      citedItems: citedItems(done.response ?? '', turn.citable),
      outcome: done.outcome ?? null,
      finishedAt: new Date(),
    }).where(eq(contextTurns.id, turn.id));
  } catch (err) {
    coreLogger.warn({ err, turnId: turn.id }, 'context hooks: turn record not finished (measurement only)');
  }
}
