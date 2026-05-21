import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { connectorRoutes } from './connectors';

describe('connectorRoutes', () => {
  test('mounts without error', () => {
    const app = new Elysia().use(connectorRoutes);
    expect(app).toBeDefined();
  });
});
