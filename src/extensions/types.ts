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
 * What a tool does, which decides the permission action it is checked under:
 * `read` → `read` (allowed by default, no mutation journal), `write` → `write`
 * (asks by default), `external` → `external` (asks, and marked dangerous so a
 * broad allow rule does not lift it).
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
