/**
 * Slash commands of plugin packages (docs/PLUGIN-PACKAGES.md#slash-commands):
 * `/name args` calls the package's tool as the user who typed it, with no
 * model turn. Registered on both command paths — the gateway's (TUI, web
 * command frames) and the chat path's (`handleCommand`, every channel) — as
 * `/name` and `/<package>:name`.
 *
 * A name taken by a built-in command, an extension or another package is
 * refused at install (`commandConflicts`); one taken after install (an
 * extension loaded later) is left to its owner and shown as a problem.
 */
import type { PluginCommandDecl } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';
import { actingContext, callPluginTool, expandInput } from './call';

/** Names a package command may never take: the chat path answers them itself. */
const RESERVED = new Set(['cancel']);

/** Every name a package's command is registered under. */
export function commandNames(pkg: string, decl: Pick<PluginCommandDecl, 'name'>): string[] {
  return [decl.name, `${pkg}:${decl.name}`];
}

/** Names registered by packages right now: not "taken" when the same package is reinstalled. */
const ownedBy = new Map<string, string>();

/** The command names taken by the host (built-ins and extensions), not by packages. */
async function hostCommandNames(): Promise<Set<string>> {
  const [{ getCommandRegistry }, { getAllCommands }] = await Promise.all([
    import('@/core/gateway/commands'),
    import('@/core/commands'),
  ]);
  const names = new Set<string>([...getCommandRegistry().names(), ...getAllCommands().map((c) => c.name.toLowerCase()), ...RESERVED]);
  for (const name of ownedBy.keys()) names.delete(name);
  return names;
}

/**
 * Why `pkg`'s commands cannot be installed: a name the host uses, or one
 * another installed package declares (`others`: their names and manifests).
 */
export async function commandConflicts(
  pkg: string, commands: readonly PluginCommandDecl[], others: ReadonlyArray<{ name: string; commands?: readonly PluginCommandDecl[] }>,
): Promise<string[]> {
  if (commands.length === 0) return [];
  const host = await hostCommandNames();
  const problems: string[] = [];
  for (const c of commands) {
    if (host.has(c.name)) problems.push(`commands: /${c.name} is a command of Octipus or an extension; choose another name`);
    for (const other of others) {
      if (other.name === pkg) continue;
      if ((other.commands ?? []).some((o) => o.name === c.name)) problems.push(`commands: /${c.name} is already a command of the plugin package ${other.name}`);
    }
  }
  return problems;
}

/** The answer to `/name args`, as the user who typed it. Never throws. */
async function runCommand(pkg: string, decl: PluginCommandDecl, userId: string, sessionId: string | undefined, workspaceId: string | undefined, rawArgs: string, clientType?: string): Promise<string> {
  try {
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const { channelCanPrompt } = await import('@/security/approval-policy');
    const session = sessionId ? await sessionRepository.findById(sessionId) : null;
    // A session that is not the caller's is treated as none: the call is theirs, not the session's.
    const own = session && (session.userId === userId || session.kind === 'room') ? session : null;
    const context = await actingContext({
      pkg, userId, kind: 'command',
      // A person typed it; an approval reaches them where the client can show one.
      attended: channelCanPrompt(clientType ?? own?.channelType ?? undefined),
      ...(own ? { sessionId: own.id, session: own } : workspaceId ? { workspaceId } : {}),
    });
    const { text, isError } = await callPluginTool(pkg, decl.tool, expandInput(decl.input ?? { text: '$args' }, rawArgs.trim()), context);
    if (isError) return `/${decl.name} failed: ${text || 'the tool reported an error'}`;
    return text || `/${decl.name} done.`;
  } catch (err) {
    coreLogger.warn({ err, pkg, command: decl.name }, 'Plugin command failed');
    return `/${decl.name} failed: ${(err as Error).message}`;
  }
}

/**
 * Register `pkg`'s command on both paths. Returns its disposer, or the reason
 * it was not registered (a name taken since install).
 */
export async function bindCommand(pkg: string, decl: PluginCommandDecl): Promise<{ dispose: () => void } | { problem: string }> {
  const [{ getCommandRegistry }, legacy] = await Promise.all([
    import('@/core/gateway/commands'),
    import('@/core/commands/registry'),
  ]);
  await import('@/core/commands');
  const gateway = getCommandRegistry();
  const names = commandNames(pkg, decl);
  const taken = names.filter((n) => (gateway.get(n) || legacy.getCommand(n)) && ownedBy.get(n) !== pkg);
  if (taken.length > 0) return { problem: `/${taken[0]} is taken by another command; the package's command is not registered` };

  const gatewayDefs = names.map((name) => {
    const def = {
      name, aliases: [] as string[], description: `${decl.description} (plugin ${pkg})`,
      handler: async (ctx: { userId: string; sessionId?: string; workspaceId?: string; clientType: string; rawArgs: string }) =>
        ({ text: await runCommand(pkg, decl, ctx.userId, ctx.sessionId, ctx.workspaceId, ctx.rawArgs, ctx.clientType) }),
    };
    gateway.register(def);
    return def;
  });
  const chatDefs = names.map((name) => {
    const handler = {
      name, description: `${decl.description} (plugin ${pkg})`,
      execute: async (ctx: { userId: string; sessionId: string; args: string }) =>
        ({ response: await runCommand(pkg, decl, ctx.userId, ctx.sessionId, undefined, ctx.args) }),
    };
    legacy.registerCommand(handler);
    return handler;
  });
  for (const n of names) ownedBy.set(n, pkg);
  return {
    dispose: () => {
      for (const def of gatewayDefs) if (gateway.get(def.name) === def) gateway.unregister(def.name);
      for (const handler of chatDefs) legacy.unregisterCommand(handler.name, handler);
      for (const n of names) if (ownedBy.get(n) === pkg) ownedBy.delete(n);
    },
  };
}
