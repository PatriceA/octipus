/**
 * Test setup - runs before all tests
 * Sets up mock environment variables for testing
 */

// Set required environment variables for tests
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/assistant_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.LITELLM_URL = 'http://localhost:4000';
process.env.MASTER_KEY = 'test-master-key-that-is-at-least-32-characters-long';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';
process.env.SESSION_SECRET = 'test-session-secret-that-is-32-chars-long';
process.env.LOG_LEVEL = 'error'; // Minimize logs during tests

// Export for tests that need to reference these
export const TEST_CONFIG = {
  masterKey: process.env.MASTER_KEY,
  jwtSecret: process.env.JWT_SECRET,
  sessionSecret: process.env.SESSION_SECRET,
};
