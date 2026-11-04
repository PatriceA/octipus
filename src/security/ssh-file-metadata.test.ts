import { expect, test } from 'vitest';
import { matchesSshFileMetadata } from './ssh-file-metadata';

const scope = { target: 'root@docker-01', cwd: '/repo', paths: ['/stack/rollback/compose.yaml', '/stack/rollback/.env', '/stack/rollback/backend.tar'] };
const call = (remote: string, args: Record<string, unknown> = {}) => ({ toolId: 'shell', toolName: 'run', action: 'execute', args: { cwd: '/repo', command: `ssh root@docker-01 '${remote}'`, network: true, ...args } });
test.each([
  'stat --format=%n:%s:%a /stack/rollback/compose.yaml /stack/rollback/.env /stack/rollback/backend.tar',
  'stat -c %s /stack/rollback/.env',
  'stat --format=%a /stack/rollback/backend.tar /stack/rollback/compose.yaml',
])('approved metadata scope covers named files and subsets: %s', remote => {
  expect(matchesSshFileMetadata(scope, call(remote))).toBe(true);
});
test('transport-only SSH options keep the same metadata scope', () => {
  const c = call('stat --format=%n:%s:%a /stack/rollback/.env');
  c.args.command = c.args.command.replace('ssh ', 'ssh -o BatchMode=yes -o ConnectTimeout=15 ');
  expect(matchesSshFileMetadata(scope, c)).toBe(true);
});
test.each([
  'cat /stack/rollback/.env',
  'stat --format=%n:%s:%a /stack/live/.env',
  'stat --format=%n:%s:%a /stack/rollback/../live/.env',
  'stat --format=%n:%s:%a /stack/rollback/*',
  'stat --format=%n:%s:%a /stack/rollback/.env; cat /stack/rollback/.env',
  'stat --format=%n:%s:%a /stack/rollback/.env > /stack/out',
  'stat --format=%n:%s:%a $(cat /stack/rollback/.env)',
  'stat --printf=%n:%s:%a /stack/rollback/.env',
  'stat --format=@/stack/rollback/.env /stack/rollback/.env',
  'stat --format=%n:%s:%a',
  'stat -L --format=%s /stack/rollback/.env',
])('metadata scope never allows contents, other paths or additional effects: %s', remote => {
  expect(matchesSshFileMetadata(scope, call(remote))).toBe(false);
});
test('a different host, cwd, shell mode or environment stays outside the scope', () => {
  const c = call('stat --format=%s /stack/rollback/.env');
  expect(matchesSshFileMetadata(scope, { ...c, args: { ...c.args, command: c.args.command.replace('docker-01', 'other-host') } })).toBe(false);
  for (const args of [{ cwd: '/other' }, { useShell: true }, { env: { SECRET: 'value' } }]) {
    expect(matchesSshFileMetadata(scope, call('stat --format=%s /stack/rollback/.env', args))).toBe(false);
  }
});
