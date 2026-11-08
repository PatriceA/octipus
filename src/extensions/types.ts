import type { TrustLevel } from '@/core/gateway/protocol';
import type { Logger } from '@/utils/logger';

/**
 * Public API exposed to user-authored extensions.
 *
 * An extension is a TypeScript module exporting a default function:
 *
 * ```ts
 * import type { ExtensionAPI } from '@octipus/extensions';
 * export default function (octi: ExtensionAPI) {
 *   octi.on('chat.message', async (event) => { ... });
 *   octi.registerCommand({ name: 'mycmd', handler: async () => ({ text: 'hi' }) });
 * }
 * ```
 */
export interface ExtensionAPI {
  /** The extension's stable name (derived from filename or directory). */
  readonly name: string;

  /** Per-extension child logger — prefixed with the extension name. */
  readonly logger: Logger;

  /**
   * Subscribe to gateway events. `pattern` matches `event.type` with `*`
   * wildcard support (`chat.*`, `swarm.*`, `*` for everything).
   * Returns an unsubscribe function that is also auto-called on dispose.
   */
  on(pattern: string, handler: ExtensionEventHandler): () => void;

  /** Register a slash command. Same shape as a built-in command. */
  registerCommand(def: ExtensionCommandDef): void;

  /**
   * Emit a notification to the gateway event bus. Gateway clients (web/TUI)
   * surface these as toast/banner messages.
   */
  notify(message: string, level?: 'info' | 'warn' | 'error', sessionId?: string): void;

  /**
   * Hook the agent loop (core/agent/hooks.ts): `before-agent-start` (the root
   * system prompt), `tool:before` (rewrite args or short-circuit a call),
   * `tool:after` (replace or redact a successful result), `spawn:before` /
   * `spawn:after`, `context` (transform the
   * messages of one model request; never the stored history) and
   * `compact:before` (supply a compaction summary). Only for an extension the
   * operator trusts (`extensions.trusted`); anything else throws. Removed when
   * the extension is disposed. Returns the unregister function.
   */
  hook<E extends import('@/core/agent/hooks').AgentHookEvent>(
    event: E,
    handler: import('@/core/agent/hooks').HookHandler<import('@/core/agent/hooks').AgentHookEvents[E]>,
  ): () => void;

  /**
   * Version of the `hook` contract (`AGENT_HOOK_API_VERSION`): event names,
   * payload shapes and failure modes are stable within it. Check it when your
   * extension depends on a payload field.
   */
  readonly hookApiVersion: number;

  /**
   * Register a tool the agents can call, as `ext_<extension>__<id>` in the
   * tool group `ext_<extension>` (list that group in a role's tools to give it
   * the tool). It runs through the same middleware as a built-in: hooks, the
   * permission check for its `effect`, approval, audit. Trusted extensions
   * only (`extensions.trusted`); anything else throws, as does an invalid
   * definition or an id already taken. Removed on dispose. Returns the
   * unregister function.
   */
  registerTool(def: ExtensionToolDef): () => void;

  /**
   * Register a model endpoint on one of the existing custom-provider kinds
   * (`openai-compatible` -> `custom-openai`, `anthropic-compatible` ->
   * `custom-anthropic`, `gemini-compatible` -> `custom-gemini`). Not provider
   * code: each model becomes an in-memory model row named
   * `ext/<extension>/<id>/<model id>` that the existing custom provider serves.
   * The rows can be chosen by name or model id (`/model`, an agent's model);
   * they are never a default, a topic binding or a fallback.
   *
   * `baseUrl` must be https and resolve to public addresses only (checked now
   * and on every request; redirects are not followed). The key is the NAME of
   * a system vault secret (`apiKeySecret`), never the key itself.
   *
   * Trusted extensions only (`extensions.trusted`): an untrusted one, an
   * invalid definition or an id already registered throws synchronously. The
   * returned promise settles once the endpoint's DNS check and the collision
   * check against configured models have passed (rejects otherwise, leaving
   * nothing registered) and resolves to the unregister function. Removed on
   * dispose.
   */
  registerProvider(def: ExtensionProviderDef): Promise<() => void>;

  /**
   * Register a teardown callback. All `on()` subscriptions are cleaned up
   * automatically; use this for any extra resources (timers, file watchers).
   */
  onDispose(fn: () => void | Promise<void>): void;
}

export interface ExtensionEventContext {
  /** The extension's name — useful when one handler is shared across extensions. */
  extensionName: string;
}

export type ExtensionEventHandler = (
  event: import('@/core/gateway/protocol').GatewayEvent,
  ctx: ExtensionEventContext,
) => void | Promise<void>;

export interface ExtensionCommandDef {
  name: string;
  aliases?: string[];
  description: string;
  args?: { name: string; required: boolean; description: string }[];
  /** Admins only, checked against the database when the command runs. Default false. */
  adminOnly?: boolean;
  /**
   * @deprecated Use `adminOnly`. Trust levels other than 'user' and 'agent'
   * are gone; 'local' and 'system' register the command as `adminOnly: true`
   * (with a warning) so a command restricted the old way stays restricted.
   */
  minTrustLevel?: 'user' | 'local' | 'system' | 'agent';
  handler: (ctx: ExtensionCommandContext) => Promise<{ text: string; ephemeral?: boolean }>;
}

/**
 * What a tool does. It decides the defaults and the flow-guard contract, and
 * the tool is checked under the action `<effect>:<id>` (one policy per tool). `read`:
 * allowed by default, no mutation journal. `write`: asks by default.
 * `external`: asks, and marked dangerous so a broad allow rule does not lift
 * it. The flow guard treats every result as untrusted, `write` and `external`
 * as write egress and `read` as query egress (security/flow-guard.ts).
 */
export type ExtensionToolEffect = 'read' | 'write' | 'external';

export interface ExtensionToolDef {
  /** Lower-case letters, digits and single underscores, starting with a letter. */
  id: string;
  description: string;
  /** JSON Schema of the arguments, `type: 'object'`. Its `required` list is enforced before the handler runs. */
  parameters?: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
  effect: ExtensionToolEffect;
  /** Its return value is the tool result (JSON-serialisable). A throw is a failed call. */
  handler: (args: Record<string, unknown>, ctx: ExtensionToolContext) => unknown | Promise<unknown>;
}

export type ExtensionProviderKind = 'openai-compatible' | 'anthropic-compatible' | 'gemini-compatible';

export interface ExtensionProviderModelDef {
  /** The model id sent upstream. */
  id: string;
  contextWindow: number;
  /** Output-token ceiling (also the per-request default). */
  maxOutput: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  /** USD per 1M input tokens, for cost tracking. Default 0. */
  costPerMillionInput?: number;
  /** USD per 1M output tokens, for cost tracking. Default 0. */
  costPerMillionOutput?: number;
  description?: string;
}

export interface ExtensionProviderDef {
  /** Lower-case letters, digits and hyphens, starting with a letter; not a built-in provider name. */
  id: string;
  /** Shown in model descriptions. */
  label?: string;
  kind: ExtensionProviderKind;
  /** https only; public addresses only. No credentials, query or fragment. */
  baseUrl: string;
  /** The name of the system vault secret holding the key. Required. */
  apiKeySecret: string;
  /**
   * The header the key goes in. Default per kind: `Authorization: Bearer`
   * (OpenAI), `x-api-key` (Anthropic), `x-goog-api-key` (Gemini).
   */
  authHeader?: string;
  /** Request path instead of the kind's default (e.g. `/openai/v1/chat/completions`). */
  path?: string;
  /** Extra non-credential headers sent on every request. */
  headers?: Record<string, string>;
  models: ExtensionProviderModelDef[];
}

export interface ExtensionToolContext {
  userId: string;
  sessionId: string;
  role?: string;
  workspaceId?: string | null;
}

export interface ExtensionCommandContext {
  userId: string;
  sessionId?: string;
  clientType: string;
  trustLevel: TrustLevel;
  args: Record<string, string>;
  rawArgs: string;
}

/** Default-export shape for extension modules. */
export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

export interface LoadedExtension {
  /** Stable name (filename without `.ts` or directory name). */
  name: string;
  /** Absolute path to the entry file. */
  entryPath: string;
  /** Per-extension dispose to unwind subscriptions/commands/tools. */
  dispose: () => Promise<void>;
}
