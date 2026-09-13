import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { pushTokens } from '@/db/schema/push-tokens';
import { parseServiceAccount, type ServiceAccount, VertexTokenManager } from '@/models/providers/vertex-token';
import { coreLogger } from '@/utils/logger';

/**
 * Push delivery to paired phones through Firebase Cloud Messaging (HTTP v1).
 *
 * Configuration is one secret: the Firebase service-account JSON, stored in
 * the vault as `fcm_service_account` (settings key `push.fcmServiceAccount`).
 * Its `project_id` names the FCM project. The OAuth2 bearer token is minted
 * with the same JWT-bearer helper Vertex uses; the `cloud-platform` scope
 * covers `messages:send`.
 *
 * Every send is best effort: a failure is logged, never thrown into the
 * approval or notification path that triggered it. Tokens FCM reports as
 * gone (`UNREGISTERED`, or 404) are deleted so a re-installed app does not
 * keep a dead row around.
 */
export interface PushMessage {
  title: string;
  body?: string;
  /** Deep-link payload for the app; FCM requires string values. */
  data?: Record<string, string>;
}

const FCM_TIMEOUT_MS = 10_000;

export class FcmPushService {
  private tokenManager: VertexTokenManager | null = null;
  private sa: ServiceAccount | null | undefined;

  constructor(
    private readonly loadServiceAccount: () => Promise<ServiceAccount | null> = loadFcmServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get db() {
    return getDb();
  }

  /** Forget the cached service account (settings changed). */
  reset(): void {
    this.sa = undefined;
    this.tokenManager = null;
  }

  async isConfigured(): Promise<boolean> {
    return (await this.serviceAccount()) !== null;
  }

  private async serviceAccount(): Promise<ServiceAccount | null> {
    if (this.sa === undefined) {
      this.sa = await this.loadServiceAccount();
      this.tokenManager = this.sa ? new VertexTokenManager(this.sa) : null;
    }
    return this.sa;
  }

  /**
   * Upsert by token. A token identifies a device, and the device belongs to
   * whoever is logged in on it: re-registering after a login as another
   * account deliberately moves the token to that account.
   */
  async register(userId: string, token: string, platform: string, deviceName?: string): Promise<void> {
    await this.db
      .insert(pushTokens)
      .values({ userId, token, platform, deviceName })
      .onConflictDoUpdate({
        target: pushTokens.token,
        set: { userId, platform, deviceName, lastSeenAt: new Date() },
      });
  }

  async unregister(userId: string, token: string): Promise<boolean> {
    // Scoped to the caller: another user's token is "not found", not deleted.
    const deleted = await this.db
      .delete(pushTokens)
      .where(and(eq(pushTokens.token, token), eq(pushTokens.userId, userId)))
      .returning({ id: pushTokens.id });
    return deleted.length > 0;
  }

  /** Send to every device of `userId`. Returns the number of accepted sends. */
  async sendToUser(userId: string, message: PushMessage): Promise<number> {
    const sa = await this.serviceAccount();
    if (!sa || !this.tokenManager) return 0;
    const rows = await this.db.select().from(pushTokens).where(eq(pushTokens.userId, userId));
    if (rows.length === 0) return 0;

    let accessToken: string;
    try {
      accessToken = await this.tokenManager.getAccessToken();
    } catch (err) {
      coreLogger.error({ err }, 'FCM: could not mint an access token');
      return 0;
    }

    const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;
    const dead: string[] = [];
    let accepted = 0;
    await Promise.all(
      rows.map(async (row) => {
        try {
          const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ message: buildFcmMessage(row.token, message) }),
            signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
          });
          if (res.ok) {
            accepted++;
            return;
          }
          const detail = await res.text().catch(() => '');
          // Only a token FCM itself reports as gone is dropped. A bare
          // INVALID_ARGUMENT also covers a malformed message body, which
          // would otherwise wipe every device of the user at once.
          if (res.status === 404 || isUnregistered(detail)) {
            dead.push(row.token);
            return;
          }
          coreLogger.warn({ status: res.status, detail: detail.slice(0, 200) }, 'FCM send rejected');
        } catch (err) {
          coreLogger.warn({ err }, 'FCM send failed');
        }
      }),
    );
    if (dead.length) {
      await this.db.delete(pushTokens).where(inArray(pushTokens.token, dead)).catch(() => undefined);
      coreLogger.info({ userId, count: dead.length }, 'FCM: removed unregistered device tokens');
    }
    return accepted;
  }
}

/** FCM v1 reports a dead token as `error.details[].errorCode === 'UNREGISTERED'`. Exported for tests. */
export function isUnregistered(body: string): boolean {
  try {
    const details = (JSON.parse(body) as { error?: { details?: Array<{ errorCode?: string }> } }).error?.details ?? [];
    return details.some((d) => d.errorCode === 'UNREGISTERED');
  } catch {
    return false;
  }
}

/** The FCM v1 message body for one device token. Exported for tests. */
export function buildFcmMessage(token: string, message: PushMessage) {
  return {
    token,
    notification: { title: message.title, ...(message.body ? { body: message.body } : {}) },
    data: message.data ?? {},
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default', 'interruption-level': 'time-sensitive' } } },
  };
}

async function loadFcmServiceAccount(): Promise<ServiceAccount | null> {
  try {
    const { getVault } = await import('@/security/vault');
    const stored = await getVault().getByName('system', 'fcm_service_account');
    if (!stored) return null;
    const sa = parseServiceAccount(stored);
    if (!sa.project_id) {
      coreLogger.warn('FCM service account JSON has no project_id; push disabled');
      return null;
    }
    return sa;
  } catch (err) {
    coreLogger.warn({ err: (err as Error).message }, 'FCM service account unavailable; push disabled');
    return null;
  }
}

let instance: FcmPushService | null = null;

export function getPushService(): FcmPushService {
  if (!instance) instance = new FcmPushService();
  return instance;
}

export function _resetPushServiceForTests(service?: FcmPushService): void {
  instance = service ?? null;
}
