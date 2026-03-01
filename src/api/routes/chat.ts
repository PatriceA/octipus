import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getOrchestratorService } from '@/core/orchestrator';
import { sessionRepository } from '@/db/repositories/session-repository';
import { generateId } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';

export const chatRoutes = new Elysia({ prefix: '/chat' })
  .use(apiContext)

  // Send a chat message through the orchestrator
  .post(
    '/',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      let { sessionId } = body;
      const { message, channel } = body;

      // Auto-create a session if none provided
      if (!sessionId) {
        const session = await sessionRepository.create({
          userId: user.id,
          channelType: channel || 'webchat',
          channelId: `chat-${generateId().slice(0, 8)}`,
          title: message.slice(0, 100),
        });
        sessionId = session.id;
      } else {
        // Verify session ownership
        const session = await sessionRepository.findById(sessionId);
        if (!session) {
          return { error: 'Session not found' };
        }
        if (!user.isAdmin && session.userId !== user.id) {
          return { error: 'Not authorized' };
        }
      }

      const orchestrator = getOrchestratorService();

      try {
        const result = await orchestrator.handleMessage(
          sessionId,
          user.id,
          message,
          channel,
        );

        return {
          response: result.response,
          sessionId: result.sessionId || sessionId,
          agentId: result.agentId,
          classification: result.classification,
        };
      } catch (error) {
        apiLogger.error({ error, sessionId }, 'Chat request failed');
        return {
          error: 'Failed to process message',
          details: (error as Error).message,
        };
      }
    },
    {
      body: t.Object({
        message: t.String({ minLength: 1 }),
        sessionId: t.Optional(t.String()),
        channel: t.Optional(t.String()),
      }),
      detail: { tags: ['chat'] },
    },
  )

  // Resolve an approval request
  .post(
    '/approve',
    async ({ user, body }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const orchestrator = getOrchestratorService();
      const resolved = orchestrator.resolveApproval(
        body.requestId,
        body.approved,
        body.response,
      );

      if (!resolved) {
        return { error: 'Approval request not found or already resolved' };
      }

      return { resolved: true };
    },
    {
      body: t.Object({
        requestId: t.String(),
        approved: t.Boolean(),
        response: t.Optional(t.String()),
      }),
      detail: { tags: ['chat'] },
    },
  );
