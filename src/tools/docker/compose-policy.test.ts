import { expect, test } from 'vitest';
import { validateComposeConfig } from './compose-policy';
const config = (service: Record<string, unknown>) => ({ name: 'demo', services: { web: service } });
test('a repository-scoped test stack can publish only explicitly approved ports', () => {
  const valid = config({ image: 'nginx:alpine', ports: [{ published: '4300', target: 80 }], volumes: [{ type: 'volume', source: 'demo_public', target: '/app' }] });
  expect(() => validateComposeConfig(valid, '/repo', [4300])).not.toThrow();
  expect(() => validateComposeConfig(valid, '/repo', [])).toThrow('approvedPorts');
});
test.each([{ privileged: true }, { deploy: { resources: { reservations: { devices: [{ capabilities: ['gpu'] }] } } } }, { device_cgroup_rules: ['a *:* rwm'] }, { security_opt: ['seccomp=unconfined'] }, { build: { network: 'host' } }, { network_mode: 'host' }, { devices: ['/dev/sda'] }, { container_name: 'another-stack' }, { volumes: [{ type: 'bind', source: '/var/run/docker.sock' }] }, { build: { ssh: ['default'] } }])('refuses host access and cross-project resources: %j', service => {
  expect(() => validateComposeConfig(config(service), '/repo', [])).toThrow();
});
test('external and custom volumes cannot enter project cleanup', () => {
  expect(() => validateComposeConfig({ ...config({}), volumes: { db: { external: true } } }, '/repo', [])).toThrow('project-owned');
});

test('rejects imports and host file consumers before Docker can flatten their provenance', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { validateRawCompose } = await import('./compose-policy');
  const dir = await mkdtemp(join(tmpdir(), 'compose-raw-'));
  try {
    for (const text of ['include: /outside/compose.yaml', 'services:\n  web:\n    extends:\n      file: /outside/compose.yaml', 'services:\n  web:\n    env_file: /outside/secret.env']) {
      const file = join(dir, 'compose.yaml'); await writeFile(file, text);
      await expect(validateRawCompose(file, dir)).rejects.toThrow(/unsupported|inside the approved repository/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('host bind mounts work only within explicitly approved host paths', () => {
  const service = config({ image: 'nginx', volumes: [{ type: 'bind', source: '/opt/app/data', target: '/data' }] });
  expect(() => validateComposeConfig(service, '/repo', [], ['/opt/app/data'])).not.toThrow();
  expect(() => validateComposeConfig(service, '/repo', [], ['/repo'])).toThrow('approvedBindPaths');
  expect(() => validateComposeConfig(service, '/repo', [])).toThrow('approvedBindPaths');
});

test('repository env files and local builds are supported, but symlink escapes and external build contexts are refused', async () => {
  const { mkdtemp, writeFile, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { validateRawCompose } = await import('./compose-policy');
  const dir = await mkdtemp(join(tmpdir(), 'compose-local-build-'));
  const outside = await mkdtemp(join(tmpdir(), 'compose-outside-'));
  try {
    const file = join(dir, 'compose.yaml');
    await writeFile(join(dir, '.env'), 'EXAMPLE=test');
    await writeFile(join(dir, 'Dockerfile'), 'FROM scratch');
    const valid = 'services:\n  app:\n    build: .\n    env_file: .env';
    await writeFile(file, valid);
    await expect(validateRawCompose(file, dir)).resolves.toBe(valid);
    expect(() => validateComposeConfig(config({ build: { context: dir }, env_file: [{ path: join(dir, '.env') }] }), dir, [])).not.toThrow();
    await symlink(outside, join(dir, 'escape'));
    for (const body of ['build: ./escape', 'env_file: ./escape/file.env', 'build: "${CONTEXT}"', 'build:\n      context: .\n      ssh: [default]']) {
      await writeFile(file, `services:\n  app:\n    ${body}`);
      await expect(validateRawCompose(file, dir)).rejects.toThrow();
    }
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
