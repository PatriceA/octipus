/** Temporary bench user — created for the live UI pass, deleted right after. */
import { eq } from 'drizzle-orm';
import { closeDb, getDb, initializeDb } from '../src/db/postgres';
import { users } from '../src/db/schema/users';
import { initializeVault } from '../src/security/vault';
import { hashPassword } from '../src/utils/crypto';

const mode = process.argv[2];
const USERNAME = 'bench-tester';
await initializeDb();
await initializeVault();

if (mode === 'create') {
  const password = process.argv[3];
  const existing = await getDb().select().from(users).where(eq(users.username, USERNAME));
  const passwordHash = await hashPassword(password);
  if (existing.length > 0) {
    await getDb().update(users).set({ passwordHash, isActive: true }).where(eq(users.username, USERNAME));
    console.log(JSON.stringify({ id: existing[0].id, username: USERNAME, reused: true }));
  } else {
    const [row] = await getDb().insert(users).values({ username: USERNAME, passwordHash, isAdmin: false, isActive: true }).returning();
    console.log(JSON.stringify({ id: row.id, username: USERNAME, reused: false }));
  }
} else if (mode === 'delete') {
  const r = await getDb().delete(users).where(eq(users.username, USERNAME)).returning({ id: users.id });
  console.log(JSON.stringify({ deleted: r.length }));
}
await closeDb();
