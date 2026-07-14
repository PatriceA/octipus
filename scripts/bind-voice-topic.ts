/**
 * One-off: bind the `voice` topic to the fast Gemini Flash Lite model so the
 * orchestrator's spoken planning turns route to it (snappy) instead of the
 * default. Reversible — rebind in the Topics page or re-run with another model.
 * Run: `bun scripts/bind-voice-topic.ts`. Restart the backend to clear its cache.
 */
import { closeDb, initializeDb } from '../src/db/postgres';
import { closeStorage, initializeStorage } from '../src/db/storage';
import { getModelRegistry } from '../src/models/model-registry';
import { initializeVault } from '../src/security/vault';

const MODEL_NAME = 'Gemini 3.1 Flash Lite';
const TOPIC = 'voice';

async function main() {
  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';
  if (mode === 'embedded') initializeStorage({ mode: 'embedded' });
  await initializeDb();
  await initializeVault();

  const registry = getModelRegistry();
  const all = await registry.getAllModels();
  const model = all.find((m) => m.name === MODEL_NAME);
  if (!model) throw new Error(`Model "${MODEL_NAME}" not found. Options: ${all.map((m) => m.name).join(', ')}`);

  const roles = { ...((model.topicRoles ?? {}) as Record<string, 'primary' | 'backup'>), [TOPIC]: 'primary' as const };
  await registry.updateModel(model.name, { topicRoles: roles });

  const check = await registry.getModelForTopic(TOPIC);
  process.stdout.write(`Bound topic "${TOPIC}" → ${model.name} (${model.modelId}). Resolves to: ${check?.modelId ?? 'NONE'}\n`);

  await closeDb();
  await closeStorage();
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
