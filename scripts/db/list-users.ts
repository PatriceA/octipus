import { getDb } from '../../src/db/index';
import { users } from '../../src/db/schema';

async function listUsers() {
  const db = getDb();
  const allUsers = await db.select().from(users);
  console.log(JSON.stringify(allUsers, null, 2));
}

listUsers().catch(console.error);
