import { initializeDb, closeDb, initializeExtensions } from '../src/db/postgres';
import { initializeStorage, closeStorage } from '../src/db/storage';
import { runMigrations } from '../src/db/migrate';

async function main() {
  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';

  // Initialize storage (needed for embedded mode)
  if (mode === 'embedded') {
    initializeStorage({ mode: 'embedded' });
  }

  // Initialize database connection
  await initializeDb();
  await initializeExtensions();

  // Run migrations
  await runMigrations();

  // Cleanup
  await closeDb();
  if (mode === 'embedded') {
    await closeStorage();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
