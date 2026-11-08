import { randomUUID } from 'node:crypto';
import { getCommandRegistry } from '@/core/gateway/commands';
import type { GatewayEventBus } from '@/core/gateway/event-bus';
import type { GatewayEvent } from '@/core/gateway/protocol';
import { matchesPattern } from '@/core/gateway/protocol';
import { createChildLogger } from '@/utils/logger';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { getAgentHooks } from '@/core/agent/hooks';
import { getConfig } from '@/config';
import type {
  ExtensionAPI,
  ExtensionCommandDef,
  ExtensionEventHandler,
  LoadedExtension,
} from './types';

/** The real path, or the path as given when it does not resolve (a deleted file is trusted by nothing). */
function real(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Whether the operator trusts this extension to hook the agent loop: its
 * entry file, or a directory containing it, is listed in `extensions.trusted`
 * (or OCTIPUS_TRUSTED_EXTENSIONS), compared by real path.
 */
export function isTrustedExtension(entryPath: string, trusted?: readonly string[]): boolean {
  const list = trusted ?? [
    ...(getConfig().extensions?.trusted ?? []),
    ...(process.env.OCTIPUS_TRUSTED_EXTENSIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  ];
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
      if (!isTrustedExtension(entryPath)) {
        throw new Error(`extension "${name}" may not hook the agent loop: it is not listed in extensions.trusted (${entryPath})`);
      }
      const off = getAgentHooks().register(event, handler);
      unsubscribers.push(off);
      logger.info({ event }, 'extension hooked the agent loop');
      return off;
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
