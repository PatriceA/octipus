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
import { activateExtensionProvider, buildExtensionProviderRows, deactivateExtensionProvider } from './providers';

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
 * registered, in reverse registration order (the last registration is undone
 * first, as with nested effects), so a teardown never sees a dependency
 * registered before it already gone.
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
  /** Every registration's undo, in registration order; dispose runs them in reverse. */
  const disposers: Array<{ what: string; run: () => void | Promise<void> }> = [];
  let disposed = false;
  let toolContainer: ExtensionToolContainer | undefined;
  const pendingToolWork: Promise<void>[] = [];
  let toolRegistrationError: string | undefined;
  /** Provider id -> its live row names (empty while its checks run). */
  const providers = new Map<string, string[]>();

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
      disposers.push({ what: `on(${pattern})`, run: unsub });
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
      disposers.push({ what: `command /${def.name}`, run: () => { registry.unregister(def.name); } });
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
      disposers.push({ what: 'onDispose callback', run: fn });
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
      disposers.push({ what: `hook ${event}`, run: off });
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
        disposers.push({
          what: `tool group ${container.id}`,
          run: async () => {
            await Promise.allSettled(pendingToolWork);
            if (toolContainer !== container) return;
            toolContainer = undefined;
            await unregisterContainer(container);
          },
        });
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

    registerProvider(input) {
      if (disposed) {
        logger.warn(`registerProvider(${input?.id}) ignored — extension already disposed`);
        return Promise.resolve(() => {});
      }
      if (!trusted) {
        throw new Error(`extension "${name}" may not register providers: it is not listed in extensions.trusted (${entryPath})`);
      }
      // One private copy, validated and used from here on: the extension
      // cannot change the definition (or answer differently from a getter)
      // between a check and its use.
      let def: typeof input;
      try {
        def = structuredClone(input);
      } catch (err) {
        logger.warn({ err }, 'registerProvider refused: the definition is not plain data');
        throw new Error(`extension "${name}" registerProvider: the definition must be plain data (${err instanceof Error ? err.message : String(err)})`);
      }
      let built: ReturnType<typeof buildExtensionProviderRows>;
      try {
        built = buildExtensionProviderRows(name, def);
        if (providers.has(def.id)) throw new Error(`extension "${name}" registerProvider: id '${def.id}' is already registered`);
      } catch (err) {
        logger.warn({ err, provider: def?.id }, 'registerProvider refused');
        throw err;
      }
      const { providerId, entries } = built;
      const id = def.id;
      providers.set(id, []);
      const unregister = () => {
        const names = providers.get(id);
        if (!names) return;
        providers.delete(id);
        deactivateExtensionProvider(names);
      };
      const work = activateExtensionProvider(name, entries).then(
        (names) => {
          // Disposed (or unregistered) while the checks ran: never go live.
          if (disposed || !providers.has(id)) {
            deactivateExtensionProvider(names);
            return () => {};
          }
          providers.set(id, names);
          logger.info({ provider: providerId, models: names }, 'extension registered a model provider endpoint');
          return unregister;
        },
        (err) => {
          providers.delete(id);
          // The extension may not await the promise: say it here too.
          logger.warn({ err, provider: providerId }, 'registerProvider failed; nothing was registered');
          throw err;
        },
      );
      disposers.push({
        what: `provider ${id}`,
        run: async () => {
          await work.catch(() => {});
          unregister();
        },
      });
      return work;
    },
  };

  const loaded: LoadedExtension = {
    name,
    entryPath,
    async dispose() {
      if (disposed) return;
      disposed = true;
      // Last registered, first undone; one failing undo never stops the rest.
      while (disposers.length > 0) {
        const { what, run } = disposers.pop() as (typeof disposers)[number];
        try { await run(); } catch (err) { logger.warn({ err, what }, 'dispose step failed'); }
      }
      for (const names of providers.values()) deactivateExtensionProvider(names);
      providers.clear();
    },
  };

  return { api, loaded };
}
