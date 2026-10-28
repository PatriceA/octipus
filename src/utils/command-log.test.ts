import { expect, test } from 'vitest';
import { redactedCommand } from './command-log';

test.each([
  ["curl -H 'X-Api-Key: private-value' https://host", 'private-value'],
  [`curl --data '{"password":"private-value"}' https://host`, 'private-value'],
  ['TOKEN=private-value shutdown -h now', 'private-value'],
  ['go test -run shutdown --api-key "private value"', 'private value'],
  ["curl -H 'Authorization: Bearer private-token' https://host", 'private-token'],
  ['curl https://user:password@host/path?token=private-value', 'password'],
  ['curl https://user:password@host/path?token=private-value', 'private-value'],
])('redacts credentials while retaining command diagnostics: %s', (command, secret) => {
  expect(redactedCommand(command)).not.toContain(secret);
  expect(redactedCommand(command)).toContain('[REDACTED]');
});

test('keeps quoted search patterns available for policy diagnostics', () => {
  const command = "rg -n 'chmod|shutdown|USER|VOLUME' cmd/main.go Dockerfile";
  expect(redactedCommand(command)).toBe(command);
});
