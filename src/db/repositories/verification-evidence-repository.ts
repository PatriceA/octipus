import { desc, eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import {
  type NewVerificationEvidenceRecord,
  type VerificationEvidenceRecord,
  verificationEvidence,
} from '../schema/verification-evidence';

/**
 * Pure "verified" rule, unit-testable without a DB. A session counts as
 * verified only when it has at least one recorded check and none failed — no
 * evidence means "not verified" (fail loud; never assume a pass we can't show).
 */
export function computeSessionVerified(rows: Array<{ passed: boolean }>): boolean {
  return rows.length > 0 && rows.every((r) => r.passed);
}

/**
 * Append-only access to the verification evidence ledger. Root-agent code
 * records a row whenever a completion check runs; the API/UI reads a session's
 * history to show what was actually verified. Never reach into `getDb()`
 * directly from verification logic — go through here.
 */
export class VerificationEvidenceRepository {
  private get db() {
    return getDb();
  }

  /** Record one completion-check result. Best-effort at call sites — a ledger
   *  write must never break the orchestration path (callers swallow + log). */
  async record(entry: NewVerificationEvidenceRecord): Promise<VerificationEvidenceRecord> {
    const [row] = await this.db.insert(verificationEvidence).values(entry).returning();
    return row;
  }

  /** A session's evidence, newest first. */
  async listForSession(sessionId: string, limit = 100): Promise<VerificationEvidenceRecord[]> {
    return this.db
      .select()
      .from(verificationEvidence)
      .where(eq(verificationEvidence.sessionId, sessionId))
      .orderBy(desc(verificationEvidence.createdAt))
      .limit(limit);
  }

  /**
   * True when the session has at least one recorded check and none of them
   * failed — the "verified" signal a completion contract gates on. A session
   * with no evidence at all returns false (nothing was verified, so we can't
   * claim it passed — fail loud, don't assume).
   */
  async isSessionVerified(sessionId: string): Promise<boolean> {
    const rows = await this.db
      .select({ passed: verificationEvidence.passed })
      .from(verificationEvidence)
      .where(eq(verificationEvidence.sessionId, sessionId));
    return computeSessionVerified(rows);
  }
}

export const verificationEvidenceRepository = new VerificationEvidenceRepository();
