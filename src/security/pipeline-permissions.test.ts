import { expect, test } from 'vitest';
import { pipelinePermissionProfileSchema } from '@/shared/pipeline-permissions';
import { profileAllows } from './pipeline-permissions';
const profile = pipelinePermissionProfileSchema.parse({ repoPath: '/repo', publicHosts: ['go.dev', 'proxy.golang.org'],
  packageManagers: ['pnpm', 'go'], dockerProjects: ['project-test'], commands: ['pnpm exec vitest run'] });
const call = (command: string, cwd = '/repo') => ({ toolId: 'shell', toolName: 'run', action: 'execute', args: { command, cwd } });
test.each(["curl --head 'https://go.dev/dl/?mode=json&include=all'", 'curl -s https://proxy.golang.org/list',
  'pnpm install', 'go version', 'docker compose -p project-test build', 'pnpm exec vitest run'])('run profile covers %s', command => {
  expect(profileAllows(profile, call(command))).toBe(true);
});
test.each(['curl -H Authorization:secret https://go.dev', 'curl https://unapproved.example', 'curl https://user:secret@go.dev',
  'pnpm install; rm -rf /repo', 'pnpm -C /other install', 'docker compose -p other build', 'go run ./unapproved.go', 'rm -rf /repo'])('asks for outside-profile command %s', command => {
  expect(profileAllows(profile, call(command))).toBe(false);
});
test('scope includes the repository and argument-dependent destructive action', () => {
  expect(profileAllows(profile, call('pnpm install', '/other'))).toBe(false);
  expect(profileAllows(profile, { ...call('pnpm install'), action: 'execute_destructive' })).toBe(false);
});

test('a profile can cover a target repo and a second repo without approving other directories (#54)', () => {
  const target = pipelinePermissionProfileSchema.parse({ repoPath: '/work/moco-rebuild', repoPaths: ['/work/shared'], packageManagers: ['pnpm'] });
  expect(profileAllows(target, call('pnpm test', '/work/moco-rebuild'))).toBe(true);
  expect(profileAllows(target, call('pnpm test', '/work/shared'))).toBe(true);
  expect(profileAllows(target, call('pnpm test', '/work/octipus'))).toBe(false);
  expect(target.allowTimedOutCommands).toBe(false);
});
