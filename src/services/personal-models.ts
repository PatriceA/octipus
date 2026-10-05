/**
 * Personal models (coworking spec §8.1, §8.4): a user's own model rows, keys
 * and topic bindings, behind `/api/me/models`.
 *
 * A personal row is built from an allowlist, never from a free-form body:
 * provider (one that honours `options.apiKey`, §8.3), provider model id, a
 * label, an endpoint for the custom providers only, the key or CLI token, and
 * text-lane bindings. Nothing that changes how the server itself runs is
 * accepted — no `cliAgent.inheritApiKeys`, `extraArgs`, `mcpConfigPath`,
 * `permissionMode` or `extraHeaders`.
 *
 * The row is named `u/<userId>/<slug>`; ownership is `owner_user_id`. The key
 * lives in the owner's vault and resolves only under the owner
 * (`resolveModelKey`). A custom endpoint is checked here for early feedback
 * and again on every request (`personalEndpointFetch`).
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auditRepository } from '@/db/repositories/audit-repository';
import { getDb } from '@/db/postgres';
import { type ModelConfigEntry, type ModelMetadata, modelConfig, userModelBindings } from '@/db/schema/models';
import { getCLIToolConfig } from '@/core/cli-agent-factory';
import { PERSONAL_CLI_VENDORS } from '@/core/cli-child-env';
import { getModelRegistry } from '@/models/model-registry';
import { isPersonalBindableTopic } from '@/models/resolve-model';
import { canonicalTopic, TOPICS } from '@/models/topics';
import { getVault } from '@/security/vault';
import type { PersonalModelSummary } from '@/shared/types';
import { validateExternalUrl } from '@/utils/sanitize';

/** Providers a personal row may use: each honours a per-request key (§8.3). */
export const PERSONAL_MODEL_PROVIDERS = [
  'anthropic', 'openai', 'deepseek', 'gemini', 'grok', 'mistral', 'moonshot', 'openrouter', 'zai',
  'custom-openai', 'custom-anthropic', 'custom-gemini', 'cli',
] as const;
export type PersonalModelProvider = (typeof PERSONAL_MODEL_PROVIDERS)[number];

const CUSTOM_PROVIDERS: ReadonlySet<string> = new Set(['custom-openai', 'custom-anthropic', 'custom-gemini']);

/** The text lanes a personal row may bind (§8.2). */
export const PERSONAL_BINDABLE_TOPICS: readonly string[] = TOPICS.filter((t) => t.kind === 'text').map((t) => t.value);

const SLUG = /^[a-z0-9-]{1,40}$/;

export class PersonalModelError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'PersonalModelError';
  }
}

const topicsSchema = z.array(z.string()).max(PERSONAL_BINDABLE_TOPICS.length);

export const createPersonalModelSchema = z.object({
  slug: z.string().regex(SLUG, 'slug must be 1–40 characters of a-z, 0-9 and -'),
  provider: z.enum(PERSONAL_MODEL_PROVIDERS),
  modelId: z.string().trim().min(1).max(200),
  label: z.string().trim().max(80).optional(),
  endpoint: z.string().trim().max(2048).optional(),
  key: z.string().min(1).max(8192),
  topics: topicsSchema.optional(),
}).strict();

export const updatePersonalModelSchema = z.object({
  label: z.string().trim().max(80).optional(),
  endpoint: z.string().trim().max(2048).optional(),
  key: z.string().min(1).max(8192).optional(),
  isEnabled: z.boolean().optional(),
  topics: topicsSchema.optional(),
}).strict();

export type CreatePersonalModelInput = z.infer<typeof createPersonalModelSchema>;
export type UpdatePersonalModelInput = z.infer<typeof updatePersonalModelSchema>;

/** What the owner sees of a personal row — never the key. */
type PersonalModelView = PersonalModelSummary;

export function personalModelName(userId: string, slug: string): string {
  return `u/${userId}/${slug}`;
}

/** The vault entry name holding a personal row's key, in the owner's vault. */
function keyRefFor(name: string): string {
  return `model-key:${name}`;
}

async function checkEndpoint(provider: string, endpoint: string | undefined): Promise<string | null> {
  if (!CUSTOM_PROVIDERS.has(provider)) {
    if (endpoint) throw new PersonalModelError(400, `An endpoint can only be set for a custom provider (${[...CUSTOM_PROVIDERS].join(', ')})`);
    return null;
  }
  if (!endpoint) throw new PersonalModelError(400, 'A custom provider needs an endpoint');
  const check = await validateExternalUrl(endpoint);
  if (!check.valid) throw new PersonalModelError(400, `Endpoint refused: ${check.reason}`);
  return endpoint.replace(/\/+$/, '');
}

function checkModelId(provider: string, modelId: string): void {
  if (modelId.startsWith('u/')) throw new PersonalModelError(400, 'A model id cannot start with "u/"');
  if (provider === 'openrouter' && !modelId.includes('/')) {
    throw new PersonalModelError(400, `OpenRouter models need the "provider/model" form, got "${modelId}"`);
  }
  if (provider === 'cli') {
    const tool = getCLIToolConfig(modelId);
    if (!tool) throw new PersonalModelError(400, `Unknown CLI model "${modelId}"`);
    if (!PERSONAL_CLI_VENDORS.includes(tool.modelProvider)) {
      throw new PersonalModelError(400, `${tool.name} cannot run on a personal token`);
    }
  }
}

function checkTopics(topics: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of topics ?? []) {
    if (!isPersonalBindableTopic(raw)) {
      throw new PersonalModelError(400, `A personal model can bind only the text lanes (${PERSONAL_BINDABLE_TOPICS.join(', ')}), not "${raw}"`);
    }
    out.add(canonicalTopic(raw));
  }
  return [...out];
}

async function storeKey(userId: string, name: string, key: string): Promise<string> {
  const vault = getVault();
  const ref = keyRefFor(name);
  for (const entry of await vault.list(userId)) {
    if (entry.name === ref) await vault.delete(userId, entry.id);
  }
  await vault.store(userId, ref, key, { credentialType: 'api_key', description: `Key for personal model ${name}` });
  return ref;
}

async function dropKey(userId: string, name: string): Promise<void> {
  const vault = getVault();
  const ref = keyRefFor(name);
  for (const entry of await vault.list(userId)) {
    if (entry.name === ref) await vault.delete(userId, entry.id);
  }
}

/** Rebind `topics` to `name` for `userId`: those lanes move to this row, others it held are released. */
async function setBindings(userId: string, name: string, topics: string[]): Promise<void> {
  const db = getDb();
  await db.delete(userModelBindings).where(and(eq(userModelBindings.userId, userId), eq(userModelBindings.modelName, name)));
  for (const topic of topics) {
    await db.insert(userModelBindings).values({ userId, topic, modelName: name })
      .onConflictDoUpdate({ target: [userModelBindings.userId, userModelBindings.topic], set: { modelName: name, createdAt: new Date() } });
  }
}

async function ownRow(userId: string, slug: string): Promise<ModelConfigEntry> {
  if (!SLUG.test(slug)) throw new PersonalModelError(404, 'Model not found');
  const [row] = await getDb().select().from(modelConfig)
    .where(and(eq(modelConfig.name, personalModelName(userId, slug)), eq(modelConfig.ownerUserId, userId))).limit(1);
  if (!row) throw new PersonalModelError(404, 'Model not found');
  return row;
}

export async function listPersonalModels(userId: string): Promise<PersonalModelView[]> {
  const rows = await getModelRegistry().getPersonalModels(userId);
  const bindings = await getDb().select().from(userModelBindings).where(eq(userModelBindings.userId, userId));
  const prefix = `u/${userId}/`;
  return rows.map((row) => ({
    name: row.name,
    slug: row.name.slice(prefix.length),
    provider: row.provider,
    modelId: row.modelId,
    label: row.metadata?.description ?? null,
    endpoint: row.endpoint,
    isEnabled: row.isEnabled,
    hasKey: !!row.apiKeyRef,
    topics: bindings.filter((b) => b.modelName === row.name).map((b) => b.topic).sort(),
  }));
}

export async function createPersonalModel(userId: string, input: CreatePersonalModelInput): Promise<PersonalModelView> {
  checkModelId(input.provider, input.modelId);
  const endpoint = await checkEndpoint(input.provider, input.endpoint);
  const topics = checkTopics(input.topics);
  const name = personalModelName(userId, input.slug);
  const registry = getModelRegistry();
  if (await registry.isRegistered(name)) throw new PersonalModelError(409, `You already have a model named "${input.slug}"`);

  const metadata: ModelMetadata = {};
  if (input.label) metadata.description = input.label;
  if (CUSTOM_PROVIDERS.has(input.provider)) metadata.customProvider = { auth: { type: 'bearer' } };

  const apiKeyRef = await storeKey(userId, name, input.key);
  await registry.registerModel({
    name,
    provider: input.provider,
    modelId: input.modelId,
    endpoint,
    apiKeyRef,
    ownerUserId: userId,
    metadata,
  });
  await setBindings(userId, name, topics);
  await auditRepository.log({ userId, action: 'personal_model_changed', resourceType: 'model', resourceId: name, details: { change: 'created',  provider: input.provider, modelId: input.modelId, topics } });
  const view = (await listPersonalModels(userId)).find((m) => m.name === name);
  if (!view) throw new Error(`Personal model ${name} vanished after creation`);
  return view;
}

export async function updatePersonalModel(userId: string, slug: string, input: UpdatePersonalModelInput): Promise<PersonalModelView> {
  const row = await ownRow(userId, slug);
  const patch: Partial<typeof modelConfig.$inferInsert> = {};
  if (input.endpoint !== undefined) patch.endpoint = await checkEndpoint(row.provider, input.endpoint);
  if (input.label !== undefined) patch.metadata = { ...(row.metadata ?? {}), description: input.label || undefined };
  if (input.isEnabled !== undefined) patch.isEnabled = input.isEnabled;
  if (input.key !== undefined) patch.apiKeyRef = await storeKey(userId, row.name, input.key);
  if (Object.keys(patch).length > 0) await getModelRegistry().updateModel(row.name, patch);
  if (input.topics !== undefined) await setBindings(userId, row.name, checkTopics(input.topics));
  await auditRepository.log({ userId, action: 'personal_model_changed', resourceType: 'model', resourceId: row.name, details: { change: 'updated',  fields: Object.keys(input).filter((k) => k !== 'key').concat(input.key ? ['key'] : []) } });
  const view = (await listPersonalModels(userId)).find((m) => m.name === row.name);
  if (!view) throw new Error(`Personal model ${row.name} vanished after update`);
  return view;
}

export async function deletePersonalModel(userId: string, slug: string): Promise<void> {
  const row = await ownRow(userId, slug);
  await getModelRegistry().deleteModel(row.name);
  await dropKey(userId, row.name);
  await auditRepository.log({ userId, action: 'personal_model_changed', resourceType: 'model', resourceId: row.name, details: { change: 'deleted' } });
}
