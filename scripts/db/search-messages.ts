import { getDb } from '../../src/db/index';
import { messages } from '../../src/db/schema';
import { ilike, or } from 'drizzle-orm';

async function searchMessages() {
  const db = getDb();
  const results = await db
    .select()
    .from(messages)
    .where(or(
      ilike(messages.content, '%email%'),
      ilike(messages.content, '%gmail%')
    ))
    .limit(20);

  console.log(JSON.stringify(results, null, 2));
}

searchMessages().catch(console.error);
