import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { runReaderAction } from '@/core/reader/actions';
import { fetchReaderDoc } from '@/core/reader/fetch';
import type { ReaderActionKind } from '@/core/reader/types';
import { isAuthenticated } from '@/security/principal';

const ACTIONS: ReaderActionKind[] = ['summarize', 'simplify', 'translate', 'action_items', 'ask'];

/**
 * Reader (feature #4) — fetch + extract a clean article, and run AI actions on
 * it. Read-only; fetching goes through the SSRF guard and the model only ever
 * sees the sanitized article text. Authenticated users only.
 */
export const readerRoutes = new Elysia({ prefix: '/reader' })
  .use(apiContext)

  // Fetch a URL and return a sanitized, reader-formatted ReaderDoc.
  .post(
    '/',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      try {
        return await fetchReaderDoc(body.url);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    {
      body: t.Object({ url: t.String({ minLength: 1, maxLength: 2048 }) }),
      detail: { tags: ['reader'] },
    }
  )

  // Run an AI action on a URL (fetched + extracted) or on supplied text.
  .post(
    '/action',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      if (!ACTIONS.includes(body.action as ReaderActionKind)) {
        set.status = 400;
        return { error: `Unknown action "${body.action}"` };
      }
      const action = body.action as ReaderActionKind;
      if ((action === 'translate' || action === 'ask') && !body.argument?.trim()) {
        set.status = 400;
        return { error: `Action "${action}" requires an argument (${action === 'translate' ? 'target language' : 'question'})` };
      }
      try {
        let text = body.text;
        if (!text && body.url) text = (await fetchReaderDoc(body.url)).textContent;
        if (!text?.trim()) {
          set.status = 400;
          return { error: 'Provide either a url or text to act on' };
        }
        return await runReaderAction(text, action, body.argument, user.id);
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    {
      body: t.Object({
        url: t.Optional(t.String({ maxLength: 2048 })),
        text: t.Optional(t.String({ maxLength: 100_000 })),
        action: t.String(),
        argument: t.Optional(t.String({ maxLength: 500 })),
      }),
      detail: { tags: ['reader'] },
    }
  );
