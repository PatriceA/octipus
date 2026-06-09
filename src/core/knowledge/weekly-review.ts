import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { memories } from '@/db/schema/memories';
import { taskState } from '@/db/schema/task-state';
import { SECURITY_PREAMBLE } from '@/core/orchestrator/roles';
import { type CompletionOptions, getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { getNoteService, type NoteService } from './notes';

/**
 * Knowledge-graph Tier 2 — weekly review.
 * See `docs/KNOWLEDGE-GRAPH.md`.
 *
 * Reads the week's daily notes + completed task_state + new memories and
 * asks an LLM to write a review note that links the projects/notes it
 * references. The model binds to the `knowledge_review` registry topic —
 * never a hardcoded model (house rule 2); an unbound topic throws.
 *
 * Dependencies are injectable so the assembly + save logic is testable
 * without a live model.
 */

export interface ReviewContext {
  start: string; // YYYY-MM-DD inclusive
  end: string;   // YYYY-MM-DD inclusive
  dailyNotes: Array<{ slug: string; title: string; body: string }>;
  completedTasks: Array<{ ownerAgent: string; taskKind: string; outputs: unknown }>;
  newMemories: Array<{ factType: string; content: string }>;
}

export interface WeeklyReviewDeps {
  notes?: NoteService;
  resolveModelId?: () => Promise<string | null>;
  complete?: (req: CompletionOptions) => Promise<{ content?: string }>;
}

const REVIEW_SYSTEM_PROMPT = `${SECURITY_PREAMBLE}

You are a journaling assistant writing a concise weekly review for the user
from their own notes and activity. Write GitHub-flavored markdown. Structure:
a one-paragraph summary, then "## Themes", "## Decisions", "## Open threads".
When you mention a topic that appears as a note, link it with a [[wikilink]]
using the note's title so the review connects into the user's knowledge graph.
Be specific and brief. Do not invent activity that isn't in the material.`;

const DAY_MS = 24 * 60 * 60 * 1000;

function toDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Gather the raw material for a review window ending at `end` (default today). */
export async function assembleReviewContext(userId: string, end: Date = new Date()): Promise<ReviewContext> {
  const endDay = toDay(end);
  const start = new Date(end.getTime() - 6 * DAY_MS);
  const startDay = toDay(start);
  const db = getDb();
  const svc = getNoteService();

  const daily = await svc.list(userId, { kind: 'daily', limit: 14 });
  const dailyNotes = daily
    .filter((n) => n.noteDate && n.noteDate >= startDay && n.noteDate <= endDay)
    .map((n) => ({ slug: n.slug, title: n.title, body: n.body }));

  const completedTasks = (
    await db
      .select({ ownerAgent: taskState.ownerAgent, taskKind: taskState.taskKind, outputs: taskState.outputs, updatedAt: taskState.updatedAt })
      .from(taskState)
      .where(and(eq(taskState.userId, userId), eq(taskState.status, 'done'), gte(taskState.updatedAt, start), lte(taskState.updatedAt, end)))
      .orderBy(desc(taskState.updatedAt))
      .limit(100)
  ).map((t) => ({ ownerAgent: t.ownerAgent, taskKind: t.taskKind, outputs: t.outputs }));

  const newMemories = (
    await db
      .select({ factType: memories.factType, content: memories.content, createdAt: memories.createdAt })
      .from(memories)
      .where(and(eq(memories.userId, userId), isNull(memories.supersededBy), gte(memories.createdAt, start)))
      .orderBy(desc(memories.createdAt))
      .limit(50)
  ).map((m) => ({ factType: m.factType, content: m.content }));

  return { start: startDay, end: endDay, dailyNotes, completedTasks, newMemories };
}

/** Render the assembled context into the user-message payload for the model. */
export function renderReviewPrompt(ctx: ReviewContext): string {
  const parts: string[] = [`Review window: ${ctx.start} → ${ctx.end}`];
  if (ctx.dailyNotes.length) {
    parts.push('\n# Daily notes');
    for (const n of ctx.dailyNotes) parts.push(`\n## ${n.title} (${n.slug})\n${n.body}`);
  }
  if (ctx.completedTasks.length) {
    parts.push('\n# Completed work');
    for (const t of ctx.completedTasks) parts.push(`- [${t.ownerAgent}/${t.taskKind}] ${JSON.stringify(t.outputs).slice(0, 300)}`);
  }
  if (ctx.newMemories.length) {
    parts.push('\n# New facts learned');
    for (const m of ctx.newMemories) parts.push(`- (${m.factType}) ${m.content}`);
  }
  if (ctx.dailyNotes.length === 0 && ctx.completedTasks.length === 0 && ctx.newMemories.length === 0) {
    parts.push('\n(No recorded activity this week.)');
  }
  return parts.join('\n');
}

export async function generateWeeklyReview(
  userId: string,
  workspaceId: string | null = null,
  deps: WeeklyReviewDeps = {},
): Promise<{ noteId: string; slug: string }> {
  const notes = deps.notes ?? getNoteService();
  const resolveModelId = deps.resolveModelId ?? (async () => {
    const m = await getModelRegistry().getModelForTopic('knowledge_review');
    return m?.modelId ?? null;
  });
  const complete = deps.complete ?? ((req) => getLiteLLMClient().complete(req));

  const modelId = await resolveModelId();
  if (!modelId) {
    // Fail loud — an unbound worker topic is a configuration error, not a
    // reason to silently produce nothing (house rule 2).
    throw new Error('Weekly review needs a model bound to topic "knowledge_review". Assign one on the Models page.');
  }

  const ctx = await assembleReviewContext(userId, new Date());
  const payload = renderReviewPrompt(ctx);

  const result = await complete({
    model: modelId,
    messages: [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT, timestamp: new Date() },
      { role: 'user', content: payload, timestamp: new Date() },
    ],
    temperature: 0.3,
    maxTokens: 1200,
    userId,
  } satisfies CompletionOptions);
  const body = (result.content ?? '').trim();
  if (!body) throw new Error('Weekly review model returned empty content');

  const slug = `reviews/week-of-${ctx.start}`;
  const saved = await notes.save({
    userId,
    workspaceId,
    slug,
    title: `Weekly review — week of ${ctx.start}`,
    body,
    noteKind: 'moc',
  });
  coreLogger.info({ component: 'weekly-review', userId, slug, links: saved.links }, 'Generated weekly review note');
  return { noteId: saved.note.id, slug: saved.note.slug };
}
