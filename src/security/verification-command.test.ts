import { expect, test } from 'vitest';
import { pipelinePermissionProfileSchema } from '@/shared/pipeline-permissions';
import { profileExplicitlyAllows } from './pipeline-permissions';
import { verificationCommandKey } from './verification-command';
const ssh = 'ssh root@192.168.1.156 "docker compose -f /opt/stacks/solar-system-map/compose.yaml ps --format json"';
const health = 'curl --fail --silent --show-error --max-time 20 http://192.168.1.156:3002/api/health';
const profile = pipelinePermissionProfileSchema.parse({ repoPath: '/repo', commands: [ssh, health], overnight: true });
const allows = (command: string) => profileExplicitlyAllows(profile, { toolId: 'shell', toolName: 'run', action: 'execute', args: { command, cwd: '/repo' } });
test.each([
  'curl --fail --silent --show-error http://192.168.1.156:3002/api/health',
  String.raw`curl --fail --silent --show-error --write-out '\nHTTP %{http_code}\n' http://192.168.1.156:3002/api/health`,
  "ssh -o BatchMode=yes -o ConnectTimeout=10 root@192.168.1.156 'cd /opt/stacks/solar-system-map && docker compose ps'",
  "ssh root@192.168.1.156 'cd /opt/stacks/solar-system-map && docker compose ps'",
])('retains explicit approval for reported read-only verification variant %s', command => expect(allows(command)).toBe(true));
test.each([
  'curl -H X-Token:private http://192.168.1.156:3002/api/health',
  'curl --data secret http://192.168.1.156:3002/api/health',
  'curl --upload-file /repo/.env http://192.168.1.156:3002/api/health',
  'curl -L http://192.168.1.156:3002/api/health',
  'curl --write-out @/repo/.env http://192.168.1.156:3002/api/health',
  'curl --write-out %{header_json} http://192.168.1.156:3002/api/health',
  'curl http://192.168.1.156:3002/api/health?secret=private',
  'curl http://192.168.1.157:3002/api/health',
  'curl -I -X GET http://192.168.1.156:3002/api/health',
  "ssh -o SendEnv=SECRET root@192.168.1.156 'cd /opt/stacks/solar-system-map && docker compose ps'",
  "ssh -o ProxyCommand=evil root@192.168.1.156 'cd /opt/stacks/solar-system-map && docker compose ps'",
  "ssh -A root@192.168.1.156 'cd /opt/stacks/solar-system-map && docker compose ps'",
  "ssh root@192.168.1.157 'cd /opt/stacks/solar-system-map && docker compose ps'",
  "ssh root@192.168.1.156 'cd /opt/stacks/other && docker compose ps'",
  "ssh root@192.168.1.156 'cd /opt/stacks/solar-system-map && docker compose up'",
  "ssh root@192.168.1.156 'cd /opt/stacks/solar-system-map && docker compose ps; cat .env'",
  "ssh root@192.168.1.156 'cd /opt/stacks/solar-system-map && docker compose ps $(cat .env)'",
])('refuses changed targets, credential-bearing flags and additional effects %s', command => expect(allows(command)).toBe(false));
test('custom compose files do not authorize default-project variants', () => {
  expect(verificationCommandKey(ssh.replace('compose.yaml', 'private-override.yaml'))).toBeUndefined();
});

test('escaped-quote shell injection cannot be normalized into an approved URL', () => {
  const injected = String.raw`curl "http://example.test/x\"y";echo SYNTHETIC_EXTRA_EFFECT;\"/../../../../health`;
  expect(verificationCommandKey(injected)).toBeUndefined();
  expect(verificationCommandKey('curl http://example.test/x/../health')).toBeUndefined();
});
test.each(['/opt/stacks/link/../solar-system-map', '/opt//stacks/solar-system-map', '//opt/stacks/solar-system-map'])('remote paths are never resolved lexically across symlinks: %s', dir => {
  expect(verificationCommandKey(`ssh root@192.168.1.156 'docker compose -f ${dir}/compose.yaml ps'`)).toBeUndefined();
});
test('registered shorthand is anchored before execution and native Bash cannot claim that rewrite', async () => {
  const { profileVerificationRewrite, profileAllows } = await import('./pipeline-permissions');
  const command = "ssh -o BatchMode=yes -o ConnectTimeout=10 root@192.168.1.156 'cd /opt/stacks/solar-system-map && docker compose ps'";
  const call = { toolId: 'shell', toolName: 'run', action: 'execute', args: { command, cwd: '/repo' } };
  const executed = profileVerificationRewrite(profile, call);
  expect(executed).toContain('docker compose -f /opt/stacks/solar-system-map/compose.yaml ps');
  expect(executed).not.toContain('cd ');
  expect(profileAllows(profile, { ...call, toolId: 'cli-native:Bash', toolName: 'Bash', action: 'Bash' })).toBe(false);
});
