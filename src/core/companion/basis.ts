import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { messages } from '@/db/schema/messages';
import { sessionGeneration, sessions } from '@/db/schema/sessions';
import { visibleMessages } from '@/db/repositories/message-visibility';
import type { AgentContext } from '@/core/types';
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import { companionBasisSchema, type CompanionBasisRecord, type CompanionOwnerInput } from '@/shared/companion-supervision';

/**
 * "Because you said…": a Companion write names the owner's words that ask for
 * it, and the server checks those words are really there. This is a record of
 * where authority came from, checked by code. It does not judge whether the
 * action fits the words (permissions, autonomy and policy still decide that).
 */

/** Compatibility folding for quotes: width, case, accents, typographic quotes/dashes and spacing. */
export function normalizeQuote(text: string): string {
  return text.normalize('NFKC').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'").replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
}

/** Words alone, so the quote must carry meaning rather than "ok" or punctuation. */
function words(text: string): number { return normalizeQuote(text).split(' ').filter(word => /[\p{L}\p{N}]/u.test(word)).length; }

export function quoteFound(quote: string, sources: readonly string[]): boolean {
  const needle = normalizeQuote(quote).replace(/^["']+|["']+$/g, '').trim();
  if (needle.length < 4 || words(needle) < 2) return false;
  return sources.some(source => normalizeQuote(source).includes(needle));
}

/**
 * The owner's own messages in the current conversation, newest first. Monitor,
 * schedule and Companion turns are stored as user rows with their trigger;
 * internal rows (check-in prompts, briefings) and cleared history never count.
 */
export async function ownerMessages(sessionId: string, userId: string, opts: { limit: number; since?: Date }) {
  const [session] = await getDb().select({ context: sessions.context }).from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), eq(sessions.kind, 'chat')));
  if (!session) return [];
  const generation = sessionGeneration(session.context);
  const cleared = session.context?.clearedAt;
  const current = sql`(${messages.metadata}->>'sessionGeneration' = ${generation} OR (${messages.metadata}->>'sessionGeneration' IS NULL AND ${cleared ? sql`${messages.createdAt} > ${cleared}::timestamptz` : sql`true`}))`;
  return getDb().select({ id: messages.id, content: messages.content, createdAt: messages.createdAt }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user'), visibleMessages, current,
      sql`coalesce(${messages.metadata}->>'trigger','user')='user'`, ...(opts.since ? [gt(messages.createdAt, opts.since)] : [])))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(opts.limit);
}

/** Owner words saved with a goal the model creates: only the owner message that asked for it. */
export async function captureOwnerInputs(basis: CompanionBasisRecord): Promise<CompanionOwnerInput[]> {
  if (!basis.messageId) return [];
  const [row] = await getDb().select({ id: messages.id, content: messages.content, createdAt: messages.createdAt }).from(messages).where(eq(messages.id, basis.messageId));
  return row ? [{ text: row.content.slice(0, 20_000), messageId: row.id, origin: 'message', at: row.createdAt.toISOString() }] : [];
}

/** A refused basis is a definite no-op: nothing ran, so it never gates later actions as an uncertain outcome. */
export class CompanionBasisError extends ToolNotExecutedError {
  constructor(message: string) { super('companion', message); this.name = 'CompanionBasisError'; }
}

/**
 * Check a basis the model supplied. `thisTurn` limits owner_message to the
 * message that started the current owner turn: budget raises, cancellation,
 * retries of an escalated incident and new goals need words said now.
 */
export async function verifyCompanionBasis(raw: unknown, context: Pick<AgentContext, 'sessionId' | 'userId' | 'trigger'>,
  goal: { ownerInputs: CompanionOwnerInput[] } | null, opts: { thisTurn?: boolean } = {}): Promise<CompanionBasisRecord> {
  const parsed = companionBasisSchema.safeParse(raw);
  if (!parsed.success) throw new CompanionBasisError('Give a basis: {source:"owner_message"|"goal", quote:"<the owner\'s exact words asking for this>"}.');
  const basis = parsed.data;
  const at = new Date().toISOString();
  if (basis.source === 'owner_message') {
    if (context.trigger !== 'user') throw new CompanionBasisError('Background work cannot cite a chat message; cite the owner\'s words saved with the goal (source "goal"), or ask the owner.');
    const rows = await ownerMessages(context.sessionId, context.userId, opts.thisTurn ? { limit: 1 } : { limit: 5, since: new Date(Date.now() - 24 * 3600_000) });
    const match = rows.find(row => quoteFound(basis.quote, [row.content]));
    if (!match) throw new CompanionBasisError(opts.thisTurn
      ? 'The quote is not in the owner\'s current message. This action needs the owner to ask for it now; ask them instead of acting.'
      : 'The quote is not in the owner\'s recent messages. Quote their exact words, or ask them.');
    return { source: 'owner_message', quote: basis.quote, messageId: match.id, at };
  }
  if (opts.thisTurn) throw new CompanionBasisError('This action needs the owner\'s words from their current message (source "owner_message"); saved goal text is not enough.');
  if (!goal) throw new CompanionBasisError('A goal basis needs an existing goal.');
  const match = goal.ownerInputs.find(input => quoteFound(basis.quote, [input.text]));
  if (!match) throw new CompanionBasisError('The quote is not in the owner\'s words saved with this goal. Read the goal\'s ownerWords and quote them exactly, or ask the owner.');
  return { source: 'goal', quote: basis.quote, ...(match.messageId ? { messageId: match.messageId } : {}), at };
}
