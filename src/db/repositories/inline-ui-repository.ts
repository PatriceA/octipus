import { and, asc, count, eq, gt, inArray } from 'drizzle-orm';
import { getDb } from '../postgres';
import { inlineUiBlocks, type InlineUiBlock, type NewInlineUiBlock } from '../schema/inline-ui-blocks';
import type { InlineUiViewState } from '@/shared/inline-ui/view/types';

/**
 * Store of interactive-answer sources (docs/plans/inline-ui-spec.md §5.1).
 * Every read is keyed by a session id the caller has already been authorized
 * for (`inlineUiAccess` in src/core/inline-ui/access.ts, or the agent's own
 * session), and never by a block id alone.
 */
export class InlineUiRepository {
  private get db() { return getDb(); }

  async create(row: NewInlineUiBlock): Promise<InlineUiBlock> {
    const [created] = await this.db.insert(inlineUiBlocks).values(row).returning();
    return created;
  }

  /** Blocks one session holds (the per-session cap). */
  async countForSession(sessionId: string): Promise<number> {
    // i2: by session id, for the agent runtime that owns the session
    const [row] = await this.db.select({ n: count() }).from(inlineUiBlocks).where(eq(inlineUiBlocks.sessionId, sessionId));
    return Number(row?.n ?? 0);
  }

  /** One block of one session, or undefined — a block id from another session is not found. */
  async getInSession(id: string, sessionId: string): Promise<InlineUiBlock | undefined> {
    // i2: by session id the caller was authorized for (inlineUiAccess / the agent's own session)
    const [row] = await this.db.select().from(inlineUiBlocks)
      .where(and(eq(inlineUiBlocks.id, id), eq(inlineUiBlocks.sessionId, sessionId)))
      .limit(1);
    return row;
  }

  /** Several blocks of one session (unknown or foreign ids are left out). */
  async getManyInSession(ids: string[], sessionId: string): Promise<InlineUiBlock[]> {
    if (ids.length === 0) return [];
    // i2: by session id the caller was authorized for
    return this.db.select().from(inlineUiBlocks)
      .where(and(inArray(inlineUiBlocks.id, ids), eq(inlineUiBlocks.sessionId, sessionId)));
  }

  /**
   * Record the last answer sent from a view of one session (spec §4). False
   * when the session holds no view with that id: an HTML block never takes a
   * state.
   */
  async setState(id: string, sessionId: string, state: InlineUiViewState): Promise<boolean> {
    // i2: by session id the caller was authorized for (the turn's own session)
    const rows = await this.db.update(inlineUiBlocks).set({ state })
      .where(and(eq(inlineUiBlocks.id, id), eq(inlineUiBlocks.sessionId, sessionId), eq(inlineUiBlocks.kind, 'view')))
      .returning({ id: inlineUiBlocks.id });
    return rows.length > 0;
  }

  /** Metadata of a session's blocks, oldest first, written after `since` (the session's last clear). */
  async listForSession(sessionId: string, since?: Date): Promise<Array<Omit<InlineUiBlock, 'css' | 'html' | 'js' | 'view'>>> {
    // i2: by session id the caller was authorized for (inlineUiAccess)
    return this.db.select({
      id: inlineUiBlocks.id,
      sessionId: inlineUiBlocks.sessionId,
      runId: inlineUiBlocks.runId,
      agentId: inlineUiBlocks.agentId,
      requesterId: inlineUiBlocks.requesterId,
      title: inlineUiBlocks.title,
      kind: inlineUiBlocks.kind,
      state: inlineUiBlocks.state,
      heightHint: inlineUiBlocks.heightHint,
      scripts: inlineUiBlocks.scripts,
      tainted: inlineUiBlocks.tainted,
      risk: inlineUiBlocks.risk,
      issues: inlineUiBlocks.issues,
      createdAt: inlineUiBlocks.createdAt,
    }).from(inlineUiBlocks)
      .where(and(eq(inlineUiBlocks.sessionId, sessionId), ...(since ? [gt(inlineUiBlocks.createdAt, since)] : [])))
      .orderBy(asc(inlineUiBlocks.createdAt))
      .limit(500);
  }
}

export const inlineUiRepository = new InlineUiRepository();
