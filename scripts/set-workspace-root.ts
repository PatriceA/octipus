/**
 * One-shot: point workspace.rootPath at ~/.octipus/workspace on the running
 * server. Writes the DB setting AND publishes the Redis change event, which the
 * live process picks up via settings-service.onChange → refreshConfigKey (no
 * restart needed). External Postgres + Redis are shared, so this standalone
 * process reaches the same DB/pubsub the server uses.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConfig, loadConfig } from '../src/config';
import { getSettingsService } from '../src/config/settings-service';
import { closeDb, initializeDb } from '../src/db/postgres';
import { closeStorage, initializeStorage } from '../src/db/storage';

async function main() {
  const target = join(homedir(), '.octipus', 'workspace');

  loadConfig();
  const config = getConfig();
  const storageMode = config.storageMode || 'external';
  await initializeDb();
  initializeStorage({ mode: storageMode });

  const svc = getSettingsService();
  const before = await svc.get('workspace.rootPath');
  await svc.set('workspace.rootPath', target);
  const after = await svc.get('workspace.rootPath');

  console.log(JSON.stringify({ before, after, target }, null, 2));

  await closeDb();
  await closeStorage();
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
