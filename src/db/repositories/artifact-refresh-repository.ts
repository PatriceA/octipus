/**
 * Rows of `artifact_agent_refresh` (src/core/artifacts/agent-refresh.ts).
 * Keyed by artifact id; callers resolve access to the artifact first (its
 * owner, through the artifact store) — nothing here checks who asks.
 */
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import {
  type AgentRefreshOutcome,
  type ArtifactAgentRefresh,
  artifactAgentRefresh,
} from '../schema/artifact-agent-refresh';

export class ArtifactRefreshRepository {
  private get db() {
    return getDb();
  }

  async get(artifactId: string): Promise<ArtifactAgentRefresh | null> {
    const [row] = await this.db.select().from(artifactAgentRefresh).where(eq(artifactAgentRefresh.artifactId, artifactId)).limit(1);
    return row ?? null;
  }

  /** Store (or replace) the instruction and who wrote it; the owner is set on the first write only. */
  async setInstruction(artifactId: string, ownerUserId: string, instruction: string, setBy: 'agent' | 'owner'): Promise<ArtifactAgentRefresh> {
    const now = new Date();
    const [row] = await this.db
      .insert(artifactAgentRefresh)
      .values({ artifactId, ownerUserId, instruction, instructionSetBy: setBy, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: artifactAgentRefresh.artifactId, set: { instruction, instructionSetBy: setBy, updatedAt: now } })
      .returning();
    return row;
  }

  async setKnowledgeAccess(artifactId: string, on: boolean): Promise<void> {
    await this.db.update(artifactAgentRefresh).set({ knowledgeAccess: on, updatedAt: new Date() }).where(eq(artifactAgentRefresh.artifactId, artifactId));
  }

  /** Turn the schedule on under `chain` (clearing a server stop and the failure streak), or off with `interval: null`. */
  async setSchedule(artifactId: string, interval: number | null, chain: string | null, nextRunAt: Date | null): Promise<void> {
    const now = new Date();
    await this.db
      .update(artifactAgentRefresh)
      .set({
        intervalMinutes: interval,
        scheduleChain: chain,
        nextRunAt,
        scheduleSetAt: interval === null ? null : now,
        scheduleDisabledReason: null,
        consecutiveFailures: 0,
        updatedAt: now,
      })
      .where(eq(artifactAgentRefresh.artifactId, artifactId));
  }

  /** The server switches the schedule off and says why; only while `chain` still owns it, when given. */
  async disableSchedule(artifactId: string, reason: string, chain?: string): Promise<boolean> {
    const rows = await this.db
      .update(artifactAgentRefresh)
      .set({ intervalMinutes: null, scheduleChain: null, nextRunAt: null, scheduleDisabledReason: reason, updatedAt: new Date() })
      .where(and(
        eq(artifactAgentRefresh.artifactId, artifactId),
        chain === undefined ? isNotNull(artifactAgentRefresh.scheduleChain) : eq(artifactAgentRefresh.scheduleChain, chain),
      ))
      .returning({ id: artifactAgentRefresh.artifactId });
    return rows.length > 0;
  }

  /** Record the next scheduled run, only while `chain` still owns the schedule. */
  async setNextRun(artifactId: string, chain: string, nextRunAt: Date): Promise<boolean> {
    const rows = await this.db
      .update(artifactAgentRefresh)
      .set({ nextRunAt, updatedAt: new Date() })
      .where(and(eq(artifactAgentRefresh.artifactId, artifactId), eq(artifactAgentRefresh.scheduleChain, chain)))
      .returning({ id: artifactAgentRefresh.artifactId });
    return rows.length > 0;
  }

  /** A scheduled attempt that broke before it could record itself: counted as a failure. */
  async recordScheduleError(artifactId: string, chain: string, error: string): Promise<void> {
    await this.db
      .update(artifactAgentRefresh)
      .set({
        lastOutcome: 'failed',
        lastError: error,
        lastAttemptAt: new Date(),
        consecutiveFailures: sql`${artifactAgentRefresh.consecutiveFailures} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(artifactAgentRefresh.artifactId, artifactId), eq(artifactAgentRefresh.scheduleChain, chain)));
  }

  /** Move a schedule to a new chain (boot re-arm); false when it was turned off meanwhile. */
  async rechain(artifactId: string, from: string, to: string): Promise<boolean> {
    const rows = await this.db
      .update(artifactAgentRefresh)
      .set({ scheduleChain: to, updatedAt: new Date() })
      .where(and(eq(artifactAgentRefresh.artifactId, artifactId), eq(artifactAgentRefresh.scheduleChain, from)))
      .returning({ id: artifactAgentRefresh.artifactId });
    return rows.length > 0;
  }

  async listScheduled(): Promise<ArtifactAgentRefresh[]> {
    return this.db.select().from(artifactAgentRefresh).where(isNotNull(artifactAgentRefresh.scheduleChain));
  }

  async setSession(artifactId: string, sessionId: string): Promise<void> {
    await this.db.update(artifactAgentRefresh).set({ sessionId }).where(eq(artifactAgentRefresh.artifactId, artifactId));
  }

  /** Name the version a run is about to insert (before the insert), or clear it. */
  async setPendingVersion(artifactId: string, versionId: string | null): Promise<void> {
    await this.db.update(artifactAgentRefresh).set({ pendingVersionId: versionId }).where(eq(artifactAgentRefresh.artifactId, artifactId));
  }

  /**
   * Claim the one in-flight refresh of an artifact: set `runStartedAt` only
   * when no run holds it, or the one that does started before `staleBefore`
   * (its process died). A conditional update, so of two concurrent claims
   * exactly one wins. Returns the claim's start time, or null when busy.
   */
  async claimRun(artifactId: string, now: Date, staleBefore: Date): Promise<Date | null> {
    const rows = await this.db
      .update(artifactAgentRefresh)
      .set({ runStartedAt: now, lastAttemptAt: now, updatedAt: now })
      .where(and(
        eq(artifactAgentRefresh.artifactId, artifactId),
        or(isNull(artifactAgentRefresh.runStartedAt), lt(artifactAgentRefresh.runStartedAt, staleBefore)),
      ))
      .returning({ startedAt: artifactAgentRefresh.runStartedAt });
    return rows[0]?.startedAt ?? null;
  }

  /**
   * Release the claim taken at `startedAt` and record how the attempt ended.
   * `countsAsFailure` adds to the schedule's failure streak; a success resets
   * it. `landed` records the page a success made current. A claim taken over
   * meanwhile (this run was presumed dead) records nothing: the newer run
   * owns the row.
   */
  async finishRun(
    artifactId: string,
    startedAt: Date,
    result: { outcome: AgentRefreshOutcome; error: string | null; countsAsFailure: boolean; landed?: { pageHash: string; versionId: string } },
  ): Promise<ArtifactAgentRefresh | null> {
    const now = new Date();
    const success = result.outcome === 'success';
    const [row] = await this.db
      .update(artifactAgentRefresh)
      .set({
        runStartedAt: null,
        lastOutcome: result.outcome,
        lastError: result.error,
        ...(success ? { lastSuccessAt: now } : {}),
        ...(result.landed ? { lastPageHash: result.landed.pageHash, lastVersionId: result.landed.versionId } : {}),
        consecutiveFailures: success
          ? 0
          : result.countsAsFailure
            ? sql`${artifactAgentRefresh.consecutiveFailures} + 1`
            : artifactAgentRefresh.consecutiveFailures,
        updatedAt: now,
      })
      .where(and(
        eq(artifactAgentRefresh.artifactId, artifactId),
        sql`date_trunc('milliseconds', ${artifactAgentRefresh.runStartedAt}) = ${startedAt.toISOString()}::timestamptz`,
      ))
      .returning();
    return row ?? null;
  }
}

export const artifactRefreshRepository = new ArtifactRefreshRepository();
