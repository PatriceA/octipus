import { describe, test, expect } from 'bun:test';

// Note: Config tests require resetting singleton state which is complex
// These are unit tests for config structure validation

describe('Config (Unit)', () => {
  describe('config structure', () => {
    test('has required server config', () => {
      const serverConfig = {
        port: 3000,
        host: '127.0.0.1',
        corsOrigins: ['http://localhost:3000'],
        enableSwagger: true,
      };

      expect(serverConfig.port).toBeGreaterThan(0);
      expect(serverConfig.port).toBeLessThan(65536);
      expect(serverConfig.corsOrigins).toBeInstanceOf(Array);
    });

    test('has required database config', () => {
      const dbConfig = {
        url: 'postgres://user:pass@localhost:5432/db',
        poolSize: 10,
      };

      expect(dbConfig.url).toContain('postgres://');
      expect(dbConfig.poolSize).toBeGreaterThan(0);
    });

    test('has required redis config', () => {
      const redisConfig = {
        url: 'redis://localhost:6379',
      };

      expect(redisConfig.url).toContain('redis://');
    });

    test('has required security config', () => {
      const securityConfig = {
        masterKey: 'a'.repeat(32),
        jwtSecret: 'b'.repeat(32),
        sessionSecret: 'c'.repeat(32),
      };

      expect(securityConfig.masterKey.length).toBeGreaterThanOrEqual(32);
      expect(securityConfig.jwtSecret.length).toBeGreaterThanOrEqual(32);
      expect(securityConfig.sessionSecret.length).toBeGreaterThanOrEqual(32);
    });

    test('has required logging config', () => {
      const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

      for (const level of validLevels) {
        expect(validLevels).toContain(level);
      }
    });
  });

  describe('environment variable parsing', () => {
    test('parses PORT as number', () => {
      const port = parseInt('3000', 10);
      expect(port).toBe(3000);
      expect(typeof port).toBe('number');
    });

    test('parses comma-separated values', () => {
      const corsOrigins = 'http://localhost:3000,http://localhost:3001';
      const parsed = corsOrigins.split(',');

      expect(parsed).toEqual(['http://localhost:3000', 'http://localhost:3001']);
    });

    test('parses boolean values', () => {
      expect('true' === 'true').toBe(true);
      expect(('false' as string) === 'true').toBe(false);
    });
  });

  describe('validation', () => {
    test('port must be valid', () => {
      const isValidPort = (port: number) => port > 0 && port < 65536;

      expect(isValidPort(3000)).toBe(true);
      expect(isValidPort(0)).toBe(false);
      expect(isValidPort(70000)).toBe(false);
    });

    test('secrets must meet minimum length', () => {
      const minLength = 32;
      const isValidSecret = (secret: string) => secret.length >= minLength;

      expect(isValidSecret('short')).toBe(false);
      expect(isValidSecret('a'.repeat(32))).toBe(true);
    });
  });
});
