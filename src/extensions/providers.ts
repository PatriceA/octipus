/**
 * `octi.registerProvider` (types.ts): a trusted extension registers an
 * ENDPOINT on one of the existing custom-provider kinds, never provider code.
 *
 * A registration becomes in-memory model rows (src/models/extension-models.ts)
 * with `provider` = `custom-openai` / `custom-anthropic` / `custom-gemini`, so
 * the call goes through the same router, custom provider, rate limiter,
 * circuit breaker, protection routing and accounting as a custom provider an
 * admin configured. `ProviderId` stays a closed set: nothing new is keyed in
 * the model catalog, pricing tables, setup flow or circuit-breaker registry.
 *
 * Endpoint and credential rules are the personal-row rules
 * (services/personal-models.ts), the strictest the custom providers have:
 * https only, no private / loopback / link-local address (checked here and on
 * every request), no redirects followed, and the key only as the name of a
 * system vault secret in the extension's own namespace (`ext.<extension>.<name>`)
 * — never a raw key, an `env:` reference, another secret of the install
 * (a provider key, a plugin secret), or an auth header.
 */
import { randomUUID } from 'node:crypto';
import type { ModelConfigEntry, CustomProviderConfig, ModelMetadata } from '@/db/schema/models';
import {
  addExtensionModels,
  EXTENSION_MODEL_PREFIX,
  type ExtensionModelEntry,
  removeExtensionModels,
} from '@/models/extension-models';
import { isReservedSecretName } from '@/security/vault';
import { getModelRegistry } from '@/models/model-registry';
import { isIpLiteral, isPrivateIP, looksLikeNonStandardIpLiteral, validateExternalUrl } from '@/utils/sanitize';
import type { ExtensionProviderDef, ExtensionProviderKind } from './types';

export const PROVIDER_KINDS: Record<ExtensionProviderKind, 'custom-openai' | 'custom-anthropic' | 'custom-gemini'> = {
  'openai-compatible': 'custom-openai',
  'anthropic-compatible': 'custom-anthropic',
  'gemini-compatible': 'custom-gemini',
};

/** The header each kind sends its key in by default (what each API expects). */
const DEFAULT_AUTH: Record<ExtensionProviderKind, CustomProviderConfig['auth']> = {
  'openai-compatible': { type: 'bearer' },
  'anthropic-compatible': { type: 'header', headerName: 'x-api-key' },
  'gemini-compatible': { type: 'header', headerName: 'x-goog-api-key' },
};

/**
 * Provider names the install already has (router, setup flow). An extension
 * provider is namespaced and can never be one of them, but an id spelled like
 * a built-in would read as one in logs and listings, so it is refused.
 */
const RESERVED_PROVIDER_IDS = new Set([
  'cli', 'ollama', 'litellm', 'openrouter', 'openai', 'anthropic', 'gemini', 'grok', 'vertex', 'deepseek',
  'mistral', 'zai', 'moonshot', 'meta', 'voyage', 'typesafe', 'custom-openai', 'custom-anthropic', 'custom-gemini',
]);

/** Headers an extension may not set: credentials go through `apiKeySecret`, transport headers are the client's. */
const FORBIDDEN_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'cookie', 'set-cookie',
  'host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'te', 'upgrade',
]);

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** The part of `ext.<extension>.<name>` after the extension's prefix. */
const SECRET_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Extension names usable in a row name and a secret namespace. */
const EXTENSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const PATH = /^\/[A-Za-z0-9._~/{}:-]{0,255}$/;
const MAX_MODELS = 64;

function fail(extension: string, message: string): never {
  throw new Error(`extension "${extension}" registerProvider: ${message}`);
}

function positiveInt(extension: string, field: string, value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
    fail(extension, `${field} must be a positive integer up to ${max}`);
  }
  return value;
}

function nonNegative(extension: string, field: string, value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(extension, `${field} must be a finite nonnegative number`);
  return value;
}

/**
 * The checks that need no network: https, no credentials or query in the URL,
 * no localhost, and no private or ambiguous IP literal. The DNS check runs
 * after (`validateExternalUrl`), and again on every request.
 */
export function checkBaseUrl(extension: string, baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || !baseUrl || baseUrl.length > 2048) fail(extension, 'baseUrl must be a URL string');
  let url: URL;
  try { url = new URL(baseUrl); } catch { fail(extension, `baseUrl is not a valid URL`); }
  if (url.protocol !== 'https:') fail(extension, 'baseUrl must use https://');
  if (url.username || url.password) fail(extension, 'baseUrl may not carry credentials; name a vault secret in apiKeySecret');
  if (url.search || url.hash) fail(extension, 'baseUrl may not carry a query or fragment');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) fail(extension, 'baseUrl may not point at localhost');
  if (looksLikeNonStandardIpLiteral(host)) fail(extension, `baseUrl has an ambiguous IP literal (${host})`);
  if (isIpLiteral(host) && isPrivateIP(host)) fail(extension, `baseUrl points at a private or reserved address (${host})`);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** The vault namespace an extension's provider keys live in: `ext.<extension>.`. */
export function extensionSecretPrefix(extension: string): string {
  return `ext.${extension}.`;
}

/**
 * Validate a definition and build its rows. Throws on anything invalid,
 * naming the extension. Pure: registers nothing. `def` is the caller's
 * private copy (api.ts clones it), so nothing can change under the checks.
 */
export function buildExtensionProviderRows(extension: string, def: ExtensionProviderDef): { providerId: string; entries: ExtensionModelEntry[] } {
  if (!EXTENSION_NAME.test(extension)) fail(extension, 'the extension name must be letters, digits, _ and - to register providers; rename its file or directory');
  if (!def || typeof def !== 'object') fail(extension, 'a definition object is required');
  const id = def.id;
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) fail(extension, 'id must be lower-case letters, digits and hyphens, starting with a letter (at most 40)');
  if (RESERVED_PROVIDER_IDS.has(id)) fail(extension, `id '${id}' is a built-in provider name`);
  const kind = def.kind;
  if (!Object.hasOwn(PROVIDER_KINDS, kind)) fail(extension, `kind must be one of ${Object.keys(PROVIDER_KINDS).join(', ')}`);
  const baseUrl = checkBaseUrl(extension, def.baseUrl);

  const raw = def as unknown as Record<string, unknown>;
  if ('apiKey' in raw || 'key' in raw || 'token' in raw) fail(extension, 'a raw key is not accepted; store it in the vault and name it in apiKeySecret');
  // Only the extension's own namespace: naming any system secret would let it
  // send the install's provider keys or plugin secrets to its endpoint, past
  // the secret's allowedTools / allowedAgents (getByName does not check them).
  const secret = def.apiKeySecret;
  const prefix = extensionSecretPrefix(extension);
  if (typeof secret !== 'string' || !secret.startsWith(prefix) || !SECRET_SUFFIX.test(secret.slice(prefix.length))) {
    fail(extension, `apiKeySecret must name a system vault secret '${prefix}<name>' (letters, digits, _ and - after the prefix)`);
  }
  if (isReservedSecretName(secret)) fail(extension, `apiKeySecret '${secret}' is a reserved system secret`);

  let auth = DEFAULT_AUTH[kind];
  if (def.authHeader !== undefined) {
    if (typeof def.authHeader !== 'string' || !HEADER_NAME.test(def.authHeader)) fail(extension, 'authHeader must be a header name');
    const lower = def.authHeader.toLowerCase();
    // `authorization` means Bearer; the key headers each kind knows are fine;
    // a transport or cookie header is not where a key goes.
    if (lower !== 'authorization' && !['x-api-key', 'api-key', 'x-goog-api-key'].includes(lower) && (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-'))) {
      fail(extension, `authHeader '${def.authHeader}' may not carry the key`);
    }
    auth = lower === 'authorization' ? { type: 'bearer' } : { type: 'header', headerName: def.authHeader };
  }

  const extraHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(def.headers ?? {})) {
    if (!HEADER_NAME.test(name)) fail(extension, `header '${name}' is not a valid header name`);
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || (auth.type === 'header' && lower === auth.headerName?.toLowerCase())) {
      fail(extension, `header '${name}' may not be set; the key is sent from apiKeySecret`);
    }
    if (typeof value !== 'string' || value.length > 1024 || /[\r\n\0]/.test(value)) fail(extension, `header '${name}' must be a single-line string`);
    extraHeaders[name] = value;
  }

  if (def.path !== undefined && (typeof def.path !== 'string' || !PATH.test(def.path) || def.path.includes('..') || def.path.includes('//'))) {
    fail(extension, 'path must be an absolute URL path (no "..", no query)');
  }

  const models = def.models;
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_MODELS) fail(extension, `models must list 1 to ${MAX_MODELS} models`);
  const providerId = `ext:${extension}:${id}`;
  const custom: CustomProviderConfig = { auth, ...(def.path ? { pathOverride: def.path } : {}), ...(Object.keys(extraHeaders).length ? { extraHeaders } : {}) };
  const now = new Date();
  const seen = new Set<string>();
  const entries = models.map((m): ExtensionModelEntry => {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !MODEL_ID.test(m.id)) fail(extension, 'each model needs an id (letters, digits and . _ : / @ + -)');
    if (m.id.startsWith('u/') || m.id.startsWith(EXTENSION_MODEL_PREFIX)) fail(extension, `model id '${m.id}' is in a reserved namespace`);
    if (seen.has(m.id)) fail(extension, `model '${m.id}' is listed twice`);
    seen.add(m.id);
    const contextWindow = positiveInt(extension, `model '${m.id}' contextWindow`, m.contextWindow, 10_000_000);
    const maxOutput = positiveInt(extension, `model '${m.id}' maxOutput`, m.maxOutput, 1_000_000);
    if (maxOutput > contextWindow) fail(extension, `model '${m.id}' maxOutput exceeds its contextWindow`);
    for (const flag of ['supportsVision', 'supportsAudioInput', 'supportsTools', 'supportsStreaming'] as const) {
      if (m[flag] !== undefined && typeof m[flag] !== 'boolean') fail(extension, `model '${m.id}' ${flag} must be a boolean`);
    }
    if (m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 500)) fail(extension, `model '${m.id}' description must be a string of at most 500 characters`);
    const metadata: ModelMetadata = {
      customProvider: custom,
      description: m.description ?? `${def.label ?? id} (registered by extension "${extension}")`,
    };
    // The row's model id is its name: nothing but that exact name reaches it
    // (extension-models.ts); the registered id is what goes upstream.
    const name = `${EXTENSION_MODEL_PREFIX}${extension}/${id}/${m.id}`;
    const row: ModelConfigEntry = {
      id: randomUUID(),
      name,
      provider: PROVIDER_KINDS[kind],
      modelId: name,
      endpoint: baseUrl,
      apiKeyRef: secret,
      orgId: null,
      ownerUserId: null,
      maxTokens: maxOutput,
      contextWindow,
      supportsVision: m.supportsVision ?? false,
      supportsAudioInput: m.supportsAudioInput ?? false,
      supportsTools: m.supportsTools ?? true,
      supportsStreaming: m.supportsStreaming ?? true,
      defaultTemperature: 0.7,
      defaultTopP: 1,
      defaultMaxTokens: maxOutput,
      topics: [],
      priority: 0,
      topicRoles: {},
      costPerInputToken: nonNegative(extension, `model '${m.id}' costPerMillionInput`, m.costPerMillionInput),
      costPerOutputToken: nonNegative(extension, `model '${m.id}' costPerMillionOutput`, m.costPerMillionOutput),
      isEnabled: true,
      isDefault: false,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
    return { row, upstreamModelId: m.id, providerKey: providerId };
  });
  return { providerId, entries };
}

/**
 * Register a validated definition: the DNS check of the endpoint, the
 * collision check against the database, then the rows go live. Returns the
 * row names (to remove on dispose).
 */
export async function activateExtensionProvider(extension: string, entries: readonly ExtensionModelEntry[]): Promise<string[]> {
  const rows = entries.map((e) => e.row);
  const endpoint = rows[0]?.endpoint;
  if (endpoint) {
    const check = await validateExternalUrl(endpoint);
    if (!check.valid) fail(extension, `baseUrl refused: ${check.reason}`);
  }
  const registry = getModelRegistry();
  for (const row of rows) {
    // The registry refuses `ext/` names and ids for new rows; one written
    // before that (or by hand) must not be shadowed silently.
    if (await registry.databaseRowExists({ name: row.name, modelId: row.modelId })) {
      fail(extension, `model '${row.name}' collides with a configured model`);
    }
  }
  try {
    addExtensionModels(entries);
  } catch (err) {
    fail(extension, err instanceof Error ? err.message : String(err));
  }
  return rows.map((r) => r.name);
}

export function deactivateExtensionProvider(names: readonly string[]): void {
  removeExtensionModels(names);
}
