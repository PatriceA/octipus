import { describe, expect, test } from 'vitest';

describe('connector tool injection surface', () => {
  test('getUserToolHandlers signature accepts userId string', async () => {
    const { ConnectorRegistry } = await import('./registry');
    const reg = new ConnectorRegistry(async () => null);
    const handlers = await reg.getUserToolHandlers('some-user-id');
    expect(Array.isArray(handlers)).toBe(true);
  });
});
