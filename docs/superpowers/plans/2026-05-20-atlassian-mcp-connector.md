# Atlassian MCP Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Atlassian built-in connector to Octipus that uses OAuth 2.1 + PKCE + Dynamic Client Registration to connect each user's own Atlassian account, exposing Atlassian MCP tools to agents.

**Architecture:** A new `src/connectors/` module defines built-in connectors as first-class citizens (separate from custom MCP servers in `src/mcp/`). Each connector has an OAuth flow backed by the existing `OAuthManager` pattern, a per-user `OAuthHTTPTransport` that injects bearer tokens at request time, and a `ConnectorRegistry` that generates lazy meta-tools (`connector_list_tools`, `connector_call_tool`) for agents. Connector tools are injected into agent workers alongside MCP tools using `context.userId`. The UI adds a "Connectors" tab to the existing `/mcp` page with a popup-based OAuth flow.

**Tech Stack:** Bun + Elysia (backend), Next.js 14 + React 18 + Tailwind (frontend), Drizzle + Postgres, AES-256-GCM Vault (token storage), Redis (OAuth state), Zod (validation)

---

## File Map

### New files
| File | Responsibility |
|------|----------------|
| `src/connectors/types.ts` | `ConnectorDefinition`, `UserConnectorStatus` interfaces |
| `src/connectors/oauth-http-transport.ts` | OAuth-aware stateless HTTP transport (fetches+refreshes vault token per request) |
| `src/connectors/atlassian/definition.ts` | Atlassian connector definition (endpoint, OAuth config, scopes) |
| `src/connectors/registry.ts` | `ConnectorRegistry` singleton — manages per-user connections, returns lazy tool handlers |
| `src/connectors/index.ts` | Re-exports |
| `src/connectors/registry.test.ts` | Unit tests for registry |
| `src/connectors/oauth-http-transport.test.ts` | Unit tests for transport token injection |
| `src/api/routes/connectors.ts` | REST endpoints: list, authorize, callback, disconnect, status |
| `web/components/mcp/connector-card.tsx` | Single connector card (install/connect/disconnect state) |
| `web/components/mcp/connectors-tab.tsx` | Tab rendering all connectors with popup OAuth logic |

### Modified files
| File | Change |
|------|--------|
| `src/security/oauth.ts` | Add `atlassian` provider with Dynamic Client Registration (RFC 7591) |
| `src/api/server.ts` | Register `connectorRoutes` alongside `mcpRoutes` |
| `src/core/orchestrator/worker-spawner.ts` | Inject per-user connector tool handlers after `getToolsForRole` |
| `src/core/swarm/spawner.ts` | Same injection for swarm child workers |
| `web/app/mcp/page.tsx` | Add "Connectors" tab next to the existing server list |

---

## Task 1: Connector types

**Files:**
- Create: `src/connectors/types.ts`

- [ ] **Step 1: Write the failing test**

Create `src/connectors/registry.test.ts` to validate the types compile and registry is importable:

```typescript
import { describe, expect, test } from 'bun:test';
import type { ConnectorDefinition, UserConnectorStatus } from './types';

describe('connector types', () => {
  test('ConnectorDefinition shape compiles', () => {
    const def: ConnectorDefinition = {
      id: 'test',
      name: 'Test',
      description: 'Test connector',
      logoUrl: '/logos/test.svg',
      mcpEndpoint: 'https://example.com/mcp',
      oauthScopes: ['read:me', 'offline_access'],
    };
    expect(def.id).toBe('test');
  });

  test('UserConnectorStatus shape compiles', () => {
    const status: UserConnectorStatus = {
      connectorId: 'test',
      connected: false,
    };
    expect(status.connected).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — verify it fails (import missing)**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/registry.test.ts
```

Expected: error `Cannot find module './types'`

- [ ] **Step 3: Create the types file**

```typescript
// src/connectors/types.ts
export interface ConnectorDefinition {
  id: string;
  name: string;
  description: string;
  logoUrl: string;
  /** Full MCP endpoint URL, e.g. https://mcp.atlassian.com/v1/mcp/authv2 */
  mcpEndpoint: string;
  /** OAuth 2.1 scopes to request */
  oauthScopes: string[];
}

export interface UserConnectorStatus {
  connectorId: string;
  connected: boolean;
  /** ISO timestamp; present when connected */
  connectedAt?: string;
  /** Error message from last connection attempt */
  error?: string;
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/registry.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add src/connectors/types.ts src/connectors/registry.test.ts && git commit -m "feat(connectors): add connector types"
```

---

## Task 2: OAuth HTTP transport

This transport is used by the ConnectorRegistry to make per-user MCP calls. It fetches the user's OAuth token from vault before each request and refreshes if expired.

**Files:**
- Create: `src/connectors/oauth-http-transport.ts`
- Create: `src/connectors/oauth-http-transport.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/connectors/oauth-http-transport.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { OAuthHTTPTransport } from './oauth-http-transport';

describe('OAuthHTTPTransport', () => {
  test('injects Authorization header into POST', async () => {
    const requests: Request[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (req: Request | string) => {
      const r = req instanceof Request ? req : new Request(req);
      requests.push(r);
      return new Response(JSON.stringify({ id: 1, result: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const getToken = mock(async () => 'test-token-abc');
    const transport = new OAuthHTTPTransport('https://example.com/mcp', getToken);
    await transport.connect();

    let received: string | undefined;
    transport.onMessage((msg) => { received = msg; });

    transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test', params: {} }));
    await new Promise((r) => setTimeout(r, 20));

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get('Authorization')).toBe('Bearer test-token-abc');
    expect(received).toBeDefined();
    globalThis.fetch = origFetch;
  });

  test('calls getToken once per send', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ id: 1, result: {} }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const getToken = mock(async () => 'tok');
    const transport = new OAuthHTTPTransport('https://example.com/mcp', getToken);
    await transport.connect();
    transport.onMessage(() => {});
    transport.send('{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}');
    transport.send('{"jsonrpc":"2.0","id":2,"method":"pong","params":{}}');
    await new Promise((r) => setTimeout(r, 20));
    expect(getToken).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/oauth-http-transport.test.ts
```

Expected: FAIL `Cannot find module './oauth-http-transport'`

- [ ] **Step 3: Implement OAuthHTTPTransport**

```typescript
// src/connectors/oauth-http-transport.ts
import type { MCPTransport } from '@/mcp/transports/interface';

type MessageHandler = (data: string) => void;
type ErrorHandler = (err: Error) => void;
type CloseHandler = () => void;

/**
 * Stateless HTTP transport for remote MCP servers requiring OAuth 2.1.
 * `getToken` is called before every POST — callers should handle refresh internally.
 */
export class OAuthHTTPTransport implements MCPTransport {
  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private closeHandlers: CloseHandler[] = [];
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly getToken: () => Promise<string>,
  ) {}

  async connect(): Promise<void> {
    // Stateless — readiness is confirmed by the first successful POST.
  }

  send(message: string): void {
    if (this.closed) return;
    this.doPost(message).catch((err) => {
      for (const h of this.errorHandlers) h(err as Error);
    });
  }

  private async doPost(message: string): Promise<void> {
    const token = await this.getToken();

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: message,
      });
    } catch (err) {
      throw new Error(`MCP POST to ${this.url} failed: ${(err as Error).message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`MCP POST to ${this.url} failed (${response.status}): ${body || response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      await this.parseSSEResponse(response);
    } else {
      const text = await response.text();
      if (text.trim()) {
        for (const h of this.messageHandlers) h(text);
      }
    }
  }

  private async parseSSEResponse(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data) for (const h of this.messageHandlers) h(data);
          }
        }
      }
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim();
        if (data) for (const h of this.messageHandlers) h(data);
      }
    } catch (err) {
      for (const h of this.errorHandlers) h(err as Error);
    }
  }

  onMessage(handler: MessageHandler): void { this.messageHandlers.push(handler); }
  onError(handler: ErrorHandler): void { this.errorHandlers.push(handler); }
  onClose(handler: CloseHandler): void { this.closeHandlers.push(handler); }

  close(): void {
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/oauth-http-transport.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add src/connectors/oauth-http-transport.ts src/connectors/oauth-http-transport.test.ts && git commit -m "feat(connectors): add OAuthHTTPTransport"
```

---

## Task 3: Atlassian connector definition

Defines the Atlassian MCP connector including OAuth discovery and scopes.

**Files:**
- Create: `src/connectors/atlassian/definition.ts`

- [ ] **Step 1: Write failing test (added to registry.test.ts)**

Append to `src/connectors/registry.test.ts`:

```typescript
import { ATLASSIAN_CONNECTOR } from './atlassian/definition';

describe('atlassian definition', () => {
  test('has required fields', () => {
    expect(ATLASSIAN_CONNECTOR.id).toBe('atlassian');
    expect(ATLASSIAN_CONNECTOR.mcpEndpoint).toBe('https://mcp.atlassian.com/v1/mcp/authv2');
    expect(ATLASSIAN_CONNECTOR.oauthScopes.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/registry.test.ts
```

Expected: FAIL `Cannot find module './atlassian/definition'`

- [ ] **Step 3: Create the definition**

```typescript
// src/connectors/atlassian/definition.ts
import type { ConnectorDefinition } from '../types';

/**
 * Atlassian Remote MCP Server connector.
 * Endpoint: https://mcp.atlassian.com/v1/mcp/authv2
 * OAuth: discovered at https://mcp.atlassian.com/.well-known/oauth-authorization-server
 */
export const ATLASSIAN_CONNECTOR: ConnectorDefinition = {
  id: 'atlassian',
  name: 'Atlassian',
  description: 'Connect Jira and Confluence via the Atlassian Remote MCP Server',
  logoUrl: '/logos/atlassian.svg',
  mcpEndpoint: 'https://mcp.atlassian.com/v1/mcp/authv2',
  oauthScopes: [
    'read:me',
    'read:jira-work',
    'write:jira-work',
    'read:confluence-content.all',
    'write:confluence-content',
    'offline_access',
  ],
};

/** Discovery URL for OAuth metadata per MCP spec. */
export const ATLASSIAN_OAUTH_DISCOVERY_URL =
  'https://mcp.atlassian.com/.well-known/oauth-authorization-server';
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/registry.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add src/connectors/atlassian/definition.ts src/connectors/registry.test.ts && git commit -m "feat(connectors): add Atlassian connector definition"
```

---

## Task 4: Atlassian OAuth in OAuthManager (Dynamic Client Registration)

Extend `src/security/oauth.ts` to add Atlassian support. Key difference: we auto-register via RFC 7591 instead of requiring manual client credentials.

The vault API:
- Store system secret: `getVault().setSystemSecret(name, value)`
- Read system secret: `getVault().getSystemSecret(name)`
- Store user secret: `getVault().store(userId, name, value, { credentialType: 'oauth_token' })`
- Read user secret: `getVault().getByName(userId, name)`

**Files:**
- Modify: `src/security/oauth.ts`

- [ ] **Step 1: Write failing test**

Create `src/security/atlassian-oauth.test.ts`:

```typescript
import { describe, expect, mock, test } from 'bun:test';

// We'll test the dynamic registration helper in isolation via the exported fn.
// Full OAuthManager is integration-tested; here we unit-test the registration discovery logic.

describe('atlassian oauth dynamic registration', () => {
  test('discovers registration endpoint from well-known URL', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | Request) => {
      const u = url instanceof Request ? url.url : url;
      if (u.includes('well-known')) {
        return new Response(JSON.stringify({
          issuer: 'https://auth.atlassian.com',
          authorization_endpoint: 'https://auth.atlassian.com/authorize',
          token_endpoint: 'https://auth.atlassian.com/oauth/token',
          registration_endpoint: 'https://auth.atlassian.com/register',
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('register')) {
        return new Response(JSON.stringify({ client_id: 'dynamic-client-123' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const { discoverAndRegisterAtlassian } = await import('./oauth');
    const result = await discoverAndRegisterAtlassian('https://octipus.example.com');
    expect(result.clientId).toBe('dynamic-client-123');
    expect(result.authorizationEndpoint).toBe('https://auth.atlassian.com/authorize');
    expect(result.tokenEndpoint).toBe('https://auth.atlassian.com/oauth/token');
    globalThis.fetch = origFetch;
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/security/atlassian-oauth.test.ts
```

Expected: FAIL `discoverAndRegisterAtlassian is not a function` (not exported yet)

- [ ] **Step 3: Add Atlassian OAuth support to oauth.ts**

Open `src/security/oauth.ts`. Add after the existing `OAUTH_VAULT_NAMES` object (around line 68):

```typescript
// Vault key names for Atlassian dynamic client registration (system-scoped)
const ATLASSIAN_CLIENT_ID_KEY = 'connector_atlassian_client_id';
const ATLASSIAN_AUTH_ENDPOINT_KEY = 'connector_atlassian_auth_endpoint';
const ATLASSIAN_TOKEN_ENDPOINT_KEY = 'connector_atlassian_token_endpoint';

// Vault key names for per-user Atlassian tokens
export const ATLASSIAN_USER_ACCESS_TOKEN_KEY = 'connector_atlassian_access_token';
export const ATLASSIAN_USER_REFRESH_TOKEN_KEY = 'connector_atlassian_refresh_token';
export const ATLASSIAN_USER_TOKEN_EXPIRY_KEY = 'connector_atlassian_token_expiry';

interface AtlassianOAuthMetadata {
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/**
 * Perform RFC 7591 Dynamic Client Registration with the Atlassian MCP server.
 * Fetches the OAuth discovery doc, registers Octipus as a public client,
 * and returns the resulting client_id + endpoint URLs.
 */
export async function discoverAndRegisterAtlassian(
  publicUrl: string,
): Promise<AtlassianOAuthMetadata> {
  const { ATLASSIAN_OAUTH_DISCOVERY_URL } = await import('@/connectors/atlassian/definition');

  // 1. Discover OAuth metadata
  const discoveryRes = await fetch(ATLASSIAN_OAUTH_DISCOVERY_URL);
  if (!discoveryRes.ok) {
    throw new Error(`Atlassian OAuth discovery failed (${discoveryRes.status})`);
  }
  const discovery = await discoveryRes.json() as {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
  };

  if (!discovery.registration_endpoint) {
    throw new Error('Atlassian OAuth discovery did not return a registration_endpoint');
  }

  // 2. Register Octipus as a public client (PKCE, no client secret)
  const registrationRes = await fetch(discovery.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Octipus',
      redirect_uris: [`${publicUrl}/api/connectors/atlassian/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client — PKCE replaces secret
    }),
  });

  if (!registrationRes.ok) {
    const body = await registrationRes.text().catch(() => '');
    throw new Error(`Atlassian client registration failed (${registrationRes.status}): ${body}`);
  }

  const registration = await registrationRes.json() as { client_id: string };
  if (!registration.client_id) {
    throw new Error('Atlassian registration response missing client_id');
  }

  return {
    clientId: registration.client_id,
    authorizationEndpoint: discovery.authorization_endpoint,
    tokenEndpoint: discovery.token_endpoint,
  };
}
```

Then add a `case 'atlassian':` block inside `getProviderConfig()`:

```typescript
case 'atlassian': {
  const v = getVault();
  const clientId = await v.getSystemSecret(ATLASSIAN_CLIENT_ID_KEY);
  const authorizationUrl = await v.getSystemSecret(ATLASSIAN_AUTH_ENDPOINT_KEY);
  const tokenUrl = await v.getSystemSecret(ATLASSIAN_TOKEN_ENDPOINT_KEY);
  if (!clientId || !authorizationUrl || !tokenUrl) return null;

  const { ATLASSIAN_CONNECTOR } = await import('@/connectors/atlassian/definition');
  const config = getConfig();
  const oauth = (config as any).oauth;
  const publicUrl = oauth?.publicUrl || `http://localhost:${config.api.port}`;

  return {
    authorizationUrl,
    tokenUrl,
    clientId,
    clientSecret: '', // public client — no secret
    scopes: ATLASSIAN_CONNECTOR.oauthScopes,
    redirectUri: `${publicUrl}/api/connectors/atlassian/callback`,
    additionalParams: {},
  };
}
```

Also add a helper to store user tokens (call it after token exchange):

```typescript
/**
 * Store per-user Atlassian OAuth tokens in vault.
 * Also handles refreshing: if an existing token is present it is overwritten.
 */
export async function storeAtlassianUserTokens(
  userId: string,
  accessToken: string,
  refreshToken: string | undefined,
  expiresInSeconds: number | undefined,
): Promise<void> {
  const v = getVault();
  const expiresAt = expiresInSeconds
    ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    : '';

  // Delete existing tokens first (vault.store creates new rows; avoid accumulation)
  const existing = await v.list(userId);
  const tokenNames = [
    ATLASSIAN_USER_ACCESS_TOKEN_KEY,
    ATLASSIAN_USER_REFRESH_TOKEN_KEY,
    ATLASSIAN_USER_TOKEN_EXPIRY_KEY,
  ];
  for (const entry of existing) {
    if (tokenNames.includes(entry.name ?? '')) {
      await v.delete(userId, entry.id);
    }
  }

  await v.store(userId, ATLASSIAN_USER_ACCESS_TOKEN_KEY, accessToken, {
    credentialType: 'oauth_token',
  });
  if (refreshToken) {
    await v.store(userId, ATLASSIAN_USER_REFRESH_TOKEN_KEY, refreshToken, {
      credentialType: 'oauth_token',
    });
  }
  if (expiresAt) {
    await v.store(userId, ATLASSIAN_USER_TOKEN_EXPIRY_KEY, expiresAt, {
      credentialType: 'other',
    });
  }
}

/**
 * Retrieve a valid Atlassian access token for a user.
 * Automatically refreshes via the refresh_token if the access token has expired.
 * Returns null if the user has no Atlassian connection.
 */
export async function getAtlassianAccessToken(userId: string): Promise<string | null> {
  const v = getVault();
  const accessToken = await v.getByName(userId, ATLASSIAN_USER_ACCESS_TOKEN_KEY);
  if (!accessToken) return null;

  const expiryStr = await v.getByName(userId, ATLASSIAN_USER_TOKEN_EXPIRY_KEY);
  const isExpired = expiryStr
    ? new Date(expiryStr).getTime() - 60_000 < Date.now()
    : false;

  if (!isExpired) return accessToken;

  // Token expired — try to refresh
  const refreshToken = await v.getByName(userId, ATLASSIAN_USER_REFRESH_TOKEN_KEY);
  if (!refreshToken) return null;

  const tokenEndpoint = await v.getSystemSecret(ATLASSIAN_TOKEN_ENDPOINT_KEY);
  const clientId = await v.getSystemSecret(ATLASSIAN_CLIENT_ID_KEY);
  if (!tokenEndpoint || !clientId) return null;

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });

  if (!res.ok) {
    securityLogger.warn({ userId, status: res.status }, 'Atlassian token refresh failed');
    return null;
  }

  const tokens = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  await storeAtlassianUserTokens(userId, tokens.access_token, tokens.refresh_token, tokens.expires_in);
  return tokens.access_token;
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/security/atlassian-oauth.test.ts
```

Expected: PASS

- [ ] **Step 5: Run all security tests to check no regressions**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/security/
```

Expected: all pass (the new atlassian test + pre-existing tests)

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add src/security/oauth.ts src/security/atlassian-oauth.test.ts && git commit -m "feat(connectors): add Atlassian OAuth with dynamic client registration"
```

---

## Task 5: ConnectorRegistry

The registry manages per-user connector connections and produces lazy meta-tools (`connector_list_tools`, `connector_call_tool`) for agent workers.

**Files:**
- Create: `src/connectors/registry.ts`
- Modify: `src/connectors/registry.test.ts` (add registry tests)

- [ ] **Step 1: Add registry tests to registry.test.ts**

Append to `src/connectors/registry.test.ts`:

```typescript
import { ConnectorRegistry } from './registry';
import { mock } from 'bun:test';

describe('ConnectorRegistry', () => {
  test('getUserToolHandlers returns empty array when user has no connectors', async () => {
    const mockGetToken = mock(async (_userId: string) => null as string | null);
    const registry = new ConnectorRegistry(mockGetToken);
    const handlers = await registry.getUserToolHandlers('user-without-connectors');
    expect(handlers).toHaveLength(0);
  });

  test('getUserToolHandlers returns two meta-tools when user has connector', async () => {
    const mockGetToken = mock(async (_userId: string) => 'valid-token');
    const registry = new ConnectorRegistry(mockGetToken);
    const handlers = await registry.getUserToolHandlers('user-with-atlassian');
    expect(handlers.length).toBeGreaterThanOrEqual(2);
    const names = handlers.map(h => h.name);
    expect(names).toContain('connector_list_tools');
    expect(names).toContain('connector_call_tool');
  });
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/registry.test.ts
```

Expected: FAIL `Cannot find module './registry'`

- [ ] **Step 3: Implement ConnectorRegistry**

```typescript
// src/connectors/registry.ts
import type { ToolHandler } from '@/core/agent-base';
import { coreLogger } from '@/utils/logger';
import { MCPProtocol, type MCPToolDefinition } from '@/mcp/protocol';
import { OAuthHTTPTransport } from './oauth-http-transport';
import { ATLASSIAN_CONNECTOR } from './atlassian/definition';
import type { ConnectorDefinition } from './types';

const ALL_CONNECTORS: ConnectorDefinition[] = [ATLASSIAN_CONNECTOR];

/**
 * Manages per-user connector connections and produces lazy MCP meta-tools.
 * Connections are transient (created on demand, not persisted across restarts)
 * because the Streamable HTTP transport is stateless per request.
 */
export class ConnectorRegistry {
  /**
   * @param getAccessToken - async fn(userId) → access token or null.
   *   Injected so registry is testable without real vault.
   */
  constructor(
    private readonly getAccessToken: (
      connectorId: string,
      userId: string,
    ) => Promise<string | null>,
  ) {}

  /**
   * Returns lazy meta-tools for all connectors the user has connected.
   * If the user has no active connectors, returns an empty array.
   */
  async getUserToolHandlers(userId: string): Promise<ToolHandler[]> {
    const activeConnectors: ConnectorDefinition[] = [];

    for (const connector of ALL_CONNECTORS) {
      const token = await this.getAccessToken(connector.id, userId).catch(() => null);
      if (token) activeConnectors.push(connector);
    }

    if (activeConnectors.length === 0) return [];

    return [
      this.buildListToolsHandler(userId, activeConnectors),
      this.buildCallToolHandler(userId, activeConnectors),
    ];
  }

  private buildListToolsHandler(
    userId: string,
    connectors: ConnectorDefinition[],
  ): ToolHandler {
    const registry = this;
    return {
      name: 'connector_list_tools',
      description:
        'List tools available from connected built-in connectors (e.g. Atlassian Jira/Confluence). ' +
        'Call before connector_call_tool to discover available tools and their parameters.',
      parameters: {
        type: 'object',
        properties: {
          connector_id: {
            type: 'string',
            description: 'Optional: filter by connector ID (e.g. "atlassian"). Omit to list all.',
          },
        },
      },
      toolId: 'connector',
      execute: async (args) => {
        const filterId = args.connector_id as string | undefined;
        const result: Array<{ connector_id: string; connector_name: string; tools: Array<{ name: string; description: string; parameters?: unknown }> }> = [];

        for (const connector of connectors) {
          if (filterId && connector.id !== filterId) continue;

          const tools = await registry.fetchConnectorTools(connector, userId).catch((err) => {
            coreLogger.warn({ err, connectorId: connector.id, userId }, 'Failed to list connector tools');
            return [] as MCPToolDefinition[];
          });

          result.push({
            connector_id: connector.id,
            connector_name: connector.name,
            tools: tools.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
          });
        }

        return result.length > 0 ? result : { message: 'No connectors matched or tools available.' };
      },
    };
  }

  private buildCallToolHandler(
    userId: string,
    connectors: ConnectorDefinition[],
  ): ToolHandler {
    const registry = this;
    return {
      name: 'connector_call_tool',
      description:
        'Call a tool on a built-in connector (e.g. Atlassian). ' +
        'Use connector_list_tools first to discover available tool names and parameter schemas.',
      parameters: {
        type: 'object',
        properties: {
          connector_id: { type: 'string', description: 'Connector ID (e.g. "atlassian")' },
          tool_name: { type: 'string', description: 'Tool name from connector_list_tools' },
          arguments: { type: 'object', description: 'Arguments per the tool schema' },
        },
        required: ['connector_id', 'tool_name'],
      },
      toolId: 'connector',
      execute: async (args) => {
        const connectorId = args.connector_id as string;
        const toolName = args.tool_name as string;
        const toolArgs = (args.arguments as Record<string, unknown>) ?? {};

        const connector = connectors.find(c => c.id === connectorId);
        if (!connector) {
          throw new Error(`Connector '${connectorId}' not found or not connected for this user.`);
        }

        return registry.callConnectorTool(connector, userId, toolName, toolArgs);
      },
    };
  }

  /** Fetch the tool list from a connector's MCP endpoint for the given user. */
  private async fetchConnectorTools(
    connector: ConnectorDefinition,
    userId: string,
  ): Promise<MCPToolDefinition[]> {
    const { transport, protocol, send } = await this.openConnection(connector, userId);
    try {
      await transport.connect();
      await protocol.sendRequest(send, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'octipus-connector', version: '1.0.0' },
      });
      protocol.sendNotification(send, 'notifications/initialized');
      const res = await protocol.sendRequest(send, 'tools/list') as { tools: MCPToolDefinition[] };
      return res.tools ?? [];
    } finally {
      transport.close();
      protocol.cleanup();
    }
  }

  /** Call a single tool on a connector's MCP endpoint. */
  private async callConnectorTool(
    connector: ConnectorDefinition,
    userId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<unknown> {
    const { transport, protocol, send } = await this.openConnection(connector, userId);
    try {
      await transport.connect();
      await protocol.sendRequest(send, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'octipus-connector', version: '1.0.0' },
      });
      protocol.sendNotification(send, 'notifications/initialized');
      return await protocol.sendRequest(send, 'tools/call', { name: toolName, arguments: toolArgs });
    } finally {
      transport.close();
      protocol.cleanup();
    }
  }

  private async openConnection(
    connector: ConnectorDefinition,
    userId: string,
  ): Promise<{ transport: OAuthHTTPTransport; protocol: MCPProtocol; send: (msg: string) => void }> {
    const transport = new OAuthHTTPTransport(
      connector.mcpEndpoint,
      () => this.getAccessToken(connector.id, userId).then(t => {
        if (!t) throw new Error(`No Atlassian token for user ${userId}`);
        return t;
      }),
    );

    const protocol = new MCPProtocol();
    transport.onMessage((line) => {
      try {
        const msg = protocol.parseMessage(line);
        protocol.handleMessage(msg);
      } catch (err) {
        coreLogger.error({ err, connectorId: connector.id }, 'Failed to parse connector MCP message');
      }
    });

    const send = (message: string) => transport.send(message);
    return { transport, protocol, send };
  }
}

// -- Singleton --

let registryInstance: ConnectorRegistry | null = null;

export function getConnectorRegistry(): ConnectorRegistry {
  if (!registryInstance) {
    const { getAtlassianAccessToken } = require('@/security/oauth') as typeof import('@/security/oauth');
    registryInstance = new ConnectorRegistry(
      async (connectorId, userId) => {
        if (connectorId === 'atlassian') return getAtlassianAccessToken(userId);
        return null;
      },
    );
  }
  return registryInstance;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/registry.test.ts
```

Expected: PASS (all tests including types, atlassian definition, and registry tests)

- [ ] **Step 5: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add src/connectors/registry.ts && git commit -m "feat(connectors): add ConnectorRegistry with lazy meta-tools"
```

---

## Task 6: Connector index + type-check

**Files:**
- Create: `src/connectors/index.ts`

- [ ] **Step 1: Create index**

```typescript
// src/connectors/index.ts
export { OAuthHTTPTransport } from './oauth-http-transport';
export { ATLASSIAN_CONNECTOR, ATLASSIAN_OAUTH_DISCOVERY_URL } from './atlassian/definition';
export { ConnectorRegistry, getConnectorRegistry } from './registry';
export type { ConnectorDefinition, UserConnectorStatus } from './types';
```

- [ ] **Step 2: Type-check**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun run typecheck 2>&1 | head -40
```

Expected: any errors in `src/connectors/` are zero. Fix any type errors before proceeding.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add src/connectors/index.ts && git commit -m "feat(connectors): add module index"
```

---

## Task 7: Backend API routes for connectors

Endpoints:
- `GET /connectors` — list connectors with per-user connected status
- `POST /connectors/:id/authorize` — start OAuth flow (dynamic registration if needed, returns URL)
- `GET /connectors/:id/callback` — Atlassian redirects here; exchange code, store tokens, return close-popup HTML
- `DELETE /connectors/:id` — disconnect user (delete vault tokens)

**Files:**
- Create: `src/api/routes/connectors.ts`

- [ ] **Step 1: Write failing test**

Create `src/api/routes/connectors.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { connectorRoutes } from './connectors';

// Minimal smoke-test: routes mount without throwing.
describe('connectorRoutes', () => {
  test('mounts without error', () => {
    const app = new Elysia().use(connectorRoutes);
    expect(app).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — verify it fails**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/api/routes/connectors.test.ts
```

Expected: FAIL `Cannot find module './connectors'`

- [ ] **Step 3: Create the routes file**

```typescript
// src/api/routes/connectors.ts
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getConfig } from '@/config';
import { ATLASSIAN_CONNECTOR } from '@/connectors/atlassian/definition';
import {
  ATLASSIAN_USER_ACCESS_TOKEN_KEY,
  ATLASSIAN_USER_REFRESH_TOKEN_KEY,
  ATLASSIAN_USER_TOKEN_EXPIRY_KEY,
  discoverAndRegisterAtlassian,
  storeAtlassianUserTokens,
} from '@/security/oauth';
import { OAuthManager } from '@/security/oauth';
import { getVault } from '@/security/vault';
import { securityLogger } from '@/utils/logger';

const ALL_CONNECTORS = [ATLASSIAN_CONNECTOR];

/** Names of vault keys holding Atlassian user tokens — used for disconnect cleanup. */
const ATLASSIAN_TOKEN_KEY_NAMES = [
  ATLASSIAN_USER_ACCESS_TOKEN_KEY,
  ATLASSIAN_USER_REFRESH_TOKEN_KEY,
  ATLASSIAN_USER_TOKEN_EXPIRY_KEY,
];

export const connectorRoutes = new Elysia({ prefix: '/connectors' })
  .use(apiContext)

  // GET /connectors — list all connectors with per-user connection status
  .get(
    '/',
    async ({ user }) => {
      if (!user) return { error: 'Unauthenticated' };

      const v = getVault();
      const results = await Promise.all(
        ALL_CONNECTORS.map(async (connector) => {
          const token = await v.getByName(user.id, ATLASSIAN_USER_ACCESS_TOKEN_KEY).catch(() => null);
          const expiry = await v.getByName(user.id, ATLASSIAN_USER_TOKEN_EXPIRY_KEY).catch(() => null);
          return {
            id: connector.id,
            name: connector.name,
            description: connector.description,
            logoUrl: connector.logoUrl,
            connected: !!token,
            expiresAt: expiry ?? undefined,
          };
        }),
      );

      return { connectors: results };
    },
    { detail: { tags: ['connectors'] } },
  )

  // POST /connectors/:id/authorize — start OAuth; returns auth URL for popup
  .post(
    '/:id/authorize',
    async ({ user, params }) => {
      if (!user) return { error: 'Unauthenticated' };
      if (params.id !== 'atlassian') return { error: `Unknown connector: ${params.id}` };

      const config = getConfig();
      const oauthConfig = (config as any).oauth;
      const publicUrl: string = oauthConfig?.publicUrl ?? `http://localhost:${config.api.port}`;

      // Ensure dynamic client registration has been performed
      const v = getVault();
      let clientId = await v.getSystemSecret('connector_atlassian_client_id').catch(() => null);
      if (!clientId) {
        securityLogger.info('Performing Atlassian dynamic client registration');
        const reg = await discoverAndRegisterAtlassian(publicUrl);
        await v.setSystemSecret('connector_atlassian_client_id', reg.clientId);
        await v.setSystemSecret('connector_atlassian_auth_endpoint', reg.authorizationEndpoint);
        await v.setSystemSecret('connector_atlassian_token_endpoint', reg.tokenEndpoint);
        clientId = reg.clientId;
      }

      const manager = new OAuthManager();
      const { url } = await manager.generateAuthorizationUrl(user.id, 'atlassian');

      return { url };
    },
    { detail: { tags: ['connectors'] } },
  )

  // GET /connectors/:id/callback — OAuth redirect target
  // Returns inline HTML that closes the popup and notifies the parent window.
  .get(
    '/:id/callback',
    async ({ params, query }) => {
      if (params.id !== 'atlassian') {
        return new Response('Unknown connector', { status: 400 });
      }

      const { code, state, error } = query as { code?: string; state?: string; error?: string };

      if (error || !code || !state) {
        const msg = error ?? 'Missing code or state';
        return new Response(buildCallbackHtml({ success: false, error: msg, connectorId: 'atlassian' }), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      try {
        const manager = new OAuthManager();
        const { userId } = await manager.exchangeCode('atlassian', code, state);

        // Tokens are stored in vault inside exchangeCode via the atlassian branch
        // (which calls storeAtlassianUserTokens). Nothing else needed here.
        securityLogger.info({ userId }, 'Atlassian connector connected');

        return new Response(buildCallbackHtml({ success: true, connectorId: 'atlassian' }), {
          headers: { 'Content-Type': 'text/html' },
        });
      } catch (err) {
        securityLogger.error({ err }, 'Atlassian OAuth callback failed');
        return new Response(
          buildCallbackHtml({ success: false, error: (err as Error).message, connectorId: 'atlassian' }),
          { headers: { 'Content-Type': 'text/html' } },
        );
      }
    },
    { detail: { tags: ['connectors'] } },
  )

  // DELETE /connectors/:id — disconnect (delete user's vault tokens)
  .delete(
    '/:id',
    async ({ user, params }) => {
      if (!user) return { error: 'Unauthenticated' };
      if (params.id !== 'atlassian') return { error: `Unknown connector: ${params.id}` };

      const v = getVault();
      const entries = await v.list(user.id);
      let removed = 0;
      for (const entry of entries) {
        if (ATLASSIAN_TOKEN_KEY_NAMES.includes(entry.name ?? '')) {
          await v.delete(user.id, entry.id);
          removed++;
        }
      }

      securityLogger.info({ userId: user.id, removed }, 'Atlassian connector disconnected');
      return { success: true };
    },
    { detail: { tags: ['connectors'] } },
  );

function buildCallbackHtml(opts: { success: boolean; connectorId: string; error?: string }): string {
  const message = opts.success
    ? `{ type: 'connector:connected', connectorId: '${opts.connectorId}' }`
    : `{ type: 'connector:error', connectorId: '${opts.connectorId}', error: ${JSON.stringify(opts.error ?? 'Unknown error')} }`;

  return `<!DOCTYPE html><html><head><title>Connecting...</title></head><body>
<script>
  try { window.opener?.postMessage(${message}, window.location.origin); } catch(_) {}
  window.close();
</script>
<p>${opts.success ? 'Connected! You can close this window.' : `Error: ${opts.error}`}</p>
</body></html>`;
}
```

**Important**: The `exchangeCode` method in `OAuthManager` (`src/security/oauth.ts`) needs to call `storeAtlassianUserTokens` after exchanging the code for tokens when the provider is `atlassian`. Open `src/security/oauth.ts` and find the `exchangeCode` method. After it receives the token response, add an `atlassian`-specific branch that calls `storeAtlassianUserTokens(stateData.userId, ...)`.

Find the section in `exchangeCode` where tokens are stored for other providers and add:

```typescript
// After the token exchange succeeds and tokenResponse is available:
if (provider === 'atlassian') {
  await storeAtlassianUserTokens(
    stateData.userId,
    tokenResponse.access_token,
    tokenResponse.refresh_token,
    tokenResponse.expires_in,
  );
}
```

- [ ] **Step 4: Run test**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/api/routes/connectors.test.ts
```

Expected: PASS

- [ ] **Step 5: Register routes in api/server.ts**

Open `src/api/server.ts`. Find where `mcpRoutes` is imported (line 41) and add:

```typescript
import { connectorRoutes } from './routes/connectors';
```

Find where `.use(mcpRoutes)` is (line 329) and add below it:

```typescript
.use(connectorRoutes)
```

- [ ] **Step 6: Type-check**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun run typecheck 2>&1 | grep -E "error|Error" | head -20
```

Expected: no new errors. Fix any before continuing.

- [ ] **Step 7: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add src/api/routes/connectors.ts src/api/routes/connectors.test.ts src/api/server.ts && git commit -m "feat(connectors): add connector REST API routes"
```

---

## Task 8: Inject connector tools into agent workers

When a worker is spawned for a user who has connectors, their connector meta-tools (`connector_list_tools`, `connector_call_tool`) must be included in the worker's tool set.

**Files:**
- Modify: `src/core/orchestrator/worker-spawner.ts`
- Modify: `src/core/swarm/spawner.ts`

- [ ] **Step 1: Write failing test**

Create `src/connectors/registry-injection.test.ts`:

```typescript
import { describe, expect, mock, test } from 'bun:test';

// Validate that getConnectorRegistry().getUserToolHandlers is callable with a userId.
// The actual integration is tested via the spawner, but this confirms the interface.
describe('connector tool injection surface', () => {
  test('getUserToolHandlers signature accepts userId string', async () => {
    const { ConnectorRegistry } = await import('./registry');
    const reg = new ConnectorRegistry(async () => null);
    const handlers = await reg.getUserToolHandlers('some-user-id');
    expect(Array.isArray(handlers)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify it passes (it should — just a type check)**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/registry-injection.test.ts
```

Expected: PASS

- [ ] **Step 3: Modify worker-spawner.ts**

Open `src/core/orchestrator/worker-spawner.ts`. Find the line:

```typescript
const roleTools = getToolsForRole(agentRole);
```

(around line 199). Replace it with:

```typescript
const roleTools = getToolsForRole(agentRole);

// Inject per-user connector tools (e.g. Atlassian) when user context is available.
if (context.userId && context.userId !== 'system' && context.userId !== 'local') {
  try {
    const { getConnectorRegistry } = await import('@/connectors');
    const connectorHandlers = await getConnectorRegistry().getUserToolHandlers(context.userId);
    roleTools.push(...connectorHandlers);
  } catch (err) {
    coreLogger.warn({ err, userId: context.userId }, 'Failed to load connector tool handlers');
  }
}
```

- [ ] **Step 4: Modify swarm/spawner.ts**

Open `src/core/swarm/spawner.ts`. Find the equivalent line (around line 308):

```typescript
const roleTools = getToolsForRole(childRole);
```

Replace with:

```typescript
const roleTools = getToolsForRole(childRole);

if (context.userId && context.userId !== 'system' && context.userId !== 'local') {
  try {
    const { getConnectorRegistry } = await import('@/connectors');
    const connectorHandlers = await getConnectorRegistry().getUserToolHandlers(context.userId);
    roleTools.push(...connectorHandlers);
  } catch (err) {
    coreLogger.error({ err, userId: context.userId }, 'Failed to load connector tools for swarm child');
  }
}
```

- [ ] **Step 5: Type-check**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun run typecheck 2>&1 | grep -E "error" | head -20
```

Expected: zero new errors.

- [ ] **Step 6: Run all connector tests**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/
```

Expected: all PASS

- [ ] **Step 7: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add src/core/orchestrator/worker-spawner.ts src/core/swarm/spawner.ts src/connectors/registry-injection.test.ts && git commit -m "feat(connectors): inject per-user connector tools into agent workers"
```

---

## Task 9: Web UI — ConnectorCard component

A single card for a connector with connect/disconnect button and status.

**Files:**
- Create: `web/components/mcp/connector-card.tsx`

- [ ] **Step 1: Create the component**

```tsx
// web/components/mcp/connector-card.tsx
'use client';

import { CheckCircle, ExternalLink, Loader2, Unplug } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ConnectorCardProps {
  id: string;
  name: string;
  description: string;
  logoUrl: string;
  connected: boolean;
  expiresAt?: string;
  onStatusChange: () => void;
}

export function ConnectorCard({
  id,
  name,
  description,
  logoUrl,
  connected,
  onStatusChange,
}: ConnectorCardProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleConnect = async () => {
    setLoading(true);
    setError('');
    try {
      const { url } = await api.post<{ url: string }>(`/connectors/${id}/authorize`, {});

      // Open OAuth popup
      const popup = window.open(url, `${name} OAuth`, 'width=600,height=700,scrollbars=yes');
      if (!popup) {
        setError('Popup blocked. Allow popups for this page and try again.');
        setLoading(false);
        return;
      }

      // Listen for the postMessage from the callback page
      const handler = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data as { type?: string; connectorId?: string; error?: string };
        if (data?.connectorId !== id) return;

        if (data.type === 'connector:connected') {
          onStatusChange();
        } else if (data.type === 'connector:error') {
          setError(data.error ?? 'OAuth failed');
        }
        window.removeEventListener('message', handler);
        setLoading(false);
      };

      window.addEventListener('message', handler);

      // Fallback: if popup closes without postMessage, stop spinner after 2 min
      const pollClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollClosed);
          window.removeEventListener('message', handler);
          setLoading(false);
          onStatusChange(); // refresh — user may have connected
        }
      }, 500);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    setError('');
    try {
      await api.delete(`/connectors/${id}`);
      onStatusChange();
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  return (
    <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-surface-container-low flex items-center justify-center shrink-0 overflow-hidden">
            <Image src={logoUrl} alt={name} width={32} height={32} className="object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-on-surface">{name}</h3>
              {connected && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-green-900/30 text-tertiary">
                  <CheckCircle className="w-3 h-3" />
                  connected
                </span>
              )}
            </div>
            <p className="text-xs text-on-surface-variant mt-0.5">{description}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin text-on-surface-variant" />
          ) : connected ? (
            <button
              onClick={handleDisconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-on-surface-variant hover:text-error hover:bg-red-900/20 rounded-lg cursor-pointer transition-colors"
            >
              <Unplug className="w-3.5 h-3.5" />
              Disconnect
            </button>
          ) : (
            <button
              onClick={handleConnect}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-on-surface rounded-lg hover:bg-primary-dim cursor-pointer transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Connect
            </button>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Type-check web**

```bash
cd "C:\Users\pallegue\Github Reps\octipus\web" && bun run typecheck 2>&1 | head -20
```

Expected: zero errors for the new file.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add web/components/mcp/connector-card.tsx && git commit -m "feat(connectors): add ConnectorCard UI component"
```

---

## Task 10: Web UI — ConnectorsTab component

Lists all connectors. Calls `GET /connectors` and renders a `ConnectorCard` for each.

**Files:**
- Create: `web/components/mcp/connectors-tab.tsx`

- [ ] **Step 1: Create the component**

```tsx
// web/components/mcp/connectors-tab.tsx
'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Puzzle } from 'lucide-react';
import { api } from '@/lib/api';
import { ConnectorCard } from './connector-card';

interface ConnectorStatus {
  id: string;
  name: string;
  description: string;
  logoUrl: string;
  connected: boolean;
  expiresAt?: string;
}

export function ConnectorsTab() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['connectors'],
    queryFn: async () => {
      try {
        return await api.get<{ connectors: ConnectorStatus[] }>('/connectors');
      } catch {
        return { connectors: [] };
      }
    },
    refetchInterval: 30_000,
  });

  const connectors = data?.connectors ?? [];

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['connectors'] });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-on-surface">Built-in Connectors</h2>
        <p className="text-xs text-on-surface-variant mt-0.5">
          First-party integrations with OAuth — connect your account and agents can use these services directly.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-on-surface-variant text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading connectors...
        </div>
      ) : connectors.length === 0 ? (
        <div className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-8 text-center">
          <Puzzle className="w-8 h-8 text-on-surface-variant mx-auto mb-2" />
          <p className="text-on-surface-variant">No connectors available</p>
        </div>
      ) : (
        <div className="space-y-3">
          {connectors.map((c) => (
            <ConnectorCard
              key={c.id}
              id={c.id}
              name={c.name}
              description={c.description}
              logoUrl={c.logoUrl}
              connected={c.connected}
              expiresAt={c.expiresAt}
              onStatusChange={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check web**

```bash
cd "C:\Users\pallegue\Github Reps\octipus\web" && bun run typecheck 2>&1 | head -20
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add web/components/mcp/connectors-tab.tsx && git commit -m "feat(connectors): add ConnectorsTab UI component"
```

---

## Task 11: Web UI — Add Connectors tab to MCP page

The MCP page (`web/app/mcp/page.tsx`) currently shows only custom MCP servers. Add a two-tab layout: "MCP Servers" (existing) and "Connectors" (new tab).

**Files:**
- Modify: `web/app/mcp/page.tsx`

- [ ] **Step 1: Add tab state and import**

Open `web/app/mcp/page.tsx`. 

At the top, after the existing imports, add:

```tsx
import { ConnectorsTab } from '@/components/mcp/connectors-tab';
import { Puzzle } from 'lucide-react';
```

(Puzzle is already available from lucide-react.)

- [ ] **Step 2: Add tab state inside MCPPage**

Inside `MCPPage`, add after the existing `useState` declarations:

```tsx
const [activeTab, setActiveTab] = useState<'servers' | 'connectors'>('servers');
```

- [ ] **Step 3: Replace the page header section with tabbed layout**

Find the `<div className="space-y-6">` that wraps the whole page return. Replace the header `<div className="flex items-center justify-between">...</div>` and the server list below it with:

```tsx
<div className="space-y-6">
  {/* Header */}
  <div className="flex items-center gap-3">
    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
      <Cable className="w-5 h-5 text-primary" />
    </div>
    <div>
      <h1 className="text-xl text-on-surface">MCP & Connectors</h1>
      <p className="text-on-surface-variant">
        Connect external services and MCP servers to your agents.
      </p>
    </div>
  </div>

  {/* Tabs */}
  <div className="flex gap-1 border-b border-outline-variant/20">
    {([
      { id: 'servers' as const, label: 'MCP Servers', icon: Cable },
      { id: 'connectors' as const, label: 'Connectors', icon: Puzzle },
    ] as const).map((tab) => (
      <button
        key={tab.id}
        onClick={() => setActiveTab(tab.id)}
        className={cn(
          'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer',
          activeTab === tab.id
            ? 'border-primary text-primary'
            : 'border-transparent text-on-surface-variant hover:text-on-surface',
        )}
      >
        <tab.icon className="w-4 h-4" />
        {tab.label}
      </button>
    ))}
  </div>

  {/* Tab content */}
  {activeTab === 'servers' && (
    <>
      <div className="flex justify-end">
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-primary text-on-surface cursor-pointer rounded-lg hover:bg-primary-dim flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          Add Server
        </button>
      </div>

      {/* ... existing server list JSX ... */}
    </>
  )}

  {activeTab === 'connectors' && <ConnectorsTab />}

  <AddServerModal
    open={showAdd}
    onClose={() => setShowAdd(false)}
    onAdded={() => queryClient.invalidateQueries({ queryKey: ['mcp-servers'] })}
  />
</div>
```

Note: Keep the existing server list JSX inside the `activeTab === 'servers'` block intact — just wrap it.

- [ ] **Step 4: Type-check web**

```bash
cd "C:\Users\pallegue\Github Reps\octipus\web" && bun run typecheck 2>&1 | head -20
```

Expected: zero errors.

- [ ] **Step 5: Lint web**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun run lint 2>&1 | head -20
```

Expected: zero new lint errors.

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add web/app/mcp/page.tsx && git commit -m "feat(connectors): add Connectors tab to MCP page"
```

---

## Task 12: Add Atlassian logo asset

The ConnectorCard references `/logos/atlassian.svg`. Provide it.

**Files:**
- Create: `web/public/logos/atlassian.svg`

- [ ] **Step 1: Create the SVG**

```svg
<!-- web/public/logos/atlassian.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path fill="#0052cc" d="M15.13 14.37c-.37-.46-.84-.42-1.07.08L10.2 22.96c-.23.5.03 1.04.56 1.04h6.77c.3 0 .58-.18.7-.47 1.2-3.03.42-6.5-3.1-9.16z"/>
  <path fill="#2684ff" d="M16 7.54c-3.63 5.16-3.18 11.48.42 15.42.23.25.56.37.9.37h5.34c.53 0 .78-.54.55-1.04C20.4 17.2 18.5 11.95 16 7.54z"/>
</svg>
```

- [ ] **Step 2: Verify file exists**

```bash
ls "C:\Users\pallegue\Github Reps\octipus\web\public\logos\atlassian.svg"
```

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && git add web/public/logos/atlassian.svg && git commit -m "feat(connectors): add Atlassian logo"
```

---

## Task 13: Final verification

- [ ] **Step 1: Run all connector tests**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test src/connectors/ src/security/atlassian-oauth.test.ts src/api/routes/connectors.test.ts
```

Expected: all PASS

- [ ] **Step 2: Run full test suite**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun test
```

Expected: same pass count as before this feature (no regressions)

- [ ] **Step 3: Type-check backend**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun run typecheck 2>&1 | grep error | head -20
```

Expected: zero errors

- [ ] **Step 4: Type-check web**

```bash
cd "C:\Users\pallegue\Github Reps\octipus\web" && bun run typecheck 2>&1 | grep error | head -20
```

Expected: zero errors

- [ ] **Step 5: Lint**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun run lint 2>&1 | grep error | head -20
```

Expected: zero errors

- [ ] **Step 6: Start dev server and manually verify**

```bash
cd "C:\Users\pallegue\Github Reps\octipus" && bun run dev
```

Navigate to `http://localhost:3007/mcp`. Verify:
1. "MCP & Connectors" heading appears
2. "MCP Servers" tab shows existing server list
3. "Connectors" tab shows "Atlassian" card with "Connect" button
4. Clicking "Connect" opens a popup (may fail at OAuth step without real Atlassian credentials, but popup should open)
5. Disconnect button appears after successful OAuth

---

## Architecture Notes for Implementer

### Vault API (src/security/vault.ts)
- `getVault().getSystemSecret(name)` → `string | null` — read system-level secret
- `getVault().setSystemSecret(name, value)` — write system-level secret
- `getVault().store(userId, name, value, { credentialType })` — store user secret
- `getVault().getByName(userId, name)` → `string | null` — read user secret by name
- `getVault().list(userId)` → array of entries (no values, just metadata including `id` and `name`)
- `getVault().delete(userId, entryId)` — delete by ID (get ID from `list()`)

### OAuthManager (src/security/oauth.ts)
- `new OAuthManager()` → instance
- `manager.generateAuthorizationUrl(userId, provider)` → `{ url }` — generates PKCE auth URL + stores state in Redis
- `manager.exchangeCode(provider, code, state)` → `{ userId }` — validates state, exchanges code for tokens
- You need to add Atlassian to `getProviderConfig()` (Task 4 above) AND add `storeAtlassianUserTokens` call inside `exchangeCode` for the `atlassian` case.

### MCPProtocol (src/mcp/protocol.ts)
- `new MCPProtocol()` → instance
- `protocol.parseMessage(line)` → parsed message
- `protocol.handleMessage(msg)` — routes responses to pending requests
- `protocol.sendRequest(send, method, params?)` → `Promise<unknown>` — JSONRPC request
- `protocol.sendNotification(send, method, params?)` — JSONRPC notification (no response)
- `protocol.cleanup()` — clear pending requests

### Dynamic Client Registration caveats
If Atlassian does not expose `registration_endpoint` in its discovery doc, `discoverAndRegisterAtlassian` will throw. In that case, fall back to requiring manual credential entry (follow the Google/Microsoft pattern in `OAUTH_VAULT_NAMES`). The plan supports this by isolating registration in a single exported function.

### Per-user connection lifecycle
Connector connections in `ConnectorRegistry` are fully transient — a new `OAuthHTTPTransport` + `MCPProtocol` is created per `fetchConnectorTools`/`callConnectorTool` call and closed immediately after. This is correct for Streamable HTTP (stateless protocol) and avoids stale connection management complexity.
