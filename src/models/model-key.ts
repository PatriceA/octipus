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
 * Install rows keep their lenient behaviour — no key in the vault, or a vault
 * that cannot be read, means the provider falls back to its env variable. A
 * personal row has no such fallback: the env key is the install's, so a
 * personal row whose key is missing or unreadable fails loud instead of
 * quietly billing the install.
 *
 * A personal row's key is released to its owner's requests only. This is the
 * provider-layer owner check: every path that turns a row into a credential
 * (`prepare`, `applyModelOverrides`, the custom providers, the agent worker,
 * `cliCredentialOwnerFor`) passes the user the call serves, and another
 * user's — or no user's — request on a personal row throws.
 */
import type { ModelConfigEntry } from '@/db/schema/models';
import { getVault } from '@/security/vault';
import { modelLogger } from '@/utils/logger';

export class PersonalModelKeyMissingError extends Error {
  constructor(modelName: string) {
    super(`Personal model '${modelName}' has no API key stored. Add one under Settings → My models.`);
    this.name = 'PersonalModelKeyMissingError';
  }
}

export class PersonalModelOwnerError extends Error {
  constructor(modelName: string) {
    super(`Model '${modelName}' is another user's personal model`);
    this.name = 'PersonalModelOwnerError';
  }
}

/** Throws unless `requesterId` may run on `row`: install rows serve anyone, a personal row only its owner. */
export function assertModelRowOwner(row: Pick<ModelConfigEntry, 'name' | 'ownerUserId'>, requesterId: string | null | undefined): void {
  if (row.ownerUserId && row.ownerUserId !== requesterId) throw new PersonalModelOwnerError(row.name);
}

/** The vault namespace a row's key lives in. */
export function modelKeyOwner(row: Pick<ModelConfigEntry, 'ownerUserId'>): string {
  return row.ownerUserId ?? 'system';
}

export async function resolveModelKey(
  row: Pick<ModelConfigEntry, 'name' | 'apiKeyRef' | 'ownerUserId' | 'provider'>,
  /** The user the call serves. Required to release a personal row's key. */
  requesterId: string | null | undefined,
): Promise<string | undefined> {
  assertModelRowOwner(row, requesterId);
  if (!row.apiKeyRef) {
    if (row.ownerUserId && row.provider !== 'cli') throw new PersonalModelKeyMissingError(row.name);
    return undefined;
  }
  if (!row.ownerUserId) {
    // An install row keeps its env fallback when the vault cannot be read.
    try {
      return (await getVault().getByName('system', row.apiKeyRef)) ?? undefined;
    } catch (err) {
      modelLogger.error({ err, model: row.name }, 'Install model key lookup failed; the provider falls back to its env key');
      return undefined;
    }
  }
  const key = await getVault().getByName(modelKeyOwner(row), row.apiKeyRef);
  if (!key) throw new PersonalModelKeyMissingError(row.name);
  return key;
}
