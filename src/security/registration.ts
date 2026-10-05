/**
 * Self-registration (`POST /api/auth/register`) and the registration modes
 * (docs/plans/coworking-spec.md §10, S6; docs/SPACES.md → Guests).
 *
 * `security.registration` decides who may create an account here:
 *
 *   - `open` — anyone;
 *   - `invite_only` — only with a valid space invite token, redeemed in the
 *     same transaction that creates the account: the account and its
 *     membership commit together, or neither does (a used-up, revoked or
 *     expired token creates no account, and a token cannot be spent on an
 *     account that then fails);
 *   - `closed` — nobody.
 *
 * The mode is checked before anything else (then the invite, then the
 * uniqueness of the username and email), so a refused caller learns nothing
 * about the accounts here. An invite token given in `open` mode is redeemed
 * too, and one that cannot be (unknown, expired, used up, revoked) fails the
 * registration with 400 `invite_invalid` rather than creating an account
 * without the membership the visitor came for: they register again without
 * it, or ask for a new link.
 *
 * The install's first account may always register (and becomes its admin):
 * an install with no account yet has no space, so no invite, and nobody to
 * create accounts. Which registration is the first is decided inside the
 * transaction, under a transaction-scoped advisory lock that serialises
 * registrations, so two racing first sign-ups cannot both become admin.
 *
 * SAML JIT, SCIM and admin-created accounts are not registrations: the IdP
 * or an admin gates them, and the mode does not apply to them.
 */
import { count, eq, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { type AcceptedInvite, acceptInviteInTx, previewInvite } from '@/core/spaces/invites';
import { getDb } from '@/db/postgres';
import { type User, users } from '@/db/schema/users';
import { SpaceError, spaceErrorStatus } from '@/security/space-access';
import { assertLocalUsername, InvalidUsernameError } from '@/security/user-kinds';
import { hashPassword } from '@/utils/crypto';
import { dbLogger } from '@/utils/logger';

export type { RegistrationMode } from '@/shared/spaces';

export type RegistrationErrorCode =
  | 'registration_closed'
  | 'invite_required'
  | 'invite_invalid'
  | 'invalid_username'
  | 'username_taken'
  | 'email_taken';

/** A registration refused; `status` is its HTTP status. */
export class RegistrationError extends Error {
  constructor(readonly code: RegistrationErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = 'RegistrationError';
  }
}

export interface RegisterOutcome {
  user: User;
  /** The space the invite token joined, when one was given and redeemed. */
  joined: AcceptedInvite | null;
}

/** Whether the install has any account of its own yet (the first registration is always open). */
export async function hasLocalAccount(): Promise<boolean> {
  const [row] = await getDb().select({ id: users.id }).from(users).where(eq(users.kind, 'local')).limit(1);
  return !!row;
}

/** Serialises registrations (first-user detection and the uniqueness checks). */
const REGISTER_LOCK = 0x6f637469;

/**
 * Create a local account under the registration mode, redeeming `inviteToken`
 * in the same transaction when given (in any mode). The caller runs
 * `afterInviteAccepted` for `joined` once this returns (committed).
 */
export async function registerUser(input: {
  username: string;
  email: string | null;
  password: string;
  inviteToken?: string | null;
}): Promise<RegisterOutcome> {
  try {
    assertLocalUsername(input.username);
  } catch (err) {
    if (err instanceof InvalidUsernameError) throw new RegistrationError('invalid_username', 400, err.message);
    throw err;
  }
  const mode = getConfig().security.registration;
  const passwordHash = await hashPassword(input.password);

  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REGISTER_LOCK})`);
    // The mode first: a refused registration learns nothing about which
    // usernames or emails exist here (no enumeration on a closed install).
    const [{ n }] = await tx.select({ n: count() }).from(users).where(eq(users.kind, 'local'));
    const isFirstUser = Number(n) === 0;
    if (!isFirstUser && mode === 'closed') {
      throw new RegistrationError('registration_closed', 403, 'Registration is closed on this install; ask an administrator for an account');
    }
    if (!isFirstUser && mode === 'invite_only' && !input.inviteToken) {
      throw new RegistrationError('invite_required', 403, 'Registration needs an invite link on this install');
    }
    // Then the invite, whatever the mode: a token that cannot be redeemed
    // fails the registration (400) before the uniqueness checks, so a made-up
    // token is no way past the mode either. Redeeming it below checks again.
    if (input.inviteToken && !(await previewInvite(input.inviteToken, tx))) throw inviteInvalid();

    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.username, input.username)).limit(1);
    if (existing) throw new RegistrationError('username_taken', 409, 'Username already exists');
    if (input.email) {
      const [byEmail] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
      if (byEmail) throw new RegistrationError('email_taken', 409, 'Email already exists');
    }

    // SAML JIT, SCIM and admins create accounts without this lock: one of
    // them taking the name meanwhile is a 409, not a 500.
    const [user] = await tx
      .insert(users)
      .values({ username: input.username, email: input.email, passwordHash, isAdmin: isFirstUser })
      .returning()
      .catch((err: unknown) => {
        const constraint = uniqueViolation(err);
        if (constraint === null) throw err;
        throw constraint.includes('email')
          ? new RegistrationError('email_taken', 409, 'Email already exists')
          : new RegistrationError('username_taken', 409, 'Username already exists');
      });

    let joined: AcceptedInvite | null = null;
    if (input.inviteToken) {
      try {
        joined = await acceptInviteInTx(tx, { userId: user.id }, input.inviteToken);
      } catch (err) {
        // The account rolls back with the refused invite.
        if (err instanceof SpaceError) {
          if (err.code === 'not_found') throw inviteInvalid();
          throw new RegistrationError('invite_invalid', spaceErrorStatus(err), err.message);
        }
        throw err;
      }
    }
    dbLogger.info({ userId: user.id, firstUser: isFirstUser, joined: joined?.workspaceId ?? null }, 'User registered');
    return { user, joined };
  });
}

function inviteInvalid(): RegistrationError {
  return new RegistrationError('invite_invalid', 400, 'This invite link is not valid any more (expired, used up or revoked); register without it, or ask for a new link');
}

/** The constraint a unique violation (`23505`) names (`''` when unnamed); null for any other error. */
function uniqueViolation(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const pg = e as { code?: unknown; constraint?: unknown };
    if (pg.code === '23505') return typeof pg.constraint === 'string' ? pg.constraint : '';
  }
  return null;
}
