/**
 * The checks every path that deletes a user runs first.
 *
 * No route deletes users today; `userRepository.delete` calls this so a
 * future one cannot skip it. Deleting a user cascades to everything they own,
 * so the refusals here are about what the install would lose with them:
 *
 *   - an id that is not a real user (`'system'`, a username) is a bug;
 *   - the last active admin cannot be deleted: nobody would be left to
 *     manage the install.
 *
 * Shared spaces add "not the last owner of a space" here.
 */
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { users } from '@/db/schema/users';
import { requireRealUserId } from '@/security/principal';

export class UserNotDeletableError extends Error {
  constructor(readonly code: 'last_admin', message: string) {
    super(message);
    this.name = 'UserNotDeletableError';
  }
}

/** Throws when `userId` must not be deleted. A user that does not exist passes. */
export async function assertDeletable(userId: string): Promise<void> {
  requireRealUserId(userId);
  const db = getDb();
  const [user] = await db
    .select({ isAdmin: users.isAdmin, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.isAdmin || !user.isActive) return;
  const [otherAdmin] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.isActive, true), ne(users.id, userId)))
    .limit(1);
  if (!otherAdmin) {
    throw new UserNotDeletableError('last_admin', 'The last active admin cannot be deleted');
  }
}
