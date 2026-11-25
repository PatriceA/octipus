/**
 * `dueBefore` is bound as a query parameter. postgres-js (external storage)
 * sent a raw `Date` in a `sql` fragment as `Date.toString()`, so
 * GET /api/tasks?due=today answered 500. Embedded PGlite hid it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isIntegration, setupIntegrationDb, teardownIntegration } from '@/test-helpers/integration';
import { seedUsers } from '@/test-helpers/multiuser-fixtures';

const userId = '33333333-3333-4333-8333-333333333333';

describe.skipIf(!isIntegration)('ScopedTaskRepo dueBefore on external Postgres', () => {
  beforeAll(async () => {
    await setupIntegrationDb();
    await seedUsers([{ id: userId, username: 'due-before' }]);
  });
  afterAll(teardownIntegration);

  test('returns only tasks due by the cutoff', async () => {
    const { scopedRepos } = await import('./scoped');
    const { principalFromUser } = await import('@/security/principal');
    const repo = scopedRepos(principalFromUser({ id: userId, username: 'due-before', isAdmin: false })).tasks;
    const due = await repo.create({ title: 'due', dueAt: new Date('2030-01-01T10:00:00Z') });
    const later = await repo.create({ title: 'later', dueAt: new Date('2030-01-02T10:00:00Z') });
    const undated = await repo.create({ title: 'undated' });
    const ids = (await repo.listOwn({ dueBefore: new Date('2030-01-01T23:59:59.999Z') })).map((t) => t.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(later.id);
    expect(ids).not.toContain(undated.id);
  });
});
