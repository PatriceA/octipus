/**
 * One-shot: store a secret in the vault for the user identified by email.
 *
 *   npx tsx scripts/vault-store.ts <email> <name> <value>
 *
 * Example:
 *   npx tsx scripts/vault-store.ts patrice.allegue@gmail.com github_token "$(gh auth token)"
 *
 * Updates in place if a row with the same (user, name) already exists.
 */

import { eq } from 'drizzle-orm';
import { closeDb, getDb, initializeDb } from '@/db';
import { users } from '@/db/schema/users';
import { getVault, initializeVault } from '@/security/vault';

async function main() {
  const [email, name, value] = process.argv.slice(2);
  if (!email || !name || !value) {
    console.error('usage: npx tsx scripts/vault-store.ts <email> <name> <value>');
    process.exit(2);
  }

  await initializeDb();
  await initializeVault();
  const db = getDb();

  const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (!user) throw new Error(`user not found: ${email}`);

  const vault = getVault();
  const existing = await vault.getByName(user.id, name);
  if (existing !== null) {
    const entries = await vault.list(user.id);
    const row = entries.find((e) => e.name === name);
    if (row) {
      await vault.update(user.id, row.id, { value });
      console.log(JSON.stringify({ action: 'updated', userId: user.id, name }, null, 2));
      return;
    }
  }

  const entry = await vault.store(user.id, name, value, {
    credentialType: 'api_key',
    description: `seeded via scripts/vault-store.ts`,
  });
  console.log(
    JSON.stringify(
      { action: 'created', userId: user.id, name, id: entry.id },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => {});
  });
