import { randomUUID } from 'node:crypto';
import { getCommandRegistry } from '@/core/gateway/commands';
import type { GatewayEventBus } from '@/core/gateway/event-bus';
import type { GatewayEvent } from '@/core/gateway/protocol';
import { matchesPattern } from '@/core/gateway/protocol';
import { createChildLogger } from '@/utils/logger';
import type {
  ExtensionAPI,
  ExtensionCommandDef,
  ExtensionEventHandler,
  LoadedExtension,
} from './types';

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
): { api: ExtensionAPI; loaded: LoadedExtension } {
  const logger = createChildLogger({ component: 'extension', extension: name });
  const unsubscribers: Array<() => void> = [];
  const commandNames: string[] = [];
  const disposeCallbacks: Array<() => void | Promise<void>> = [];
  let disposed = false;

  const api: ExtensionAPI = {
    name,
    logger,

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
      const registry = getCommandRegistry();
      registry.register({
        name: def.name,
        aliases: def.aliases ?? [],
        description: def.description,
        args: def.args,
        minTrustLevel: def.minTrustLevel ?? 'user',
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
      for (const cb of disposeCallbacks) {
        try { await cb(); } catch (err) { logger.warn({ err }, 'onDispose callback failed'); }
      }
      disposeCallbacks.length = 0;
    },
  };

  return { api, loaded };
}
