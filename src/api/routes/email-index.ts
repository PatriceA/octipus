import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { mailIndexStatus, setMailIndexEnabled } from '@/core/email/mail-index';
import { isAuthenticated } from '@/security/principal';

/**
 * The owner's switch for the local index of Gmail / Outlook headers
 * (core/email/mail-index.ts, docs/MAIL.md): whether it is kept, and how far
 * each mailbox's index is. Off deletes every indexed row at once.
 */
export const emailIndexRoutes = new Elysia({ prefix: '/email' })
  .use(apiContext)
  .get('/index', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    return mailIndexStatus(user.id);
  }, { detail: { tags: ['email'] } })
  .put('/index', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    return setMailIndexEnabled(user.id, body.enabled);
  }, { body: t.Object({ enabled: t.Boolean() }), detail: { tags: ['email'] } });
