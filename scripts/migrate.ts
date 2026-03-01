import { runMigrations } from '../src/db/migrate';

runMigrations()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
