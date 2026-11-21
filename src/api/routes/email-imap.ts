import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { draftReply, getCategories, replyOptions, summarizeMessage } from '@/core/email';
import { imapAiRefusal, readImap } from '@/core/email/imap-mailbox';
import { upsertUserLabel } from '@/core/email/triage-labels';
import { createTasksFromSource, emailToTask } from '@/core/tasks/sourced';
import { contentRepos } from '@/db/repositories/content';
import { isAuthenticated, type Principal } from '@/security/principal';
import { mailboxOf } from '@/shared/email';

const NOT_AUTHENTICATED = { error: 'Not authenticated' };
const ID = t.Object({ id: t.String({ minLength: 1, maxLength: 64 }) });

/**
 * One IMAP / POP3 message the caller's scope reaches, and whether the
 * models may read it (protection level). `set` gets the refusal's status.
 */
async function readable(principal: Principal, id: string, set: { status?: number | string }, uses: 'everyday' | 'triage' = 'everyday') {
  const read = await readImap(contentRepos(principal), id);
  if (!read) { set.status = 404; return { error: 'Message not found' } as const; }
  const refusal = await imapAiRefusal(principal.userId, read.level, uses);
  if (refusal) { set.status = 403; return { error: refusal } as const; }
  return read.message;
}

/**
 * The AI help of the Email page (summary, reply directions, drafts, a to-do,
 * the owner's triage label) for IMAP / POP3 mail. The mail is read through
 * the caller's content scope; at protection level 3-4 it goes to local models
 * only (core/email/imap-mailbox.ts). Nothing here sends mail: a drafted reply
 * comes back as text for the compose panel, which saves it through /api/mail.
 */
export const emailImapRoutes = new Elysia({ prefix: '/email/imap' })
  .use(apiContext)

  .post('/message/:id/summarize', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const message = await readable(principal, params.id, set);
    if ('error' in message) return message;
    try { return { summary: await summarizeMessage(principal.userId, message) }; }
    catch (err) { set.status = 400; return { error: (err as Error).message }; }
  }, { params: ID, detail: { tags: ['email'] } })

  .post('/message/:id/reply-options', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const message = await readable(principal, params.id, set);
    if ('error' in message) return message;
    try { return { options: await replyOptions(principal.userId, message) }; }
    catch (err) { set.status = 400; return { error: (err as Error).message }; }
  }, { params: ID, detail: { tags: ['email'] } })

  .post('/message/:id/draft', async ({ principal, params, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const message = await readable(principal, params.id, set);
    if ('error' in message) return message;
    try { return await draftReply(principal.userId, message, body?.instruction); }
    catch (err) { set.status = 400; return { error: (err as Error).message }; }
  }, { params: ID, body: t.Object({ instruction: t.Optional(t.String({ maxLength: 500 })) }), detail: { tags: ['email'] } })

  // A to-do from the mail. No model reads it: only the subject, sender and the start of the mail are copied.
  .post('/message/:id/task', async ({ principal, params, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const read = await readImap(contentRepos(principal), params.id);
    if (!read) { set.status = 404; return { error: 'Message not found' }; }
    try {
      const [task] = await createTasksFromSource(principal, 'email', [emailToTask(read.message)]);
      return { task: { id: task.id, title: task.title, priority: task.priority } };
    } catch (err) {
      set.status = 400;
      return { error: (err as Error).message };
    }
  }, { params: ID, detail: { tags: ['email'] } })

  // The caller's own label for a mail they can read: it wins over every model from then on.
  .put('/triage/label/:id', async ({ principal, params, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return NOT_AUTHENTICATED; }
    const categories = await getCategories(principal.userId);
    if (!Object.hasOwn(categories, body.category)) { set.status = 400; return { error: `Unknown category: ${body.category}` }; }
    const read = await readImap(contentRepos(principal), params.id);
    if (!read || read.message.status !== 'received') { set.status = 404; return { error: 'Message not found' }; }
    await upsertUserLabel(principal.userId, mailboxOf(read.message), read.message, { priority: body.priority, category: body.category });
    return { ok: true };
  }, {
    params: ID,
    body: t.Object({
      priority: t.Union([t.Literal('low'), t.Literal('normal'), t.Literal('high')]),
      category: t.String({ minLength: 1, maxLength: 100 }),
    }),
    detail: { tags: ['email'] },
  });
