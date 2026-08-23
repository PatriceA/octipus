import { Elysia } from '@/api/http';
import { apiContext } from '@/api/context';
import { verificationEvidenceRepository } from '@/db/repositories/verification-evidence-repository';
import { scopedRepos } from '@/db/repositories/scoped';
import { isAuthenticated } from '@/security/principal';
import { coreLogger } from '@/utils/logger';

/**
 * Verification evidence — read-only view of the completion checks recorded for
 * a session (QA verdicts, schema gates, pre-verify commands). Ownership is
 * enforced via the scoped session lookup: you can only read evidence for a
 * session you own (admins keep cross-user visibility).
 */
export const verificationRoutes = new Elysia({ prefix: '/verification' })
  .use(apiContext)
  .get('/:sessionId', async ({ user, principal, params, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }
    try {
      // 404 (not 403) when the session isn't the caller's — don't reveal existence.
      const session = await scopedRepos(principal).sessions.findById(params.sessionId);
      if (!session) {
        set.status = 404;
        return { error: 'Session not found' };
      }
      const evidence = await verificationEvidenceRepository.listForSession(params.sessionId);
      const verified = await verificationEvidenceRepository.isSessionVerified(params.sessionId);
      return { sessionId: params.sessionId, verified, evidence };
    } catch (err) {
      coreLogger.error({ err, sessionId: params.sessionId }, 'Failed to read verification evidence');
      set.status = 500;
      return { error: (err as Error).message };
    }
  });
