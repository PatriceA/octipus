/**
 * Run a user's context hooks before an agent starts, and record what they
 * injected and what the agent then did (docs/CONTEXT-HOOKS.md).
 *
 * Hooks run together and share one token budget (`contextHooks.maxTokens`),
 * spent in list order. A hook that fails or is not done HOOK_TIMEOUT_MS after
 * the run began costs the turn its block, never the turn: the agent starts
 * without it. Listing, hooks and commits all end by START_DEADLINE_MS.
 *
 * A hook computes its block without side effects; what showing it implies
 * (recall: the session's protection level, the passages' access counts) is
 * its result's `commit`, run here only for the blocks that are injected. A
 * block dropped for the budget, or a hook that timed out and finishes later,
 * leaves nothing behind but its run record.
 */
import { isJobOn } from '@/core/modules/registry';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { type ContextHookRunRecord, contextTurns } from '@/db/schema/context-hooks';
import { coreLogger } from '@/utils/logger';
import { withDeadline } from '@/utils/concurrency';
import type { RepeatableBlock } from '@/core/agent/repeated-context';
import { KIND_RUNNERS } from './kinds';
import { citedItems, usedPassages } from './measure';
import { listContextHooks } from './store';
import { agentUsageKey, toolUseSnapshot, type ToolUseCount } from './tool-usage';
import type { ContextHookInput, ContextHookItem, ContextHookResult } from './types';

/**
 * The latest a hook's block can be ready, counted from the start of the run
 * (listing the user's hooks included): a hook still running then is cut off
 * (`timeout`) and the agent starts without its block.
 */
export const HOOK_TIMEOUT_MS = 4_000;
/**
 * The whole run before an agent starts: listing the hooks, running them
 * (HOOK_TIMEOUT_MS of it) and committing what is shown. A commit still
 * running at it leaves its block out (`commit_failed`). The turn record is
 * written after, without holding up the start.
 */
export const START_DEADLINE_MS = 4_500;

/** How a hook's search went, kept on its record when its block is left out after: the reduced mode and whether it cleared the bar. */
function searchedWith(result: ContextHookResult): Pick<ContextHookResult, 'degraded' | 'bar'> {
  return {
    ...(result.degraded ? { degraded: result.degraded } : {}),
    ...(result.bar ? { bar: result.bar } : {}),
  };
}

/** A recorded turn, handed back to `finishContextTurn` when the agent is done. */
export interface ContextTurnHandle {
  id: string;
  /** Whose tool calls count: the session (a root turn and its workers) or one agent (`bindTurnToAgent`). */
  usageKey: string;
  startUse: ToolUseCount;
  /**
   * What the answer can name: the recall passages. Not a context note (shown
   * every turn as guidance, not a source to name) nor the index.
   */
  citable: ContextHookItem[];
  /**
   * The recall passages shown, each with its excerpt and the query it was
   * searched with: what `finishContextTurn` compares the answer against
   * (`usedPassages`). In memory only; the row gets the count.
   */
  shown: Array<{ excerpt: string; query: string }>;
  /** The record's write (`runContextHooks` does not wait for it); false when it failed. Absent: written. */
  recorded?: Promise<boolean>;
  /** Passages shown but not yet counted as read (`accessOnStart`): `bindTurnToAgent` counts them. */
  pendingAccess?: string[];
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
    /**
     * Count the shown passages as read only when the agent has started
     * (`bindTurnToAgent`), not here: for a start that can still be refused
     * after its hooks (the concurrency limit, a quota, the space check of the
     * spawn). The protection level is raised here either way: the model is
     * chosen after it, and raising it for a passage no model saw is the safe
     * direction.
     */
    accessOnStart?: boolean;
  },
): Promise<ContextHooksOutcome> {
  const settings = getConfig().contextHooks;
  // Recall is the `recall` module (docs/MODULES.md): off, no hook runs.
  if (!settings?.enabled || !isJobOn('context-hooks')) return NONE;
  const started = Date.now();
  const hooksBy = started + HOOK_TIMEOUT_MS;
  const startBy = started + START_DEADLINE_MS;
  const left = (by: number) => Math.max(0, by - Date.now());
  let hooks;
  try {
    hooks = (await withDeadline(() => listContextHooks(input.userId), left(hooksBy))).filter((h) => h.enabled && h.events.includes(input.event));
  } catch (err) {
    coreLogger.warn({ err, userId: input.userId }, 'context hooks: could not list hooks — agent starts without them');
    return NONE;
  }
  if (hooks.length === 0) return NONE;
  const { previousMessage, accessOnStart, ...hookInput } = input;
  let previous: Promise<string | undefined> | undefined;
  const previousFor = (): Promise<string | undefined> =>
    (previous ??= typeof previousMessage === 'function' ? previousMessage() : Promise.resolve(previousMessage));

  // All hooks at once, under one deadline: a slow embedding provider costs the
  // turn HOOK_TIMEOUT_MS at most, however many hooks the user has. The shared
  // budget is applied afterwards, in list order: a block that no longer fits
  // is left out. A hook is handed the deadline and its signal, which aborts
  // when it passes: recall then does not search after it.
  const results = await Promise.all(hooks.map(async (hook) => {
    const hookStart = Date.now();
    let result: ContextHookResult;
    try {
      result = await withDeadline(async (signal) => {
        // Only recall reads the previous message (`buildRecallQuery`).
        const prev = hook.kind === 'recall' ? await previousFor() : undefined;
        return KIND_RUNNERS[hook.kind]({ ...hookInput, ...(prev ? { previousMessage: prev } : {}), tokenBudget: settings.maxTokens, deadlineAt: hooksBy, signal }, hook.config);
      }, left(hooksBy));
    } catch (err) {
      const reason = (err as Error)?.message === 'timeout' ? 'timeout' : 'failed';
      coreLogger.warn({ err, hook: hook.name, userId: input.userId }, 'context hook failed — skipped for this turn');
      result = { status: 'error', reason, text: '', items: [], tokens: 0 };
    }
    return { hook, result, latencyMs: Date.now() - hookStart };
  }));

  // The shared budget in list order, and the side effects of what is shown
  // before the agent starts: the session must hold the level of what it was
  // given before it can pass it on. A commit that fails leaves its block out
  // (fail safe: a block whose level could not be raised is not shown) and
  // gives its tokens back: a later block left out for the budget is then
  // considered again, and committed in turn. A block once committed stays.
  const kept = results.map((r) => ({ ...r, decided: r.result.status !== 'injected' || !r.result.text }));
  const spent = () => kept.reduce((n, e) => n + (e.decided && e.result.status === 'injected' ? e.result.tokens : 0), 0);
  for (;;) {
    let budget = settings.maxTokens - spent();
    const round = kept.filter((e) => {
      if (e.decided || e.result.tokens > budget) return false;
      budget -= e.result.tokens;
      return true;
    });
    if (round.length === 0) break;
    const failed = await Promise.all(round.map(async (entry) => {
      entry.decided = true;
      const { hook, result } = entry;
      if (!result.commit) return false;
      const commit = result.commit;
      try {
        await withDeadline(() => commit(), left(startBy));
        return false;
      } catch (err) {
        coreLogger.error({ err, hook: hook.name, userId: input.userId }, 'context hook: committing its block failed — the block is left out of this turn');
        entry.result = { status: 'error', reason: 'commit_failed', text: '', items: [], tokens: 0, ...searchedWith(result) };
        return true;
      }
    }));
    if (!failed.some(Boolean)) break;
  }
  for (const entry of kept) {
    if (entry.decided) continue;
    const ran = entry.result;
    entry.result = { status: 'skipped', reason: 'budget_spent', text: '', items: [], tokens: 0, ...searchedWith(ran) };
  }

  const texts: string[] = [];
  const repeatable: RepeatableBlock[] = [];
  const labelledBlocks: ContextHooksOutcome['labelledBlocks'] = [];
  const records: ContextHookRunRecord[] = [];
  const citable: ContextHookItem[] = [];
  let injectedItems = 0;
  const shown: ContextTurnHandle['shown'] = [];
  const access: string[] = [];
  for (const { hook, latencyMs, result } of kept) {
    if (result.status === 'injected' && result.text) {
      if (result.access) access.push(...result.access);
      texts.push(result.text);
      repeatable.push(result.repeatable ?? result.text);
      labelledBlocks.push({ label: `Context hook: ${hook.name}`, text: result.text });
      if (hook.kind !== 'notes_index') injectedItems += result.items.length;
      if (hook.kind === 'recall') citable.push(...result.items);
      if (result.shown) shown.push(...result.shown.excerpts.map((excerpt) => ({ excerpt, query: result.shown?.query ?? '' })));
    }
    records.push({
      id: hook.id,
      hook: hook.name,
      kind: hook.kind,
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      ...searchedWith(result),
      // The index lists many titles and is not something to cite; its count is enough.
      items: hook.kind === 'notes_index' ? [] : result.items,
      tokens: result.tokens,
      latencyMs,
    });
  }

  const text = texts.join('');
  // The record is measurement: written after, without holding up the start.
  // The handle exists at once (its id chosen here); finishing it waits for
  // the write, and is skipped when the write failed.
  const id = randomUUID();
  const recorded = getDb().insert(contextTurns).values({
    id,
    userId: input.userId,
    sessionId: input.sessionId,
    event: input.event,
    role: input.role ?? null,
    channel: input.channel ?? null,
    hooks: records,
    injectedItems,
    tokens: records.reduce((n, r) => n + r.tokens, 0),
    latencyMs: Date.now() - started,
  }).then(() => true, (err: unknown) => {
    coreLogger.warn({ err, userId: input.userId }, 'context hooks: turn record not saved (measurement only)');
    return false;
  });
  const turn: ContextTurnHandle = {
    id, usageKey: input.sessionId, startUse: toolUseSnapshot(input.sessionId), citable, shown, recorded,
    ...(accessOnStart && access.length ? { pendingAccess: access } : {}),
  };
  if (!accessOnStart) countAccess(access);
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
  // The agent exists: what it was shown counts as read, once (a retry binds again).
  if (turn.pendingAccess) countAccess(turn.pendingAccess);
  delete turn.pendingAccess;
}

/** Count recall passages as read (LFU retention). Fire and forget, as `recordAccess` is. */
function countAccess(ids: string[]): void {
  if (!ids.length) return;
  void import('@/core/rag/embeddings').then(({ getEmbeddingService }) => getEmbeddingService().recordAccess(ids), (err: unknown) => {
    coreLogger.warn({ err, count: ids.length }, 'context hooks: shown passages not counted as read (retention signal only)');
  });
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

/**
 * Close a turn record: what the agent looked up itself, which injected
 * sources its answer named, and how many recall passages it used. Never
 * throws. For a worker or a swarm child the answer is its result text.
 */
export async function finishContextTurn(
  turn: ContextTurnHandle | null,
  done: { agentId?: string; response?: string; outcome?: string },
): Promise<void> {
  if (!turn) return;
  try {
    const end = toolUseSnapshot(turn.usageKey);
    if (turn.recorded && !(await turn.recorded)) return;
    const { model, cli } = await describeModel(done.agentId).catch(() => ({ model: null, cli: null }));
    await getDb().update(contextTurns).set({
      agentId: done.agentId ?? null,
      model,
      cli,
      knowledgeToolCalls: Math.max(0, end.knowledge - turn.startUse.knowledge),
      notesToolCalls: Math.max(0, end.notes - turn.startUse.notes),
      // A title that only repeats what was searched for is not counted as named.
      citedItems: citedItems(done.response ?? '', turn.citable, [...new Set(turn.shown.map((s) => s.query))].join('\n')),
      // Measured only when recall showed something; no answer uses nothing.
      usedItems: turn.shown.length ? usedPassages(done.response ?? '', turn.shown) : null,
      outcome: done.outcome ?? null,
      finishedAt: new Date(),
    }).where(eq(contextTurns.id, turn.id));
  } catch (err) {
    coreLogger.warn({ err, turnId: turn.id }, 'context hooks: turn record not finished (measurement only)');
  }
}
