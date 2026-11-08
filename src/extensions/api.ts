import { randomUUID } from 'node:crypto';
import { getCommandRegistry } from '@/core/gateway/commands';
import type { GatewayEventBus } from '@/core/gateway/event-bus';
import type { GatewayEvent } from '@/core/gateway/protocol';
import { matchesPattern } from '@/core/gateway/protocol';
import { createChildLogger } from '@/utils/logger';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { AGENT_HOOK_API_VERSION, getAgentHooks } from '@/core/agent/hooks';
import { getConfig } from '@/config';
import type {
  ExtensionAPI,
  ExtensionCommandDef,
  ExtensionEventHandler,
  LoadedExtension,
} from './types';
import { ExtensionToolContainer, registerContainer, unregisterContainer } from './tools';

/** The hook contract version an extension sees as `octi.hookApiVersion`. */
export const OCTI_HOOK_API_VERSION = AGENT_HOOK_API_VERSION;

/** The real path, or the path as given when it does not resolve (a deleted file is trusted by nothing). */
function real(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

let trustedSnapshot: readonly string[] | undefined;

/**
 * The trusted list, read ONCE — before the first extension's code runs — and
 * kept for the life of the process. Read at call time instead, an extension
 * could add itself to OCTIPUS_TRUSTED_EXTENSIONS (or re-point its symlink)
 * inside its own factory and then pass. Changing the list needs a restart.
 * Only absolute entries count: a relative one (or '') would resolve against
 * the working directory, which is where project extensions live.
 */
export function trustedExtensionPaths(): readonly string[] {
  trustedSnapshot ??= Object.freeze([
    ...(getConfig().extensions?.trusted ?? []),
    ...(process.env.OCTIPUS_TRUSTED_EXTENSIONS ?? '').split(',').map((s) => s.trim()),
  ].filter((item) => item && isAbsolute(item)).map(real));
  return trustedSnapshot;
}

/** Test seam. */
export function resetTrustedExtensionPaths(): void {
  trustedSnapshot = undefined;
}

/**
 * Whether the operator trusts this extension to hook the agent loop: its
 * entry file, or a directory containing it, is in the trusted list, compared
 * by real path. The loader decides this at discovery, before the extension's
 * code runs (`buildExtensionContext`'s `trusted`).
 */
export function isTrustedExtension(entryPath: string, trusted: readonly string[] = trustedExtensionPaths()): boolean {
  const list = trusted.filter((item) => item && isAbsolute(item));
  if (!list.length) return false;
  const entry = real(entryPath);
  return list.some((item) => {
    const rel = relative(real(item), entry);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

/**
 * Build a fresh ExtensionAPI bound to the given event bus, plus a
 * `dispose()` that unwinds every subscription/command this extension
 * registered.
 *
 * Failure isolation: handler exceptions are caught and logged; one bad
 * handler must not take down the bus or the rest of the extensions.
 */
export function buildExtensionContext(
  name: string,
  entryPath: string,
  eventBus: GatewayEventBus,
  /** Decided before the extension's code runs (`isTrustedExtension`). */
  trusted: boolean = isTrustedExtension(entryPath),
): { api: ExtensionAPI; loaded: LoadedExtension } {
  const logger = createChildLogger({ component: 'extension', extension: name });
  const unsubscribers: Array<() => void> = [];
  const commandNames: string[] = [];
  const disposeCallbacks: Array<() => void | Promise<void>> = [];
  let disposed = false;
  let toolContainer: ExtensionToolContainer | undefined;
  const pendingToolWork: Promise<void>[] = [];
  let toolRegistrationError: string | undefined;

  const api: ExtensionAPI = {
    name,
    logger,
    hookApiVersion: OCTI_HOOK_API_VERSION,

    on(pattern: string, handler: ExtensionEventHandler): () => void {
      if (disposed) {
        logger.warn(`on(${pattern}) ignored — extension already disposed`);
        return () => {};
      }
      const wrapped = (event: GatewayEvent) => {
        if (!matchesPattern(event.type, pattern)) return;
        Promise.resolve()
          .then(() => handler(event, { extensionName: name }))
          .catch((err) => {
            logger.error({ err, eventType: event.type }, `extension handler for "${pattern}" threw`);
          });
      };
      const unsub = eventBus.subscribe(pattern, wrapped);
      unsubscribers.push(unsub);
      return unsub;
    },

    registerCommand(def: ExtensionCommandDef): void {
      if (disposed) {
        logger.warn(`registerCommand(${def.name}) ignored — extension already disposed`);
        return;
      }
      // Extensions are runtime JS: a command still restricted the old way
      // (`minTrustLevel: 'local'`) must not register unrestricted.
      let adminOnly = def.adminOnly ?? false;
      const legacy: unknown = def.minTrustLevel;
      if (legacy !== undefined) {
        if (legacy === 'local' || legacy === 'system') {
          adminOnly = true;
          logger.warn(`registerCommand(${def.name}): minTrustLevel '${legacy}' is deprecated; registered as adminOnly: true`);
        } else if (legacy !== 'user' && legacy !== 'agent') {
          throw new Error(`registerCommand(${def.name}): unknown minTrustLevel ${JSON.stringify(legacy)}; use adminOnly`);
        }
      }
      const registry = getCommandRegistry();
      registry.register({
        name: def.name,
        aliases: def.aliases ?? [],
        description: def.description,
        args: def.args,
        adminOnly,
        handler: async (ctx) => {
          try {
            return await def.handler({
              userId: ctx.userId,
              sessionId: ctx.sessionId,
              clientType: ctx.clientType,
              trustLevel: ctx.trustLevel,
              args: ctx.args,
              rawArgs: ctx.rawArgs,
            });
          } catch (err) {
            logger.error({ err, command: def.name }, 'extension command handler threw');
            return { text: `Error in /${def.name}: ${(err as Error).message}` };
          }
        },
      });
      commandNames.push(def.name);
    },

    notify(message: string, level: 'info' | 'warn' | 'error' = 'info', sessionId?: string): void {
      eventBus.publish({
        id: randomUUID(),
        type: 'extension.notify',
        source: `extension:${name}`,
        sessionId,
        timestamp: Date.now(),
        payload: { extensionName: name, message, level },
      });
    },

    onDispose(fn) {
      disposeCallbacks.push(fn);
    },

    hook(event, handler) {
      if (disposed) {
        logger.warn(`hook(${event}) ignored — extension already disposed`);
        return () => {};
      }
      if (!trusted) {
        throw new Error(`extension "${name}" may not hook the agent loop: it is not listed in extensions.trusted (${entryPath})`);
      }
      // A failure names the extension: a fail-closed event's error (and the
      // withheld `tool:after` result) says whose hook it was.
      const named: typeof handler = async (ctx) => {
        try {
          await handler(ctx);
        } catch (err) {
          throw new Error(`extension "${name}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      };
      const off = getAgentHooks().register(event, named);
      unsubscribers.push(off);
      logger.info({ event }, 'extension hooked the agent loop');
      return off;
    },

    registerTool(def) {
      if (disposed) {
        logger.warn(`registerTool(${def?.id}) ignored — extension already disposed`);
        return () => {};
      }
      if (!trusted) {
        throw new Error(`extension "${name}" may not register tools: it is not listed in extensions.trusted (${entryPath})`);
      }
      if (toolRegistrationError) {
        throw new Error(`extension "${name}" cannot register tools: registering its tool group failed (${toolRegistrationError})`);
      }
      if (toolContainer) {
        toolContainer.add(def);
      } else {
        // Validate the first tool before claiming the group, so a bad
        // definition leaves nothing registered.
        const container = new ExtensionToolContainer(name, logger);
        container.add(def);
        pendingToolWork.push(registerContainer(container).catch(async (err) => {
          logger.error({ err, toolGroup: container.id }, 'registering the extension tool group failed');
          // Nothing may go on adding tools to a group the registry does not
          // serve: release the half-registered group and refuse later calls.
          toolRegistrationError = err instanceof Error ? err.message : String(err);
          if (toolContainer === container) toolContainer = undefined;
          await unregisterContainer(container).catch(() => {});
        }));
        toolContainer = container;
      }
      const container = toolContainer;
      return () => { container.remove(def.id); };
    },
  };

  const loaded: LoadedExtension = {
    name,
    entryPath,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsub of unsubscribers) {
        try { unsub(); } catch (err) { logger.warn({ err }, 'unsubscribe failed during dispose'); }
      }
      unsubscribers.length = 0;
      const cmdRegistry = getCommandRegistry();
      for (const cmdName of commandNames) {
        try { cmdRegistry.unregister(cmdName); } catch (err) { logger.warn({ err, cmdName }, 'unregister command failed'); }
      }
      commandNames.length = 0;
      if (toolContainer) {
        await Promise.allSettled(pendingToolWork);
        try { await unregisterContainer(toolContainer); } catch (err) { logger.warn({ err }, 'unregister tools failed'); }
        toolContainer = undefined;
      }
      for (const cb of disposeCallbacks) {
        try { await cb(); } catch (err) { logger.warn({ err }, 'onDispose callback failed'); }
      }
      disposeCallbacks.length = 0;
    },
  };

  return { api, loaded };
}
