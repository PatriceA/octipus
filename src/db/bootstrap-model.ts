import { count } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { modelConfig, type NewModelConfigEntry } from '@/db/schema/models';
import { getVault } from '@/security/vault';
import { logger } from '@/utils/logger';

/**
 * First-boot model bootstrap. Reads `BOOTSTRAP_PROVIDER`,
 * `BOOTSTRAP_MODEL`, `BOOTSTRAP_API_KEY`, `BOOTSTRAP_BASE_URL` from
 * the env and seeds a single default model_config row + vault entry.
 *
 * Skipped (no-op) when:
 *   - The model_config table already has rows (existing instance).
 *   - BOOTSTRAP_PROVIDER is empty.
 *
 * Idempotent: rerunning with the same env is harmless; rerunning
 * after the user added their own models is also harmless (the row
 * count check short-circuits).
 *
 * Runs once at startup, between gateway.start() and channel
 * initialization. See src/index.ts.
 */
export async function bootstrapDefaultModel(): Promise<void> {
  const provider = (process.env.BOOTSTRAP_PROVIDER || '').trim();
  if (!provider) return;

  const db = getDb();
  const [{ value: existing }] = await db.select({ value: count() }).from(modelConfig);
  if (existing > 0) {
    logger.debug({ existing }, 'bootstrap-model: model_config not empty, skipping seed');
    return;
  }

  const modelId = (process.env.BOOTSTRAP_MODEL || '').trim();
  const apiKey = (process.env.BOOTSTRAP_API_KEY || '').trim();
  const baseUrl = (process.env.BOOTSTRAP_BASE_URL || '').trim();

  if (!modelId) {
    logger.warn({ provider }, 'bootstrap-model: BOOTSTRAP_PROVIDER set but BOOTSTRAP_MODEL empty — skipping');
    return;
  }

  // Vault: store the API key under a system secret name keyed by
  // provider. Model rows reference this via `apiKeyRef`. Skipped for
  // providers that don't need a key in our setup (ollama, cli).
  // Fail loud if the vault write fails for a provider that needs a key —
  // a row with apiKeyRef=null would be silently unusable at first call.
  let apiKeyRef: string | null = null;
  if (apiKey && provider !== 'ollama' && provider !== 'cli') {
    const refName = `${provider}_api_key`;
    try {
      await getVault().setSystemSecret(refName, apiKey, {
        description: `Bootstrap ${provider} API key (auto-configured by setup)`,
        tags: ['bootstrap', provider],
      });
      apiKeyRef = refName;
    } catch (err) {
      logger.error(
        { err, provider },
        'bootstrap-model: vault write failed — aborting seed to avoid creating an unusable model row',
      );
      return;
    }
  }

  const friendlyName = `${provider} ${modelId}`;
  const endpoint = baseUrl || null;

  const row: NewModelConfigEntry = {
    name: friendlyName,
    provider,
    modelId,
    endpoint,
    apiKeyRef,
    topics: ['general'],
    topicRoles: { general: 'primary' },
    isEnabled: true,
    isDefault: true,
  };

  try {
    await db.insert(modelConfig).values(row);
    logger.info(
      { provider, modelId, hasKey: !!apiKeyRef, endpoint: endpoint ?? '(default)' },
      'bootstrap-model: seeded default model from BOOTSTRAP_* env',
    );
  } catch (err) {
    logger.error({ err, provider, modelId }, 'bootstrap-model: insert failed');
  }
}
