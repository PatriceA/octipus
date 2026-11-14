/**
 * Download the optional local embedding engine and its model, verified, with
 * no database and without starting anything (docs/RAG.md → Local embeddings).
 * The Docker build runs it when OCTIPUS_BAKE_EMBEDDING=1; afterwards
 * `octi capabilities install local-embedding` only probes and registers.
 *
 *   npx tsx scripts/fetch-local-engine.ts [--model <id>]
 */
import { fetchLocalEngineFiles } from '@/capabilities/local-engine/install';
import { modelsRoot } from '@/capabilities/local-engine/paths';

const i = process.argv.indexOf('--model');
const modelId = i > 0 ? process.argv[i + 1] : undefined;
try {
  const model = await fetchLocalEngineFiles(modelId, (text) => process.stdout.write(`${text}\n`));
  process.stdout.write(`Local embedding engine and ${model.label} are in ${modelsRoot()}.\n`);
} catch (err) {
  process.stderr.write(`fetch-local-engine: ${(err as Error).message}\n`);
  process.exit(1);
}
