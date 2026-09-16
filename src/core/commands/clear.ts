import { sessionRepository } from '@/db/repositories/session-repository';
import { registerCommand } from './registry';

registerCommand({
  name: 'clear',
  description: 'Clear conversation context and start fresh',
  async execute(ctx) {
    await sessionRepository.clearContext(ctx.sessionId);
    return { response: 'Session context cleared. Send a new message to start fresh.' };
  },
});
