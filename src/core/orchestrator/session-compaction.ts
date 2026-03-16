import { sessionRepository } from '@/db/repositories/session-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { compactMessagesWithSummary } from '@/utils/context-compaction';
import { coreLogger } from '@/utils/logger';
import type { SessionContext } from '@/db/schema/sessions';

const COMPACTION_MESSAGE_THRESHOLD = 20;
const COMPACTION_TOKEN_THRESHOLD = 8000;

/**
 * Check if a session needs compaction and trigger it if so.
 */
export async function maybeCompactSession(sessionId: string): Promise<void> {
  const session = await sessionRepository.findById(sessionId);
  if (!session) return;

  if (session.messageCount >= COMPACTION_MESSAGE_THRESHOLD || session.tokenCount >= COMPACTION_TOKEN_THRESHOLD) {
    await compactSessionContext(sessionId);
  }
}

/**
 * Compact a session's message history into a summary stored in session context.
 */
async function compactSessionContext(sessionId: string): Promise<void> {
  const messages = await messageRepository.findBySession(sessionId, 200, 0, ['user', 'assistant']);
  if (messages.length < 10) return;

  const agentMessages = messages.map(m => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
    timestamp: m.createdAt,
  }));

  const result = await compactMessagesWithSummary(agentMessages, {
    maxTokens: 4000,
    preserveRecentCount: 6,
  });

  const summaryMsg = result.messages.find(m => m.role === 'system' && m.content.startsWith('Summary'));
  if (summaryMsg || result.removed > 0) {
    const session = await sessionRepository.findById(sessionId);
    const existingContext = (session?.context as SessionContext) || {};
    await sessionRepository.update(sessionId, {
      context: {
        ...existingContext,
        compactedSummary: summaryMsg?.content || existingContext.compactedSummary,
      },
    });
    coreLogger.info({ sessionId, removed: result.removed }, 'Session context compacted');
  }
}
