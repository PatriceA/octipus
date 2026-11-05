import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

const goal = { id: 'goal-one', title: 'Finish the project', request: 'Finish the project', outcome: 'Verified delivery', acceptanceCriteria: ['Tests pass'], state: 'active', priority: 0, revision: 1, protectionLevel: 1 };
const defaultSettings = { enabled: false, modelName: '', autonomy: 'observe', maxConcurrent: 2, dailyTokenBudget: 100000, turnTokenBudget: 16000,
  maxRepairAttempts: 2, quietHoursStart: 22, quietHoursEnd: 7, timezone: 'UTC', revision: 0, supervisorSessionId: null };
async function setup(page: import('@playwright/test').Page) {
  await stubAllDefaults(page);
  await page.route('**/api/companion/goals', route => json(route, 200, { goals: [goal] }));
  await page.route('**/api/companion/goals/goal-one', route => json(route, 200, { goal, links: [{ id: 'link', sessionId: 'existing-session', pipelineId: null, purpose: 'Project work', ownership: 'owner', active: true }] }));
  await page.route('**/api/companion/goals/goal-one/incidents', route => json(route, 200, { incidents: [] }));
  await page.route('**/api/companion/goals/goal-one/actions', route => json(route, 200, { actions: [] }));
  await page.route('**/api/companion/settings', route => json(route, 200, defaultSettings));
  await page.route('**/api/models', route => json(route, 200, { models: [{ name: 'Codex', modelId: 'cli/codex', provider: 'cli', supportsTools: true, isEnabled: true }] }));
  await page.route('**/api/sessions?limit=100', route => json(route, 200, { sessions: [{ id: 'existing-session', title: 'Project session' }] }));
  await page.goto('/companion');
  await page.getByRole('button', { name: /Finish the project/ }).click();
  await expect(page.getByRole('region', { name: 'Goal details' })).toBeVisible();
}

test('long requests keep their full content with separately bounded outcome and acceptance', async ({ authenticatedPage: page }) => {
  await setup(page);
  let body: Record<string, unknown> | undefined;
  await page.route('**/api/companion/goals', async route => {
    if (route.request().method() === 'POST') { body = route.request().postDataJSON(); return json(route, 200, goal); }
    return json(route, 200, { goals: [goal] });
  });
  await page.getByLabel('What would you like done?').fill('x'.repeat(3000));
  await page.getByLabel('Desired outcome').fill('Verified delivery');
  await page.getByLabel('Acceptance criteria, one per line').fill('Tests pass\nDeliverable opens');
  await page.getByRole('button', { name: 'Create goal' }).click();
  await expect.poll(() => body?.request).toBe('x'.repeat(3000));
  expect(body?.acceptanceCriteria).toEqual(['Tests pass', 'Deliverable opens']);
});

test('unknown start receipts keep their key across unrelated saves, while acknowledged new starts get fresh keys', async ({ authenticatedPage: page }) => {
  await setup(page);
  const keys: string[] = [];
  await page.route('**/api/companion/goals/goal-one/sessions', route => {
    keys.push(route.request().postDataJSON().requestKey);
    return json(route, keys.length === 1 ? 502 : 200, keys.length === 1 ? { error: 'Receipt lost' } : { id: 'action', sessionId: 'existing-session' });
  });
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('Codex');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Receipt lost');
  await page.getByLabel('Priority').selectOption('2');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
  await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect.poll(() => keys.length).toBe(3);
  expect(keys[2]).not.toBe(keys[1]);
});

test('repeated intentional instructions get distinct action keys after successful acknowledgement', async ({ authenticatedPage: page }) => {
  await setup(page);
  const keys: string[] = [];
  await page.route('**/api/companion/goals/goal-one/messages', route => { keys.push(route.request().postDataJSON().requestKey); return json(route, 200, { id: `action-${keys.length}` }); });
  await page.getByLabel('Adopt an existing session').selectOption('existing-session');
  for (let i = 0; i < 2; i++) {
    await page.getByLabel('Send instructions to the selected session').fill('Continue');
    await page.getByRole('button', { name: 'Send instructions', exact: true }).click();
    await expect(page.getByLabel('Send instructions to the selected session')).toHaveValue('');
  }
  expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
});

test('background supervision settings persist and can be revoked without opening configuration files', async ({ authenticatedPage: page }) => {
  await setup(page);
  let settings = { ...defaultSettings };
  await page.route('**/api/models', route => json(route, 200, { models: [{ name: 'Local supervisor', modelId: 'qwen', provider: 'ollama', supportsTools: true, isEnabled: true }] }));
  await page.route('**/api/companion/settings', route => {
    if (route.request().method() === 'PUT') settings = { ...settings, ...route.request().postDataJSON().settings, revision: settings.revision + 1 };
    return json(route, 200, settings);
  });
  await page.reload();
  const panel = page.getByRole('form', { name: 'Supervision settings' });
  await panel.getByRole('checkbox', { name: 'Enable background supervision' }).check();
  await panel.getByRole('combobox', { name: 'Supervisor model' }).selectOption('Local supervisor');
  await panel.getByRole('button', { name: 'Save supervision settings' }).click();
  await expect.poll(() => settings.enabled).toBe(true);
  await page.reload();
  await expect(panel.getByRole('checkbox', { name: 'Enable background supervision' })).toBeChecked();
  await panel.getByRole('checkbox', { name: 'Enable background supervision' }).uncheck();
  await panel.getByRole('button', { name: 'Save supervision settings' }).click();
  await expect.poll(() => settings.enabled).toBe(false);
});

test('goal-wide execution approval persists without a command list and can be revoked', async ({ authenticatedPage: page }) => {
  await setup(page);
  let current: Record<string, unknown> = {...goal, executionPolicy: null};
  let granted: Record<string, unknown> | undefined;
  await page.route('**/api/companion/goals/goal-one', route=>json(route,200,{goal:current,links:[]}));
  await page.route('**/api/companion/goals/goal-one/authorization', route=>{
    const input=route.request().postDataJSON();granted=input.profile;
    current={...current,revision:Number(current.revision)+1,executionPolicy:input.profile?{profile:input.profile,approvedAt:'2026-11-05T12:00:00Z'}:null};
    return json(route,200,current);
  });
  await page.getByLabel('Repository directory',{exact:true}).fill('/home/you/projects');
  await page.getByLabel('Include host network services, Docker and USB devices').check();
  await page.getByRole('button',{name:'Approve execution for this goal'}).click();
  await expect(page.getByRole('button',{name:'Revoke execution scope'})).toBeVisible();
  expect(granted).toMatchObject({executionScope:'run',repoPath:'/home/you/projects',hostServices:true});
  expect(granted).not.toHaveProperty('commands');
  await page.reload();await page.getByRole('button',{name:/Finish the project/}).click();
  await expect(page.getByRole('button',{name:'Revoke execution scope'})).toBeVisible();
  await page.getByRole('button',{name:'Revoke execution scope'}).click();
  await expect(page.getByRole('button',{name:'Approve execution for this goal'})).toBeVisible();expect(granted).toBeNull();
});

test('recovery exposes the actual verification record supporting resolution',async({authenticatedPage:page})=>{
  await setup(page);
  await page.route('**/api/companion/goals/goal-one/incidents',route=>json(route,200,{incidents:[{id:'incident',sessionId:'existing-session',category:'environment',state:'resolved',summary:'SDK location not found',strategies:['Restore SDK mount'],evidenceId:'evidence-one',updatedAt:'2026-11-05T12:00:00Z'}]}));
  await page.route('**/api/verification/existing-session',route=>json(route,200,{sessionId:'existing-session',verified:true,evidence:[{id:'evidence-one',sessionId:'existing-session',kind:'adhoc',passed:true,createdAt:'2026-11-05T12:00:00Z',detail:{checkScope:'incident:incident',command:'sdk-runtime-check',exitCode:0}}]}));
  await page.reload();await page.getByRole('button',{name:/Finish the project/}).click();
  await page.getByText('Inspect verification',{exact:true}).click();
  await expect(page.getByText('sdk-runtime-check (exit 0)',{exact:true})).toBeVisible();
});
