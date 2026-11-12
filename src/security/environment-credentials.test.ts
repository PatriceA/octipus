import { afterEach, expect, it, vi } from 'vitest';
import { getConfig } from '@/config';
import { executionEnvironmentSchema } from '@/shared/execution-environment';
import { buildAgentContext } from '@/core/agent/context';
import { environmentCredentialOptions } from './environment-credentials';
const vault = vi.hoisted(() => ({ getByNameAuthorized: vi.fn() }));
vi.mock('./vault', () => ({ getVault: () => vault }));
const userId = '11111111-1111-4111-8111-111111111111';
const original = getConfig().security.executionEnvironments;
afterEach(() => { getConfig().security.executionEnvironments = original; vi.resetAllMocks(); });
const context = buildAgentContext({ id: 'worker', userId, sessionId: 'session', role: 'general', topic: 'general', model: 'fixture', status: 'running', scope: { workspaceId: null, space: null, trigger: 'user', funding: 'own' }, metadata: {} });
function configure() { getConfig().security.executionEnvironments = [executionEnvironmentSchema.parse({ id: 'host', name: 'Computer', backend: 'host', userId, roots: ['/projects'], isDefault: true, credentials: [{ variable: 'GH_TOKEN', secret: 'github-cli' }] })]; }
it('authorizes the exact consumer and masks raw/encoded credentials in output and errors', async () => {
  configure(); vault.getByNameAuthorized.mockResolvedValue('synthetic-owner-token');
  const runtime = await environmentCredentialOptions(context, { timeout: 50, env: { HELLO: 'world' } });
  expect(vault.getByNameAuthorized).toHaveBeenCalledWith({ userId, workspaceId: null, toolId: 'execution-environment', agentId: 'worker' }, 'github-cli');
  expect(runtime.options.env).toEqual({ HELLO: 'world', GH_TOKEN: 'synthetic-owner-token' });
  const output = runtime.mask({ stdout: 'synthetic-owner-token', stderr: Buffer.from('synthetic-owner-token').toString('base64') });
  expect(JSON.stringify(output)).not.toContain('synthetic-owner-token'); expect(output.stderr).toBe('[REDACTED_CREDENTIAL]');
  const error = new Error('synthetic-owner-token', { cause: new Error('synthetic-owner-token') });
  expect(runtime.maskError(error)).toBe(error); expect(JSON.stringify(error)).not.toContain('synthetic-owner-token'); expect(error.message).toBe('[REDACTED_CREDENTIAL]');
});
it('fails before spawning when a configured credential is unavailable', async () => {
  configure(); vault.getByNameAuthorized.mockResolvedValue(null);
  await expect(environmentCredentialOptions(context, {})).rejects.toThrow('unavailable');
});

it('masks inherited host CLI environment credentials too', async () => {
  configure(); getConfig().security.executionEnvironments[0].hostIdentity = true;
  vault.getByNameAuthorized.mockResolvedValue('bound-secret');
  const previous = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_SECRET_ACCESS_KEY = 'inherited-cli-secret';
  try { const runtime = await environmentCredentialOptions(context, {}); expect(runtime.mask({ stdout: 'inherited-cli-secret' }).stdout).toBe('[REDACTED_CREDENTIAL]'); }
  finally { if (previous === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = previous; }
});
