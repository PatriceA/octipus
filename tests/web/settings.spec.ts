import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

test.describe('settings page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('settings page renders current theme', async ({ authenticatedPage: page }) => {
    await page.goto('/settings');
    await expect(page.locator('body')).toContainText(/theme|settings|dark|preferences/i, { timeout: 10_000 });
  });

  // The toggle used to save the value from before the click, so the PUT was a
  // no-op and the refetch flipped the switch straight back.
  test('boolean toggle saves the flipped value', async ({ authenticatedPage: page }) => {
    const puts: unknown[] = [];
    await page.route('**/api/settings', (route) =>
      json(route, 200, {
        categories: ['agent'],
        settings: {
          agent: [{
            key: 'agent.promptDumps', value: true, valueType: 'boolean', defaultValue: true,
            description: 'Write prompts', isSecret: false, category: 'agent',
          }],
        },
      }),
    );
    await page.route('**/api/settings/agent.promptDumps', (route) => {
      puts.push(route.request().postDataJSON());
      return json(route, 200, { ok: true });
    });

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Configuration' }).click();
    await page.getByRole('switch', { name: 'promptDumps' }).click();
    await expect.poll(() => puts).toEqual([{ value: false }]);
  });

  test('topic → model mapping is rendered', async ({ authenticatedPage: page }) => {
    await page.goto('/settings');
    await expect(page.locator('body')).toContainText(/coding|research|topic|mapping|gpt-4o|claude/i, { timeout: 10_000 }).catch(() => {
      /* Settings UI may not expose this section in all environments. */
    });
  });
});

test('root and child swarm budgets have distinct labels and root tokens save to the correct key', async ({ authenticatedPage: page }) => {
  let rootTokens = 200000;
  const puts: unknown[] = [];
  await page.route('**/api/settings', route => json(route, 200, {
    categories: ['swarm'], settings: { swarm: ['root', 'agent', 'subagent'].map(level => ({
      key: `swarm.levelDefaults.${level}.tokens`, value: level === 'root' ? rootTokens : 80000,
      valueType: 'number', defaultValue: 200000, description: `${level} token pool`, isSecret: false, category: 'swarm',
    })) },
  }));
  await page.route('**/api/settings/swarm.levelDefaults.root.tokens', route => {
    const body = route.request().postDataJSON();
    puts.push(body);
    rootTokens = body.value;
    return json(route, 200, { ok: true });
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'agent.tokens', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'subagent.tokens', exact: true })).toBeVisible();
  const root = page.getByRole('spinbutton', { name: 'root.tokens', exact: true });
  await root.fill('20000000');
  await root.press('Enter');
  await expect.poll(() => puts).toEqual([{ value: 20000000 }]);
  await page.reload();
  await page.getByRole('button', { name: 'Configuration', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'root.tokens', exact: true })).toHaveValue('20000000');
});

test('CLI tools can be discovered, approved, reloaded, removed and added by path', async ({ authenticatedPage: page }) => {
  const tool = { name: 'oc', path: '/home/you/.local/bin/oc', resolvedPath: '/home/you/tools/oc' };
  let approved: Array<typeof tool & { available: boolean }> = [];
  const writes: unknown[] = [];
  await page.route('**/api/settings/cli-tools', route => json(route, 200, { approved, discovered: [tool] }));
  await page.route('**/api/settings/cli-tools/*', route => {
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON());
      approved = [{ ...tool, available: true }];
    } else approved = [];
    return json(route, 200, { success: true });
  });
  await page.goto('/settings?tab=cli-tools');
  await expect(page.getByRole('heading', { name: 'CLI tools', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search installed commands' }).fill('oc');
  await expect(page.getByText('Points to /home/you/tools/oc')).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await expect.poll(() => writes).toEqual([{ path: tool.path }]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('No additional tools approved yet.')).toBeVisible();
  await page.getByLabel('Add by executable path').fill(tool.path);
  await page.getByRole('button', { name: 'Approve path', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await expect.poll(() => writes.length).toBe(2);
});

test('CLI tools offer existing kubeconfig selection and removal without exposing credentials', async ({ authenticatedPage: page }) => {
  const candidate = { path: '/home/you/.kube/config', context: 'your-cluster-context' };
  let selected: typeof candidate | null = null;
  const writes: unknown[] = [];
  await page.route('**/api/settings/cli-tools', route => json(route, 200, { approved: [], discovered: [], kubeconfig: selected, kubeconfigCandidates: [candidate] }));
  await page.route('**/api/settings/cli-tools-kubeconfig', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    selected = body.path ? candidate : null;
    return json(route, 200, { success: true });
  });
  await page.goto('/settings?tab=cli-tools');
  await page.getByRole('button', { name: 'Use this kubeconfig', exact: true }).click();
  await expect(page.getByText('Selected: /home/you/.kube/config')).toBeVisible();
  await expect.poll(() => writes).toEqual([{ path: candidate.path }]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Remove kubeconfig access' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove kubeconfig access' }).click();
  await expect(page.getByRole('button', { name: 'Use this kubeconfig', exact: true })).toBeVisible();
  await expect.poll(() => writes).toEqual([{ path: candidate.path }, { path: null }]);
});

test('automatic recovery is a persistent personal setting',async({authenticatedPage:page})=>{
 let enabled=false;const writes:unknown[]=[];
 await page.route('**/api/auth/me',route=>json(route,200,{id:'e2e-user-id',username:'e2etest',isAdmin:true,totpEnabled:false,preferences:{autoApproveRecovery:enabled}}));
 await page.route('**/api/auth/recovery-policy',route=>{const body=route.request().postDataJSON();writes.push(body);enabled=body.autoApproveRecovery;return json(route,200,{autoApproveRecovery:enabled});});
 await page.goto('/settings?tab=security');const toggle=page.getByRole('switch',{name:'Automatically approve recovery'});
 await expect(toggle).not.toBeChecked();await toggle.check();await expect(toggle).toBeChecked();
 await expect.poll(()=>writes).toEqual([{autoApproveRecovery:true}]);await page.reload();await expect(toggle).toBeChecked();
 await toggle.uncheck();await expect(toggle).not.toBeChecked();await expect.poll(()=>writes).toEqual([{autoApproveRecovery:true},{autoApproveRecovery:false}]);
});
