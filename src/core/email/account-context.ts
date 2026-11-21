/**
 * Which of a user's accounts of one provider a mail request works on, when
 * they connected several (two Gmail accounts, say).
 *
 * A request names the account with `account` (its address) next to
 * `provider`. The route wraps its handler in `withMailboxAccount`, which
 * checks that the address is one of the calling user's own connected
 * accounts and then runs the handler with that choice in scope. Every
 * provider call underneath (core/email/providers.ts) asks the OAuth manager
 * for that account's token; code that runs outside a request (agents, the
 * heartbeat) has no choice in scope and gets the default account, as before.
 *
 * Why in scope and not a parameter: the mail code passes `userId` through a
 * long chain of functions to the provider call. The choice only ever picks
 * among the same user's own tokens (`getValidToken(userId, …)` takes the
 * user explicitly), so a choice in the wrong place can at worst name an
 * account that user has not connected, which fails as "not connected".
 *
 * The default account is never "selected": a request naming it is treated as
 * a request without an account, so its data stays keyed as it always was.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getOAuthManager, normalizeAccount } from '@/security/oauth';
import type { EmailProvider, MailboxKey } from '@/shared/email';

/** A non-default account of a provider. */
export interface MailboxSelection {
  provider: EmailProvider;
  account: string;
}

const scope = new AsyncLocalStorage<MailboxSelection | null>();

/** Run `fn` with this account chosen (null: the default accounts). */
export function inMailbox<T>(selection: MailboxSelection | null, fn: () => T): T {
  return scope.run(selection, fn);
}

/** The account chosen for `provider` in this request; undefined means its default account. */
export function selectedAccount(provider: EmailProvider): string | undefined {
  const s = scope.getStore();
  return s && s.provider === provider ? s.account : undefined;
}

/**
 * How data about this provider's mail is keyed (the triage training set):
 * the bare provider for the default account, as it always was, and
 * `provider:<address>` for any other, so two accounts' mail never mixes.
 */
export function mailboxKey(provider: MailboxKey): string {
  // An IMAP mailbox is its own key; only Google / Microsoft have accounts.
  if (provider !== 'google' && provider !== 'microsoft') return provider;
  const account = selectedAccount(provider);
  return account ? `${provider}:${account}` : provider;
}

/** A request named an account the user has not connected, or named it badly. */
export class MailboxAccountError extends Error {}

/**
 * The selection a request's `provider` and `account` stand for, checked
 * against the user's own connected accounts. Null: the default account (or
 * no account named).
 */
export async function resolveSelection(userId: string, provider: unknown, account: unknown): Promise<MailboxSelection | null> {
  if (account === undefined || account === null || account === '') return null;
  const address = normalizeAccount(account);
  if (!address) throw new MailboxAccountError('account must be an email address.');
  if (provider !== 'google' && provider !== 'microsoft') throw new MailboxAccountError('An account is named together with its provider ("google" or "microsoft").');
  const role = await getOAuthManager().accountRole(userId, provider, address);
  if (!role) throw new MailboxAccountError(`${address} is not one of your connected ${provider === 'google' ? 'Google' : 'Microsoft 365'} accounts.`);
  return role === 'default' ? null : { provider, account: address };
}

interface RouteContext {
  user?: { id: string } | null;
  request: Request;
  body?: unknown;
  set: { status?: number | string };
}

/**
 * Wrap a mail route handler: `account` (query string, or the JSON body) picks
 * which of the user's accounts of `provider` it works on.
 */
export function withMailboxAccount<C extends RouteContext, R>(handler: (ctx: C) => R | Promise<R>): (ctx: C) => Promise<R | { error: string }> {
  return async (ctx: C) => {
    if (!ctx.user) return handler(ctx);
    const query = new URL(ctx.request.url).searchParams;
    const body = (ctx.body && typeof ctx.body === 'object' ? ctx.body : {}) as { provider?: unknown; account?: unknown };
    const account = query.get('account') ?? body.account;
    if (account === undefined || account === null || account === '') return inMailbox(null, () => handler(ctx));
    let selection: MailboxSelection | null;
    try {
      selection = await resolveSelection(ctx.user.id, query.get('provider') ?? body.provider, account);
    } catch (err) {
      if (!(err instanceof MailboxAccountError)) throw err;
      ctx.set.status = 400;
      return { error: err.message };
    }
    return inMailbox(selection, () => handler(ctx));
  };
}
