import { sessionRepository } from '@/db/repositories/session-repository';
import type { SessionContext } from '@/db/schema/sessions';
import { registerCommand } from './registry';

registerCommand({
  name: 'clear',
  description: 'Clear conversation context and start fresh',
  async execute(ctx) {
    const session = await sessionRepository.findById(ctx.sessionId);
    if (session) {
      const existing = (session.context as SessionContext) || {};
      await sessionRepository.update(ctx.sessionId, {
        context: {
          ...existing,
          compactedSummary: undefined,
          activeCommand: undefined,
          planningState: undefined,
        },
      });
    }
    return { response: 'Session context cleared. Send a new message to start fresh.' };
  },
});
