/**
 * Admin-managed allowlist of shared notification destinations (see
 * `src/db/schema/notification-destinations.ts` and `./ownership.ts`).
 */
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import {
  type NotificationDestination,
  notificationDestinations,
} from '@/db/schema/notification-destinations';
import { organizations } from '@/db/schema/organizations';

export interface NewDestinationInput {
  channelType: string;
  channelId: string;
  label?: string | null;
  orgId?: string | null;
  createdBy: string;
}

export async function listDestinations(): Promise<NotificationDestination[]> {
  return getDb().select().from(notificationDestinations).orderBy(desc(notificationDestinations.createdAt));
}

/**
 * Add a destination. Returns `{ conflict: true }` when the same
 * (channelType, channelId, orgId) is already listed, `{ unknownOrg: true }`
 * for an org id that does not exist.
 */
export async function addDestination(
  input: NewDestinationInput,
): Promise<{ destination: NotificationDestination } | { conflict: true } | { unknownOrg: true }> {
  const db = getDb();
  if (input.orgId) {
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, input.orgId)).limit(1);
    if (!org) return { unknownOrg: true };
  }
  const [row] = await db
    .insert(notificationDestinations)
    .values({
      channelType: input.channelType,
      channelId: input.channelId,
      label: input.label ?? null,
      orgId: input.orgId ?? null,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing()
    .returning();
  return row ? { destination: row } : { conflict: true };
}

export async function removeDestination(id: string): Promise<NotificationDestination | null> {
  const [row] = await getDb().delete(notificationDestinations).where(eq(notificationDestinations.id, id)).returning();
  return row ?? null;
}
