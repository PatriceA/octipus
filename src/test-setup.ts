/**
 * Test setup — runs before all tests.
 *
 * Generates ephemeral random secrets per process so committed test fixtures
 * never resemble production credentials. Existing env vars (e.g. for
 * integration tests pointing at a real DB) take precedence.
 */
import { randomBytes } from 'crypto';

const rand = (bytes: number) => randomBytes(bytes).toString('hex');

process.env.NODE_ENV = 'test';
// A URL that resolves to NOTHING, on purpose. The old default named
// `test:test@localhost:5432/octipus_test` — the database name is the one the
// integration lane uses, but the role and port are not (that lane is role
// `octipus` on 5443), so nothing in this repo ever creates what it names. It
// read like a configured test database and behaved like a decoy: a
// unit test that fell through to a query died with `role "test" does not
// exist`, and the suite stayed green only because a permission rule normally
// short-circuited before the query — which file ran first decided whether it
// did. On a machine that happens to have a `test` role it was worse: unit
// tests silently querying a developer's own Postgres.
//
// The lanes that need a real database say so themselves: the integration
// runner exports DATABASE_URL (`scripts/test-integration.ts`) and embedded
// suites set STORAGE_MODE=embedded, and both win here because this is a `??`.
// For everything else, reaching the database is the bug, and the host name is
// the error message.
export const UNROUTABLE_DATABASE_URL =
  'postgres://none:none@no-database-in-this-test-lane.invalid:5432/none';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? UNROUTABLE_DATABASE_URL;
process.env.LITELLM_URL = process.env.LITELLM_URL ?? 'http://localhost:4000';
process.env.MASTER_KEY = process.env.MASTER_KEY ?? `test-master-${rand(24)}`;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? `test-session-${rand(24)}`;
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

export const TEST_CONFIG = {
  masterKey: process.env.MASTER_KEY,
  jwtSecret: process.env.JWT_SECRET,
  sessionSecret: process.env.SESSION_SECRET,
};
