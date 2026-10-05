/**
 * The one model resolver for request paths (coworking spec §8.2).
 *
 * Two shapes:
 *
 *   resolveModel({ userId, topic })  — which row runs `topic` for this user:
 *       1. the user's personal binding (`user_model_bindings`), text lanes only
 *       2. the install/org binding for the lane
 *       3. the install default, only when the caller asks (`fallbackToDefault`)
 *          — the root agent; worker lanes fail loud when unbound (house rule 2)
 *
 *   resolveModel({ userId, name })   — an explicit choice (`/model`, a pipeline
 *       stage, `POST /api/agents` …). The name (or provider model id) resolves
 *       only to a row that user may see: an install row (system-wide or in one
 *       of their orgs) or their own personal row. Another user's personal row
 *       resolves to nothing, exactly like a name that does not exist.
 *
 * Install-level lanes (`background`, `decision`, `embedding`, `vision`, `ocr`)
 * never take a personal binding: they run install work funded `install`.
 *
 * A sponsored turn (`sponsor`, coworking spec §9.1) is paid by the space's
 * sponsor, so the requester's own rows — billed to the requester's key — are
 * out: step 1 is the sponsor's personal binding instead, when that row is one
 * of the sponsor models, and an explicit choice may name a sponsor model.
 */
import { CLI_SPACE_MODES } from '@/core/cli-adapters';
import { getCLIToolConfig } from '@/core/cli-agent-factory';
import type { AgentSponsor } from '@/core/types';
import type { ModelConfigEntry } from '@/db/schema/models';
import type { SpaceRole } from '@/db/schema/organizations';
import { getModelRegistry } from '@/models/model-registry';
import { canonicalTopic, TOPICS, type TopicKind } from '@/models/topics';
import { can } from '@/security/space-access';

export interface ResolveByTopic {
  /** The person the call serves. Absent (system work) ⇒ install rows only. */
  userId?: string;
  topic: string;
  /** The session runs in a shared space: install CLI rows need `cliAgent.sharedUse` (D14). */
  inSpace?: boolean;
  /** The requester's role in that space: a commenter's turns use API models only (§5.6). */
  spaceRole?: SpaceRole;
  /** The lane's backup binding instead of its primary. Personal bindings have no backup. */
  backup?: boolean;
  /** Fall back to the install default when the lane is unbound — root agent only. */
  fallbackToDefault?: boolean;
  /** The turn is sponsored: the sponsor's models replace the requester's own. */
  sponsor?: AgentSponsor | null;
}

export interface ResolveByName {
  userId: string;
  /** A row name, or a provider model id. */
  name: string;
  inSpace?: boolean;
  spaceRole?: SpaceRole;
  sponsor?: AgentSponsor | null;
}

/**
 * Whether a personal row (`ownerUserId` set) may run for `userId`: their
 * own row on their own money, or a sponsor model of a sponsored turn.
 *
 * A personal CLI row is never a sponsor model for anyone but the sponsor:
 * a CLI child gets its row's credential in its environment (and the
 * owner's vendor config directory), where the member driving the turn can
 * read it (`env`, `/proc/self/environ`). An API row's key stays server-side.
 */
export function personalRowAllowed(row: Pick<ModelConfigEntry, 'name' | 'ownerUserId' | 'provider'>, userId: string | undefined, sponsor: AgentSponsor | null | undefined): boolean {
  if (!row.ownerUserId) return true;
  if (sponsor) {
    if (row.provider === 'cli' && sponsor.userId !== userId) return false;
    return row.ownerUserId === sponsor.userId && sponsor.models.includes(row.name);
  }
  return row.ownerUserId === userId;
}

/** The kind of a (canonicalized) topic; unknown topics are treated as text lanes. */
export function topicKind(topic: string): TopicKind {
  const canonical = canonicalTopic(topic);
  return TOPICS.find((t) => t.value === canonical)?.kind ?? 'text';
}

/** Personal rows may bind only `kind: 'text'` lanes (spec §8.2). */
export function isPersonalBindableTopic(topic: string): boolean {
  const canonical = canonicalTopic(topic);
  return TOPICS.some((t) => t.value === canonical && t.kind === 'text');
}

function isRealUser(userId: string | undefined): userId is string {
  return !!userId && userId !== 'system';
}

/**
 * Whether a CLI row may serve a space session (§5.6). API rows always may.
 * A CLI row may not for a commenter (API models only), nor when its adapter
 * declares no space mode (Vibe). Then D14: an install CLI model is somebody's
 * personal subscription unless the operator marked it for shared use; a
 * personal row is the requester's own and needs no mark. A row that may not
 * is skipped, so the lane falls through to the install binding rather than
 * failing the turn at spawn.
 */
export function usableInSpace(row: ModelConfigEntry, spaceRole?: SpaceRole): boolean {
  if (row.provider !== 'cli') return true;
  if (spaceRole && !can(spaceRole, 'run_agent_write')) return false;
  const tool = getCLIToolConfig(row.modelId);
  if (!tool || !CLI_SPACE_MODES[tool.adapter ?? tool.name]) return false;
  if (row.ownerUserId) return true;
  return row.metadata?.cliAgent?.sharedUse === true;
}

/**
 * Whether `nameOrId` names a row `userId` could have meant: an install row
 * (any org, enabled or not) or one of their own. An explicit choice that
 * `resolveModel` refused but that names such a row is a row the requester may
 * not use — it must be refused, not passed through to a provider as a raw id.
 * Other users' personal rows do not count: they neither block this user's
 * passthrough of the same model id nor reveal that someone registered it.
 */
export async function isRegisteredModel(nameOrId: string, userId: string): Promise<boolean> {
  // `u/` is the reserved personal-row namespace (no install name and no model
  // id may start with it): refused without a lookup, so it says nothing about
  // which personal rows exist.
  if (nameOrId.startsWith('u/')) return true;
  return getModelRegistry().isRegistered(nameOrId, userId);
}

export async function resolveModel(req: ResolveByTopic | ResolveByName): Promise<ModelConfigEntry | null> {
  const registry = getModelRegistry();
  if ('name' in req) {
    const sponsorRow = req.sponsor?.models.includes(req.name) ? await registry.getModel(req.name) : null;
    const row = (sponsorRow && personalRowAllowed(sponsorRow, req.userId, req.sponsor) ? sponsorRow : null)
      ?? (await registry.getModelVisibleTo(req.name, req.userId))
      ?? (await registry.getModelByModelIdVisibleTo(req.name, req.userId));
    if (!row || !row.isEnabled) return null;
    if (!personalRowAllowed(row, req.userId, req.sponsor)) return null;
    if (req.inSpace && !usableInSpace(row, req.spaceRole)) return null;
    return row;
  }

  const { userId, topic } = req;
  const usable = (row: ModelConfigEntry | null): row is ModelConfigEntry => !!row && (!req.inSpace || usableInSpace(row, req.spaceRole));
  // Step 1: the payer's personal binding — the sponsor's (one of the sponsor
  // models) in a sponsored turn, the requester's otherwise. A personal CLI
  // binding a space turn may not use falls through to the install lane (a
  // commenter, an adapter without a space mode).
  const payer = req.sponsor ? req.sponsor.userId : userId;
  if (!req.backup && isRealUser(payer) && isPersonalBindableTopic(topic)) {
    const personal = await registry.getUserBinding(payer, topic);
    if (usable(personal) && personalRowAllowed(personal, userId, req.sponsor)) return personal;
  }
  const install = req.backup ? await registry.getBackupModelForTopic(topic) : await registry.getModelForTopic(topic);
  if (usable(install)) return install;
  if (!req.fallbackToDefault) return null;
  const fallback = await registry.getDefaultModel();
  if (usable(fallback)) return fallback;
  return null;
}
