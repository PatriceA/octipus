import { coreLogger } from '@/utils/logger';
import type { ConnectionContext, TrustLevel } from './protocol';

// ── Types ─────────────────────────────────────────────────────────

export interface CommandDef {
  name: string;
  aliases: string[];
  description: string;
  args?: { name: string; required: boolean; description: string }[];
  minTrustLevel: TrustLevel;
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}

export interface CommandContext {
  userId: string;
  sessionId?: string;
  clientType: string;
  trustLevel: TrustLevel;
  args: Record<string, string>;
  rawArgs: string;
}

export interface CommandResult {
  text: string;
  ephemeral?: boolean;
}

// ── Trust Level Ordering ──────────────────────────────────────────

const TRUST_ORDER: Record<TrustLevel, number> = { agent: 0, user: 1, local: 2, system: 3 };

function hasTrust(actual: TrustLevel, required: TrustLevel): boolean {
  return TRUST_ORDER[actual] >= TRUST_ORDER[required];
}

// ── Command Registry ──────────────────────────────────────────────

export class CommandRegistry {
  private commands: Map<string, CommandDef> = new Map();
  private aliases: Map<string, string> = new Map();

  register(cmd: CommandDef): void {
    this.commands.set(cmd.name, cmd);
    for (const alias of cmd.aliases) {
      this.aliases.set(alias, cmd.name);
    }
  }

  /**
   * Parse and execute a command string (e.g., "/expert researcher").
   * Returns null if input is not a command.
   */
  async execute(input: string, ctx: Omit<CommandContext, 'args' | 'rawArgs'>): Promise<CommandResult | null> {
    if (!input.startsWith('/')) return null;

    const parts = input.slice(1).trim().split(/\s+/);
    const name = parts[0]?.toLowerCase();
    if (!name) return null;

    const rawArgs = parts.slice(1).join(' ');
    const cmdName = this.aliases.get(name) || name;
    const cmd = this.commands.get(cmdName);

    if (!cmd) {
      return { text: `Unknown command: /${name}. Use /help to see available commands.` };
    }

    if (!hasTrust(ctx.trustLevel, cmd.minTrustLevel)) {
      return { text: `Insufficient permissions for /${cmdName}.`, ephemeral: true };
    }

    // Parse positional args
    const args: Record<string, string> = {};
    if (cmd.args) {
      for (let i = 0; i < cmd.args.length; i++) {
        if (parts[i + 1]) args[cmd.args[i].name] = parts[i + 1];
      }
    }

    try {
      return await cmd.handler({ ...ctx, args, rawArgs });
    } catch (err) {
      coreLogger.error({ err, command: cmdName }, 'Command execution error');
      return { text: `Error executing /${cmdName}: ${(err as Error).message}` };
    }
  }

  /**
   * Get all commands visible to a trust level.
   */
  getAvailable(trustLevel: TrustLevel): CommandDef[] {
    return [...this.commands.values()].filter(cmd => hasTrust(trustLevel, cmd.minTrustLevel));
  }
}

// ── Built-in Commands ─────────────────────────────────────────────

export function registerBuiltinCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'List available commands',
    minTrustLevel: 'user',
    handler: async (ctx) => {
      const cmds = registry.getAvailable(ctx.trustLevel);
      const lines = cmds.map(c => {
        const aliasStr = c.aliases.length > 0 ? ` (${c.aliases.map(a => '/' + a).join(', ')})` : '';
        return `  /${c.name}${aliasStr} — ${c.description}`;
      });
      return { text: `Available commands:\n${lines.join('\n')}` };
    },
  });

  registry.register({
    name: 'status',
    aliases: ['s'],
    description: 'Show current session status',
    minTrustLevel: 'user',
    handler: async (ctx) => {
      try {
        const { getAgentManager } = await import('@/core/agent-manager');
        const agentManager = getAgentManager();
        const running = agentManager.getRunningCount();
        return {
          text: `Session: ${ctx.sessionId || 'none'}\nRunning agents: ${running}`,
        };
      } catch {
        return { text: `Session: ${ctx.sessionId || 'none'}` };
      }
    },
  });

  registry.register({
    name: 'expert',
    aliases: ['e'],
    description: 'Switch expert or list available experts',
    args: [{ name: 'name', required: false, description: 'Expert name or "reset"' }],
    minTrustLevel: 'user',
    handler: async (ctx) => {
      try {
        const { getDb } = await import('@/db/postgres');
        const { experts: expertsTable } = await import('@/db/schema/experts');
        const { or, eq, isNull } = await import('drizzle-orm');
        const db = getDb();

        if (!ctx.args.name) {
          // List experts — only filter by userId if it's a valid UUID
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ctx.userId);
          const conditions = isUuid
            ? or(eq(expertsTable.isSystem, true), eq(expertsTable.userId, ctx.userId), isNull(expertsTable.userId))
            : or(eq(expertsTable.isSystem, true), isNull(expertsTable.userId));
          const experts = await db.select({
            name: expertsTable.name,
            icon: expertsTable.icon,
            description: expertsTable.description,
            role: expertsTable.role,
          }).from(expertsTable).where(conditions);
          const iconToEmoji: Record<string, string> = {
            code: '💻', eye: '👁️', search: '🔍', palette: '🎨', server: '⚙️',
            shield: '🛡️', database: '🗄️', brain: '🧠', 'check-circle': '✅',
            'trending-up': '📈', workflow: '🔄', clipboard: '📋', 'book-open': '📖',
            mail: '✉️', bot: '🤖', 'file-text': '📄', 'bar-chart': '📊',
          };
          const lines = experts.map(e => {
            const emoji = iconToEmoji[e.icon || ''] || '🤖';
            return `  ${emoji} ${e.name} — ${e.description || e.role}`;
          });
          return { text: `Available experts:\n${lines.join('\n')}\n\nUse /expert <name> to switch, /expert reset to auto-route.` };
        }

        if (ctx.args.name === 'reset') {
          return { text: 'Expert reset to auto-routing. Next messages will be classified automatically.' };
        }

        return { text: `Switched to expert: ${ctx.args.name}. Next messages will be handled by this expert.` };
      } catch (err) {
        return { text: `Error: ${(err as Error).message}` };
      }
    },
  });

  registry.register({
    name: 'abort',
    aliases: ['stop', 'cancel'],
    description: 'Cancel running agents',
    minTrustLevel: 'user',
    handler: async (ctx) => {
      try {
        const { getAgentManager } = await import('@/core/agent-manager');
        const agentManager = getAgentManager();
        const running = agentManager.getRunningCount();
        if (running === 0) {
          return { text: 'No running agents to stop.' };
        }
        agentManager.stopAll();
        return { text: `Stopped ${running} running agent(s).` };
      } catch {
        return { text: 'Error stopping agents.' };
      }
    },
  });

  registry.register({
    name: 'compact',
    aliases: [],
    description: 'Compact session context — summarizes history and saves to session folder',
    minTrustLevel: 'user',
    handler: async (ctx) => {
      if (!ctx.sessionId) return { text: 'No active session to compact.' };
      try {
        const { maybeCompactSession } = await import('@/core/orchestrator/session-compaction');
        await maybeCompactSession(ctx.sessionId);
        return { text: 'Session compacted. Older messages summarized, recent messages preserved.' };
      } catch (err) {
        return { text: `Compaction failed: ${(err as Error).message}` };
      }
    },
  });

  registry.register({
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear conversation display',
    minTrustLevel: 'user',
    handler: async () => {
      return { text: '[clear]' };
    },
  });

}

// ── Singleton ─────────────────────────────────────────────────────

let instance: CommandRegistry | null = null;

export function getCommandRegistry(): CommandRegistry {
  if (!instance) {
    instance = new CommandRegistry();
    registerBuiltinCommands(instance);
  }
  return instance;
}
