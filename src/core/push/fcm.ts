import { createHash, randomUUID } from 'crypto';
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
 *
 * Appwrite Messaging is the preferred transport when the vault holds
 * `appwrite_push` (settings key `push.appwrite`): JSON with `endpoint`,
 * `projectId`, `providerId` (the project's FCM provider) and `apiKey`. The
 * Firebase service account then lives in Appwrite, not here. Each Octipus
 * user is an Appwrite user with the same id; each device token is one of its
 * push targets, created server-side so the app holds no Appwrite credential.
 */
export interface PushMessage {
  title: string;
  body?: string;
  /** Deep-link payload for the app; FCM requires string values. */
  data?: Record<string, string>;
}

const FCM_TIMEOUT_MS = 10_000;

export interface AppwritePushConfig {
  endpoint: string;
  projectId: string;
  providerId: string;
  apiKey: string;
}

export class FcmPushService {
  private tokenManager: VertexTokenManager | null = null;
  private sa: ServiceAccount | null | undefined;
  private aw: AppwritePushConfig | null | undefined;

  constructor(
    private readonly loadServiceAccount: () => Promise<ServiceAccount | null> = loadFcmServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly loadAppwrite: () => Promise<AppwritePushConfig | null> = loadAppwriteConfig,
  ) {}

  private get db() {
    return getDb();
  }

  /** Forget the cached service account (settings changed). */
  reset(): void {
    this.sa = undefined;
    this.aw = undefined;
    this.tokenManager = null;
  }

  async isConfigured(): Promise<boolean> {
    return (await this.appwrite()) !== null || (await this.serviceAccount()) !== null;
  }

  private async appwrite(): Promise<AppwritePushConfig | null> {
    if (this.aw === undefined) this.aw = await this.loadAppwrite();
    return this.aw;
  }

  private appwriteCall(cfg: AppwritePushConfig, method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(`${cfg.endpoint.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        'x-appwrite-project': cfg.projectId,
        'x-appwrite-key': cfg.apiKey,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
    });
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
   *
   * Returns null on success, or why the Appwrite push target could not be
   * created (the row is kept; the next login retries).
   */
  async register(userId: string, token: string, platform: string, deviceName?: string): Promise<string | null> {
    const [prev] = await this.db
      .select({ userId: pushTokens.userId })
      .from(pushTokens)
      .where(eq(pushTokens.token, token));
    await this.db
      .insert(pushTokens)
      .values({ userId, token, platform, deviceName })
      .onConflictDoUpdate({
        target: pushTokens.token,
        set: { userId, platform, deviceName, lastSeenAt: new Date() },
      });
    const cfg = await this.appwrite();
    if (!cfg) return null;
    const targetId = appwriteTargetId(token);
    try {
      if (prev && prev.userId !== userId) {
        await this.appwriteCall(cfg, 'DELETE', `/users/${prev.userId}/targets/${targetId}`);
      }
      // 409 = user / target already exists, which is the normal re-login case.
      const u = await this.appwriteCall(cfg, 'POST', '/users', { userId });
      if (!u.ok && u.status !== 409) return `Appwrite user: HTTP ${u.status} ${(await u.text()).slice(0, 200)}`;
      const t = await this.appwriteCall(cfg, 'POST', `/users/${userId}/targets`, {
        targetId,
        providerType: 'push',
        identifier: token,
        providerId: cfg.providerId,
        ...(deviceName ? { name: deviceName } : {}),
      });
      if (!t.ok && t.status !== 409) return `Appwrite target: HTTP ${t.status} ${(await t.text()).slice(0, 200)}`;
      return null;
    } catch (err) {
      coreLogger.warn({ err }, 'Appwrite push target registration failed');
      return `Appwrite unreachable: ${(err as Error).message}`;
    }
  }

  async unregister(userId: string, token: string): Promise<boolean> {
    // Scoped to the caller: another user's token is "not found", not deleted.
    const deleted = await this.db
      .delete(pushTokens)
      .where(and(eq(pushTokens.token, token), eq(pushTokens.userId, userId)))
      .returning({ id: pushTokens.id });
    const cfg = deleted.length ? await this.appwrite() : null;
    if (cfg) {
      await this.appwriteCall(cfg, 'DELETE', `/users/${userId}/targets/${appwriteTargetId(token)}`).catch((err) =>
        coreLogger.warn({ err }, 'Appwrite push target removal failed'),
      );
    }
    return deleted.length > 0;
  }

  /** Send to every device of `userId`. Returns the number of accepted sends. */
  async sendToUser(userId: string, message: PushMessage): Promise<number> {
    const cfg = await this.appwrite();
    if (cfg) return this.sendViaAppwrite(cfg, userId, message);
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

  private async sendViaAppwrite(cfg: AppwritePushConfig, userId: string, message: PushMessage): Promise<number> {
    const rows = await this.db.select({ token: pushTokens.token }).from(pushTokens).where(eq(pushTokens.userId, userId));
    if (rows.length === 0) return 0;
    try {
      const res = await this.appwriteCall(
        cfg,
        'POST',
        '/messaging/messages/push',
        buildAppwritePush(rows.map((r) => appwriteTargetId(r.token)), message),
      );
      if (res.ok) return rows.length;
      coreLogger.warn({ status: res.status, detail: (await res.text()).slice(0, 200) }, 'Appwrite push rejected');
    } catch (err) {
      coreLogger.warn({ err }, 'Appwrite push failed');
    }
    // ponytail: Appwrite delivers asynchronously, so dead FCM tokens are not pruned here; read the message's deliveryErrors if they pile up.
    return 0;
  }
}

/**
 * Appwrite target ids are at most 36 chars of [a-zA-Z0-9._-]; FCM tokens are
 * longer, so the id is a stable hash of the token. Exported for tests.
 */
export function appwriteTargetId(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

/** The Appwrite `createPush` body for a user's device targets. Exported for tests. */
export function buildAppwritePush(targets: string[], message: PushMessage) {
  return {
    messageId: randomUUID(),
    title: message.title,
    body: message.body ?? '',
    data: message.data ?? {},
    targets,
    priority: 'high',
  };
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

async function loadAppwriteConfig(): Promise<AppwritePushConfig | null> {
  try {
    const { getVault } = await import('@/security/vault');
    const stored = await getVault().getByName('system', 'appwrite_push');
    if (!stored) return null;
    const cfg = JSON.parse(stored) as Partial<AppwritePushConfig>;
    if (!cfg.endpoint || !cfg.projectId || !cfg.providerId || !cfg.apiKey) {
      coreLogger.warn('Appwrite push config needs endpoint, projectId, providerId and apiKey; Appwrite push disabled');
      return null;
    }
    return cfg as AppwritePushConfig;
  } catch (err) {
    coreLogger.warn({ err: (err as Error).message }, 'Appwrite push config unavailable');
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
