import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { notifications, } from '@/db/schema/notifications';
import { coreLogger } from '@/utils/logger';

interface NotificationHandler {
  (notification: { userId: string; type: string; title: string; body?: string; metadata?: Record<string, unknown> }): void;
}

export class NotificationService {
  private get db() { return getDb(); }
  private wsHandlers: Set<NotificationHandler> = new Set();

  onNotification(handler: NotificationHandler): () => void {
    this.wsHandlers.add(handler);
    return () => this.wsHandlers.delete(handler);
  }

  async notify(
    userId: string,
    type: string,
    title: string,
    body?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.insert(notifications).values({
        userId,
        type,
        title,
        body,
        metadata: metadata || {},
      });

      // Paired phones: approvals are the interrupts a person must not miss.
      if (type.startsWith('approval')) {
        import('@/core/push/fcm')
          .then(({ getPushService }) =>
            getPushService().sendToUser(userId, {
              title,
              body,
              data: stringValues({ kind: 'approval', type, ...(metadata ?? {}) }),
            }),
          )
          .catch((err) => coreLogger.error({ err, userId, type }, 'Push delivery failed'));
      }

      // Push to WebSocket handlers
      for (const handler of this.wsHandlers) {
        try {
          handler({ userId, type, title, body, metadata });
        } catch (err) {
          coreLogger.error({ err }, 'Notification handler error');
        }
      }

      // Cross-channel delivery if configured
      const deliverTo = metadata?.deliverTo as string[] | undefined;
      if (deliverTo?.length) {
        try {
          const { getUMI } = await import('@/channels/interface');
          const umi = getUMI();
          for (const target of deliverTo) {
            const [channelType, channelId] = target.split(':');
            if (channelType && channelId && umi.isChannelAvailable(channelType as any)) {
              umi.send(channelType as any, channelId, {
                content: `${title}${body ? `\n${body}` : ''}`,
              }).catch(err => coreLogger.error({ err, target }, 'Channel delivery failed'));
            }
          }
        } catch (err) { coreLogger.error({ err }, 'silent failure in notification-service'); }
      }
    } catch (error) {
      coreLogger.error({ error, userId, type }, 'Failed to create notification');
    }
  }

  async getUnread(userId: string): Promise<typeof notifications.$inferSelect[]> {
    return this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
  }

  async getAll(userId: string, limit = 50, offset = 0) {
    return this.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async markRead(id: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ read: true })
      .where(eq(notifications.id, id));
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ read: true })
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
  }

  async getUnreadCount(userId: string): Promise<number> {
    const result = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
    return result.length;
  }
}

/** FCM data payloads must be flat string maps. */
function stringValues(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || k === 'deliverTo') continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

let instance: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!instance) {
    instance = new NotificationService();
  }
  return instance;
}
