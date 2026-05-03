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
  /** Default `'user'`. Use `'local'` to require local-trust. */
  minTrustLevel?: TrustLevel;
  handler: (ctx: ExtensionCommandContext) => Promise<{ text: string; ephemeral?: boolean }>;
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
