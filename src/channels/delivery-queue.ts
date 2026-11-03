/**
 * Outbound chat messages that failed to send are retried, not lost.
 *
 * `deliver()` sends once and reports the result. Notifications, hook results
 * and approval prompts used to log a failure and move on, so a Telegram API
 * hiccup or a Slack socket reconnecting at the wrong moment meant the message
 * never arrived — and an approval prompt that never arrives leaves a run
 * blocked with nobody aware of it.
 *
 * `deliverDurably` sends at once, exactly like `deliver`. Only when that send
 * fails on an external channel (`send_failed`: the platform, not the policy)
 * is the message written to `channel_deliveries` and retried by a flush loop
 * with backoff. A target that is not allowed is never queued: that is a
 * decision, not a failure. Out of attempts, the row is marked `failed` and the
 * user gets an in-app notification saying what did not arrive.
 *
 * At-least-once: a process that dies between the platform accepting a message
 * and the row being marked `sent` sends it again after restart. Chat APIs
 * offer no idempotency key to prevent that; a duplicate notice is the lesser
 * failure than a missing one.
 *
 * A kind can register a check (`registerDeliveryKind`): an approval prompt
 * whose request was answered in the web app meanwhile is dropped instead of
 * sent, and one that does go out is recorded so a reply in chat answers it.
 */
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type ChannelDelivery, channelDeliveries } from '@/db/schema/channel-deliveries';
import { channelLogger } from '@/utils/logger';
import { deliver, type DeliveryResult, EXTERNAL_CHANNELS, loadNotifyScope, type NotifyScope, sendResolved, type TargetResolution } from './ownership';

/** Delay before each retry, by attempt already made (1-based). The last entry repeats. */
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_200_000];
/** Sends in all, the first one included: about 38 minutes from first failure to giving up. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** A row left `sending` this long belonged to a process that died mid-flush. */
export const STALE_SENDING_MS = 5 * 60_000;
/** Finished rows are kept this long. */
export const RETENTION_MS = 7 * 24 * 60 * 60_000;
const FLUSH_BATCH = 25;
const DEFAULT_FLUSH_INTERVAL_MS = 15_000;

export interface DurableMessage {
  content: string;
  threadId?: string;
}

export interface DeliveryKind {
  /** False when the message no longer matters (an approval answered meanwhile): the row is dropped. */
  stillWanted?: (row: ChannelDelivery) => boolean | Promise<boolean>;
  /** Called after a retried send succeeds. */
  onSent?: (row: ChannelDelivery) => void | Promise<void>;
}

const kinds = new Map<string, DeliveryKind>();

/**
 * Marks rows only this process can judge (an approval lives in this process's
 * memory). A row from an earlier process is dropped, never sent: its request
 * is gone, and the prompt would ask about something nobody can answer.
 */
const PROCESS_ID = crypto.randomUUID();
const PROCESS_KEY = '__process';
/**
 * A process-local row is claimed only by the process that queued it, so a
 * second live process never drops another's approval prompt. Past this age
 * its owner is gone (approvals expire within the hour) and any process may
 * claim it, only to drop it.
 */
export const ORPHANED_LOCAL_ROW_MS = 2 * 60 * 60_000;

/** Register the checks of one kind of message. Idempotent per kind. */
export function registerDeliveryKind(kind: string, handlers: DeliveryKind): void {
  kinds.set(kind, handlers);
}

export type DurableDeliveryResult = DeliveryResult & { queued?: boolean; deliveryId?: string };

function retryDelay(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0];
}

/**
 * Send now; on a platform failure, queue the message for retry. A failed send
 * never throws: a queue write that fails leaves the plain failed result,
 * logged. Only a caller error (a scope or target of someone else) throws.
 */
export async function deliverDurably(
  userId: string,
  channelType: string,
  channelId: string,
  message: DurableMessage,
  opts: {
    kind: string;
    meta?: Record<string, unknown>;
    /** Only this process can judge the row (see PROCESS_ID). */
    processLocal?: boolean;
    /** The user's notify scope, when the caller has loaded it already. */
    scope?: NotifyScope;
    /**
     * The target, when the caller has already resolved it as allowed for this
     * user and chat: the first send goes through it. Retries resolve afresh.
     */
    resolved?: Extract<TargetResolution, { allowed: true }>;
  },
): Promise<DurableDeliveryResult> {
  if (opts.scope && opts.scope.userId !== userId) throw new Error('deliverDurably: scope belongs to another user');
  if (opts.resolved && opts.resolved.target !== `${channelType}:${channelId}`) {
    throw new Error(`deliverDurably: resolved target ${opts.resolved.target} is not ${channelType}:${channelId}`);
  }
  const result = opts.resolved
    ? await sendResolved(opts.resolved, message)
    : await deliver(opts.scope ?? await loadNotifyScope(userId), channelType, channelId, message);
  // `unresolved` is retried too: a Teams chat whose conversation is not known
  // yet may become known (the user messages the bot), and if it does not, the
  // user is told after the last attempt rather than never.
  if (result.ok || result.reason === 'not_allowed' || !EXTERNAL_CHANNELS.has(channelType)) return result;
  try {
    const [row] = await getDb().insert(channelDeliveries).values({
      userId, channelType, channelId,
      content: message.content,
      threadId: message.threadId ?? null,
      kind: opts.kind,
      meta: { ...(opts.meta ?? {}), ...(opts.processLocal ? { [PROCESS_KEY]: PROCESS_ID } : {}) },
      attempts: 1,
      lastError: result.error,
      nextAttemptAt: new Date(Date.now() + retryDelay(1)),
    }).returning({ id: channelDeliveries.id });
    channelLogger.warn(
      { userId, target: result.target, kind: opts.kind, deliveryId: row.id, error: result.error },
      'Channel send failed; queued for retry',
    );
    return { ...result, queued: true, deliveryId: row.id };
  } catch (err) {
    channelLogger.error({ err, userId, target: result.target, kind: opts.kind }, 'Channel send failed and could not be queued for retry');
    return result;
  }
}

async function finish(id: string, status: ChannelDelivery['status'], patch: Partial<ChannelDelivery> = {}): Promise<void> {
  await getDb().update(channelDeliveries)
    .set({ ...patch, status, updatedAt: new Date() })
    .where(eq(channelDeliveries.id, id));
}

/** Tell the user, in the app, that a message to one of their chats did not arrive. */
async function reportGaveUp(row: ChannelDelivery): Promise<void> {
  const { getNotificationService } = await import('@/core/notification-service');
  const preview = row.content.length > 200 ? `${row.content.slice(0, 200)}…` : row.content;
  // No deliverTo: a notice about a chat that cannot be reached is not sent to that chat.
  await getNotificationService().notify(
    row.userId,
    'channel_delivery_failed',
    `A message to ${row.channelType} could not be delivered`,
    `Tried ${row.attempts} times over ${Math.round((Date.now() - row.createdAt.getTime()) / 60_000)} minutes. Last error: ${row.lastError ?? 'unknown'}\n\n${preview}`,
    { deliveryId: row.id, channelType: row.channelType, channelId: row.channelId, kind: row.kind },
  );
}

async function attempt(row: ChannelDelivery): Promise<'sent' | 'retry' | 'failed' | 'dropped'> {
  const kind = kinds.get(row.kind);
  const owner = row.meta?.[PROCESS_KEY];
  if (owner !== undefined && owner !== PROCESS_ID) {
    // Only claimed once orphaned (ORPHANED_LOCAL_ROW_MS): its process is gone.
    await finish(row.id, 'dropped', { lastError: 'queued by a process that has ended' });
    return 'dropped';
  }
  if (kind?.stillWanted && !(await kind.stillWanted(row))) {
    await finish(row.id, 'dropped', { lastError: 'no longer wanted' });
    return 'dropped';
  }
  const result = await deliver(await loadNotifyScope(row.userId), row.channelType, row.channelId, {
    content: row.content,
    ...(row.threadId ? { threadId: row.threadId } : {}),
  });
  if (result.ok) {
    await finish(row.id, 'sent', { sentAt: new Date(), attempts: row.attempts + 1 });
    try {
      await kind?.onSent?.(row);
    } catch (err) {
      channelLogger.error({ err, deliveryId: row.id, kind: row.kind }, 'Delivery sent but its follow-up failed');
    }
    return 'sent';
  }
  if (result.reason === 'not_allowed') {
    // Unlinked or no longer approved since: a decision, not something to retry.
    await finish(row.id, 'dropped', { attempts: row.attempts + 1, lastError: result.error });
    return 'dropped';
  }
  return retryOrFail(row, result.error);
}

/** Count one more failed attempt: back off, or give up and tell the user. */
async function retryOrFail(row: ChannelDelivery, error: string): Promise<'retry' | 'failed'> {
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await finish(row.id, 'failed', { attempts, lastError: error });
    await reportGaveUp({ ...row, attempts, lastError: error });
    return 'failed';
  }
  await getDb().update(channelDeliveries).set({
    status: 'pending', attempts, lastError: error, updatedAt: new Date(),
    nextAttemptAt: new Date(Date.now() + retryDelay(attempts)),
  }).where(eq(channelDeliveries.id, row.id));
  return 'retry';
}

export interface FlushResult { sent: number; retry: number; failed: number; dropped: number }

/**
 * One pass: claim due rows (SKIP LOCKED, so two processes never send one
 * row), try each, and delete finished rows past retention.
 */
export async function flushDeliveries(): Promise<FlushResult> {
  const db = getDb();
  const out: FlushResult = { sent: 0, retry: 0, failed: 0, dropped: 0 };
  const claimed = await db.update(channelDeliveries)
    .set({ status: 'sending', updatedAt: new Date() })
    .where(inArray(channelDeliveries.id, sql`(
      SELECT id FROM channel_deliveries
      WHERE status = 'pending' AND next_attempt_at <= now()
        AND (meta->>${PROCESS_KEY} IS NULL OR meta->>${PROCESS_KEY} = ${PROCESS_ID}
             OR created_at < ${new Date(Date.now() - ORPHANED_LOCAL_ROW_MS)})
      ORDER BY next_attempt_at
      LIMIT ${FLUSH_BATCH}
      FOR UPDATE SKIP LOCKED
    )`))
    .returning();
  for (const row of claimed) {
    try {
      out[await attempt(row)]++;
    } catch (err) {
      // A check or the database failed mid-attempt: it counts as an attempt,
      // with backoff, so a row that always throws ends in `failed` and a
      // notice instead of being retried every pass forever.
      channelLogger.error({ err, deliveryId: row.id }, 'Delivery retry failed unexpectedly');
      try {
        out[await retryOrFail(row, (err as Error).message)]++;
      } catch (e) {
        channelLogger.error({ err: e, deliveryId: row.id }, 'Could not record the failed attempt; the stale-sending sweep will requeue it');
        out.retry++;
      }
    }
  }
  await db.delete(channelDeliveries).where(and(
    inArray(channelDeliveries.status, ['sent', 'failed', 'dropped']),
    lt(channelDeliveries.updatedAt, new Date(Date.now() - RETENTION_MS)),
  ));
  if (claimed.length > 0) channelLogger.info(out, 'Channel delivery retries');
  return out;
}

/** Rows a dead process left `sending` go back to `pending`. */
export async function requeueStaleSending(olderThanMs = STALE_SENDING_MS): Promise<number> {
  const rows = await getDb().update(channelDeliveries)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(and(eq(channelDeliveries.status, 'sending'), lt(channelDeliveries.updatedAt, new Date(Date.now() - olderThanMs))))
    .returning({ id: channelDeliveries.id });
  if (rows.length > 0) channelLogger.warn({ requeued: rows.length }, 'Requeued channel deliveries left mid-send by an earlier process');
  return rows.length;
}

/** Start the retry loop. Returns its stop function. */
export function startDeliveryQueue(intervalMs = DEFAULT_FLUSH_INTERVAL_MS): () => void {
  let running = false;
  const tick = async () => {
    if (running) return; // a slow pass must not overlap the next
    running = true;
    try {
      await requeueStaleSending();
      await flushDeliveries();
    } catch (err) {
      channelLogger.error({ err }, 'Channel delivery retry pass failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
