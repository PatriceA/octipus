/**
 * Backfill model_config.topicRoles from the legacy model_config.topics[] array.
 *
 * Context: topic→model binding used to live in the per-model `topics[]` array,
 * edited from the Models page. The Topics page (W10) made `topicRoles` (a
 * `Record<topic, 'primary' | 'backup'>` per model) the single source of truth
 * and is the only place the UI now reads/writes bindings. Installs configured
 * before that switch have their assignments stranded in `topics[]` with an empty
 * `topicRoles`, so the Topics page shows every topic as unassigned.
 *
 * This one-time backfill folds `topics[]` into `topicRoles` as `primary`.
 *
 * Resolution rules (decided with the maintainer):
 *  - Legacy `topics[]` wins: `topicRoles` is rebuilt wholesale from `topics[]`,
 *    discarding any pre-existing (possibly diverged) `topicRoles` entries.
 *  - One primary per topic: if several models list the same topic, the
 *    highest-priority model wins it (ties broken by name for determinism); the
 *    losers simply don't get that topic. (Backup roles aren't inferable from the
 *    legacy array, so none are created — assign them on the Topics page.)
 *  - Idempotent: re-running produces the same result and updates nothing if the
 *    bindings already match.
 *
 * The legacy `topics[]` column is left untouched (getModelForTopic still falls
 * back to it), so this is non-destructive.
 *
 * Run: npx tsx scripts/backfill-topic-roles.ts
 */

import { getDb } from '@/db';
import { modelConfig } from '@/db/schema/models';
import { eq } from 'drizzle-orm';

async function main() {
  const db = getDb();
  const models = await db.select().from(modelConfig);

  // One primary per topic: the highest-priority claimant wins (ties by name).
  const winnerByTopic = new Map<string, string>();
  const sorted = [...models].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name),
  );
  for (const m of sorted) {
    for (const topic of m.topics ?? []) {
      if (!winnerByTopic.has(topic)) winnerByTopic.set(topic, m.name);
    }
  }

  let updated = 0;
  let unchanged = 0;
  for (const m of models) {
    // Rebuild this model's roles from the topics it owns (legacy wins wholesale).
    const next: Record<string, 'primary' | 'backup'> = {};
    for (const topic of m.topics ?? []) {
      if (winnerByTopic.get(topic) === m.name) next[topic] = 'primary';
    }

    // Key-order-independent compare so an unchanged row isn't re-written every
    // run just because JSONB returns keys in a different order than we built them.
    const canon = (o: Record<string, string>) =>
      JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
    const current = (m.topicRoles ?? {}) as Record<string, 'primary' | 'backup'>;
    if (canon(current) === canon(next)) {
      unchanged++;
      continue;
    }

    await db
      .update(modelConfig)
      .set({ topicRoles: next, updatedAt: new Date() })
      .where(eq(modelConfig.name, m.name));
    updated++;
    console.log(
      `  ${m.name}: ${JSON.stringify(current)} → ${JSON.stringify(next)}`,
    );
  }

  console.log(`\nBackfill complete: ${updated} updated, ${unchanged} unchanged.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
