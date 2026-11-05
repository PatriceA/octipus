import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

test('a user approves the entire run without command lists, retains it after reload and can revoke it', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await page.route('**/api/verification/scope-session', route => json(route, 200, { evidence: [] }));
  let profile: Record<string, unknown> = { repoPath: '/work/project', commands: ['old command'], hostServices: true };
  const writes: Array<Record<string, unknown>> = [];
  let resumes = 0;
  await page.route('**/api/agents/scope-agent', route => json(route, 200, {
    id: 'scope-agent', sessionId: 'scope-session', userId: 'e2e-user-id', topic: 'general', model: 'fixture', status: 'completed', iteration: 1, createdAt: new Date().toISOString(), metadata: {},
  }));
  await page.route('**/api/pipelines', route => json(route, 200, { pipelines: [{ id: 'scope-run', rootAgentId: 'scope-agent' }] }));
  await page.route('**/api/pipelines/scope-run', route => json(route, 200, { pipeline: { id: 'scope-run', title: 'Deployment', type: 'development', status: 'paused', currentNodeKey: null, metadata: { permissionProfile: { profile } } }, nodes: [] }));
  await page.route('**/api/pipelines/scope-run/resume', route => { resumes++; return json(route, 200, { resuming: true }); });
  await page.route('**/api/pipelines/scope-run/permission-profile', route => {
    const body = route.request().postDataJSON();
    expect(body.confirmed).toBe(true);
    profile = body.profile; writes.push(profile);
    return json(route, 200, { saved: true, profile });
  });
  await page.goto('/agents/view?id=scope-agent');
  const panel = page.getByRole('region', { name: 'Run permissions' });
  await expect(panel).toContainText('Current shell approval: Individual commands');
  await expect(panel).toContainText('credentials and private data');
  await panel.getByRole('button', { name: 'Approve entire run' }).click();
  await expect(panel).toContainText('Permissions saved');
  expect(writes[0]).toMatchObject({ repoPath: '/work/project', executionScope: 'run', commands: [], hostServices: true });
  expect(resumes).toBe(0);
  await page.reload();
  await expect(panel).toContainText('Current shell approval: Entire run');
  await panel.getByRole('button', { name: 'Revoke run-wide shell approval' }).click();
  await expect(panel).toContainText('Current shell approval: Individual commands');
  expect(writes[1]).toMatchObject({ executionScope: 'commands', commands: [], packageManagers: [], publicHosts: [] });
});

test('run permission save errors remain visible and do not claim approval', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await page.route('**/api/verification/scope-session', route => json(route, 200, { evidence: [] }));
  await page.route('**/api/agents/scope-agent', route => json(route, 200, { id: 'scope-agent', sessionId: 'scope-session', topic: 'general', model: 'fixture', status: 'completed', iteration: 1, metadata: {} }));
  await page.route('**/api/pipelines', route => json(route, 200, { pipelines: [{ id: 'scope-run', rootAgentId: 'scope-agent' }] }));
  await page.route('**/api/pipelines/scope-run', route => json(route, 200, { pipeline: { id: 'scope-run', title: 'Deployment', status: 'paused', metadata: { permissionProfile: { profile: { repoPath: '/work/project' } } } }, nodes: [] }));
  await page.route('**/api/pipelines/scope-run/permission-profile', route => json(route, 409, { error: 'Pause or stop the pipeline before changing its permissions' }));
  await page.goto('/agents/view?id=scope-agent');
  await page.getByRole('button', { name: 'Approve entire run' }).click();
  await expect(page.getByRole('alert')).toContainText('Pause or stop');
  await expect(page.getByRole('region', { name: 'Run permissions' })).toContainText('Current shell approval: Individual commands');
});
