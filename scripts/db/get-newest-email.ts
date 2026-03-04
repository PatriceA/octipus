import { googleWorkspaceSkill } from '../../src/skills/google-workspace/index';
import { getDb } from '../../src/db/index';
import { users } from '../../src/db/schema';
import { eq } from 'drizzle-orm';
import { getPermissionManager } from '../../src/security/permissions';
import { initializeVault } from '../../src/security/vault';

async function getNewestEmail() {
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
  await googleWorkspaceSkill.initialize();

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

  const tool = googleWorkspaceSkill.getTool('gmail_list');
  if (!tool) {
    console.error('Tool gmail_list not found');
    return;
  }

  try {
    const result = await tool.execute({ limit: 1 }, context as any);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error executing tool:', error);
  }
}

getNewestEmail().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
