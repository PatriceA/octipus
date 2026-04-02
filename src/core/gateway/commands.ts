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
  /** Connection metadata — can be mutated by commands (e.g., /expert stores activeExpertId) */
  metadata?: Record<string, unknown>;
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
    description: 'Show current session status, agents, and expert',
    minTrustLevel: 'user',
    handler: async (ctx) => {
      try {
        const { getAgentManager } = await import('@/core/agent-manager');
        const agentManager = getAgentManager();
        const agents = agentManager.list();
        const running = agents.filter(a => a.status === 'running');
        const expert = ctx.metadata?.activeExpertName as string | undefined;

        let text = `Session: ${ctx.sessionId?.slice(0, 8) || 'none'}`;
        if (expert) text += `  |  Expert: ${expert}`;
        text += `\nAgents: ${running.length} running / ${agents.length} total`;

        if (running.length > 0) {
          text += '\n';
          for (const a of running) {
            const elapsed = Math.round((Date.now() - new Date(a.createdAt).getTime()) / 1000);
            text += `\n  ${a.role} (${a.model || 'default'}) — ${a.topic || 'general'} — ${elapsed}s — iter ${a.iteration}`;
          }
        }
        return { text };
      } catch {
        return { text: `Session: ${ctx.sessionId?.slice(0, 8) || 'none'}` };
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
        const { or, eq, isNull, sql } = await import('drizzle-orm');
        const db = getDb();

        // Use rawArgs for the full expert name (e.g., "Data Analyst" not just "Data")
        const expertName = ctx.rawArgs.trim();

        if (!expertName) {
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
            code: '💻', eye: '👀', search: '🔍', palette: '🎨', server: '🔧',
            shield: '🔒', database: '🗃', brain: '🧠', 'check-circle': '✅',
            'trending-up': '📈', workflow: '🔄', clipboard: '📋', 'book-open': '📖',
            mail: '📩', bot: '🤖', 'file-text': '📄', 'bar-chart': '📊',
          };
          const lines = experts.map(e => {
            const emoji = iconToEmoji[e.icon || ''] || '🤖';
            return `  ${emoji} ${e.name} — ${e.description || e.role}`;
          });
          return { text: `Available experts:\n${lines.join('\n')}\n\nUse /expert <name> to switch, /expert reset to auto-route.` };
        }

        if (expertName.toLowerCase() === 'reset') {
          if (ctx.metadata) {
            delete ctx.metadata.activeExpertId;
            delete ctx.metadata.activeExpertName;
          }
          return { text: 'Expert reset to auto-routing. Next messages will be classified automatically.' };
        }

        // Verify the expert exists
        const match = await db.select({ id: expertsTable.id, name: expertsTable.name })
          .from(expertsTable)
          .where(sql`LOWER(${expertsTable.name}) = LOWER(${expertName})`)
          .limit(1);
        if (match.length === 0) {
          return { text: `Expert "${expertName}" not found. Use /expert to list available experts.` };
        }

        // Store active expert in connection metadata
        if (ctx.metadata) {
          ctx.metadata.activeExpertId = match[0].id;
          ctx.metadata.activeExpertName = match[0].name;
        }

        return { text: `Switched to expert: ${match[0].name}. Next messages will be handled by this expert.` };
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

  registry.register({
    name: 'cost',
    aliases: [],
    description: 'Show cumulative token usage and cost for this session',
    minTrustLevel: 'user',
    handler: async (ctx) => {
      try {
        const { getCostTracker } = await import('@/models/cost-tracker');
        const costTracker = getCostTracker();
        const usage = await costTracker.getSessionStats(ctx.sessionId);
        if (!usage || (usage.totalInputTokens === 0 && usage.totalOutputTokens === 0)) {
          return { text: 'No token usage recorded for this session yet.' };
        }
        const total = usage.totalInputTokens + usage.totalOutputTokens;
        let text = `📊 Session token usage:\n  Input: ${usage.totalInputTokens.toLocaleString()} tokens\n  Output: ${usage.totalOutputTokens.toLocaleString()} tokens\n  Total: ${total.toLocaleString()} tokens\n  Requests: ${usage.requestCount}`;
        if (usage.totalCost) {
          text += `\n  Cost: $${usage.totalCost.toFixed(4)}`;
        }
        return { text };
      } catch {
        return { text: 'Token usage tracking not available.' };
      }
    },
  });

  registry.register({
    name: 'diff',
    aliases: [],
    description: 'Show git diff for workspace changes',
    minTrustLevel: 'user',
    handler: async () => {
      try {
        const { execSync } = await import('child_process');
        const { getConfig } = await import('@/config');
        const cwd = getConfig().workspace?.rootPath || process.cwd();
        const diff = execSync('git diff --stat', { cwd, timeout: 10_000, encoding: 'utf-8' });
        return { text: diff.trim() || 'No unstaged changes.' };
      } catch {
        return { text: 'Not a git repository or git not available.' };
      }
    },
  });

  registry.register({
    name: 'version',
    aliases: ['v'],
    description: 'Show assistant version and build info',
    minTrustLevel: 'user',
    handler: async () => {
      try {
        const { readFileSync } = await import('fs');
        const { resolve } = await import('path');
        const pkgPath = resolve(process.cwd(), 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        return { text: `Assistant v${pkg.version || '0.0.0'} (Bun ${Bun.version})` };
      } catch {
        return { text: `Assistant (Bun ${Bun.version})` };
      }
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
