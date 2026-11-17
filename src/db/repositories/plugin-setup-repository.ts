import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/postgres';
import { kvStore } from '@/db/schema/kv';
import type { PluginSetupDraft } from '@/shared/plugin-setup';

const schema = z.object({
  revision: z.number().int().min(1), contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  stage: z.enum(['configure', 'review', 'installed', 'ready']), updatedAt: z.string(),
}).strict();
const keyOf = (owner: string, workspace: string | null, name: string) => `plugin-setup:${owner}:${workspace ?? 'personal'}:${name}`;

/** Drafts contain non-secret configuration only, never consent, passphrases or tokens. */
export const pluginSetupRepository = {
  async get(owner: string, workspace: string | null, name: string): Promise<PluginSetupDraft | null> {
    const [row] = await getDb().select().from(kvStore).where(eq(kvStore.key, keyOf(owner, workspace, name))).limit(1);
    if (!row || row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    return schema.parse(JSON.parse(row.value));
  },
  async save(owner: string, workspace: string | null, name: string, input: Omit<PluginSetupDraft, 'revision' | 'updatedAt'>, expectedRevision: number): Promise<PluginSetupDraft> {
    const value = schema.parse({ ...input, revision: expectedRevision + 1, updatedAt: new Date().toISOString() });
    const key = keyOf(owner, workspace, name);
    const expiresAt = new Date(Date.now() + 30 * 86400_000);
    const [row] = await getDb().insert(kvStore).values({ key, value: JSON.stringify(value), expiresAt })
      .onConflictDoUpdate({ target: kvStore.key, set: { value: JSON.stringify(value), expiresAt },
        where: sql`((${kvStore.value}::jsonb->>'revision')::int = ${expectedRevision} OR ${kvStore.expiresAt} <= now())` }).returning();
    if (!row) throw new Error('Setup changed in another window. Reload before saving.');
    return value;
  },
};
