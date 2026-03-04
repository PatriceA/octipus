import { getDb } from '../../src/db/index';
import { embeddings } from '../../src/db/schema/embeddings';
import { desc } from 'drizzle-orm';

async function listEmbeddings() {
  const db = getDb();
  const allEmbeddings = await db.select().from(embeddings).orderBy(desc(embeddings.createdAt)).limit(10);
  console.log(JSON.stringify(allEmbeddings, null, 2));
}

listEmbeddings().then(() => process.exit(0)).catch(console.error);
