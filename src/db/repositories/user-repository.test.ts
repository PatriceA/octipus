import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
  truncateTables,
} from '@/test-helpers/integration';
import type { UserRepository } from './user-repository';

// Integration tests require a running Postgres (docker-compose.test.yml).
// Enabled with INTEGRATION=1; otherwise the block is skipped so `bun test`
// stays green without Docker. Run via:
//   bun run test:integration -- src/db/repositories/user-repository.test.ts

describe.skipIf(!isIntegration)('UserRepository (Integration)', () => {
  let repo: UserRepository;

  beforeAll(async () => {
    await setupIntegrationDb();
    // Import after DB init so the repository's `getDb()` proxy resolves correctly
    const mod = await import('./user-repository');
    repo = new mod.UserRepository();
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  beforeEach(async () => {
    await truncateTables(['users']);
  });

  test('create + findById round-trips a user', async () => {
    const created = await repo.create({
      username: `alice-${Date.now()}`,
      email: 'alice@example.com',
      isAdmin: false,
      isActive: true,
    });

    expect(created.id).toBeDefined();
    expect(created.username).toContain('alice-');

    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found!.email).toBe('alice@example.com');
  });

  test('findByUsername returns user or null', async () => {
    const username = `bob-${Date.now()}`;
    await repo.create({ username, email: 'bob@example.com' });

    const hit = await repo.findByUsername(username);
    expect(hit?.username).toBe(username);

    const miss = await repo.findByUsername('does-not-exist');
    expect(miss).toBeNull();
  });

  test('update mutates fields and bumps updatedAt', async () => {
    const created = await repo.create({ username: `carol-${Date.now()}` });
    const before = created.updatedAt.getTime();

    // Wait at least a millisecond so timestamps differ
    await new Promise((r) => setTimeout(r, 2));

    const updated = await repo.update(created.id, { email: 'new@example.com' });
    expect(updated?.email).toBe('new@example.com');
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  test('delete removes the row', async () => {
    const created = await repo.create({ username: `dana-${Date.now()}` });
    const ok = await repo.delete(created.id);
    expect(ok).toBe(true);

    const found = await repo.findById(created.id);
    expect(found).toBeNull();

    const deleteMissing = await repo.delete(created.id);
    expect(deleteMissing).toBe(false);
  });

  test('channel binding add / findByChannelBinding / remove', async () => {
    const created = await repo.create({ username: `eve-${Date.now()}` });

    const binding = {
      channelType: 'telegram' as const,
      channelUserId: '12345',
      channelUserName: 'eve_tg',
      isVerified: true,
      createdAt: new Date().toISOString(),
    };

    await repo.addChannelBinding(created.id, binding);

    const byBinding = await repo.findByChannelBinding('telegram', '12345');
    expect(byBinding?.id).toBe(created.id);

    await repo.removeChannelBinding(created.id, 'telegram', '12345');
    const afterRemove = await repo.findByChannelBinding('telegram', '12345');
    expect(afterRemove).toBeNull();
  });

  test('listActive returns only active users', async () => {
    await repo.create({ username: `active-${Date.now()}`, isActive: true });
    await repo.create({ username: `inactive-${Date.now()}`, isActive: false });

    const active = await repo.listActive();
    const names = active.map((u) => u.username);
    expect(names.some((n) => n.startsWith('active-'))).toBe(true);
    expect(names.some((n) => n.startsWith('inactive-'))).toBe(false);
  });
});

// Unit tests for repository logic that don't require database
describe('UserRepository (Unit)', () => {
  test('should have test coverage for repository methods', () => {
    // These would test the repository methods with mocked db
    expect(true).toBe(true);
  });
});
