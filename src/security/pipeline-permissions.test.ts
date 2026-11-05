import { expect, test } from 'vitest';
import { pipelinePermissionProfileSchema } from '@/shared/pipeline-permissions';
import { profileAllows, profileExplicitlyAllows } from './pipeline-permissions';
import { proposedPipelinePermissionProfileSchema, permissionProfileDisclosure } from '@/shared/pipeline-permissions';
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


test.each([undefined, null, '', '.', './repo'])('a profile never substitutes its repo for an unknown execution cwd: %j', cwd => {
  const approved = pipelinePermissionProfileSchema.parse({ repoPath: process.cwd(), commands: ['pnpm test'] });
  expect(profileAllows(approved, { toolId: 'shell', toolName: 'run', action: 'execute', args: { command: 'pnpm test', ...(cwd === undefined ? {} : { cwd }) } })).toBe(false);
});

test('new proposals default to run scope; old stored approvals retain command scope', () => {
  const old = pipelinePermissionProfileSchema.parse({ repoPath: '/repo' });
  const proposed = proposedPipelinePermissionProfileSchema.parse({ repoPath: '/repo' });
  expect(old.executionScope).toBe('commands');
  expect(proposed.executionScope).toBe('run');
  expect(permissionProfileDisclosure(proposed)).toMatch(/credentials and private data/);
  expect(permissionProfileDisclosure(proposed)).toMatch(/not a network destination allowlist/);
});

test.each([
  'ssh root@tower "docker compose exec -T backend node -e \'db.query(sql)\'"',
  'curl --fail --max-time 20 http://tower/api/health',
  'python3 deploy.py --backup && python3 deploy.py --verify',
  'rm -rf ./temporary-test-stack',
])('run approval covers new shell work and data-flow consent without a command list: %s', command => {
  const run = proposedPipelinePermissionProfileSchema.parse({ repoPath: '/repo', repoPaths: ['/worktree'] });
  for (const cwd of ['/repo', '/repo/backend', '/worktree/qa']) {
    expect(profileExplicitlyAllows(run, call(command, cwd))).toBe(true);
    expect(profileAllows(run, { ...call(command, cwd), action: 'execute_destructive' })).toBe(true);
    expect(profileAllows(run, { ...call(command, cwd), toolName: 'run_background' })).toBe(true);
    expect(profileAllows(run, { toolId: 'cli-native:Bash', toolName: 'Bash', action: 'Bash', args: { command, cwd } })).toBe(true);
  }
  expect(profileAllows(run, call(command, '/repo-foreign'))).toBe(false);
  expect(profileAllows(run, { ...call(command), args: { command, cwd: '/repo', dangerouslyDisableSandbox: true } })).toBe(false);
  expect(profileAllows(run, { ...call(command), toolId: 'unrelated' })).toBe(false);
  expect(profileAllows(run, { ...call(command), toolName: 'unknown' })).toBe(false);
});
