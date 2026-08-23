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
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/octipus_test';
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
