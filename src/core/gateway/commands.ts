import { getCLIToolConfig } from '@/core/cli-agent-factory';
import { describeCliCapabilities } from '@/shared/cli-capabilities';
import { addPlanFeedback, formatWorkPlan } from '@/shared/work-plan';
import { workPlanRepository } from '@/db/repositories/work-plan-repository';
import { coreLogger } from '@/utils/logger';
import type { TrustLevel } from './protocol';
import { canActInSession } from '@/core/rooms/access';

// ── Types ─────────────────────────────────────────────────────────

export interface CommandDef {
  name: string;
  aliases: string[];
  description: string;
  args?: { name: string; required: boolean; description: string }[];
  /**
   * Admins only. Checked against `users.is_admin` read from the database when
   * the command runs, never against the connection's trust level or the
   * admin flag it carried at sign-in.
   */
  adminOnly?: boolean;
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}

export interface CommandContext {
  userId: string;
  sessionId?: string;
  /** The connection's workspace (resolved at auth); new sessions are created in it. */
  workspaceId?: string;
  clientType: string;
  trustLevel: TrustLevel;
  args: Record<string, string>;
  rawArgs: string;
  /** Connection metadata — commands may mutate it. */
  metadata?: Record<string, unknown>;
}

export interface CommandResult {
  text: string;
  ephemeral?: boolean;
  /** Structured form of `text` for clients that can render it (TUI session picker, transcript replay). */
  data?: unknown;
}

// ── Admin check ───────────────────────────────────────────────────

/**
 * Is `userId` an active admin right now? Read from the users row on every
 * call, so a demotion takes effect on the next command rather than on the
 * next sign-in. Gateway principals are always user ids; anything else is not
 * an admin.
 */
export async function isAdminInDatabase(userId: string): Promise<boolean> {
  const { isUuid } = await import('@/db/repositories/scoped');
  if (!isUuid(userId)) return false;
  const { userRepository } = await import('@/db/repositories/user-repository');
  const user = await userRepository.findById(userId);
  return user?.isAdmin === true && user.isActive !== false;
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
   * Remove a command and all its aliases. Used by the extension loader
   * to clean up on `/reload` and shutdown. Returns whether the command
   * was actually present.
   */
  unregister(name: string): boolean {
    const cmd = this.commands.get(name);
    if (!cmd) return false;
    this.commands.delete(name);
    for (const alias of cmd.aliases) {
      if (this.aliases.get(alias) === name) this.aliases.delete(alias);
    }
    return true;
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

    if (cmd.adminOnly && !(await isAdminInDatabase(ctx.userId))) {
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
   * Get all commands visible to a caller; admin-only ones need `isAdmin`.
   */
  getAvailable(isAdmin: boolean): CommandDef[] {
    return [...this.commands.values()].filter(cmd => !cmd.adminOnly || isAdmin);
  }
}

// ── Built-in Commands ─────────────────────────────────────────────

export function registerBuiltinCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'skills', aliases: [],
    description: 'List or select skills: /skills <id or name> always|session|auto [--global]',
    handler: async ctx => {
      const { handleSkillSelectionCommand } = await import('@/skills/selection-command');
      const userId = ctx.userId;
      // The TUI allocates its UUID before the first message. Persist that session
      // so a skill can be selected before any model starts working.
      if (ctx.sessionId && /^[0-9a-f-]{36}$/i.test(ctx.sessionId)) {
        const { resolveSession } = await import('@/core/agent/session-resolver');
        await resolveSession(ctx.sessionId, userId, ctx.clientType, ctx.workspaceId);
      }
      return { text: await handleSkillSelectionCommand(userId, ctx.sessionId, ctx.rawArgs) };
    },
  });
  for (const name of ['work-plan', 'work-plan-status', 'plan-feedback']) {
    registry.register({
      name, aliases: [],
      description: name === 'plan-feedback' ? 'Give feedback on the current work plan' : name === 'work-plan' ? 'Show the current plan, evidence, and feedback' : 'Compact work-plan progress',
      handler: async ctx => {
        // Compact status is machine-read by the TUI: empty text = no plan, error = unavailable.
        if (!ctx.sessionId) return { text: name === 'work-plan-status' ? '' : 'No active session.' };
        const userId = ctx.userId;
        // The session row is created by the first message; until then (or for
        // a session that is not the caller's) there is simply no plan.
        const state = await workPlanRepository.read(ctx.sessionId, userId)
          .catch((err: unknown) => { if ((err as Error).message === 'Session not found') return null; throw err; });
        if (!state) return { text: name === 'work-plan-status' ? '' : 'No plan yet — the session starts with your first message.' };
        if (name === 'work-plan-status') return { text: state.current ? formatWorkPlan(state, true) : '' };
        if (name !== 'plan-feedback') {
          let text = formatWorkPlan(state);
          {
            const { getAgentManager } = await import('@/core/agent-manager');
            const roots = getAgentManager().getBySession(ctx.sessionId).filter(a => a.getContext().root)
              .sort((a, b) => b.getContext().createdAt.getTime() - a.getContext().createdAt.getTime());
            const root = roots.find(a => a.getStatus() === 'running') ?? roots[0];
            const cli = root && getCLIToolConfig(root.getContext().model);
            if (cli) text += `\n\nCLI: ${describeCliCapabilities(cli)}`;
          }
          return { text };
        }
        if (!state.current) return { text: 'No plan published yet.' };
        try {
          const next = addPlanFeedback(state, state.current.id, state.revision, ctx.rawArgs);
          await workPlanRepository.save(ctx.sessionId, userId, state.revision, next);
        } catch (err) {
          // Validation and revision conflicts are user-facing, not command failures.
          return { text: err instanceof Error ? err.message : 'Feedback was not saved.' };
        }
        return { text: 'Feedback saved as pending. Running tools may finish first. If the turn has ended, send a message to continue with your feedback.' };
      },
    });
  }

  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'List available commands',
    handler: async (ctx) => {
      const cmds = registry.getAvailable(await isAdminInDatabase(ctx.userId));
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
    handler: async (ctx) => {
      try {
        const { getAgentManager } = await import('@/core/agent-manager');
        const agentManager = getAgentManager();
        // The caller's own agents only: other users' roles and topics are theirs.
        const agents = agentManager.list().filter(a => a.userId === ctx.userId);
        const running = agents.filter(a => a.status === 'running');
        let text = `Session: ${ctx.sessionId?.slice(0, 8) || 'none'}`;
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
    name: 'abort',
    aliases: ['stop', 'cancel'],
    description: 'Cancel your running agents',
    handler: async (ctx) => {
      try {
        const { getAgentManager } = await import('@/core/agent-manager');
        const agentManager = getAgentManager();
        // The caller's own agents, never every user's on the install.
        const running = agentManager.getByUser(ctx.userId).filter(a => a.getStatus() === 'running').length;
        if (running === 0) {
          return { text: 'No running agents to stop.' };
        }
        const stopped = agentManager.stopUser(ctx.userId);
        return { text: `Stopped ${stopped} running agent(s).` };
      } catch (err) {
        coreLogger.error({ err, userId: ctx.userId }, 'abort command failed');
        return { text: `Error stopping agents: ${(err as Error).message}` };
      }
    },
  });

  registry.register({
    name: 'plan',
    aliases: [],
    description: 'Toggle plan mode — explore and propose without changing anything. /plan on | off',
    handler: async (ctx) => {
      if (!ctx.sessionId) return { text: 'No active session.' };
      const { togglePlanMode } = await import('@/core/agent/plan-mode');
      const { text } = await togglePlanMode(ctx.sessionId, ctx.rawArgs);
      return { text };
    },
  });

  registry.register({
    name: 'compact',
    aliases: [],
    description: 'Compact session context — summarizes history and saves to session folder. Optional: /compact <focus instructions>',
    handler: async (ctx) => {
      const { compactSessionCommand } = await import('@/core/agent/session-compaction');
      return { text: await compactSessionCommand(ctx.sessionId, ctx.rawArgs, ctx.userId) };
    },
  });

  registry.register({
    name: 'clear',
    aliases: ['cls', 'reset'],
    description: 'Reset rootAgent context (and clear UI display on channels that support it)',
    handler: async (ctx) => {
      if (!ctx.sessionId) return { text: 'No active session.' };
      try {
        const { sessionRepository } = await import('@/db/repositories/session-repository');
        const session = await sessionRepository.findById(ctx.sessionId);
        if (!session) return { text: 'Session not found.' };

        await sessionRepository.clearContext(ctx.sessionId);

        // Channels with ephemeral transcripts (webchat, tui) wipe the UI too.
        // Persistent-transcript channels (telegram, slack, …) keep history visible
        // but the root agent will ignore anything before the clear boundary.
        const DISPLAY_CLEAR_CLIENTS = new Set(['webchat', 'tui', 'web', 'ide']);
        if (DISPLAY_CLEAR_CLIENTS.has(ctx.clientType)) {
          return { text: '[clear]' };
        }
        return {
          text: 'Context reset. Past messages stay in this chat but I will start fresh from your next message.',
        };
      } catch (err) {
        coreLogger.error({ err, sessionId: ctx.sessionId }, 'clear command failed');
        return { text: `Clear failed: ${(err as Error).message}` };
      }
    },
  });

  registry.register({
    name: 'sessions',
    aliases: [],
    description: 'List your recent sessions (TUI: /resume <n|id> reopens one)',
    handler: async (ctx) => {
      const { sessionRepository } = await import('@/db/repositories/session-repository');
      const { messageRepository } = await import('@/db/repositories/message-repository');
      const rows = await sessionRepository.listByUser(ctx.userId, 15);
      const data = await Promise.all(rows.map(async (s) => {
        // The default title is "<channel> conversation" — the first question is the useful label.
        const generic = !s.title || / conversation$/.test(s.title);
        const first = generic ? (await messageRepository.findBySession(s.id, 1, 0, ['user']))[0]?.content : undefined;
        const title = (generic ? first : s.title)?.replace(/\s+/g, ' ').trim().slice(0, 60) || s.title || s.channelType;
        return { id: s.id, title, channel: s.channelType, messages: s.messageCount, updatedAt: s.updatedAt.toISOString() };
      }));
      const text = data.length
        ? data.map((s, i) => `${String(i + 1).padStart(2)}  ${s.id.slice(0, 8)}  ${s.updatedAt.slice(0, 16).replace('T', ' ')}  ${String(s.messages).padStart(3)} msg  ${s.title}`).join('\n')
        : 'No sessions yet.';
      return { text, data };
    },
  });

  registry.register({
    name: 'history',
    aliases: [],
    description: 'Replay this session\'s conversation (last 50 messages)',
    handler: async (ctx) => {
      if (!ctx.sessionId) return { text: 'No active session.' };
      // Gate here as well as at adoption: `chat.send` also binds the connection
      // to a session, and a transcript must never follow a bare id. Owner
      // only — no trust level or admin flag reads another user's transcript.
      const { sessionRepository } = await import('@/db/repositories/session-repository');
      const session = await sessionRepository.findById(ctx.sessionId);
      if (!(await canActInSession(session, ctx.userId, 'chat'))) return { text: 'Session not found.' };
      const { messageRepository } = await import('@/db/repositories/message-repository');
      const rows = (await messageRepository.getLastMessages(ctx.sessionId, 50)).reverse();
      const data = rows
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
        .map((m) => ({ role: m.role, content: m.content, at: m.createdAt.toISOString() }));
      if (data.length === 0) return { text: 'No messages in this session yet.', data };
      return { text: data.map((m) => `${m.role === 'user' ? '❯' : ' '} ${m.content}`).join('\n\n'), data };
    },
  });

  registry.register({
    name: 'cost',
    aliases: [],
    description: 'Show cumulative token usage and cost for this session',
    handler: async (ctx) => {
      try {
        const { getCostTracker } = await import('@/models/cost-tracker');
        const costTracker = getCostTracker();
        if (!ctx.sessionId) return { text: 'No active session.' };
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
    name: 'proposals',
    aliases: ['skills-proposals'],
    description: 'Review distilled skill/expert proposals — /proposals, /proposals approve <n>, /proposals reject <n>',
    args: [
      { name: 'action', required: false, description: 'approve | reject' },
      { name: 'index', required: false, description: 'Row number from the list' },
    ],
    handler: async (ctx) => {
      const {
        approveProposal, listPendingProposals, rejectProposal,
      } = await import('@/services/skill-proposal-service');

      // Everyone, admins included, sees and acts on their own proposals only.
      const scope = ctx.userId;

      const pending = await listPendingProposals(scope);
      const action = (ctx.args.action || '').toLowerCase();

      if (!action) {
        if (pending.length === 0) return { text: 'No pending skill proposals.' };
        const lines = pending.map((p, i) =>
          `  ${i + 1}. ${p.name} (${p.kind}) — ${p.description}\n     from ${p.exemplarCount} run(s)`,
        );
        return {
          text: `Pending skill proposals:\n${lines.join('\n')}\n\n`
            + 'Approve with /proposals approve <n>, reject with /proposals reject <n>.',
        };
      }

      if (pending.length === 0) return { text: 'No pending skill proposals.' };

      if (action !== 'approve' && action !== 'reject') {
        return { text: `Unknown action "${action}". Use /proposals, /proposals approve <n>, or /proposals reject <n>.` };
      }

      // The index is positional over the SAME oldest-first list the user just
      // read, so it stays stable while nothing is resolved.
      const index = Number.parseInt(ctx.args.index ?? '', 10);
      const target = Number.isInteger(index) ? pending[index - 1] : undefined;
      if (!target) {
        return { text: `Pick a row number between 1 and ${pending.length}. Run /proposals to see the list.` };
      }

      if (action === 'approve') {
        const result = await approveProposal(target.id, { userId: scope });
        return result
          ? { text: `Approved: "${result.name}" is now a ${result.promoted}.` }
          : { text: 'That proposal is no longer pending.' };
      }

      const suppressedUntil = await rejectProposal(target.id, scope);
      return suppressedUntil
        ? { text: `Rejected "${target.name}". Suppressed until ${suppressedUntil.toISOString().slice(0, 10)}.` }
        : { text: 'That proposal is no longer pending.' };
    },
  });

  registry.register({
    name: 'mcp',
    aliases: [],
    description: 'MCP servers — /mcp for status, /mcp reconnect [server] after restarting one',
    args: [
      { name: 'action', required: false, description: 'reconnect' },
      { name: 'server', required: false, description: 'Server id or name (omit for all enabled)' },
    ],
    handler: async (ctx) => {
      // The server list (names, status, errors) is install state, and
      // reconnecting rebinds a process-wide bridge every user's agents call:
      // both need an admin — read from the database, not the connection.
      if (!(await isAdminInDatabase(ctx.userId))) {
        return { text: 'MCP server status and reconnects need an admin account.' };
      }

      const { getMCPBridge } = await import('@/mcp/bridge');
      const bridge = getMCPBridge();
      const configs = bridge.getServerConfigs();
      if (configs.length === 0) return { text: 'No MCP servers configured. Add one on the MCP page.' };

      const action = (ctx.args.action || '').toLowerCase();

      if (!action) {
        const lines = configs.map((cfg) => {
          const conn = bridge.getConnection(cfg.id);
          const status = cfg.isEnabled === false ? 'disabled' : (conn?.status ?? 'disconnected');
          const detail = conn?.status === 'connected'
            ? `${conn.tools.length} tool(s)`
            : (conn?.error ?? '');
          return `  ${statusIcon(status)} ${cfg.name} (${cfg.id}) — ${status}${detail ? ` · ${detail}` : ''}`;
        });
        return {
          text: `MCP servers:\n${lines.join('\n')}\n\nRestarted one? /mcp reconnect [server]`,
        };
      }

      if (action !== 'reconnect') {
        return { text: `Unknown action "${action}". Use /mcp or /mcp reconnect [server].` };
      }

      const wanted = (ctx.args.server || '').toLowerCase();
      const targets = wanted
        ? configs.filter((c) => c.id.toLowerCase() === wanted || c.name.toLowerCase() === wanted)
        : configs.filter((c) => c.isEnabled !== false);
      if (targets.length === 0) {
        return { text: wanted ? `No MCP server matches "${ctx.args.server}".` : 'No enabled MCP servers.' };
      }

      const { getMcpCircuitBreaker } = await import('@/mcp/circuit-breaker');
      const results: string[] = [];
      for (const server of targets) {
        // A server that was down has an open circuit and may have burned its
        // auto-reconnect attempts; a manual reconnect clears both.
        getMcpCircuitBreaker().reset(server.id);
        try {
          await bridge.disconnect(server.id);
          const conn = await bridge.connect(server);
          results.push(`  ✅ ${server.name} — ${conn.tools.length} tool(s)`);
        } catch (err) {
          results.push(`  ❌ ${server.name} — ${(err as Error).message}`);
        }
      }
      return { text: `Reconnected:\n${results.join('\n')}` };
    },
  });

  registry.register({
    name: 'diff',
    aliases: [],
    description: 'Show git diff for workspace changes',
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
    name: 'changes',
    aliases: [],
    description: 'Review git changes in the workspace — /changes for the list, /changes <path> for a file diff',
    args: [{ name: 'path', required: false, description: 'File to show a before/after diff for' }],
    handler: async (ctx) => {
      try {
        const { sessionFsAccess, WorkspaceFS } = await import('@/security/workspace-fs');
        const { agentPrincipal } = await import('@/security/principal');
        const { sessionRepository } = await import('@/db/repositories/session-repository');
        // The session's own root (its workspace, or its dev-mode project) —
        // what the agent wrote to; the connection's workspace before the
        // session exists.
        const session = ctx.sessionId ? await sessionRepository.findById(ctx.sessionId) : null;
        const fs = session && await canActInSession(session, ctx.userId, 'chat')
          ? WorkspaceFS.forSession(session, await sessionFsAccess(session, ctx.userId))
          : WorkspaceFS.forPrincipal(agentPrincipal({ userId: ctx.userId, workspaceId: ctx.workspaceId ?? null }));
        // Use rawArgs, not ctx.args.path: the registry splits input on
        // whitespace, so a path containing a space would only populate the
        // first token in args.path. rawArgs preserves the whole path.
        const path = ctx.rawArgs?.trim();

        // Per-file diff: /changes <path>
        if (path) {
          let absPath: string;
          try {
            absPath = fs.resolve(path);
          } catch (err) {
            return { text: `Invalid path: ${(err as Error).message}`, ephemeral: true };
          }
          const { getWorkspaceChangeDiff } = await import('@/core/session-changes');
          const { computeLineDiff } = await import('@/shared/diff');
          const diff = await getWorkspaceChangeDiff(fs.root, absPath);
          const { patch, added, removed } = computeLineDiff(diff.original, diff.modified);
          if (!patch.trim()) return { text: `No changes in ${diff.path}.` };
          const trunc = diff.truncated ? '\n… (file truncated before diff)' : '';
          return { text: `${diff.path}  (+${added} −${removed})\n${patch}${trunc}` };
        }

        // Listing: /changes
        const { getWorkspaceChanges } = await import('@/core/session-changes');
        const result = await getWorkspaceChanges(fs.root);
        if (!result.isGitRepo) return { text: 'Not a git repository — no changes to show.' };
        if (result.changes.length === 0) return { text: 'No changes in the workspace.' };
        const label: Record<string, string> = {
          added: 'A ', modified: 'M ', deleted: 'D ', renamed: 'R ', untracked: '??',
        };
        const lines = result.changes.map((c) => `  ${label[c.status] ?? '  '} ${c.path}`);
        const head = result.branch ? `Changes on ${result.branch}:` : 'Changes:';
        return { text: `${head}\n${lines.join('\n')}\n\nRun /changes <path> to see a file's diff.` };
      } catch (err) {
        coreLogger.error({ err, userId: ctx.userId }, 'changes command failed');
        return { text: `Failed to read changes: ${(err as Error).message}` };
      }
    },
  });

  registry.register({
    name: 'reload-extensions',
    aliases: ['reload'],
    description: 'Re-discover and reload user extensions from .octipus/extensions/',
    adminOnly: true,
    handler: async () => {
      try {
        const { getExtensionRegistry } = await import('@/extensions');
        const result = await getExtensionRegistry().reload();
        return { text: `Reloaded extensions (${result.count} active).` };
      } catch (err) {
        return { text: `Failed to reload extensions: ${(err as Error).message}` };
      }
    },
  });

  registry.register({
    name: 'persona',
    aliases: [],
    description: 'Configure the rootAgent persona — name, tone, narration, free-form facts',
    handler: async (ctx) => {
      const { handlePersonaCommand } = await import('@/core/personas/commands');
      try {
        const result = await handlePersonaCommand({ userId: ctx.userId, rawArgs: ctx.rawArgs });
        return { text: result.text };
      } catch (err) {
        return { text: `Persona command failed: ${(err as Error).message}` };
      }
    },
  });

  registry.register({
    name: 'version',
    aliases: ['v'],
    description: 'Show Octipus version and build info',
    handler: async () => {
      const { getAppVersion } = await import('@/utils/version');
      return { text: `Octipus v${getAppVersion()} (Node ${process.versions.node})` };
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

/** Status glyph for the /mcp list. */
function statusIcon(status: string): string {
  if (status === 'connected') return '✅';
  if (status === 'connecting') return '⏳';
  if (status === 'disabled') return '⏸️';
  return '❌';
}
