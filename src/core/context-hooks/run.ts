/**
 * Run a user's context hooks before an agent starts, and record what they
 * injected and what the agent then did (docs/CONTEXT-HOOKS.md).
 *
 * Hooks run together and share one token budget (`contextHooks.maxTokens`),
 * spent in list order. A hook that fails or takes longer than HOOK_TIMEOUT_MS
 * costs the turn its block, never the turn: the agent starts without it.
 *
 * A hook computes its block without side effects; what showing it implies
 * (recall: the session's protection level, the passages' access counts) is
 * its result's `commit`, run here only for the blocks that are injected. A
 * block dropped for the budget, or a hook that timed out and finishes later,
 * leaves nothing behind but its run record.
 */
import { isJobOn } from '@/core/modules/registry';
import { eq } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { type ContextHookRunRecord, contextTurns } from '@/db/schema/context-hooks';
import { coreLogger } from '@/utils/logger';
import { withDeadline } from '@/utils/concurrency';
import type { RepeatableBlock } from '@/core/agent/repeated-context';
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
  /** Each injected hook's block, in order: `text` is their concatenation. */
  blocks: string[];
  /** `blocks` with each hook's name, for the Context inspector. */
  labelledBlocks: Array<{ label: string; text: string }>;
  /**
   * `blocks` as the cross-turn omission takes them (`REPEATABLE_CONTEXT_KEY`):
   * the recall block as a group repeated per passage, the others whole.
   */
  repeatable: RepeatableBlock[];
  turn: ContextTurnHandle | null;
}

const NONE: ContextHooksOutcome = { text: '', blocks: [], labelledBlocks: [], repeatable: [], turn: null };

/**
 * The hooks' blocks for this agent start, and the turn record to finish.
 * Never throws.
 */
export async function runContextHooks(
  input: Omit<ContextHookInput, 'tokenBudget' | 'previousMessage'> & {
    role?: string;
    channel?: string;
    /**
     * `ContextHookInput.previousMessage`, or how to read it. A reader runs
     * once, only when a recall hook runs, and inside that hook's deadline: a
     * slow read costs the turn no more than the hook may.
     */
    previousMessage?: string | (() => Promise<string | undefined>);
  },
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
  const { previousMessage, ...hookInput } = input;
  let previous: Promise<string | undefined> | undefined;
  const previousFor = (): Promise<string | undefined> =>
    (previous ??= typeof previousMessage === 'function' ? previousMessage() : Promise.resolve(previousMessage));

  // All hooks at once, under one deadline: a slow embedding provider costs the
  // turn HOOK_TIMEOUT_MS at most, however many hooks the user has. The shared
  // budget is applied afterwards, in list order: a block that no longer fits
  // is left out.
  const results = await Promise.all(hooks.map(async (hook) => {
    const hookStart = Date.now();
    let result: ContextHookResult;
    try {
      result = await withDeadline(async () => {
        // Only recall reads the previous message (`buildRecallQuery`).
        const prev = hook.kind === 'recall' ? await previousFor() : undefined;
        return KIND_RUNNERS[hook.kind]({ ...hookInput, ...(prev ? { previousMessage: prev } : {}), tokenBudget: settings.maxTokens }, hook.config);
      }, HOOK_TIMEOUT_MS);
    } catch (err) {
      const reason = (err as Error)?.message === 'timeout' ? 'timeout' : 'failed';
      coreLogger.warn({ err, hook: hook.name, userId: input.userId }, 'context hook failed — skipped for this turn');
      result = { status: 'error', reason, text: '', items: [], tokens: 0 };
    }
    return { hook, result, latencyMs: Date.now() - hookStart };
  }));

  // The shared budget, in list order: a block that no longer fits is left out.
  let budget = settings.maxTokens;
  const kept = results.map(({ hook, latencyMs, result: ran }) => {
    let result = ran;
    if (result.status === 'injected' && result.tokens > budget) {
      result = { status: 'skipped', reason: 'budget_spent', text: '', items: [], tokens: 0, ...(ran.degraded ? { degraded: ran.degraded } : {}) };
    }
    if (result.status === 'injected' && result.text) budget -= result.tokens;
    return { hook, latencyMs, result };
  });

  // The side effects of what is shown, before the agent starts: the session
  // must hold the level of what it was given before it can pass it on. A
  // commit that fails leaves its block out (fail safe: a block whose level
  // could not be raised is not shown).
  await Promise.all(kept.map(async (entry) => {
    const { hook, result } = entry;
    const commit = result.commit;
    if (result.status !== 'injected' || !result.text || !commit) return;
    try {
      await withDeadline(() => commit(), HOOK_TIMEOUT_MS);
    } catch (err) {
      coreLogger.error({ err, hook: hook.name, userId: input.userId }, 'context hook: committing its block failed — the block is left out of this turn');
      entry.result = { status: 'error', reason: 'commit_failed', text: '', items: [], tokens: 0, ...(result.degraded ? { degraded: result.degraded } : {}) };
    }
  }));

  const texts: string[] = [];
  const repeatable: RepeatableBlock[] = [];
  const labelledBlocks: ContextHooksOutcome['labelledBlocks'] = [];
  const records: ContextHookRunRecord[] = [];
  const citable: ContextHookItem[] = [];
  for (const { hook, latencyMs, result } of kept) {
    if (result.status === 'injected' && result.text) {
      texts.push(result.text);
      repeatable.push(result.repeatable ?? result.text);
      labelledBlocks.push({ label: `Context hook: ${hook.name}`, text: result.text });
      if (hook.kind !== 'notes_index') citable.push(...result.items);
    }
    records.push({
      id: hook.id,
      hook: hook.name,
      kind: hook.kind,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.degraded ? { degraded: result.degraded } : {}),
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
  return { text, blocks: texts.filter(Boolean), labelledBlocks, repeatable, turn };
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
