import { getGateway } from '../../src/core/gateway';
import { googleWorkspaceTool } from '../../src/tools/google-workspace/index';
import { getDb } from '../../src/db/index';
import { users } from '../../src/db/schema';
import { eq } from 'drizzle-orm';
import { getPermissionManager } from '../../src/security/permissions';
import { initializeVault } from '../../src/security/vault';

async function getUnreadEmails() {
  // Initialize gateway (database, redis, etc.)
  const gateway = getGateway();
  await gateway.start();

  try {
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
    await pm.setPermission(patrice.id, 'google-workspace', 'email_read', 'ALLOW');

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

    const tool = googleWorkspaceTool.getTool('gmail_search');
    if (!tool) {
      console.error('Tool gmail_search not found');
      return;
    }

    const result = await tool.execute({ query: 'is:unread', limit: 50 }, context as any);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error executing tool:', error);
  } finally {
    await gateway.stop();
  }
}

getUnreadEmails().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
