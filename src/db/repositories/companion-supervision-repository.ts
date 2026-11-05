import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionGoals, companionSessionLinks, type CompanionGoal } from '@/db/schema/companion-supervision';
import { workspaces } from '@/db/schema/organizations';
import { users } from '@/db/schema/users';
import { sessions } from '@/db/schema/sessions';
import { pipelines } from '@/db/schema/pipelines';
import { tasks } from '@/db/schema/tasks';
import { verificationEvidence } from '@/db/schema/verification-evidence';
import { assertNoCredentialTemplates } from '@/security/credential-boundary';
import {
  adoptCompanionExecutionSchema, canTransitionCompanionGoal, companionScopeSchema,
  CompanionSupervisionError, createCompanionGoalSchema, updateCompanionGoalSchema,
  type CompanionCompletionEvidence, type CompanionScope,
} from '@/shared/companion-supervision';

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];
const fail = (code: CompanionSupervisionError['code'], message: string): never => { throw new CompanionSupervisionError(code, message); };
const terminal = (goal: CompanionGoal) => goal.state === 'completed' || goal.state === 'cancelled';

/** All entry points revalidate scope in the transaction; no admin bypass or implicit enrollment. */
export class CompanionSupervisionRepository {
  readonly scope: CompanionScope;
  constructor(scope: CompanionScope, private db = getDb) {
    this.scope = Object.freeze(companionScopeSchema.parse(scope));
  }

  private async assertScope(tx: Transaction) {
    const [row] = await tx.select({ id: workspaces.id }).from(workspaces).innerJoin(users, eq(users.id, workspaces.userId))
      .where(and(eq(workspaces.id, this.scope.workspaceId), eq(workspaces.userId, this.scope.userId), eq(workspaces.kind, 'personal'),
        isNull(workspaces.archivedAt), eq(users.isActive, true), eq(users.kind, 'local'))).for('share');
    if (!row) fail('scope_unavailable', 'Companion supervision requires your active personal workspace');
  }

  private goalWhere(id: string) {
    return and(eq(companionGoals.id, id), eq(companionGoals.userId, this.scope.userId), eq(companionGoals.workspaceId, this.scope.workspaceId));
  }

  private async goal(tx: Transaction, id: string, lock = false) {
    const query = tx.select().from(companionGoals).where(this.goalWhere(id));
    const [goal] = await (lock ? query.for('update') : query);
    if (!goal) return fail('not_found', 'Companion goal not found');
    return goal;
  }

  private async session(tx: Transaction, id: string) {
    const [session] = await tx.select({ id: sessions.id, protectionLevel: sessions.protectionLevel, metadata: sessions.metadata }).from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, this.scope.userId), eq(sessions.workspaceId, this.scope.workspaceId),
        eq(sessions.kind, 'chat'), isNull(sessions.groupChannelId))).for('update');
    if (!session) return fail('not_found', 'Personal session not found in this workspace');
    return session;
  }

  /** Protection can rise after adoption. Consumers must use current source levels. */
  private async protect(tx: Transaction, goal: CompanionGoal): Promise<CompanionGoal> {
    const [levels] = await tx.select({ level: sql<number | null>`max(${sessions.protectionLevel})` }).from(sessions)
      .where(and(eq(sessions.userId, this.scope.userId), eq(sessions.workspaceId, this.scope.workspaceId), or(
        ...(goal.workPlanSessionId ? [eq(sessions.id, goal.workPlanSessionId)] : []),
        inArray(sessions.id, tx.select({ id: companionSessionLinks.sessionId }).from(companionSessionLinks).where(eq(companionSessionLinks.goalId, goal.id))),
      )));
    // Persist the high-water mark before returning retained data. Deleting a
    // source later must not downgrade a goal that has already observed it.
    const [protectedGoal] = await tx.update(companionGoals).set({
      protectionLevel: sql`greatest(${companionGoals.protectionLevel}, ${levels?.level ?? 1})`,
    }).where(this.goalWhere(goal.id)).returning();
    return protectedGoal;
  }

  async create(input: unknown) {
    const data = createCompanionGoalSchema.parse(input);
    assertNoCredentialTemplates(data);
    return this.db().transaction(async tx => {
      await this.assertScope(tx);
      // Claim the request key before source locks. Retries must acquire the
      // goal before a session, just like adoption, including concurrent creates.
      const [created] = await tx.insert(companionGoals).values({ ...data, ...this.scope, taskId: null, workPlanSessionId: null }).onConflictDoNothing({
        target: [companionGoals.userId, companionGoals.workspaceId, companionGoals.requestKey],
      }).returning();
      if (!created) {
        const [existing] = await tx.select().from(companionGoals).where(and(eq(companionGoals.userId, this.scope.userId),
          eq(companionGoals.workspaceId, this.scope.workspaceId), eq(companionGoals.requestKey, data.requestKey))).for('update');
        // Mutable priority is excluded: a retry must not undo later prioritization.
        if (!existing || existing.title !== data.title || existing.request !== data.request || existing.outcome !== data.outcome
          || JSON.stringify(existing.acceptanceCriteria) !== JSON.stringify(data.acceptanceCriteria) || existing.tokenBudget !== data.tokenBudget
          || existing.taskId !== data.taskId || existing.workPlanSessionId !== data.workPlanSessionId) {
          return fail('conflict', 'Request key already belongs to a different goal request');
        }
        return this.protect(tx, existing);
      }
      let protectionLevel = 1;
      if (data.taskId) {
        const [task] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, data.taskId),
          eq(tasks.userId, this.scope.userId), eq(tasks.workspaceId, this.scope.workspaceId))).for('share');
        if (!task) fail('not_found', 'Task not found in this workspace');
      }
      if (data.workPlanSessionId) {
        const source = await this.session(tx, data.workPlanSessionId);
        if (!source.metadata?.workPlan) fail('not_found', 'Session has no saved work plan');
        protectionLevel = source.protectionLevel ?? 1;
      }
      const [goal] = await tx.update(companionGoals).set({ taskId: data.taskId, workPlanSessionId: data.workPlanSessionId, protectionLevel })
        .where(this.goalWhere(created.id)).returning();
      return goal;
    });
  }

  async list(limit = 50) {
    return this.db().transaction(async tx => {
      await this.assertScope(tx);
      const rows = await tx.select().from(companionGoals).where(and(eq(companionGoals.userId, this.scope.userId),
        eq(companionGoals.workspaceId, this.scope.workspaceId))).orderBy(desc(companionGoals.priority), desc(companionGoals.createdAt))
        .limit(Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 50, 100)));
      // Protection writes take row locks. Use a stable order across list calls
      // even when another transaction changes priorities between snapshots.
      const protectedRows = new Map<string, CompanionGoal>();
      for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) protectedRows.set(row.id, await this.protect(tx, row));
      return rows.map(row => protectedRows.get(row.id)!);
    });
  }

  async read(id: string) {
    return this.db().transaction(async tx => {
      await this.assertScope(tx);
      const goal = await this.protect(tx, await this.goal(tx, id));
      const links = await tx.select().from(companionSessionLinks).where(eq(companionSessionLinks.goalId, goal.id)).orderBy(companionSessionLinks.createdAt);
      return { goal, links };
    });
  }

  async adopt(id: string, input: unknown) {
    const data = adoptCompanionExecutionSchema.parse(input);
    assertNoCredentialTemplates(data);
    return this.db().transaction(async tx => {
      await this.assertScope(tx);
      const goal = await this.goal(tx, id, true);
      if (terminal(goal)) return fail('conflict', 'This goal has ended');
      // All claims in a session serialize, including pipeline versus whole-session ownership.
      const session = await this.session(tx, data.sessionId);
      if (data.pipelineId) {
        const [pipeline] = await tx.select({ id: pipelines.id }).from(pipelines).where(and(eq(pipelines.id, data.pipelineId),
          eq(pipelines.sessionId, session.id), eq(pipelines.userId, this.scope.userId), eq(pipelines.workspaceId, this.scope.workspaceId))).for('share');
        if (!pipeline) return fail('not_found', 'Pipeline not found in this session');
      }
      const execution = data.pipelineId ? eq(companionSessionLinks.pipelineId, data.pipelineId) : and(eq(companionSessionLinks.sessionId, session.id), isNull(companionSessionLinks.pipelineId));
      const [existing] = await tx.select().from(companionSessionLinks).where(and(eq(companionSessionLinks.goalId, goal.id), execution));
      if (existing) {
        if (existing.ownership !== data.ownership || existing.purpose !== data.purpose) return fail('conflict', 'Execution is already linked with different supervision settings');
        return { goal: await this.protect(tx, goal), link: existing };
      }
      if (goal.revision !== data.expectedRevision || goal.state === 'paused') return fail('conflict', 'Goal changed or is paused; refresh before adopting work');
      if (data.ownership === 'owner') {
        const [owner] = await tx.select({ id: companionSessionLinks.id }).from(companionSessionLinks).where(and(
          eq(companionSessionLinks.sessionId, session.id), eq(companionSessionLinks.active, true), eq(companionSessionLinks.ownership, 'owner'),
          ne(companionSessionLinks.goalId, goal.id), ...(data.pipelineId ? [or(isNull(companionSessionLinks.pipelineId), eq(companionSessionLinks.pipelineId, data.pipelineId))] : []),
        ));
        if (owner) return fail('conflict', 'Another goal already supervises this execution');
      }
      const [link] = await tx.insert(companionSessionLinks).values({ goalId: goal.id, sessionId: session.id, pipelineId: data.pipelineId,
        purpose: data.purpose, ownership: data.ownership }).returning();
      const [updated] = await tx.update(companionGoals).set({ revision: goal.revision + 1, updatedAt: new Date(),
        protectionLevel: Math.max(goal.protectionLevel, session.protectionLevel ?? 1) }).where(this.goalWhere(id)).returning();
      return { goal: await this.protect(tx, updated), link };
    });
  }

  private async validateCompletion(tx: Transaction, goal: CompanionGoal, evidence: CompanionCompletionEvidence[]) {
    const indexes = new Set(evidence.map(item => item.criterionIndex));
    if (indexes.size !== evidence.length || indexes.size !== goal.acceptanceCriteria.length
      || evidence.some(item => item.criterionIndex >= goal.acceptanceCriteria.length)) return fail('invalid_evidence', 'Every acceptance criterion requires its own evidence reference');
    const valid = await tx.select({ id: verificationEvidence.id }).from(verificationEvidence)
      .innerJoin(sessions, eq(sessions.id, verificationEvidence.sessionId))
      .innerJoin(companionSessionLinks, and(eq(companionSessionLinks.sessionId, sessions.id), eq(companionSessionLinks.goalId, goal.id),
        eq(companionSessionLinks.active, true), or(isNull(companionSessionLinks.pipelineId), eq(companionSessionLinks.pipelineId, verificationEvidence.pipelineId))))
      .where(and(inArray(verificationEvidence.id, evidence.map(item => item.evidenceId)), eq(verificationEvidence.passed, true),
        eq(sessions.userId, this.scope.userId), eq(sessions.workspaceId, this.scope.workspaceId), eq(sessions.kind, 'chat'), isNull(sessions.groupChannelId),
        // Old item-level pipeline rows have no stable check identity. Require
        // scoped evidence or a separate aggregate check instead of guessing.
        sql`(${verificationEvidence.pipelineId} IS NULL OR ${verificationEvidence.nodeId} IS NOT NULL
          OR ${verificationEvidence.kind} NOT IN ('qa_verdict', 'audit_coverage', 'side_effect')
          OR length(${verificationEvidence.detail}->>'checkScope') > 0)`,
        sql`NOT EXISTS (
          SELECT 1 FROM verification_evidence newer
          WHERE newer.session_id = ${verificationEvidence.sessionId}
            AND newer.pipeline_id IS NOT DISTINCT FROM ${verificationEvidence.pipelineId}
            AND newer.kind = ${verificationEvidence.kind}
            AND newer.stage IS NOT DISTINCT FROM ${verificationEvidence.stage}
            AND newer.node_id IS NOT DISTINCT FROM ${verificationEvidence.nodeId}
            AND newer.detail->>'checkScope' IS NOT DISTINCT FROM ${verificationEvidence.detail}->>'checkScope'
            AND newer.detail->>'command' IS NOT DISTINCT FROM ${verificationEvidence.detail}->>'command'
            AND (newer.created_at > ${verificationEvidence.createdAt}
              OR (newer.created_at = ${verificationEvidence.createdAt} AND newer.passed = false))
        )`));
    const ids = new Set(valid.map(row => row.id));
    if (evidence.some(item => !ids.has(item.evidenceId))) return fail('invalid_evidence', 'Completion evidence must be current, pass and belong to a linked execution');
    const [unfinished] = await tx.select({ id: pipelines.id }).from(companionSessionLinks)
      .innerJoin(pipelines, and(eq(pipelines.sessionId, companionSessionLinks.sessionId),
        or(isNull(companionSessionLinks.pipelineId), eq(pipelines.id, companionSessionLinks.pipelineId))))
      .where(and(eq(companionSessionLinks.goalId, goal.id), eq(companionSessionLinks.active, true), eq(companionSessionLinks.ownership, 'owner'), ne(pipelines.status, 'completed'))).limit(1);
    if (unfinished) return fail('conflict', 'An owned pipeline has not completed');
  }

  async update(id: string, input: unknown) {
    const data = updateCompanionGoalSchema.parse(input);
    assertNoCredentialTemplates(data);
    return this.db().transaction(async tx => {
      await this.assertScope(tx);
      const goal = await this.protect(tx, await this.goal(tx, id, true));
      if (goal.revision !== data.expectedRevision) return fail('conflict', 'Goal changed; refresh before updating it');
      if (terminal(goal)) return fail('conflict', 'This goal has ended');
      if (data.state !== undefined && !canTransitionCompanionGoal(goal.state, data.state)) return fail('conflict', 'Goal state transition is not allowed');
      if (data.evidence) await this.validateCompletion(tx, goal, data.evidence);
      const now = new Date();
      const [updated] = await tx.update(companionGoals).set({ state: data.state ?? goal.state, priority: data.priority ?? goal.priority,
        protectionLevel: goal.protectionLevel, revision: goal.revision + 1, updatedAt: now,
        ...(data.evidence ? { completionEvidence: data.evidence, completedAt: now } : {}),
      }).where(this.goalWhere(id)).returning();
      if (terminal(updated)) await tx.update(companionSessionLinks).set({ active: false, releasedAt: now })
        .where(and(eq(companionSessionLinks.goalId, goal.id), eq(companionSessionLinks.active, true)));
      return updated;
    });
  }
}
