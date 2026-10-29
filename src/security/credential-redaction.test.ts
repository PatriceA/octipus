import { expect, test } from 'vitest';
import { databaseCredentialValues, credentialVariants, redactCredentialData } from './credential-redaction';

test('structured diagnostic masking covers known raw and common transformed canaries before serialization', () => {
  const canary = 'Synthetic-Canary-"quoted"\nwith spaces /+@';
  const forms = credentialVariants([canary]);
  const data = { message: canary, nested: forms.map(value => ({ error: value })), cause: new Error(canary) };
  const serialized = JSON.stringify(redactCredentialData(data, [canary]));
  for (const form of forms) expect(serialized).not.toContain(form);
  expect(serialized).toContain('[REDACTED_CREDENTIAL]');
});

test('unsupported cyclic response data fails closed', () => {
  const cycle: { nested?: unknown } = {}; cycle.nested = cycle;
  expect(() => redactCredentialData(cycle, ['Synthetic-canary'])).toThrow('Unsupported credential-bearing response');
});

test('cyclic errors and opaque binary responses cannot bypass diagnostic masking', () => {
  const error = new Error('synthetic'); error.cause = error;
  expect(() => redactCredentialData(error, ['Synthetic-canary'])).toThrow('Unsupported credential-bearing response');
  expect(() => redactCredentialData(Buffer.from('Synthetic-canary'), ['Synthetic-canary'])).toThrow('Unsupported credential-bearing response');
});


test('database credential masks include URI and password query-option values independently', () => {
  const dsn = 'postgres://user:synthetic%20uri%2Bpassword@localhost/db?password=synthetic-query-password&sslpassword=synthetic-ssl-password';
  const values = databaseCredentialValues(dsn);
  expect(values).toEqual(expect.arrayContaining(['synthetic uri+password', 'synthetic-query-password', 'synthetic-ssl-password']));
  const safe = redactCredentialData({ error: 'synthetic uri+password', row: 'synthetic-query-password', ssl: 'synthetic-ssl-password' }, values);
  expect(safe).toEqual({ error: '[REDACTED_CREDENTIAL]', row: '[REDACTED_CREDENTIAL]', ssl: '[REDACTED_CREDENTIAL]' });
});
