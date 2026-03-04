import { getDb } from '../../src/db/index';
import { messages } from '../../src/db/schema';
import { desc, eq } from 'drizzle-orm';

async function listSessionMessages() {
  const db = getDb();
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, '480dacda-91b5-433a-97ec-0b21613dc0dc'))
    .orderBy(desc(messages.createdAt));
  console.log(JSON.stringify(msgs, null, 2));
}

listSessionMessages().then(() => process.exit(0)).catch(console.error);
