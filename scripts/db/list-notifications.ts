import { getDb } from '../../src/db/index';
import { notifications } from '../../src/db/schema/notifications';

async function listNotifications() {
  const db = getDb();
  const allNotifications = await db.select().from(notifications).limit(20);
  console.log(JSON.stringify(allNotifications, null, 2));
}

listNotifications().catch(console.error);
