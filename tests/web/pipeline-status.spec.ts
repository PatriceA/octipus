import { expect, test } from './fixtures/auth';
import { json, selectChatSession } from './fixtures/api-stubs';
import { stubGateway } from './fixtures/gateway';

test('companion stays working while a background worker runs after the reply', async ({ authenticatedPage: page }) => {
  const gateway = await stubGateway(page);
  await page.goto('/chat');
  await selectChatSession(page, 'sess-1');
  await expect.poll(() => gateway.subscribed()).toBe(1);
  gateway.event('agent.spawned', { workerId: 'pipeline-worker', role: 'coding', model: 'test' }, 'sess-1');
  const activity = page.getByTestId('companion-activity');
  await expect(activity).toContainText('We’re still working. You can send a message anytime.');
  await expect(activity).not.toContainText('Ready for your next idea.');
  gateway.event('agent.completed', { workerId: 'pipeline-worker', role: 'coding' }, 'sess-1');
  await expect(activity).toContainText('Ready for your next idea.');
});

test('template preview exposes item loops without model overrides', async ({ authenticatedPage: page }) => {
  await page.route('**/api/pipelines/templates', route => json(route, 200, { templates: [{
    id: 'cli', name: 'CLI recipe', steps: [{ name: 'Implement', topic: 'coding', model: 'cli/test', loopOverPlan: true }],
  }] }));
  await page.goto('/pipelines');
  await page.getByRole('button', { name: 'Expand CLI recipe' }).click();
  await expect(page.getByText('Model override: cli/test')).toHaveCount(0);
  await expect(page.getByText('Per plan item')).toBeVisible();
});

test('running pipeline rings fit inside the scroll viewport', async ({ authenticatedPage: page }) => {
  await page.route('**/api/agents/root', route => json(route, 200, { id: 'root', model: 'test', topic: 'build', status: 'running', createdAt: new Date().toISOString() }));
  await page.route('**/api/agents/root/events**', route => json(route, 200, { events: [] }));
  await page.route('**/api/pipelines', route => json(route, 200, { pipelines: [{ id: 'run', rootAgentId: 'root' }] }));
  await page.route('**/api/pipelines/run', route => json(route, 200, {
    pipeline: { id: 'run', title: 'Test pipeline', type: 'test', status: 'running', currentNodeKey: 'n0' },
    nodes: [{ id: 'n0', nodeKey: 'n0', name: 'Implementation', role: 'coding', status: 'running', ordinal: 0 }],
  }));
  await page.goto('/agents/view?id=root');
  const circle = page.locator('.ring-4');
  await expect(circle).toBeVisible();
  const fits = await circle.evaluate(el => {
    const viewport = el.closest('.overflow-x-auto')!.getBoundingClientRect();
    const ring = el.getBoundingClientRect();
    return ring.top - 4 >= viewport.top && ring.left - 4 >= viewport.left && ring.bottom + 4 <= viewport.bottom;
  });
  expect(fits).toBe(true);
});

test('stage editor selects roles and explains their topic model assignment', async ({ authenticatedPage: page }) => {
  await page.route('**/api/roles', route => json(route, 200, { roles: [{ role: 'coding', lane: 'build' }] }));
  await page.route('**/api/pipelines/templates', route => json(route, 200, { templates: [{
    id: 'mine', name: 'My recipe', steps: [{ name: 'Implement', topic: 'coding', model: 'legacy-model' }],
  }] }));
  await page.goto('/pipelines');
  await page.getByRole('button', { name: 'Edit My recipe' }).click();
  await page.getByText('Implement', { exact: true }).click();
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('coding');
  await expect(page.getByText(/Models come from its topic assignment/)).toContainText('(build)');
  await expect(page.getByLabel('Model override', { exact: true })).toHaveCount(0);
});
