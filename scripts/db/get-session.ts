import { getDb } from '../../src/db/index';
import { sessions } from '../../src/db/schema';
import { eq } from 'drizzle-orm';

async function getSession() {
  const db = getDb();
  const session = await db.select().from(sessions).where(eq(sessions.id, '480dacda-91b5-433a-97ec-0b21613dc0dc'));
  console.log(JSON.stringify(session, null, 2));
}

getSession().then(() => process.exit(0)).catch(console.error);
