import { googleWorkspaceTool } from '../../src/tools/google-workspace/index';
import { getDb } from '../../src/db/index';
import { users } from '../../src/db/schema';
import { eq } from 'drizzle-orm';
import { getPermissionManager } from '../../src/security/permissions';
import { initializeVault } from '../../src/security/vault';

async function getCalendarEvents() {
  const db = getDb();
  const patrice = await db.query.users.findFirst({
    where: eq(users.username, 'Patrice')
  });

  if (!patrice) {
    console.error('User Patrice not found');
    return;
  }

  // Initialize vault
  await initializeVault();

  // Set permission to ALLOW for the script execution
  const pm = getPermissionManager();
  await pm.setPermission(patrice.id, 'google-workspace', 'calendar_read', 'ALLOW');

  // Initialize the skill (registers tools)
  await googleWorkspaceTool.initialize();

  const context = {
    id: 'script-' + Date.now(),
    userId: patrice.id,
    sessionId: 'internal-script',
    topic: 'internal',
    model: 'internal',
    role: 'admin',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Get today's date range
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  // Format as ISO 8601
  const startISO = start.toISOString();
  const endISO = end.toISOString();

  const tool = googleWorkspaceTool.getTool('calendar_events');
  if (!tool) {
    console.error('Tool calendar_events not found');
    return;
  }

  try {
    const result = await tool.execute(
      {
        calendarId: 'primary',
        start: startISO,
        end: endISO,
        limit: 100
      },
      context as any
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error executing tool:', error);
  }
}

getCalendarEvents().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
