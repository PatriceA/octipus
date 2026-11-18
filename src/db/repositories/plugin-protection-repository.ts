import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type Database } from '@/db/postgres';
import { pluginPackages, pluginStore } from '@/db/schema/plugin-packages';
import { kvStore } from '@/db/schema/kv';
import type { PluginProtectionApproval } from '@/shared/plugin-protection';
const schema = z
  .object({
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    connections: z
      .array(
        z
          .object({
            id: z.string(),
            origin: z.string().url(),
            pathPrefix: z.string(),
          })
          .strict(),
      )
      .max(100),
    approvedBy: z.string(),
    approvedAt: z.string(),
  })
  .strict();
const key = (name: string) => `plugin-protection:${name}`;
/** Durable policy contains target metadata, never credentials or plugin code. */
export const pluginProtectionRepository = {
  async get(name: string, db: Pick<Database, 'select'> = getDb()): Promise<PluginProtectionApproval | null> {
    const [row] = await db
      .select({ value: kvStore.value })
      .from(kvStore)
      .where(eq(kvStore.key, key(name)))
      .limit(1);
    return row ? schema.parse(JSON.parse(row.value)) : null;
  },
  async delete(name: string): Promise<void> {
    await getDb()
      .delete(kvStore)
      .where(eq(kvStore.key, key(name)));
  },
  async put(
    name: string,
    approval: PluginProtectionApproval,
    settings?: import('@/shared/record-fields').RecordData,
  ): Promise<void> {
    const value = JSON.stringify(schema.parse(approval));
    await getDb().transaction(async (tx) => {
      await tx
        .insert(kvStore)
        .values({ key: key(name), value, expiresAt: null })
        .onConflictDoUpdate({
          target: kvStore.key,
          set: { value, expiresAt: null },
        });
      if (settings)
        await tx.update(pluginPackages).set({ settings, updatedAt: new Date() }).where(eq(pluginPackages.name, name));
      // Raising is conservative. A later policy reduction must never relabel saved Internal data Public.
      await tx
        .update(pluginStore)
        .set({ protectionLevel: approval.level })
        .where(and(eq(pluginStore.packageName, name), lt(pluginStore.protectionLevel, approval.level)));
    });
  },
};
