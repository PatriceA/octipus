import { sessionRepository } from '@/db/repositories/session-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { coreLogger } from '@/utils/logger';
import type { SessionContext } from '@/db/schema/sessions';

export interface CommandContext {
  sessionId: string;
  userId: string;
  args: string;
}

export interface CommandResult {
  response: string;
  /** If true, next messages in this session route to this command handler */
  continueCommand?: boolean;
}

export interface CommandHandler {
  name: string;
  description: string;
  execute: (ctx: CommandContext) => Promise<CommandResult>;
}

const commands = new Map<string, CommandHandler>();

export function registerCommand(handler: CommandHandler): void {
  commands.set(handler.name.toLowerCase(), handler);
}

export function getCommand(name: string): CommandHandler | undefined {
  return commands.get(name.toLowerCase());
}

export function getAllCommands(): CommandHandler[] {
  return Array.from(commands.values());
}

/**
 * Try to handle a message as a command. Returns null if not a command.
 * Persists both the user message and command response to the DB.
 */
export async function handleCommand(
  content: string,
  sessionId: string,
  userId: string,
): Promise<string | null> {
  // Check if there's an active multi-step command
  const session = await sessionRepository.findById(sessionId);
  const ctx = (session?.context as SessionContext) || {};

  if (ctx.activeCommand) {
    // Cancel takes priority
    if (content.trim().toLowerCase() === '/cancel') {
      await sessionRepository.update(sessionId, {
        context: { ...ctx, activeCommand: undefined, planningState: undefined },
      });
      const response = 'Command cancelled.';
      await persistCommandExchange(sessionId, userId, content, response);
      return response;
    }

    // Allow other slash commands to pass through during active commands
    // (e.g., /status, /help, /stop should work even mid-questionnaire)
    if (content.trim().startsWith('/')) {
      const [slashCmd] = content.trim().split(/\s+/);
      const slashName = slashCmd.toLowerCase().slice(1);
      if (slashName !== ctx.activeCommand && getCommand(slashName)) {
        // Fall through to normal slash command handling below
      } else if (slashName !== ctx.activeCommand) {
        // Unknown slash command during active command — don't feed it to the questionnaire
        const response = `Unknown command: \`${slashCmd}\`. Type \`/help\` to see available commands.\n\n_Note: \`/${ctx.activeCommand}\` is still active. Send \`/cancel\` to abort it._`;
        await persistCommandExchange(sessionId, userId, content, response);
        return response;
      } else {
        // Re-entering the same active command — route to handler
        const handler = getCommand(ctx.activeCommand);
        if (handler) {
          await messageRepository.create({ sessionId, role: 'user', content });
          const result = await handler.execute({ sessionId, userId, args: content });
          if (!result.continueCommand) {
            const freshSession = await sessionRepository.findById(sessionId);
            const freshCtx = (freshSession?.context as SessionContext) || {};
            await sessionRepository.update(sessionId, {
              context: { ...freshCtx, activeCommand: undefined },
            });
          }
          await messageRepository.create({ sessionId, role: 'assistant', content: result.response });
          return result.response;
        }
      }
    } else {
      // Non-slash message — route to active command handler
      const handler = getCommand(ctx.activeCommand);
      if (handler) {
        await messageRepository.create({ sessionId, role: 'user', content });
        const result = await handler.execute({ sessionId, userId, args: content });
        if (!result.continueCommand) {
          // Re-read session to avoid overwriting state saved by the command handler
          const freshSession = await sessionRepository.findById(sessionId);
          const freshCtx = (freshSession?.context as SessionContext) || {};
          await sessionRepository.update(sessionId, {
            context: { ...freshCtx, activeCommand: undefined },
          });
        }
        await messageRepository.create({ sessionId, role: 'assistant', content: result.response });
        return result.response;
      }
    }
  }

  // Check for new slash command
  if (!content.startsWith('/')) return null;

  const [cmd, ...rest] = content.split(/\s+/);
  const commandName = cmd.toLowerCase().slice(1); // remove /
  const handler = getCommand(commandName);

  // /cancel outside an active command — acknowledge gracefully
  if (commandName === 'cancel') {
    const response = 'Nothing to cancel.';
    await persistCommandExchange(sessionId, userId, content, response);
    return response;
  }

  if (!handler) {
    // Unknown command
    const response = `Unknown command: \`${cmd}\`. Type \`/help\` to see available commands.`;
    await persistCommandExchange(sessionId, userId, content, response);
    return response;
  }

  await messageRepository.create({ sessionId, role: 'user', content });
  const result = await handler.execute({
    sessionId,
    userId,
    args: rest.join(' '),
  });

  if (result.continueCommand) {
    // Re-read session to avoid overwriting state saved by the command handler
    const freshSession = await sessionRepository.findById(sessionId);
    const freshCtx = (freshSession?.context as SessionContext) || {};
    await sessionRepository.update(sessionId, {
      context: { ...freshCtx, activeCommand: commandName },
    });
  }

  await messageRepository.create({ sessionId, role: 'assistant', content: result.response });
  return result.response;
}

async function persistCommandExchange(
  sessionId: string,
  userId: string,
  userMessage: string,
  response: string,
): Promise<void> {
  await messageRepository.create({ sessionId, role: 'user', content: userMessage });
  await messageRepository.create({ sessionId, role: 'assistant', content: response });
}
