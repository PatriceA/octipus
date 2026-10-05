/**
 * Space connectors (docs/plans/coworking-spec.md §9.5).
 *
 * A space connector is connected once by an owner and then used by the
 * space's agent for every member who may run it — the "space" hat: a GitHub
 * repository, a Jira site, a Linear workspace the team shares. Its
 * credentials are space secrets (`vault.scope = 'space'`), read and written
 * only through `spaceRepos(principal).secrets` after a membership check.
 *
 * - OAuth connectors (`ALL_CONNECTORS`) have their own connect, callback and
 *   refresh flow here: `beginSpaceConnectorAuth` puts the space in the OAuth
 *   state, `OAuthManager.exchangeCode` hands the tokens to
 *   `storeSpaceConnectorTokens`, which reads the user's ownership again, and
 *   `spaceConnectorAccessToken` refreshes under the space.
 * - GitHub is a token an owner pastes (a fine-grained token for the team's
 *   repositories); the GitHub tool hands it to `runGh` as `opts.token`.
 *
 * The values are used only inside connector code — the connector registry's
 * token getter and the GitHub tool — never through `{{secret:}}`, so a turn
 * cannot route one into a shell command or an HTTP request.
 */
import { ALL_CONNECTORS, findConnector } from '@/connectors/definitions';
import { getDb } from '@/db/postgres';
import { memberPrincipal, spaceRepos } from '@/db/repositories/space';
import type { Principal } from '@/security/principal';
import { requireCan, SpaceError } from '@/security/space-access';
import { coreLogger } from '@/utils/logger';
import { auditActor, getMembership, isSpaceArchived, type SpaceActor, writeSpaceAudit } from './service';

/** The GitHub connector: a token, not an OAuth app. */
export const GITHUB_SPACE_CONNECTOR = {
  id: 'github',
  name: 'GitHub',
  description: 'A GitHub token (fine-grained, limited to the team\'s repositories) the space\'s agent uses for gh',
} as const;

/** The secret names of a connector inside a space. */
export function spaceConnectorKeys(connectorId: string): { accessToken: string; refreshToken: string; tokenExpiry: string } {
  return {
    accessToken: `connector_${connectorId}_access_token`,
    refreshToken: `connector_${connectorId}_refresh_token`,
    tokenExpiry: `connector_${connectorId}_token_expiry`,
  };
}

export interface SpaceConnectorView {
  id: string;
  name: string;
  description: string;
  /** `oauth`: connect in a popup; `token`: an owner pastes a token. */
  kind: 'oauth' | 'token';
  connected: boolean;
  /** The owner who connected it. */
  connectedBy: string | null;
  connectedAt: string | null;
}

/** Every connector a space can have, with whether it is connected (any member reads). */
export async function listSpaceConnectors(actor: SpaceActor, workspaceId: string): Promise<SpaceConnectorView[]> {
  const principal = await memberPrincipal(actor.userId, workspaceId);
  const secrets = await spaceRepos(principal).secrets.list();
  const byName = new Map(secrets.map((s) => [s.name, s]));
  const { displayNames } = await import('@/core/session-history');
  const names = await displayNames(secrets.map((s) => s.storedBy));
  const view = (id: string, name: string, description: string, kind: SpaceConnectorView['kind']): SpaceConnectorView => {
    const row = byName.get(spaceConnectorKeys(id).accessToken);
    return {
      id, name, description, kind,
      connected: !!row,
      connectedBy: row ? names.get(row.storedBy) ?? null : null,
      connectedAt: row ? row.updatedAt.toISOString() : null,
    };
  };
  return [
    view(GITHUB_SPACE_CONNECTOR.id, GITHUB_SPACE_CONNECTOR.name, GITHUB_SPACE_CONNECTOR.description, 'token'),
    ...ALL_CONNECTORS.map((c) => view(c.id, c.name, c.description, 'oauth')),
  ];
}

/** Owners only, space open; `not_found` for a stranger. */
async function requireOwner(actor: SpaceActor, workspaceId: string): Promise<Principal> {
  requireCan(await getMembership(actor.userId, workspaceId), 'manage_space');
  if (await isSpaceArchived(workspaceId)) throw new SpaceError('archived', 'This space is archived');
  return memberPrincipal(actor.userId, workspaceId);
}

async function audit(actor: SpaceActor, workspaceId: string, connectorId: string, details: Record<string, unknown>): Promise<void> {
  await writeSpaceAudit(getDb(), {
    ...auditActor(actor),
    action: 'space_updated',
    workspaceId,
    resourceType: 'space_connector',
    resourceId: connectorId,
    details: { connectorId, ...details },
  });
}

/**
 * Connect a connector to the space (owners). GitHub takes `token`; an OAuth
 * connector returns the authorization URL its popup opens — the callback,
 * from the same browser (`browserBinding`, `src/api/oauth-browser.ts`),
 * stores the tokens (`storeSpaceConnectorTokens`).
 */
export async function connectSpaceConnector(
  actor: SpaceActor,
  workspaceId: string,
  connectorId: string,
  input: { token?: string; browserBinding: string },
): Promise<{ connected: true } | { url: string }> {
  const principal = await requireOwner(actor, workspaceId);
  if (connectorId === GITHUB_SPACE_CONNECTOR.id) {
    const token = input.token?.trim();
    if (!token) throw new SpaceError('invalid_input', 'Paste a GitHub token');
    if (/\s/.test(token) || token.length > 400) throw new SpaceError('invalid_input', 'That does not look like a GitHub token');
    await spaceRepos(principal).secrets.write(spaceConnectorKeys(connectorId).accessToken, token, 'api_key');
    await audit(actor, workspaceId, connectorId, { connected: true });
    return { connected: true };
  }
  const connector = findConnector(connectorId);
  if (!connector) throw new SpaceError('not_found', `Unknown connector: ${connectorId}`);
  if (input.token !== undefined) throw new SpaceError('invalid_input', `${connector.name} connects with OAuth, not a pasted token`);
  const { ensureConnectorClient, OAuthManager, oauthPublicUrl } = await import('@/security/oauth');
  await ensureConnectorClient(connector.id, oauthPublicUrl());
  return new OAuthManager().generateAuthorizationUrl(actor.userId, connector.id, { spaceId: workspaceId, browserBinding: input.browserBinding });
}

/**
 * The callback half of a space connector's OAuth flow: the user who started
 * it must still own the space (read now, D5); the tokens are stored under
 * the space and the connection is audited.
 */
export async function storeSpaceConnectorTokens(input: {
  userId: string;
  workspaceId: string;
  connectorId: string;
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
}): Promise<void> {
  const actor: SpaceActor = { userId: input.userId };
  const principal = await requireOwner(actor, input.workspaceId);
  const secrets = spaceRepos(principal).secrets;
  const keys = spaceConnectorKeys(input.connectorId);
  await secrets.write(keys.accessToken, input.accessToken, 'oauth_token');
  if (input.refreshToken) await secrets.write(keys.refreshToken, input.refreshToken, 'oauth_token');
  else await secrets.remove([keys.refreshToken]);
  if (input.expiresInSeconds) {
    await secrets.write(keys.tokenExpiry, new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(), 'other');
  } else {
    await secrets.remove([keys.tokenExpiry]);
  }
  await audit(actor, input.workspaceId, input.connectorId, { connected: true });
}

/** Disconnect (owners): the space's secrets of that connector are deleted. */
export async function disconnectSpaceConnector(actor: SpaceActor, workspaceId: string, connectorId: string): Promise<{ removed: number }> {
  if (connectorId !== GITHUB_SPACE_CONNECTOR.id && !findConnector(connectorId)) throw new SpaceError('not_found', `Unknown connector: ${connectorId}`);
  const principal = await requireOwner(actor, workspaceId);
  const keys = spaceConnectorKeys(connectorId);
  const removed = await spaceRepos(principal).secrets.remove([keys.accessToken, keys.refreshToken, keys.tokenExpiry]);
  if (removed > 0) await audit(actor, workspaceId, connectorId, { connected: false });
  return { removed };
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const refreshInFlight = new Map<string, Promise<string | null>>();

/**
 * A space connector's access token for connector code acting for `principal`
 * (a member in the space, role read for the turn), refreshed under the space
 * when it is about to expire. Null when the space has not connected it.
 */
export async function spaceConnectorAccessToken(principal: Principal, connectorId: string): Promise<string | null> {
  const secrets = spaceRepos(principal).secrets;
  const keys = spaceConnectorKeys(connectorId);
  const token = await secrets.read(keys.accessToken);
  if (!token) return null;
  const expiry = await secrets.read(keys.tokenExpiry);
  if (!expiry || new Date(expiry).getTime() - REFRESH_BUFFER_MS >= Date.now()) return token;

  const key = `${principal.workspaceId}:${connectorId}`;
  const running = refreshInFlight.get(key);
  if (running) return running;
  const refresh = (async () => {
    const refreshToken = await secrets.read(keys.refreshToken);
    if (!refreshToken) return null;
    const { redeemConnectorRefreshToken } = await import('@/security/oauth');
    const tokens = await redeemConnectorRefreshToken(connectorId, refreshToken, { spaceId: String(principal.workspaceId) });
    if (!tokens) return null;
    await secrets.refresh(keys.accessToken, tokens.access_token);
    if (tokens.refresh_token) await secrets.refresh(keys.refreshToken, tokens.refresh_token);
    if (tokens.expires_in) await secrets.refresh(keys.tokenExpiry, new Date(Date.now() + tokens.expires_in * 1000).toISOString());
    coreLogger.info({ spaceId: principal.workspaceId, connectorId }, 'Space connector token refreshed');
    return tokens.access_token;
  })().finally(() => refreshInFlight.delete(key));
  refreshInFlight.set(key, refresh);
  return refresh;
}

/** The space's GitHub token for `runGh`, or null when the space has none. */
export function spaceGithubToken(principal: Principal): Promise<string | null> {
  return spaceRepos(principal).secrets.read(spaceConnectorKeys(GITHUB_SPACE_CONNECTOR.id).accessToken);
}
