import { getDb } from '../../src/db/index';
import { messages } from '../../src/db/schema';
import { desc } from 'drizzle-orm';

async function listMessages() {
  const db = getDb();
  const msgs = await db.select().from(messages).orderBy(desc(messages.createdAt)).limit(10);
  console.log(JSON.stringify(msgs, null, 2));
}

listMessages().then(() => process.exit(0)).catch(console.error);
