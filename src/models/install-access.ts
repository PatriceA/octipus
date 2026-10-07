import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { users } from '@/db/schema/users';
import type { ModelConfigEntry } from '@/db/schema/models';

/**
 * Who may run on the install's models and keys (docs/SPACES.md → Who may use
 * the install's models). An admin always may; another local account when
 * `users.install_models` says so; a remote member never. Everyone else runs
 * only on their own models (Settings → My models) and, in a sponsored space
 * turn, on what the sponsor may use.
 *
 * The check sits where every model call passes (`instrumented.ts` for API
 * providers, the CLI spawn sites), so no caller that picks a row on its own
 * gets around it. Install-topic work (`funding: 'install'`: memory
 * extraction, embeddings, compaction, …) is the install's own and is not
 * checked.
 */

const UUID = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i;
const TTL_MS = 15_000;
const cache = new Map<string, { allowed: boolean; at: number }>();

export class InstallModelsDeniedError extends Error {
  constructor() {
    super('This account may not use the install\'s models: add your own under Settings → My models, or ask an admin to allow it');
    this.name = 'InstallModelsDeniedError';
  }
}

/**
 * Whether `userId` may run on install rows. Ids that are not users of this
 * install (the system user, internal callers without a requester) may.
 */
export async function mayUseInstallModels(userId: string | null | undefined): Promise<boolean> {
  if (!userId || !UUID.test(userId)) return true;
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.allowed;
  const [row] = await getDb()
    .select({ isAdmin: users.isAdmin, installModels: users.installModels, kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // An id with no account (deleted meanwhile) gets nothing of the install's.
  const allowed = !!row && row.kind === 'local' && (row.isAdmin || row.installModels);
  cache.set(userId, { allowed, at: Date.now() });
  return allowed;
}

/** Drop a cached answer: the user's admin or install-models flag changed. */
export function forgetInstallAccess(userId: string): void {
  cache.delete(userId);
}

/** Test hook. */
export function resetInstallAccessCache(): void {
  cache.clear();
}

/**
 * Throws `InstallModelsDeniedError` unless a call that serves `userId` may run
 * on `row` (`null`: a raw model id with no row, served on the install's env
 * keys). A personal row is its owner's business (`assertModelRowOwner`).
 * `funding: 'install'` is install work; `sponsor` runs on what the sponsor
 * may use.
 */
export async function assertInstallModelAccess(
  row: Pick<ModelConfigEntry, 'ownerUserId'> | null,
  userId: string | null | undefined,
  funding: 'own' | 'sponsor' | 'install',
  sponsorUserId?: string | null,
): Promise<void> {
  if (row?.ownerUserId) return;
  if (funding === 'install') return;
  const payer = funding === 'sponsor' && sponsorUserId ? sponsorUserId : userId;
  if (!(await mayUseInstallModels(payer))) throw new InstallModelsDeniedError();
}
