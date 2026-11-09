import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

const userId = '11111111-1111-4111-8111-111111111111';
test('owner can configure, test, reload and revoke a shared execution environment', async ({ authenticatedPage: page }) => {
  let environments: Record<string, unknown>[] = [];
  const probes: unknown[] = [];
  await page.route('**/api/settings/execution-environments', route => json(route, 200, { environments, credentials: [], userId, machine: 'workstation', account: 'owner', legacy: { sandbox: 'required' } }));
  await page.route('**/api/settings/execution-environments/*', route => {
    const entry = { ...route.request().postDataJSON(), revision: environments.length ? 2 : 1 };
    environments = [entry]; return json(route, 200, { environment: entry });
  });
  await page.route('**/api/settings/execution-environments/*/test', route => {
    probes.push(route.request().postDataJSON());
    return json(route, 200, { status: 'ready', summary: 'Runtime and files are accessible', checks: [{ name: 'Execution', passed: true, detail: 'owner@workstation' }], result: { exitCode: 0, stdout: 'owner\n', stderr: '', timedOut: false } });
  });
  await page.goto('/settings?tab=environments');
  await expect(page.getByRole('heading', { name: 'Environments & Access' })).toBeVisible();
  await page.getByRole('button', { name: 'Add this computer' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Project workstation');
  await page.getByLabel('Project folders').fill('/home/owner/projects');
  await page.getByLabel('Interactive work', { exact: true }).selectOption('automatic');
  await page.getByLabel('Companion and background work').selectOption('automatic');
  await page.getByLabel('I approve this environment').check();
  await page.getByRole('button', { name: 'Save environment' }).click();
  await expect.poll(() => environments[0]?.background).toBe('automatic');
  await page.reload();
  await expect(page.getByText('Project workstation', { exact: true })).toBeVisible();
  await page.getByLabel('Runtime check command').fill('oc whoami');
  await page.getByRole('button', { name: 'Test readiness' }).click();
  await expect.poll(() => probes).toEqual([{ command: 'oc whoami' }]);
  await expect(page.getByText('Runtime and files are accessible')).toBeVisible();
  await page.getByRole('button', { name: 'Disable access' }).click();
  await expect.poll(() => environments[0]?.enabled).toBe(false);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Test readiness' })).toBeDisabled();
});

test('session selection sends the remote folder and shows the actual remote account', async ({ authenticatedPage: page }) => {
  let chosen = false;
  const writes: unknown[] = [];
  await page.route('**/api/sessions/sess-1/execution-environment', route => {
    if (route.request().method() === 'PUT') { writes.push(route.request().postDataJSON()); chosen = true; return json(route, 200, { success: true }); }
    return json(route, 200, { selectedEnvironmentId: chosen ? 'tower' : null, environment: chosen ? { id: 'tower', backend: 'ssh', name: 'Tower', account: 'deploy', machine: 'tower' } : { backend: 'legacy' },
      available: [{ id: 'tower', name: 'Tower', backend: 'ssh', roots: ['/opt/project'] }] });
  });
  await page.goto('/chat?session=sess-1');
  await page.getByRole('combobox', { name: 'Project execution environment' }).selectOption('tower');
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect.poll(() => writes).toEqual([{ environmentId: 'tower', projectPath: '/opt/project', expectedEnvironmentId: null }]);
  await expect(page.getByText('Tower: deploy@tower', { exact: true })).toBeVisible();
});

test('selecting a broad environment preserves a nested project and shows default selection accurately', async ({ authenticatedPage: page }) => {
  const writes: unknown[] = [];
  await page.route('**/api/sessions/sess-1/execution-environment', route => {
    if (route.request().method() === 'PUT') { writes.push(route.request().postDataJSON()); return json(route, 200, { success: true }); }
    return json(route, 200, { selectedEnvironmentId: null, defaultEnvironmentId: 'host', projectPath: '/home/owner/projects/app', environment: { id: 'host', backend: 'host', name: 'Computer' }, available: [{ id: 'host', backend: 'host', name: 'Computer', roots: ['/home/owner/projects'] }] });
  });
  await page.goto('/chat?session=sess-1');
  const selector = page.getByRole('combobox', { name: 'Project execution environment' });
  await expect(selector).toHaveValue('');
  await selector.selectOption('host');
  await expect.poll(() => writes).toEqual([{ environmentId: 'host', projectPath: '/home/owner/projects/app', expectedEnvironmentId: null }]);
  await expect(page.getByRole('button', { name: 'Use this folder' })).toHaveCount(0);
});

test('tools explain whether they use the session environment, server or connection', async ({ authenticatedPage: page }) => {
  await page.route('**/api/tools', route => json(route, 200, { tools: [
    { id: 'shell', name: 'Test shell', version: '1', description: 'Project commands', isInitialized: true, status: 'active', permissions: [], tools: [], execution: { kind: 'environment', program: 'sh' } },
    { id: 'docker', name: 'Test Docker', version: '1', description: 'Container services', isInitialized: true, status: 'active', permissions: [], tools: [], execution: { kind: 'host' } },
    { id: 'connections', name: 'Test connections', version: '1', description: 'Connected services', isInitialized: true, status: 'active', permissions: [], tools: [], execution: { kind: 'connection' } },
  ] }));
  await page.goto('/tools');
  await expect(page.getByText('Session environment', { exact: true })).toBeVisible();
  await expect(page.getByText('Octipus server', { exact: true })).toBeVisible();
  await expect(page.getByText('Configured connection', { exact: true })).toBeVisible();
});

test('workstation automation is a single reviewed grant with inventory and explicit Deny guidance', async ({ authenticatedPage: page }) => {
  let environments: Record<string, unknown>[] = [];
  await page.route('**/api/settings/execution-environments', route => json(route, 200, { environments, credentials: [], userId, machine: 'workstation', account: 'owner', denials: [{ toolId: 'shell', action: 'execute_elevated' }], legacy: { sandbox: 'required' } }));
  await page.route('**/api/settings/execution-environments/*', route => {
    environments = [{ ...route.request().postDataJSON(), revision: 1 }]; return json(route, 200, { environment: environments[0] });
  });
  await page.route('**/api/settings/execution-environments/*/test', route => json(route, 200, { status: 'ready', summary: 'Commands visible', checks: [], inventory: { commands: [{ name: 'gh', path: '/usr/bin/gh' }, { name: 'oc', path: '/usr/local/bin/oc' }, { name: 'tea', path: '/usr/bin/tea' }], sshAliases: ['tower', 'second-machine'], truncated: false } }));
  await page.goto('/settings?tab=environments');
  await expect(page.getByText('shell.execute_elevated', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Set up workstation automation' }).click();
  await expect(page.getByLabel('Execution authority')).toHaveValue('account');
  await expect(page.getByLabel('Companion and background work')).toHaveValue('automatic');
  await expect(page.getByLabel(/Continue routine pipeline sign-offs/)).toBeChecked();
  await expect(page.getByRole('button', { name: 'Save environment' })).toBeDisabled();
  await page.getByLabel('Project folders', { exact: false }).fill('/home/owner/projects');
  await page.getByLabel('I approve this environment', { exact: false }).check();
  await page.getByRole('button', { name: 'Save environment' }).click();
  await expect.poll(() => environments[0]?.authority).toBe('account');
  expect(environments[0]).toMatchObject({ installedPrograms: 'all', hostIdentity: true, hostServices: true, network: true, allowDataTransfer: true, background: 'automatic', pipelineAutonomy: true });
  await page.getByRole('button', { name: 'Test readiness' }).click();
  await expect(page.getByText('/usr/local/bin/oc', { exact: false })).toBeVisible();
  await expect(page.getByText('tower, second-machine', { exact: false })).toBeVisible();
});

test('account environment selection preserves another local worktree without adding folders', async ({ authenticatedPage: page }) => {
  const writes: unknown[] = [];
  await page.route('**/api/sessions/sess-1/execution-environment', route => {
    if (route.request().method() === 'PUT') { writes.push(route.request().postDataJSON()); return json(route, 200, { success: true }); }
    return json(route, 200, { selectedEnvironmentId: null, projectPath: '/home/owner/worktrees/app', environment: { backend: 'host' }, available: [{ id: 'account', backend: 'host', authority: 'account', name: 'Automation', roots: ['/home/owner/projects'] }] });
  });
  await page.goto('/chat?session=sess-1');
  await page.getByRole('combobox', { name: 'Project execution environment' }).selectOption('account');
  await expect.poll(() => writes).toEqual([{ environmentId: 'account', projectPath: '/home/owner/worktrees/app', expectedEnvironmentId: null }]);
  await expect(page.getByRole('button', { name: 'Use this folder' })).toHaveCount(0);
});
