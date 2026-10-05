/**
 * One key resolver for a model row (coworking spec §8.3).
 *
 * The key belongs to whoever owns the ROW, never to whoever sent the request:
 * a personal row's key lives in its owner's vault, an install row's in the
 * system vault. Resolving under the requester (what the custom providers used
 * to do) let a user's own vault entry named like an install row's `apiKeyRef`
 * stand in for the install key, and a personal row's key could never be found
 * by anyone else's turn that legitimately ran on it.
 *
 * Install rows keep their lenient behaviour — no key in the vault means the
 * provider falls back to its env variable. A personal row has no such
 * fallback: the env key is the install's, so a personal row whose key is
 * missing fails loud instead of quietly billing the install.
 */
import type { ModelConfigEntry } from '@/db/schema/models';
import { getVault } from '@/security/vault';

export class PersonalModelKeyMissingError extends Error {
  constructor(modelName: string) {
    super(`Personal model '${modelName}' has no API key stored. Add one under Settings → My models.`);
    this.name = 'PersonalModelKeyMissingError';
  }
}

/** The vault namespace a row's key lives in. */
export function modelKeyOwner(row: Pick<ModelConfigEntry, 'ownerUserId'>): string {
  return row.ownerUserId ?? 'system';
}

export async function resolveModelKey(
  row: Pick<ModelConfigEntry, 'name' | 'apiKeyRef' | 'ownerUserId' | 'provider'>,
): Promise<string | undefined> {
  if (!row.apiKeyRef) {
    if (row.ownerUserId && row.provider !== 'cli') throw new PersonalModelKeyMissingError(row.name);
    return undefined;
  }
  const key = await getVault().getByName(modelKeyOwner(row), row.apiKeyRef);
  if (!key && row.ownerUserId) throw new PersonalModelKeyMissingError(row.name);
  return key ?? undefined;
}
