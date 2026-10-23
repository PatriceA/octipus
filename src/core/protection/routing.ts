/**
 * Routing by protection level (docs/PROTECTION-LEVELS.md, C6b). While the
 * `protection` module is on, a session that has read content at level 3-4
 * (or pipeline work on such a document) has its model calls served by local
 * models only: the model is switched to a local one where there is a choice,
 * and a call that would still leave the house is refused. With no local
 * model to switch to, the turn stops and says so rather than sending the
 * data out.
 */
import type { ModelConfigEntry } from '@/db/schema/models';
import { isModuleOn } from '@/core/modules/registry';
import { PROTECTION_LEVEL_LABELS, type ProtectionLevel } from '@/shared/protection';
import { pseudonymsOf, type Pseudonyms } from './pseudonymize';
import { currentContentLevel, loadSessionLevel, sessionProtectionLevel } from './session-level';

/** The lowest level whose content stays on local models. */
export const LOCAL_ONLY_LEVEL = 3;

/** A call refused because its data would leave the house. Not retryable. */
export class ProtectionRoutingError extends Error {
  readonly level: ProtectionLevel;
  constructor(level: ProtectionLevel, message: string) {
    super(message);
    this.name = 'ProtectionRoutingError';
    this.level = level;
  }
}

/**
 * The level of what the calls of `sessionId` (and the content work around
 * them) carry, or undefined while the `protection` module is off. A stored
 * level that cannot be read counts as 4: where data may go is not decided on
 * a level not known.
 */
export async function carriedLevel(sessionId: string | undefined): Promise<ProtectionLevel | undefined> {
  if (!isModuleOn('protection')) return undefined;
  const level: ProtectionLevel = currentContentLevel() ?? 1;
  try {
    await loadSessionLevel(sessionId);
    return Math.max(level, sessionProtectionLevel(sessionId)) as ProtectionLevel;
  } catch {
    return 4;
  }
}

/**
 * How a call reaches a remote model. `pseudonymized`: a completion or a
 * stream, whose personal data is replaced before it leaves (C6c); level 3
 * may then go out where the owner allows it (`protection.remoteAtLevel3`).
 * Embeddings, images, OCR and CLI agents carry the data as it is.
 */
export interface Egress { pseudonymized?: boolean }

/** A completion or stream: pseudonymized on its way out. */
export const PSEUDONYMIZED: Egress = { pseudonymized: true };

async function localOnlyFrom(egress: Egress): Promise<number> {
  if (!egress.pseudonymized) return LOCAL_ONLY_LEVEL;
  const { getConfig } = await import('@/config');
  return getConfig().protection?.remoteAtLevel3 ? LOCAL_ONLY_LEVEL + 1 : LOCAL_ONLY_LEVEL;
}

/**
 * The level that keeps the calls of `sessionId` on local models, or
 * undefined while they may use any model: the module is off, or nothing at
 * 3-4 was read (at 4 only, for a pseudonymized call where level 3 may go out).
 */
export async function localOnlyLevel(sessionId: string | undefined, egress: Egress = {}): Promise<ProtectionLevel | undefined> {
  const level = await carriedLevel(sessionId);
  if (level === undefined) return undefined;
  return level >= await localOnlyFrom(egress) ? level : undefined;
}

type HostedRow = Pick<ModelConfigEntry, 'provider' | 'modelId' | 'metadata' | 'endpoint'>;

/**
 * Does a call on `row` stay on the owner's own machine or network? The
 * row's data policy (models/decision.ts), and for Ollama a check that the
 * model is not one of Ollama's cloud models. A CLI agent is a vendor's
 * harness and never counts as local. `via` is the provider actually called:
 * a fallback to the LiteLLM proxy leaves the row's own host. Fails closed.
 */
export async function runsLocally(row: HostedRow | null | undefined, via?: string): Promise<boolean> {
  if (!row || row.provider === 'cli') return false;
  if (via && via === 'litellm' && row.provider !== 'litellm') return false;
  const [{ resolveDataPolicy }, { getConfig }] = await Promise.all([import('@/models/decision'), import('@/config')]);
  const ollamaUrl = getConfig().ollama.url;
  if (resolveDataPolicy(row, ollamaUrl).hosting !== 'local') return false;
  if (row.provider !== 'ollama') return true;
  const { ollamaRunsLocally } = await import('@/models/local-decision');
  return ollamaRunsLocally(row.endpoint || ollamaUrl || '', row.modelId);
}

function refusal(level: ProtectionLevel, what: string): ProtectionRoutingError {
  return new ProtectionRoutingError(level,
    `This conversation holds ${PROTECTION_LEVEL_LABELS[level].toLowerCase()} content (protection level ${level}), which stays on local models, `
    + `and ${what}. Bind a local model (Models page) or start a new conversation for other work.`);
}

/**
 * Throws `ProtectionRoutingError` when the call on `row` (through provider
 * `via`) may not go where it would go: the session holds level 3-4 content
 * and the row does not run locally.
 */
export async function assertMayLeave(row: HostedRow | null | undefined, sessionId: string | undefined, via?: string, egress: Egress = {}): Promise<void> {
  const level = await localOnlyLevel(sessionId, row?.provider === 'cli' ? {} : egress);
  if (level === undefined || await runsLocally(row, via)) return;
  throw refusal(level, `${row?.modelId ?? 'this model'} is not a local model`);
}

/** What the replacement row has to do. */
export type LocalNeed = 'tools' | 'text' | 'vision';

function serves(row: ModelConfigEntry, need: LocalNeed): boolean {
  if (!row.isEnabled) return false;
  // An embedding model writes vectors, not text.
  const topics = [...(row.topics ?? []), ...Object.keys(row.topicRoles ?? {})];
  if (topics.length > 0 && topics.every((t) => t === 'embedding')) return false;
  if (/embed/i.test(row.modelId)) return false;
  if (need === 'vision') return row.supportsVision;
  if (need === 'tools') return row.supportsTools && !row.modelId.includes('reasoner') && !row.modelId.includes('thinking');
  return true;
}

/**
 * The row the session's work runs on: `row` while it may (the session is
 * below 3, or the row is local), else the first local row among
 * `candidates` (the default first) that serves `need`. Throws
 * `ProtectionRoutingError` when there is none.
 */
export async function localRowInstead<R extends ModelConfigEntry>(
  row: R | null | undefined,
  sessionId: string | undefined,
  need: LocalNeed,
  candidates: () => Promise<{ defaultModel: R | null; rows: R[] }>,
  egress: Egress = {},
): Promise<R | null | undefined> {
  // A CLI agent brings its own harness: nothing it sends is pseudonymized.
  const level = await localOnlyLevel(sessionId, row?.provider === 'cli' ? {} : egress);
  if (level === undefined || await runsLocally(row)) return row;
  const { defaultModel, rows } = await candidates();
  const ordered = defaultModel ? [defaultModel, ...rows.filter((r) => r.name !== defaultModel.name)] : rows;
  for (const candidate of ordered) {
    if (serves(candidate, need) && await runsLocally(candidate)) return candidate;
  }
  throw refusal(level, need === 'vision' ? 'no local model that reads images is bound' : 'no local model is bound');
}

/**
 * The mapping a call on `row` (through provider `via`) is pseudonymized
 * with, or undefined when it goes out as it is: the module is off, the
 * content is public (level 1), or the row is local. Level 4 never gets here
 * on a remote row: `assertMayLeave` refused it.
 */
export async function pseudonymsFor(row: HostedRow | null | undefined, sessionId: string | undefined, via?: string): Promise<Pseudonyms | undefined> {
  const level = await carriedLevel(sessionId);
  if (level === undefined || level < 2) return undefined;
  if (await runsLocally(row, via)) return undefined;
  return pseudonymsOf(sessionId);
}
