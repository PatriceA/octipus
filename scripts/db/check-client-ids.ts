import { getVault, initializeVault } from '../../src/security/vault';
import { getDb } from '../../src/db/index';
import { vault } from '../../src/db/schema';
import { eq, and } from 'drizzle-orm';

async function checkClientIds() {
  await initializeVault();
  const db = getDb();
  const v = getVault();

  const entries = await db
    .select()
    .from(vault)
    .where(and(eq(vault.name, 'google_oauth_client_id'), eq(vault.userId, 'system')));

  console.log('Found', entries.length, 'Google Client IDs');

  for (const entry of entries) {
    const val = await v.get('system', entry.id);
    console.log(`ID: ${entry.id}, Value: ${val}`);
  }
}

checkClientIds().then(() => process.exit(0)).catch(console.error);
