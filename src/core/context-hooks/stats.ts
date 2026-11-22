/**
 * The numbers behind the Recall page: how often each hook injected
 * something and why it did not, and what agents did afterwards — searched
 * the knowledge base or notes themselves, named a recall passage in the
 * answer, used one — overall, per model (CLI agents apart from the others)
 * and per event (root turns apart from specialists and swarm children). A
 * recall hook that shows passages on nearly every searched message, or
 * almost never, gets a calibration warning (`calibrationVerdict`).
 *
 * And the eval: a list of questions, each with what a good answer would be
 * found in, run through the recall search against the user's real knowledge
 * base without a model call — once at the hook's settings, or swept across a
 * range of `minSimilarity` values with a recommended one (`sweepRecall`).
 */
import { requireCapability } from '@/core/capabilities/gates';
import { and, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type ContextHookRunRecord, type ContextTurnRow, contextTurns } from '@/db/schema/context-hooks';
import { getConfig } from '@/config';
import type {
  ContextHookStats, ContextHookUse, Rate, RecallCalibrationWarning, RecallEvalCase, RecallEvalResult, RecallQualifiedBy, RecallSweepResult,
} from '@/shared/context-hooks';
import { coreLogger } from '@/utils/logger';
import { choosePassages, KIND_CONFIG, type RecallConfig, type RecallSearch, type RecallSelection, searchRecall, selectRecallPassages } from './kinds';
import { calibrationMessage, calibrationSample, calibrationVerdict, MAX_SWEEP_THRESHOLDS, recommendThreshold, SWEEP_THRESHOLDS } from './measure';
import { listContextHooks } from './store';
import { CONTEXT_HOOK_EVENTS } from './types';

export type { ContextHookStats, RecallEvalCase, RecallEvalResult, RecallSweepResult } from '@/shared/context-hooks';

const MAX_ROWS = 5_000;

const rate = (n: number, of: number): Rate => ({ n, of });

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

function recallStatus(row: ContextTurnRow): 'injected' | 'abstained' | 'none' {
  const recall = row.hooks.filter((h) => h.kind === 'recall');
  if (recall.some((h) => h.status === 'injected')) return 'injected';
  if (recall.some((h) => h.status === 'abstained')) return 'abstained';
  return 'none';
}

/**
 * Recall passages shown on this turn, read from its hook records, so rows
 * written before `used_items` count the same way. A context note is not
 * one: it is shown every turn as guidance, not a source to name.
 */
const recallPassages = (row: ContextTurnRow) =>
  row.hooks.reduce((n, h) => n + (h.kind === 'recall' && h.status === 'injected' ? h.items.length : 0), 0);

const searchedIn = (row: ContextTurnRow) => (row.knowledgeToolCalls ?? 0) + (row.notesToolCalls ?? 0) > 0;

/** Named and used over finished turns. */
function use(list: ContextTurnRow[]): ContextHookUse {
  const withPassages = list.filter((r) => recallPassages(r) > 0);
  // Rows from before used_items was measured hold null: they are left out of "used".
  const measured = withPassages.filter((r) => r.usedItems !== null);
  return {
    turns: list.length,
    injected: rate(withPassages.length, list.length),
    searched: rate(list.filter(searchedIn).length, list.length),
    cited: rate(withPassages.filter((r) => (r.citedItems ?? 0) > 0).length, withPassages.length),
    used: rate(measured.filter((r) => (r.usedItems ?? 0) > 0).length, measured.length),
  };
}

function groupBy<K>(rows: ContextTurnRow[], key: (r: ContextTurnRow) => K): Map<K, ContextTurnRow[]> {
  const out = new Map<K, ContextTurnRow[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** A passage qualified on similarity: what a top score is about. Rows from before `qualifiedBy` was recorded count every passage. */
const bySimilarity = (item: ContextHookRunRecord['items'][number]) => !item.qualifiedBy || item.qualifiedBy.includes('similarity');

interface HookAgg {
  name: string; kind: string; runs: number; injected: number; abstained: number; skipped: number; errors: number;
  tokens: number[]; latency: number[]; top: number[]; degraded: number; budgetSpent: number; commitFailed: number;
  qualified: Record<RecallQualifiedBy, number>;
  /** Calibration: runs that searched on the bar, and those that found passages (`calibrationSample`). */
  searched: number; found: number;
}

export async function contextHookStats(userId: string, days = 30): Promise<ContextHookStats> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await getDb().select().from(contextTurns)
    .where(and(eq(contextTurns.userId, userId), gte(contextTurns.createdAt, since)))
    .orderBy(desc(contextTurns.createdAt))
    .limit(MAX_ROWS + 1);
  const sampled = rows.length > MAX_ROWS;
  if (sampled) rows.pop();

  const hookAgg = new Map<string, HookAgg>();
  for (const row of rows) {
    for (const h of row.hooks) {
      // Grouped by id: names repeat and change. Rows from before ids were recorded group by name.
      const key = h.id ?? `name:${h.hook}`;
      const a = hookAgg.get(key) ?? {
        name: h.hook, kind: h.kind, runs: 0, injected: 0, abstained: 0, skipped: 0, errors: 0, tokens: [], latency: [], top: [],
        degraded: 0, budgetSpent: 0, commitFailed: 0, qualified: { similarity: 0, coverage: 0, identifier: 0 }, searched: 0, found: 0,
      };
      a.runs++;
      if (h.status === 'injected') { a.injected++; a.tokens.push(h.tokens); }
      else if (h.status === 'abstained') a.abstained++;
      else if (h.status === 'skipped') a.skipped++;
      else a.errors++;
      if (h.status !== 'skipped') a.latency.push(h.latencyMs);
      if (h.degraded) a.degraded++;
      if (h.reason === 'budget_spent') a.budgetSpent++;
      if (h.reason === 'commit_failed') a.commitFailed++;
      if (h.status === 'injected') for (const item of h.items) for (const q of item.qualifiedBy ?? []) a.qualified[q]++;
      // The top score is the cosine of a passage that cleared the bar on it: a
      // keyword-only passage has a score of 0 and says nothing about the bar.
      const scored = h.items.filter(bySimilarity);
      if (scored.length) a.top.push(Math.max(...scored.map((i) => i.score)));
      if (h.kind === 'recall') {
        const sample = calibrationSample(h);
        if (sample) a.searched++;
        if (sample === 'found') a.found++;
      }
      a.name = a.name || h.hook;
      hookAgg.set(key, a);
    }
  }

  const finished = rows.filter((r) => r.finishedAt);
  const injected = finished.filter((r) => recallStatus(r) === 'injected');
  const abstainedRows = finished.filter((r) => recallStatus(r) === 'abstained');
  const overall = use(finished);

  let memory: ContextHookStats['memory'] = { facts: 0, missing: [] };
  try {
    memory = await memoryStatus(userId);
  } catch (err) {
    coreLogger.warn({ err, userId }, 'context hooks: memory status could not be read — the panel shows the rest');
  }

  const calibration: RecallCalibrationWarning[] = [];
  for (const [id, a] of hookAgg) {
    if (a.kind !== 'recall') continue;
    const verdict = calibrationVerdict(a.found, a.searched);
    if (verdict) calibration.push({ id, hook: a.name, verdict, found: rate(a.found, a.searched), message: calibrationMessage(a.name, verdict, a.found, a.searched) });
  }

  return {
    days,
    turns: rows.length,
    sampled,
    byHook: [...hookAgg.entries()].map(([id, a]) => ({
      id, hook: a.name, kind: a.kind, runs: a.runs, injected: a.injected, abstained: a.abstained, skipped: a.skipped, errors: a.errors,
      avgTokens: avg(a.tokens), avgLatencyMs: avg(a.latency),
      avgTopScore: a.top.length ? Number((a.top.reduce((x, y) => x + y, 0) / a.top.length).toFixed(3)) : null,
      degraded: a.degraded, budgetSpent: a.budgetSpent, commitFailed: a.commitFailed, qualified: a.qualified,
    })),
    searched: overall.searched,
    searchedAfterInjection: rate(injected.filter(searchedIn).length, injected.length),
    searchedAfterAbstain: rate(abstainedRows.filter(searchedIn).length, abstainedRows.length),
    cited: overall.cited,
    used: overall.used,
    byModel: [...groupBy(finished, (r) => `${r.model ?? 'unknown'}|${r.cli}`).values()]
      .map((list) => ({ model: list[0].model ?? 'unknown', cli: list[0].cli, ...use(list) }))
      .sort((a, b) => b.turns - a.turns),
    byEvent: CONTEXT_HOOK_EVENTS
      .map((event) => ({ event, ...use(finished.filter((r) => r.event === event)) }))
      .filter((e) => e.turns > 0),
    calibration,
    recent: rows.slice(0, 25).map((r) => ({
      id: r.id, event: r.event, role: r.role, channel: r.channel, model: r.model, cli: r.cli, tokens: r.tokens, latencyMs: r.latencyMs,
      knowledgeToolCalls: r.knowledgeToolCalls, notesToolCalls: r.notesToolCalls, citedItems: r.citedItems, usedItems: r.usedItems, outcome: r.outcome,
      createdAt: r.createdAt.toISOString(),
      hooks: r.hooks.map((h) => ({
        hook: h.hook, status: h.status, ...(h.reason ? { reason: h.reason } : {}), ...(h.degraded ? { degraded: h.degraded } : {}),
        titles: h.items.map((i) => i.title), tokens: h.tokens,
      })),
    })),
    memory,
  };
}

/**
 * Long-term memory only fills when the extractor can run: a model on the
 * `background` topic (it extracts and judges facts), an embedding model (it
 * stores and dedups them), and extraction not switched off. Without them the
 * memory block is empty on every turn, which looks exactly like "the agent
 * ignores memory".
 */
async function memoryStatus(userId: string): Promise<ContextHookStats['memory']> {
  const { queryRaw } = await import('@/db/postgres');
  const { getModelRegistry } = await import('@/models/model-registry');
  const { getConfig } = await import('@/config');
  const facts = await queryRaw('SELECT count(*)::int AS n FROM memories_active WHERE user_id = $1', [userId]);
  const registry = getModelRegistry();
  const [background, embedding] = await Promise.all([
    registry.getModelForTopic('background').catch(() => null),
    registry.getModelForTopic('embedding').catch(() => null),
  ]);
  const missing: ContextHookStats['memory']['missing'] = [];
  if (!background) missing.push('background_model');
  if (!embedding) missing.push('embedding_model');
  if (getConfig().memory?.extractionCadence === 'off') missing.push('extraction_off');
  return { facts: Number(facts.rows[0]?.n ?? 0), missing };
}

// ── Eval ────────────────────────────────────────────────────────────────────

/** The Knowledge recall hook's settings with `overrides`, and the budget a turn would give it. */
async function evalSettings(userId: string, overrides: Partial<Pick<RecallConfig, 'limit' | 'minSimilarity'>>): Promise<{ config: RecallConfig; budget: number }> {
  // Recall searches the knowledge base: nothing to evaluate without an embedding model.
  await requireCapability('embedding');
  const builtin = (await listContextHooks(userId)).find((h) => h.builtin === 'knowledge-recall');
  const config = KIND_CONFIG.recall.parse({ ...(builtin?.config ?? {}), ...overrides });
  // The hook's own selection, within the budget a turn would give it: what is
  // reported is exactly what would be injected.
  const budget = Math.min(config.tokenBudget, getConfig().contextHooks?.maxTokens ?? config.tokenBudget);
  return { config, budget };
}

/** One case scored against what recall would inject for it. */
function scoreCase(c: RecallEvalCase, passages: RecallSelection['passages']): RecallEvalResult['cases'][number] {
  const hits = passages.map((p) => p.hit);
  const wanted = c.expect.map((e) => e.trim().toLowerCase()).filter(Boolean);
  const index = wanted.length === 0 ? -1 : hits.findIndex((h) => {
    const hay = [h.metadata?.title ?? '', h.metadata?.filePath ?? '', h.sourceId, h.id, h.content].join('\n').toLowerCase();
    return wanted.some((w) => hay.includes(w));
  });
  const rank = index >= 0 ? index + 1 : null;
  return {
    question: c.question,
    expect: c.expect,
    hits: passages.map((p) => ({ title: p.item.title, sourceId: p.item.sourceId, score: p.item.score })),
    rank,
    pass: wanted.length === 0 ? hits.length === 0 : rank !== null,
  };
}

/** Found, mean reciprocal rank and abstained over scored cases. */
function summarize(out: RecallEvalResult['cases']): Pick<RecallEvalResult, 'found' | 'mrr' | 'abstained'> {
  const answerable = out.filter((c) => c.expect.some((e) => e.trim()));
  const empty = out.filter((c) => !c.expect.some((e) => e.trim()));
  return {
    found: rate(answerable.filter((c) => c.rank !== null).length, answerable.length),
    mrr: answerable.length ? Number((answerable.reduce((s, c) => s + (c.rank ? 1 / c.rank : 0), 0) / answerable.length).toFixed(3)) : 0,
    abstained: rate(empty.filter((c) => c.hits.length === 0).length, empty.length),
  };
}

export async function evaluateRecall(
  userId: string,
  workspaceId: string | null,
  cases: RecallEvalCase[],
  overrides: Partial<Pick<RecallConfig, 'limit' | 'minSimilarity'>> = {},
): Promise<RecallEvalResult> {
  const { config, budget } = await evalSettings(userId, overrides);
  const out: RecallEvalResult['cases'] = [];
  for (const c of cases) {
    const { passages } = await selectRecallPassages({ userId, workspaceId, query: c.question }, config, budget);
    out.push(scoreCase(c, passages));
  }
  return { config: { limit: config.limit, minSimilarity: config.minSimilarity }, cases: out, ...summarize(out) };
}

/**
 * The eval at each of `thresholds` (`SWEEP_THRESHOLDS` by default), with the
 * value `recommendThreshold` picks. Each question is searched, and so
 * embedded, once: what depends on `minSimilarity` is the selection from the
 * candidates (`choosePassages`), run per threshold without I/O. The hook's
 * other settings are kept. No recommendation when a question could not be
 * embedded (the bar was not applied to it) or the cases lack one of the two
 * kinds of question.
 */
export async function sweepRecall(
  userId: string,
  workspaceId: string | null,
  cases: RecallEvalCase[],
  options: { thresholds?: readonly number[]; limit?: number } = {},
): Promise<RecallSweepResult> {
  const thresholds = [...new Set(options.thresholds ?? SWEEP_THRESHOLDS)].sort((a, b) => a - b);
  if (!thresholds.length || thresholds.length > MAX_SWEEP_THRESHOLDS || thresholds.some((t) => !(t >= 0 && t <= 1))) {
    throw new Error(`thresholds: 1 to ${MAX_SWEEP_THRESHOLDS} values between 0 and 1`);
  }
  const { config, budget } = await evalSettings(userId, options.limit !== undefined ? { limit: options.limit } : {});
  const searched: Array<RecallSearch | null> = [];
  for (const c of cases) searched.push(await searchRecall({ userId, workspaceId, query: c.question }, config));
  const degraded = searched.filter((s) => s?.search.embeddingError).length;
  const rows = thresholds.map((minSimilarity) => {
    const at = { ...config, minSimilarity };
    const out = cases.map((c, i) => {
      const s = searched[i];
      return scoreCase(c, s ? choosePassages(s, at, budget).passages : []);
    });
    const { found, abstained, mrr } = summarize(out);
    return { minSimilarity, found, abstained, mrr };
  });
  const { recommended, reason } = degraded ? { recommended: null, reason: 'embedding_failed' as const } : recommendThreshold(rows);
  return {
    config: { limit: config.limit, keywordCoverage: config.keywordCoverage, maxGap: config.maxGap, minSimilarity: config.minSimilarity },
    rows, recommended, ...(reason ? { reason } : {}), degraded,
  };
}
