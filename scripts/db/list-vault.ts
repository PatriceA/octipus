import { getDb } from '../../src/db/index';
import { vault } from '../../src/db/schema';

async function listVault() {
  const db = getDb();
  const allVault = await db.select().from(vault);
  console.log(JSON.stringify(allVault.map(e => ({
    id: e.id,
    userId: e.userId,
    name: e.name,
    credentialType: e.credentialType,
    metadata: e.metadata
  })), null, 2));
}

listVault().catch(console.error);
