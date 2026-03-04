import { getDb } from '../../src/db/index';
import { notifications } from '../../src/db/schema/notifications';
import { desc } from 'drizzle-orm';

async function listRecentNotifications() {
  const db = getDb();
  const allNotifications = await db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(20);
  console.log(JSON.stringify(allNotifications, null, 2));
}

listRecentNotifications().catch(console.error);
