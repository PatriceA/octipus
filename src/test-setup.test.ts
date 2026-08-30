import { describe, expect, test } from 'vitest';
import { UNROUTABLE_DATABASE_URL } from './test-setup';

/**
 * The default must be unable to reach a database — any database.
 *
 * It used to name `test:test@localhost:5432/octipus_test`, which reads like a
 * configured test database and is not one: the integration lane uses that
 * database name but role `octipus` on port 5443, so nothing creates the role or
 * listens on the port this named. A unit test that fell through to a query died with
 * `role "test" does not exist`, and the suite stayed green only because a
 * permission rule usually short-circuited first — order-dependent, so adding a
 * test could flip it. On a machine that does have a `test` role it is worse:
 * the unit suite quietly queries a developer's own Postgres.
 *
 * `.invalid` is reserved by RFC 2606 and guaranteed never to resolve, so the
 * failure is immediate and the host name says what went wrong.
 */
describe('the fallback DATABASE_URL', () => {
  test('names a host that can never resolve', () => {
    expect(new URL(UNROUTABLE_DATABASE_URL).hostname).toMatch(/\.invalid$/);
  });
});
