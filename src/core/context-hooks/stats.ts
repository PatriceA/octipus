/**
 * The numbers behind the "Automatic recall" panel: how often each hook
 * injected something, and what agents did afterwards — searched the
 * knowledge base or notes themselves, named an injected source in the
 * answer — overall and per model, CLI agents apart from the others.
 *
 * And the eval: a list of questions, each with what a good answer would be
 * found in, run through the recall search against the user's real knowledge
 * base without a model call. That is the number to watch when tuning
 * `minSimilarity`: how many answerable questions found their source, and how
 * many questions that should find nothing were given something anyway.
 */
import { and, desc, eq, gte } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type ContextTurnRow, contextTurns } from '@/db/schema/context-hooks';
import { contentWords, KIND_CONFIG, type RecallConfig, recallHits } from './kinds';
import { listContextHooks } from './store';

const MAX_ROWS = 5_000;

interface Rate { n: number; of: number }
const rate = (n: number, of: number): Rate => ({ n, of });

export interface ContextHookStats {
  days: number;
  turns: number;
  byHook: Array<{ hook: string; kind: string; runs: number; injected: number; abstained: number; skipped: number; errors: number; avgTokens: number; avgLatencyMs: number; avgTopScore: number | null }>;
  /** Finished turns where the agent read the knowledge base or notes itself. */
  searched: Rate;
  /** …of those where recall injected passages, and of those where it found nothing. */
  searchedAfterInjection: Rate;
  searchedAfterAbstain: Rate;
  /** Turns with injected passages whose answer named at least one of them. */
  cited: Rate;
  byModel: Array<{ model: string; cli: boolean | null; turns: number; injected: Rate; searched: Rate; cited: Rate }>;
  recent: Array<Pick<ContextTurnRow, 'id' | 'event' | 'role' | 'channel' | 'model' | 'cli' | 'tokens' | 'latencyMs' | 'knowledgeToolCalls' | 'notesToolCalls' | 'citedItems' | 'outcome'> & {
    createdAt: string;
    hooks: Array<{ hook: string; status: string; reason?: string; titles: string[]; tokens: number }>;
  }>;
  /** What keeps long-term memory from filling; empty when nothing does. */
  memory: { facts: number; missing: Array<'background_model' | 'embedding_model' | 'extraction_off'> };
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

function recallStatus(row: ContextTurnRow): 'injected' | 'abstained' | 'none' {
  const recall = row.hooks.filter((h) => h.kind === 'recall');
  if (recall.some((h) => h.status === 'injected')) return 'injected';
  if (recall.some((h) => h.status === 'abstained')) return 'abstained';
  return 'none';
}

const searchedIn = (row: ContextTurnRow) => (row.knowledgeToolCalls ?? 0) + (row.notesToolCalls ?? 0) > 0;

export async function contextHookStats(userId: string, days = 30): Promise<ContextHookStats> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await getDb().select().from(contextTurns)
    .where(and(eq(contextTurns.userId, userId), gte(contextTurns.createdAt, since)))
    .orderBy(desc(contextTurns.createdAt))
    .limit(MAX_ROWS);

  const hookAgg = new Map<string, { kind: string; runs: number; injected: number; abstained: number; skipped: number; errors: number; tokens: number[]; latency: number[]; top: number[] }>();
  for (const row of rows) {
    for (const h of row.hooks) {
      const a = hookAgg.get(h.hook) ?? { kind: h.kind, runs: 0, injected: 0, abstained: 0, skipped: 0, errors: 0, tokens: [], latency: [], top: [] };
      a.runs++;
      if (h.status === 'injected') { a.injected++; a.tokens.push(h.tokens); }
      else if (h.status === 'abstained') a.abstained++;
      else if (h.status === 'skipped') a.skipped++;
      else a.errors++;
      if (h.status !== 'skipped') a.latency.push(h.latencyMs);
      if (h.items.length) a.top.push(Math.max(...h.items.map((i) => i.score)));
      hookAgg.set(h.hook, a);
    }
  }

  const finished = rows.filter((r) => r.finishedAt);
  const injected = finished.filter((r) => recallStatus(r) === 'injected');
  const abstainedRows = finished.filter((r) => recallStatus(r) === 'abstained');
  const withItems = finished.filter((r) => r.injectedItems > 0);

  const models = new Map<string, ContextTurnRow[]>();
  for (const r of finished) {
    const key = `${r.model ?? 'unknown'}|${r.cli}`;
    models.set(key, [...(models.get(key) ?? []), r]);
  }

  let memory: ContextHookStats['memory'] = { facts: 0, missing: [] };
  try {
    memory = await memoryStatus(userId);
  } catch { /* the panel shows the rest */ }

  return {
    days,
    turns: rows.length,
    byHook: [...hookAgg.entries()].map(([hook, a]) => ({
      hook, kind: a.kind, runs: a.runs, injected: a.injected, abstained: a.abstained, skipped: a.skipped, errors: a.errors,
      avgTokens: avg(a.tokens), avgLatencyMs: avg(a.latency),
      avgTopScore: a.top.length ? Number((a.top.reduce((x, y) => x + y, 0) / a.top.length).toFixed(3)) : null,
    })),
    searched: rate(finished.filter(searchedIn).length, finished.length),
    searchedAfterInjection: rate(injected.filter(searchedIn).length, injected.length),
    searchedAfterAbstain: rate(abstainedRows.filter(searchedIn).length, abstainedRows.length),
    cited: rate(withItems.filter((r) => (r.citedItems ?? 0) > 0).length, withItems.length),
    byModel: [...models.values()].map((list) => ({
      model: list[0].model ?? 'unknown',
      cli: list[0].cli,
      turns: list.length,
      injected: rate(list.filter((r) => r.injectedItems > 0).length, list.length),
      searched: rate(list.filter(searchedIn).length, list.length),
      cited: rate(list.filter((r) => (r.citedItems ?? 0) > 0).length, list.filter((r) => r.injectedItems > 0).length),
    })).sort((a, b) => b.turns - a.turns),
    recent: rows.slice(0, 25).map((r) => ({
      id: r.id, event: r.event, role: r.role, channel: r.channel, model: r.model, cli: r.cli, tokens: r.tokens, latencyMs: r.latencyMs,
      knowledgeToolCalls: r.knowledgeToolCalls, notesToolCalls: r.notesToolCalls, citedItems: r.citedItems, outcome: r.outcome,
      createdAt: r.createdAt.toISOString(),
      hooks: r.hooks.map((h) => ({ hook: h.hook, status: h.status, ...(h.reason ? { reason: h.reason } : {}), titles: h.items.map((i) => i.title), tokens: h.tokens })),
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

export interface RecallEvalCase {
  question: string;
  /** Text naming where the answer is: a note title, a file name, a source id, or a phrase from the passage. Empty: the knowledge base should have nothing. */
  expect: string[];
}

export interface RecallEvalResult {
  config: Pick<RecallConfig, 'limit' | 'minSimilarity'>;
  cases: Array<{ question: string; expect: string[]; hits: Array<{ title: string; sourceId: string; score: number }>; rank: number | null; pass: boolean }>;
  /** Answerable questions whose source was injected. */
  found: Rate;
  /** Mean reciprocal rank over answerable questions (1 = always first). */
  mrr: number;
  /** Questions that should find nothing and were given nothing. */
  abstained: Rate;
}

export async function evaluateRecall(
  userId: string,
  workspaceId: string | null,
  cases: RecallEvalCase[],
  overrides: Partial<Pick<RecallConfig, 'limit' | 'minSimilarity'>> = {},
): Promise<RecallEvalResult> {
  const builtin = (await listContextHooks(userId)).find((h) => h.builtin === 'knowledge-recall');
  const config = KIND_CONFIG.recall.parse({ ...(builtin?.config ?? {}), ...overrides });
  const out: RecallEvalResult['cases'] = [];
  for (const c of cases) {
    const hits = contentWords(c.question) < 2 ? [] : await recallHits({ userId, workspaceId, query: c.question }, config);
    const wanted = c.expect.map((e) => e.trim().toLowerCase()).filter(Boolean);
    const index = wanted.length === 0 ? -1 : hits.findIndex((h) => {
      const hay = [h.metadata?.title ?? '', h.metadata?.filePath ?? '', h.sourceId, h.id, h.content].join('\n').toLowerCase();
      return wanted.some((w) => hay.includes(w));
    });
    const rank = index >= 0 ? index + 1 : null;
    out.push({
      question: c.question,
      expect: c.expect,
      hits: hits.map((h) => ({ title: h.metadata?.title || h.metadata?.filePath || h.sourceId, sourceId: h.sourceId, score: Number(h.similarity.toFixed(3)) })),
      rank,
      pass: wanted.length === 0 ? hits.length === 0 : rank !== null,
    });
  }
  const answerable = out.filter((c) => c.expect.some((e) => e.trim()));
  const empty = out.filter((c) => !c.expect.some((e) => e.trim()));
  return {
    config: { limit: config.limit, minSimilarity: config.minSimilarity },
    cases: out,
    found: rate(answerable.filter((c) => c.rank !== null).length, answerable.length),
    mrr: answerable.length ? Number((answerable.reduce((s, c) => s + (c.rank ? 1 / c.rank : 0), 0) / answerable.length).toFixed(3)) : 0,
    abstained: rate(empty.filter((c) => c.hits.length === 0).length, empty.length),
  };
}
