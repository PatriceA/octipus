/**
 * Shared mutable test state (fixtures) used across test modules.
 *
 * Auth modes:
 * - MASTER_KEY env → uses master key as Bearer token (skips register/login)
 * - Otherwise → creates a test user via register/login
 */

export const fixtures = {
  authToken: (process.env.MASTER_KEY || null) as string | null,
  testUserId: process.env.MASTER_KEY ? 'system' : null as string | null,
  testUsername: process.env.MASTER_KEY ? 'system' : `e2e_test_${Date.now()}`,
  testPassword: 'TestP@ssw0rd!2024',
  chatSessionId: null as string | null,
  testExpertId: null as string | null,
  testRecurringTaskId: null as string | null,
  /** Whether auth was bootstrapped via MASTER_KEY (skips register/login tests) */
  usingMasterKey: !!process.env.MASTER_KEY,
  /** Gateway WS URL — derived from BASE_URL, overridable via GATEWAY_URL */
  gatewayUrl: '' as string,
};

export const BASE_URL = process.env.API_URL || 'http://localhost:3005/api';

/**
 * Derive the gateway WebSocket URL from BASE_URL.
 * BASE_URL ends in /api; the gateway WS is mounted on the same server at /gateway.
 * Example: http://localhost:3005/api → ws://localhost:3005/gateway
 */
function deriveGatewayUrl(): string {
  if (process.env.GATEWAY_URL) return process.env.GATEWAY_URL;
  const url = new URL(BASE_URL);
  const wsProto = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${url.host}/gateway`;
}

fixtures.gatewayUrl = deriveGatewayUrl();
