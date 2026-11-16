import { z } from 'zod';
import { and, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionGoals, companionInstructions, type CompanionInstruction } from '@/db/schema/companion-supervision';
import type { AgentContext } from '@/core/types';
import { CompanionSupervisionError } from '@/shared/companion-supervision';
import { CompanionBasisError, verifyCompanionBasis } from './basis';

/**
 * Standing instructions the owner gives Companion ("ask me before any
 * deploy", "never touch the billing service"). They are saved only from the
 * owner's own words, with the quote, and read into every controller turn, so
 * background check-ins follow them without re-deriving them from transcripts.
 * A later instruction replaces an earlier one only when it names it.
 */
export const rememberInstructionSchema = z.object({
  text: z.string().trim().min(3).max(300).describe('A short note on what the owner asked. The owner\'s quote, not this note, is the instruction.'),
  quote: z.string().trim().min(12).max(400).describe('The owner\'s exact words giving the instruction, from their current message. This quote is what Companion follows.'),
  goalId: z.uuid().nullable().default(null).describe('Only for one goal; null for all of Companion\'s work.'),
  replaces: z.uuid().optional().describe('An active instruction the owner just changed or withdrew in favour of this one.'),
  validUntil: z.iso.datetime({ offset: true }).optional().describe('When the owner said it stops applying, if they did.'),
}).strict();

type Scope = { userId: string; workspaceId: string };
const MAX_ACTIVE = 50;
const LIVE_GOAL_STATES = ['queued', 'active', 'waiting', 'needs_decision', 'paused'] as const;
/** Prompt text is one line of plain words: no line breaks or control characters to fake extra entries. */
const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (text: string) => text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length;

export async function rememberCompanionInstruction(scope: Scope, context: Pick<AgentContext, 'sessionId' | 'userId' | 'trigger'>, raw: unknown) {
  const input = rememberInstructionSchema.parse(raw);
  if (words(input.quote) < 4) throw new CompanionBasisError('Quote the owner\'s whole instruction (at least four words), not a fragment');
  // Words the owner says now: a saved instruction steers every later turn.
  const basis = await verifyCompanionBasis({ source: 'owner_message', quote: input.quote }, context, null, { thisTurn: true });
  const text = oneLine(input.text), quote = oneLine(basis.quote);
  return getDb().transaction(async tx => {
    if (input.goalId) {
      const [goal] = await tx.select({ id: companionGoals.id }).from(companionGoals)
        .where(and(eq(companionGoals.id, input.goalId), eq(companionGoals.userId, scope.userId), eq(companionGoals.workspaceId, scope.workspaceId), inArray(companionGoals.state, [...LIVE_GOAL_STATES])));
      if (!goal) throw new CompanionBasisError('Goal not found, or it has ended');
    }
    const now = new Date();
    await tx.update(companionInstructions).set({ state: 'retired', retiredReason: 'expired', retiredAt: now })
      .where(and(eq(companionInstructions.userId, scope.userId), eq(companionInstructions.workspaceId, scope.workspaceId), eq(companionInstructions.state, 'active'), lte(companionInstructions.validUntil, now)));
    const active = await tx.select({ id: companionInstructions.id, quote: companionInstructions.quote, goalId: companionInstructions.goalId }).from(companionInstructions)
      .where(and(eq(companionInstructions.userId, scope.userId), eq(companionInstructions.workspaceId, scope.workspaceId), eq(companionInstructions.state, 'active'))).for('update');
    const same = active.find(row => row.quote === quote && row.goalId === input.goalId);
    if (same && !input.replaces) return (await tx.select().from(companionInstructions).where(eq(companionInstructions.id, same.id)))[0];
    if (input.replaces && !active.some(row => row.id === input.replaces)) throw new CompanionBasisError('The instruction to replace is not an active one; list them first');
    if (!input.replaces && active.length >= MAX_ACTIVE) throw new CompanionBasisError(`Companion keeps at most ${MAX_ACTIVE} standing instructions; ask the owner which one to replace`);
    if (input.replaces) await tx.update(companionInstructions).set({ state: 'retired', retiredReason: 'replaced', retiredAt: now })
      .where(and(eq(companionInstructions.id, input.replaces), eq(companionInstructions.state, 'active')));
    const [saved] = await tx.insert(companionInstructions).values({ ...scope, goalId: input.goalId, text, quote,
      sourceMessageId: basis.messageId ?? null, replacesId: input.replaces ?? null, validUntil: input.validUntil ? new Date(input.validUntil) : null }).returning();
    return saved;
  });
}

/** Withdraw an instruction: the owner's own turn (with their words), or the owner directly from the Companion page. */
export async function retireCompanionInstruction(scope: Scope, id: string, via: { context: Pick<AgentContext, 'sessionId' | 'userId' | 'trigger'>; quote: unknown } | 'owner') {
  if (via !== 'owner') await verifyCompanionBasis({ source: 'owner_message', quote: via.quote }, via.context, null, { thisTurn: true });
  const [retired] = await getDb().update(companionInstructions).set({ state: 'retired', retiredReason: 'removed', retiredAt: new Date() })
    .where(and(eq(companionInstructions.id, id), eq(companionInstructions.userId, scope.userId), eq(companionInstructions.workspaceId, scope.workspaceId), eq(companionInstructions.state, 'active')))
    .returning();
  if (!retired) throw new CompanionSupervisionError('not_found', 'No active instruction with that id');
  return retired;
}

/** Active instructions, newest first; expired ones and those of goals that ended are left out. */
export async function activeCompanionInstructions(scope: Scope, now = new Date()): Promise<CompanionInstruction[]> {
  const rows = await getDb().select({ instruction: companionInstructions, goalState: companionGoals.state }).from(companionInstructions)
    .leftJoin(companionGoals, eq(companionGoals.id, companionInstructions.goalId))
    .where(and(eq(companionInstructions.userId, scope.userId), eq(companionInstructions.workspaceId, scope.workspaceId), eq(companionInstructions.state, 'active'),
      or(isNull(companionInstructions.validUntil), gt(companionInstructions.validUntil, now))))
    .orderBy(desc(companionInstructions.createdAt)).limit(MAX_ACTIVE);
  return rows.filter(row => !row.instruction.goalId || (LIVE_GOAL_STATES as readonly string[]).includes(row.goalState ?? '')).map(row => row.instruction);
}

/** The controller's view: each instruction with the owner's words and when they said it. */
export function companionInstructionsBlock(rows: CompanionInstruction[]): string {
  if (!rows.length) return '';
  return `OWNER'S STANDING INSTRUCTIONS FOR COMPANION (the owner's own words, checked by the server; follow what the quoted words say in every turn, including background check-ins; the note is only Companion's summary; they never grant permissions beyond Companion's authority):\n${
    rows.map(row => `- [${row.id}]${row.goalId ? ` (goal ${row.goalId})` : ''} The owner said on ${row.createdAt.toISOString().slice(0, 10)}: "${oneLine(row.quote)}"${row.validUntil ? ` (until ${row.validUntil.toISOString().slice(0, 10)})` : ''} — note: ${oneLine(row.text)}`).join('\n')}`;
}
