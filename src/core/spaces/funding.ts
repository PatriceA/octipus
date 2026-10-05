/**
 * Who pays for the agent in a space (docs/plans/coworking-spec.md §9.1).
 *
 * A space's `agent_funding` is `own`, `unattended` or `sponsored`;
 * `fundingFor` (src/core/agent/context.ts) reads it for every turn. The
 * sponsor is an owner who named themselves (nobody is made to pay by
 * someone else); `sponsor_models` lists the sponsor's own model rows that
 * sponsored turns may run on, and only the sponsor sets it.
 *
 * When the sponsor stops being an owner — removed, demoted, leaving, or
 * cleared by another owner — `sponsor_user_id` and `sponsor_models` are
 * cleared in the same transaction as the change, with an audit row (I10),
 * and the space's sponsored agents stop (`pauseSponsoredWork`): sponsored
 * work does not run again until an owner names a new sponsor.
 */
import { and, eq } from 'drizzle-orm';
import type { SpaceFundingSettings } from '@/core/agent/context';
import { getDb } from '@/db/postgres';
import { isUuid } from '@/db/repositories/scoped';
import { type AgentFundingMode, type SpaceRole, workspaces } from '@/db/schema/organizations';
import { requireCan, SpaceError } from '@/security/space-access';
import { coreLogger } from '@/utils/logger';
import { auditActor, type Executor, getMembership, type SpaceActor, writeSpaceAudit } from './service';

export const AGENT_FUNDING_MODES: readonly AgentFundingMode[] = ['own', 'unattended', 'sponsored'];

/** At most this many sponsor models. */
const MAX_SPONSOR_MODELS = 20;

/** The space's funding settings, read now. Throws `not_found` for an id that names no space. */
export async function spaceFunding(workspaceId: string, db: Executor = getDb()): Promise<SpaceFundingSettings> {
  if (!isUuid(workspaceId)) throw new SpaceError('not_found', 'Space not found');
  const [row] = await db
    .select({ mode: workspaces.agentFunding, sponsorUserId: workspaces.sponsorUserId, sponsorModels: workspaces.sponsorModels })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, 'shared')))
    .limit(1);
  if (!row) throw new SpaceError('not_found', 'Space not found');
  return { mode: row.mode, sponsorUserId: row.sponsorUserId, sponsorModels: row.sponsorModels ?? [] };
}

export interface SpaceFundingInput {
  mode?: string;
  /** `me` names the actor as the sponsor; null clears the sponsor. */
  sponsor?: 'me' | null;
  /** The sponsor's own model rows sponsored turns may use. The sponsor only. */
  sponsorModels?: string[];
}

/**
 * Change the space's funding (owners). Naming a sponsor names oneself;
 * clearing it pauses sponsored work. Only the sponsor lists sponsor models,
 * each one of their own enabled model rows. One audit row per change.
 */
export async function setSpaceFunding(actor: SpaceActor, workspaceId: string, input: SpaceFundingInput): Promise<SpaceFundingSettings & { warning?: string }> {
  if (input.mode !== undefined && !(AGENT_FUNDING_MODES as readonly string[]).includes(input.mode)) {
    throw new SpaceError('invalid_input', 'agentFunding must be own, unattended or sponsored');
  }
  const models = input.sponsorModels === undefined ? undefined : [...new Set(input.sponsorModels.map((m) => m.trim()).filter(Boolean))];
  if (models && models.length > MAX_SPONSOR_MODELS) throw new SpaceError('invalid_input', `At most ${MAX_SPONSOR_MODELS} sponsor models`);
  // Read before the transaction (the registry reads on its own connection):
  // the actor lists their own rows; that they are the sponsor is checked inside.
  if (models) await assertOwnModels(actor.userId, models);

  const outcome = await getDb().transaction(async (tx) => {
    requireCan(await getMembership(actor.userId, workspaceId, tx, { lock: 'share' }), 'manage_space');
    const [space] = await tx
      .select({ archivedAt: workspaces.archivedAt, mode: workspaces.agentFunding, sponsorUserId: workspaces.sponsorUserId, sponsorModels: workspaces.sponsorModels })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, 'shared')))
      .for('update');
    if (!space) throw new SpaceError('not_found', 'Space not found');
    if (space.archivedAt) throw new SpaceError('archived', 'This space is archived');

    const mode = (input.mode as AgentFundingMode | undefined) ?? space.mode;
    let sponsorUserId = space.sponsorUserId;
    if (input.sponsor === 'me') sponsorUserId = actor.userId;
    if (input.sponsor === null) sponsorUserId = null;
    let sponsorModels = sponsorUserId === space.sponsorUserId ? space.sponsorModels : [];
    if (models !== undefined) {
      if (!sponsorUserId || sponsorUserId !== actor.userId) {
        throw new SpaceError('forbidden_role', 'Only the sponsor chooses the sponsor models');
      }
      sponsorModels = models;
    }

    const changes: Record<string, { previousValue: unknown; newValue: unknown }> = {};
    if (mode !== space.mode) changes.agentFunding = { previousValue: space.mode, newValue: mode };
    if (sponsorUserId !== space.sponsorUserId) changes.sponsor = { previousValue: space.sponsorUserId, newValue: sponsorUserId };
    if (JSON.stringify(sponsorModels) !== JSON.stringify(space.sponsorModels)) {
      changes.sponsorModels = { previousValue: space.sponsorModels, newValue: sponsorModels };
    }
    if (Object.keys(changes).length > 0) {
      await tx.update(workspaces)
        .set({ agentFunding: mode, sponsorUserId, sponsorModels, updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
      await writeSpaceAudit(tx, { ...auditActor(actor), action: 'space_updated', workspaceId, details: { field: 'funding', changes } });
    }
    // Sponsored work stops when the sponsor goes or the mode pays for less.
    const paused = (space.sponsorUserId !== null && sponsorUserId !== space.sponsorUserId)
      || (space.mode !== 'own' && mode === 'own')
      || (space.mode === 'sponsored' && mode !== 'sponsored');
    return { settings: { mode, sponsorUserId, sponsorModels }, paused };
  });
  if (!outcome.paused) return outcome.settings;
  const warning = await settle(workspaceId, 'Funding change');
  return warning ? { ...outcome.settings, warning } : outcome.settings;
}

/** Every name is an enabled model row of `userId`'s own (§8.1). */
async function assertOwnModels(userId: string, names: readonly string[]): Promise<void> {
  const { getModelRegistry } = await import('@/models/model-registry');
  const registry = getModelRegistry();
  for (const name of names) {
    const row = await registry.getModel(name);
    if (!row || row.ownerUserId !== userId || !row.isEnabled) {
      throw new SpaceError('invalid_input', `"${name}" is not one of your own models`);
    }
  }
}

/**
 * In the caller's membership transaction: when `userId` is the space's
 * sponsor and their new role (null: removed or left) is no longer owner,
 * clear the sponsor and the sponsor models, with an audit row. Returns
 * whether it did — the caller then runs `pauseSponsoredWork` after commit.
 */
export async function clearLostSponsorInTx(
  tx: Executor,
  actor: SpaceActor,
  workspaceId: string,
  userId: string,
  newRole: SpaceRole | null,
): Promise<boolean> {
  if (newRole === 'owner') return false;
  const cleared = await tx.update(workspaces)
    .set({ sponsorUserId: null, sponsorModels: [], updatedAt: new Date() })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.sponsorUserId, userId)))
    .returning({ id: workspaces.id });
  if (cleared.length === 0) return false;
  await writeSpaceAudit(tx, {
    ...auditActor(actor),
    action: 'space_updated',
    workspaceId,
    details: { field: 'funding', reason: newRole ? 'sponsor_downgraded' : 'sponsor_removed', changes: { sponsor: { previousValue: userId, newValue: null } } },
  });
  return true;
}

/**
 * Stop every sponsored agent of the space (room listen turns included).
 * Sponsored work cannot start again until the space has a sponsor: every
 * new turn's `fundingFor` refuses it. Returns how many agents stopped.
 */
export async function pauseSponsoredWork(workspaceId: string): Promise<number> {
  const { getAgentManager } = await import('@/core/agent-manager');
  const stopped = getAgentManager().stopWorkspace(workspaceId, undefined, { funding: 'sponsor' });
  if (stopped > 0) coreLogger.info({ workspaceId, stopped }, 'Sponsored agents stopped');
  return stopped;
}

/** Run `pauseSponsoredWork` after a committed change; a failure is logged and returned. */
export async function settle(workspaceId: string, what: string): Promise<string | null> {
  const { settleFollowUp } = await import('./membership');
  return settleFollowUp(what, { workspaceId }, () => pauseSponsoredWork(workspaceId));
}
