import { expect, test } from 'vitest';
import { redactedCommand } from './command-log';

test.each([
  ["curl -H 'X-Api-Key: private-value' https://host", 'private-value'],
  [`curl --data '{"password":"private-value"}' https://host`, 'private-value'],
  ['YAEMP_TEST_ADMIN_URL=postgres://owner:private-value@localhost/db go test ./...', 'private-value'],
  ['postgres://owner:private-value@extra@localhost/db', 'private-value@extra'],
  ['curl --user alice:private-value https://host', 'private-value'],
  ['curl --user=alice:private-value https://host', 'private-value'],
  ['curl -ualice:private-value https://host', 'private-value'],
  ['curl --proxy-user alice:private-value https://host', 'private-value'],
  [`curl --header='Authorization: Bearer private-value' https://host`, 'private-value'],
  [`curl --data='{"password":"private-value"}' https://host`, 'private-value'],
  [`curl -HAuthorization:Bearer\\ private-value https://host`, 'private-value'],
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


test.each([
  String.raw`TOKEN="first\"second" go test`,
  String.raw`curl --user "alice:first\"second" https://host`,
  `curl -H 'X-Api-Key: first"second' https://host`,
  `TOKEN='first'"second" go test`,
  `curl --user 'alice:first'"second" https://host`,
  `sh -c 'curl --user alice:firstsecond https://host; shutdown -h now'`,
])('consumes complete credential words, including escaped and mixed quotes: %s', command => {
  const output = redactedCommand(command);
  expect(output).toContain('[REDACTED]');
  expect(output).not.toContain('first');
  expect(output).not.toContain('second');
});
