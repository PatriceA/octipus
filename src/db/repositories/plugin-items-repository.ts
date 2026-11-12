/**
 * What a plugin package created in a user's mail and calendars through the
 * host API (`plugin_items`, docs/PLUGIN-PACKAGES.md#mail-and-calendar): the
 * drafts and events it may change or send, and nothing else.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import { pluginItems } from '../schema/plugin-packages';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Exec = Db | Tx;

export type PluginItemKind = 'mail_draft' | 'calendar_event';
export type PluginItemProvider = 'mail' | 'google' | 'microsoft';

export interface PluginItemRef {
  plugin: string;
  userId: string;
  kind: PluginItemKind;
  provider: PluginItemProvider;
  itemId: string;
}

export const pluginItemsRepository = {
  /** Record that the package created an item for the user (idempotent). */
  async record(ref: PluginItemRef, db: Exec = getDb()): Promise<void> {
    await db.insert(pluginItems)
      .values({ packageName: ref.plugin, userId: ref.userId, kind: ref.kind, provider: ref.provider, itemId: ref.itemId })
      .onConflictDoNothing();
  },

  /** Whether the package created this item for this user. */
  async owns(ref: PluginItemRef, db: Exec = getDb()): Promise<boolean> {
    const [row] = await db.select({ itemId: pluginItems.itemId }).from(pluginItems).where(and(
      eq(pluginItems.packageName, ref.plugin), eq(pluginItems.userId, ref.userId), eq(pluginItems.kind, ref.kind),
      eq(pluginItems.provider, ref.provider), eq(pluginItems.itemId, ref.itemId),
    )).limit(1);
    return !!row;
  },

  /** Forget one item (it was sent or deleted). */
  async forget(ref: PluginItemRef, db: Exec = getDb()): Promise<void> {
    await db.delete(pluginItems).where(and(
      eq(pluginItems.packageName, ref.plugin), eq(pluginItems.userId, ref.userId), eq(pluginItems.kind, ref.kind),
      eq(pluginItems.provider, ref.provider), eq(pluginItems.itemId, ref.itemId),
    ));
  },

  /** Forget every item of the package (another publisher takes it over); how many. */
  async forgetPackage(pkg: string, db: Exec = getDb()): Promise<number> {
    const rows = await db.delete(pluginItems).where(eq(pluginItems.packageName, pkg)).returning({ itemId: pluginItems.itemId });
    return rows.length;
  },
};
