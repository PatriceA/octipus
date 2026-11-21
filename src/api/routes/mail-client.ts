import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { ImapMailboxError, listImap, markImap, readImap } from '@/core/email/imap-mailbox';
import { contentRepos } from '@/db/repositories/content';
import { isAuthenticated } from '@/security/principal';
import { IMAP_FOLDERS } from '@/shared/email';

const NOT_AUTHENTICATED = { error: 'Not authenticated' };

function failed(err: unknown, set: { status?: number | string }) {
  if (err instanceof ImapMailboxError) { set.status = err.status; return { error: err.message }; }
  throw err;
}

/**
 * IMAP / POP3 mailboxes in the shapes of the Email page (src/shared/email.ts),
 * so one client reads them next to Google and Microsoft mail. Reads go
 * through `contentRepos(principal)` exactly like /api/mail: personally the
 * caller's mailboxes, in a space its functional mailboxes. Drafts and sends
 * stay on /api/mail.
 */
export const mailClientRoutes = new Elysia({ prefix: '/mail/client' })
  .use(apiContext)

  .get('/messages', async ({ principal, query, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    try {
      return await listImap(contentRepos(principal), principal.userId, query.account, {
        folder: query.folder ?? 'inbox',
        q: query.q,
        unread: query.unread === 'true',
        limit: Number.parseInt(query.limit ?? '25', 10) || 25,
        pageToken: query.pageToken,
      });
    } catch (err) {
      return failed(err, set);
    }
  }, {
    query: t.Object({
      account: t.String({ maxLength: 64 }),
      folder: t.Optional(t.Union(IMAP_FOLDERS.map((f) => t.Literal(f)))),
      q: t.Optional(t.String({ maxLength: 200 })),
      unread: t.Optional(t.String({ maxLength: 5 })),
      limit: t.Optional(t.String({ maxLength: 3 })),
      pageToken: t.Optional(t.String({ maxLength: 120 })),
    }),
    detail: { tags: ['mail'] },
  })

  .get('/messages/:id', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const read = await readImap(contentRepos(principal), params.id);
    if (!read) { set.status = 404; return { error: 'Message not found' }; }
    return read.message;
  }, { params: t.Object({ id: t.String({ maxLength: 64 }) }), detail: { tags: ['mail'] } })

  // Read / unread on several messages: the only change these mailboxes take (nothing on the server changes).
  .post('/messages/batch', async ({ principal, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    return markImap(contentRepos(principal), body.ids, body.action === 'unread');
  }, {
    body: t.Object({
      ids: t.Array(t.String({ maxLength: 64 }), { minItems: 1, maxItems: 100 }),
      action: t.Union([t.Literal('read'), t.Literal('unread')]),
    }),
    detail: { tags: ['mail'] },
  });
