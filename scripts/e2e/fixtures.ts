/**
 * Shared mutable test state (fixtures) used across test modules.
 */

export const fixtures = {
  authToken: null as string | null,
  testUserId: null as string | null,
  testUsername: `e2e_test_${Date.now()}`,
  testPassword: 'TestP@ssw0rd!2024',
  chatSessionId: null as string | null,
  testPresetId: null as string | null,
  testRecurringTaskId: null as string | null,
};

export const BASE_URL = process.env.API_URL || 'http://localhost:3005/api';
