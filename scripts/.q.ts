import { sql } from 'drizzle-orm';
import { closeDb, getDb, initializeDb } from '../src/db/postgres';
await initializeDb();
const r = await getDb().execute(sql.raw(process.argv[2]));
const rows = Array.isArray(r) ? r : (r as any).rows ?? [];
console.log(JSON.stringify(rows, null, 1).slice(0, 4000));
await closeDb();
