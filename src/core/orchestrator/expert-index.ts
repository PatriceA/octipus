/**
 * Expert index for the orchestrator prompt.
 *
 * The orchestrator routes work by picking a `spawn_child` role, but the role
 * table in prompt.md is static — it can't know about experts the user has
 * created. This builds a compact, per-turn index of every expert visible to
 * the calling user (system experts + the user's own), so the orchestrator can
 * pass an exact `expertId` to spawn_child instead of always falling back to
 * the role's default system expert. The list is read from the DB each turn,
 * so newly added experts are routable immediately — no prompt edits, no
 * restart.
 */

import { asc, desc, eq, or } from 'drizzle-orm';
import { coreLogger } from '@/utils/logger';
import { truncateLinesToTokens } from '@/utils/token-count';

/** Hard cap on prompt lines — an unbounded expert list would eat the context. */
const MAX_EXPERTS_IN_PROMPT = 50;

// Token budget for the whole expert list (Phase 5 item 2 follow-up). The count
// cap alone can't bound it — descriptions are free-form and uncapped, so a few
// verbose experts could dominate the prompt. Sized so 50 minimal lines (the
// count cap) always fit; it only bites when descriptions bloat the block.
// Custom experts sort first, so budget pressure drops system defaults last.
const EXPERT_INDEX_TOKEN_BUDGET = 3000;

export interface ExpertIndexEntry {
  id: string;
  name: string;
  description: string | null;
  role: string;
  isSystem: boolean;
}

/** Load the experts visible to `userId`: system experts + the user's own. */
export async function loadVisibleExperts(userId: string): Promise<ExpertIndexEntry[]> {
  const { getDb } = await import('@/db/postgres');
  const { experts } = await import('@/db/schema/experts');
  const db = getDb();
  const rows = await db
    .select({
      id: experts.id,
      name: experts.name,
      description: experts.description,
      role: experts.role,
      isSystem: experts.isSystem,
    })
    .from(experts)
    .where(or(eq(experts.isSystem, true), eq(experts.userId, userId)))
    // Custom experts first — they're more specific than the generic system
    // defaults, so they should survive the MAX cap and read first.
    .orderBy(asc(experts.isSystem), desc(experts.updatedAt), asc(experts.name))
    .limit(MAX_EXPERTS_IN_PROMPT + 1);
  return rows;
}

/**
 * Render the AVAILABLE EXPERTS prompt block. Returns '' when the lookup fails
 * or there are no experts — the orchestrator then routes by role alone, which
 * is exactly the pre-index behaviour (auto-pick of the role's system expert).
 */
export async function buildExpertIndexBlock(userId: string): Promise<string> {
  let rows: ExpertIndexEntry[];
  try {
    rows = await loadVisibleExperts(userId);
  } catch (err) {
    coreLogger.warn({ err, userId }, 'Expert index lookup failed — orchestrator routes by role only this turn');
    return '';
  }
  if (rows.length === 0) return '';

  const countCapped = rows.length > MAX_EXPERTS_IN_PROMPT;
  const shown = countCapped ? rows.slice(0, MAX_EXPERTS_IN_PROMPT) : rows;

  const allLines = shown.map((e) => {
    const desc = e.description ? ` — ${e.description}` : '';
    const custom = e.isSystem ? '' : ' [custom]';
    return `- ${e.name}${custom} (role: ${e.role}, expertId: ${e.id})${desc}`;
  });
  // Bound the list in tokens too, keeping whole lines so no expertId is severed.
  const { lines, truncated: tokenCapped } = truncateLinesToTokens(allLines, EXPERT_INDEX_TOKEN_BUDGET);
  const truncated = countCapped || tokenCapped;

  return (
    `\n\nAVAILABLE EXPERTS\n` +
    `These experts are configured on this system. When one of them is clearly the best fit for a task, ` +
    `pass its \`expertId\` (and its \`role\`) to spawn_child so the child runs with that expert's prompt, skills, and model. ` +
    `Custom experts (marked [custom]) are user-created specialists — prefer them over the generic system expert of the same role when their description matches the task. ` +
    `If no listed expert stands out, omit \`expertId\` and the role's default expert is used.\n` +
    lines.join('\n') +
    (truncated ? `\n(…list truncated at ${lines.length} experts)` : '')
  );
}
