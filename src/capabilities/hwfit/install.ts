/**
 * Install orchestration for the hwfit recommender: pull a catalog model into
 * Ollama, register it, and bind it to topics. Runs as a tracked background job
 * so the HTTP request returns immediately and the client polls (or, later,
 * streams) progress.
 *
 * Dependencies (pull / register / first-model check) are injected so the
 * orchestration is unit-testable without a live Ollama server or DB.
 */
import type { NewModelConfigEntry } from '@/db/schema/models';
import type { PullProgress } from '@/models/providers/ollama-provider';
import { modelLogger } from '@/utils/logger';
import type { CatalogTopic, ModelCatalogEntry } from './types';

export type InstallStatus = 'pulling' | 'registering' | 'done' | 'error';

export interface InstallJob {
  id: string;
  modelId: string;
  bindTopics: CatalogTopic[];
  status: InstallStatus;
  /** Current-layer download progress, 0–100. */
  percent: number;
  /** Latest Ollama status string. */
  statusText: string;
  /** Registered model name once status === 'done'. */
  modelName?: string;
  /** Failure reason once status === 'error'. */
  error?: string;
  startedAt: number;
}

export interface InstallDeps {
  pull: (id: string, onProgress: (p: PullProgress) => void) => Promise<void>;
  register: (entry: NewModelConfigEntry) => Promise<void>;
  /** True when no models are configured yet (⇒ the install should become default). */
  isFirstModel: () => Promise<boolean>;
}

/**
 * Build the DB entry for a pulled catalog model. Pure + exported for testing.
 * Resolves to topic bindings (`topicRoles`), never a hardcoded default — house
 * rule #2. Capabilities beyond vision are derived by the capabilities system.
 */
export function buildModelEntry(
  entry: ModelCatalogEntry,
  bindTopics: CatalogTopic[],
  isFirst: boolean,
): NewModelConfigEntry {
  return {
    name: entry.id,
    provider: 'ollama',
    modelId: entry.id,
    contextWindow: entry.contextWindow,
    topics: bindTopics,
    topicRoles: Object.fromEntries(bindTopics.map((t) => [t, 'primary' as const])),
    supportsVision: entry.topics.includes('vision'),
    isDefault: isFirst,
  };
}

const jobs = new Map<string, InstallJob>();

export function getInstallJob(id: string): InstallJob | undefined {
  return jobs.get(id);
}

/**
 * Run the pull → register → bind sequence, mutating `job` as it progresses.
 * Never throws — failures are recorded on the job (and logged). Exported so
 * tests can await the full sequence; production callers use startInstall.
 */
export async function runInstall(job: InstallJob, entry: ModelCatalogEntry, deps: InstallDeps): Promise<void> {
  try {
    job.status = 'pulling';
    await deps.pull(entry.id, (p) => {
      if (typeof p.percent === 'number') job.percent = p.percent;
      job.statusText = p.status;
    });

    job.status = 'registering';
    const isFirst = await deps.isFirstModel();
    const model = buildModelEntry(entry, job.bindTopics, isFirst);
    await deps.register(model);

    job.modelName = model.name;
    job.percent = 100;
    job.status = 'done';
    modelLogger.info({ model: model.name, topics: job.bindTopics, isDefault: isFirst }, 'hwfit: model installed and bound');
  } catch (err) {
    job.status = 'error';
    job.error = (err as Error).message;
    modelLogger.error({ modelId: entry.id, err: job.error }, 'hwfit: install failed');
  }
}

/**
 * Start a background install and return the tracked job immediately. The caller
 * polls getInstallJob(id) for progress.
 */
export function startInstall(entry: ModelCatalogEntry, bindTopics: CatalogTopic[], deps: InstallDeps): InstallJob {
  const job: InstallJob = {
    id: globalThis.crypto.randomUUID(),
    modelId: entry.id,
    bindTopics,
    status: 'pulling',
    percent: 0,
    statusText: 'starting',
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  // Fire-and-forget; runInstall records its own outcome on the job.
  void runInstall(job, entry, deps);
  return job;
}
