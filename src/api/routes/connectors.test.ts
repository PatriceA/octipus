import { describe, expect, test } from 'vitest';
import { Elysia } from '@/api/http';
import { connectorRoutes } from './connectors';

describe('connectorRoutes', () => {
  test('mounts without error', () => {
    const app = new Elysia().use(connectorRoutes);
    expect(app).toBeDefined();
  });
});
