/**
 * In-memory stand-ins for the two stores a provider call reads before it
 * reaches the wire: the model registry (which row, which provider, which
 * endpoint and key reference) and the vault (which key). Paired with the
 * scripted provider (`scripted-provider.ts`), they let a unit suite run the
 * real client and router end to end with no database and no network.
 *
 * A suite installs them with module mocks; the factories import this module,
 * so the suite and the code under test share one instance:
 *
 *   vi.mock('@/models/model-registry', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@/models/model-registry')>()),
 *     getModelRegistry: (await import('@/models/testing/model-doubles')).registryDouble.registry,
 *   }));
 *   vi.mock('@/security/vault', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@/security/vault')>()),
 *     getVault: (await import('@/models/testing/model-doubles')).vaultDouble.vault,
 *   }));
 *
 * The registry double answers like the real queries: disabled rows are never
 * returned, install rows come before the requester's personal rows, and
 * another user's personal row is never returned by model id.
 */
import type { ModelConfigEntry } from '@/db/schema/models';

let rowSeq = 0;

/** A complete `model_config` row with the schema defaults; `name` defaults to `<provider> <modelId>`. */
export function modelRow(over: Partial<ModelConfigEntry> & Pick<ModelConfigEntry, 'provider' | 'modelId'>): ModelConfigEntry {
  rowSeq++;
  return {
    id: `00000000-0000-4000-8000-${String(rowSeq).padStart(12, '0')}`,
    name: `${over.provider} ${over.modelId}`,
    endpoint: null,
    apiKeyRef: null,
    orgId: null,
    ownerUserId: null,
    maxTokens: 16384,
    contextWindow: 128000,
    supportsVision: false,
    supportsAudioInput: false,
    supportsTools: true,
    supportsStreaming: true,
    defaultTemperature: 0.7,
    defaultTopP: 1,
    defaultMaxTokens: 16384,
    topics: [],
    priority: 0,
    topicRoles: {},
    costPerInputToken: 0,
    costPerOutputToken: 0,
    isEnabled: true,
    isDefault: false,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as ModelConfigEntry;
}

const rows: ModelConfigEntry[] = [];
let registryFailure: Error | undefined;

function lookup<T>(read: () => T): Promise<T> {
  return registryFailure ? Promise.reject(registryFailure) : Promise.resolve(read());
}

const registryApi = {
  getModel: (name: string) => lookup(() => rows.find(r => r.name === name && r.isEnabled) ?? null),
  getModelByModelId: (modelId: string, opts: { userId?: string } = {}) => lookup(() =>
    rows.find(r => r.modelId === modelId && r.isEnabled && !r.ownerUserId)
    ?? (opts.userId ? rows.find(r => r.modelId === modelId && r.isEnabled && r.ownerUserId === opts.userId) : undefined)
    ?? null),
  getModelForTopic: (topic: string) => lookup(() =>
    rows.find(r => r.isEnabled && !r.ownerUserId && r.topicRoles?.[topic] === 'primary') ?? null),
};

export const registryDouble = {
  /** Stands in for `getModelRegistry`. */
  registry: () => registryApi,
  add(...added: ModelConfigEntry[]): void { rows.push(...added); },
  /** Every lookup rejects with `err` until `clear()` (a registry outage). */
  failWith(err: Error): void { registryFailure = err; },
  clear(): void { rows.length = 0; registryFailure = undefined; },
};

const secrets = new Map<string, string>();
let vaultFailure: Error | undefined;

const vaultApi = {
  getByName: (scope: string, name: string) =>
    vaultFailure ? Promise.reject(vaultFailure) : Promise.resolve(secrets.get(`${scope}\u0000${name}`) ?? null),
};

export const vaultDouble = {
  /** Stands in for `getVault`. */
  vault: () => vaultApi,
  /** Store `value` under `name` in `scope` ('system' or a user id). */
  set(scope: string, name: string, value: string): void { secrets.set(`${scope}\u0000${name}`, value); },
  /** Every read rejects with `err` until `clear()` (a vault that cannot decrypt). */
  failWith(err: Error): void { vaultFailure = err; },
  clear(): void { secrets.clear(); vaultFailure = undefined; },
};
