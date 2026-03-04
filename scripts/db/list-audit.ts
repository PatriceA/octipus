import { getDb } from '../../src/db/index';
import { auditLog } from '../../src/db/schema/audit';
import { desc } from 'drizzle-orm';

async function listAudit() {
  const db = getDb();
  const logs = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(20);
  console.log(JSON.stringify(logs, null, 2));
}

listAudit().then(() => process.exit(0)).catch(console.error);
