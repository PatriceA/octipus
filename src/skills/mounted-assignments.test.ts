import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('mounted ids can be assigned while database skill deletion still cascades', async () => {
  const db = new PGlite(); // Isolated in memory; never opens the installed database.
  try {
    await db.exec(`CREATE TABLE skills (id text PRIMARY KEY);
      CREATE TABLE skill_topic_assignments (skill_id text REFERENCES skills(id) ON DELETE CASCADE, topic text);
      INSERT INTO skills VALUES ('db-skill');
      INSERT INTO skill_topic_assignments VALUES ('db-skill', 'coding');`);
    await db.exec(await readFile(new URL('../db/migrations/0118_mounted_skill_assignments.sql', import.meta.url), 'utf8'));
    await db.exec(`INSERT INTO skill_topic_assignments VALUES ('external:claude-user:pdf:SKILL', 'research');
      DELETE FROM skills WHERE id = 'db-skill';`);
    expect((await db.query('SELECT * FROM skill_topic_assignments')).rows).toEqual([
      { skill_id: 'external:claude-user:pdf:SKILL', topic: 'research' },
    ]);
  } finally { await db.close(); }
}, 30000);
