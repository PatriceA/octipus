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
import type { AgentSponsor } from '@/core/types';
import type { ModelConfigEntry } from '@/db/schema/models';
import { getModelRegistry } from '@/models/model-registry';
import { canonicalTopic, TOPICS, type TopicKind } from '@/models/topics';

export interface ResolveByTopic {
  /** The person the call serves. Absent (system work) ⇒ install rows only. */
  userId?: string;
  topic: string;
  /** The session runs in a shared space: install CLI rows need `cliAgent.sharedUse` (D14). */
  inSpace?: boolean;
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
  sponsor?: AgentSponsor | null;
}

/**
 * Whether a personal row (`ownerUserId` set) may run for `userId`: their
 * own row on their own money, or a sponsor model of a sponsored turn.
 */
export function personalRowAllowed(row: Pick<ModelConfigEntry, 'name' | 'ownerUserId'>, userId: string | undefined, sponsor: AgentSponsor | null | undefined): boolean {
  if (!row.ownerUserId) return true;
  if (sponsor) return row.ownerUserId === sponsor.userId && sponsor.models.includes(row.name);
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
 * D14: an install CLI model is somebody's personal subscription unless the
 * operator marked it for shared use, so it does not run in a space session
 * unmarked. A personal row is the requester's own and is not affected.
 */
export function usableInSpace(row: ModelConfigEntry): boolean {
  if (row.ownerUserId || row.provider !== 'cli') return true;
  return row.metadata?.cliAgent?.sharedUse === true;
}

/**
 * Whether `nameOrId` names a registry row at all. An explicit choice that
 * `resolveModel` refused but that names a row is a row the requester may not
 * use — it must be refused, not passed through to a provider as a raw id.
 */
export async function isRegisteredModel(nameOrId: string): Promise<boolean> {
  return getModelRegistry().isRegistered(nameOrId);
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
    if (req.inSpace && !usableInSpace(row)) return null;
    return row;
  }

  const { userId, topic } = req;
  // Step 1: the payer's personal binding — the sponsor's (one of the sponsor
  // models) in a sponsored turn, the requester's otherwise.
  const payer = req.sponsor ? req.sponsor.userId : userId;
  if (!req.backup && isRealUser(payer) && isPersonalBindableTopic(topic)) {
    const personal = await registry.getUserBinding(payer, topic);
    if (personal && personalRowAllowed(personal, userId, req.sponsor)) return personal;
  }
  const install = req.backup ? await registry.getBackupModelForTopic(topic) : await registry.getModelForTopic(topic);
  if (install && (!req.inSpace || usableInSpace(install))) return install;
  if (!req.fallbackToDefault) return null;
  const fallback = await registry.getDefaultModel();
  if (fallback && (!req.inSpace || usableInSpace(fallback))) return fallback;
  return null;
}
