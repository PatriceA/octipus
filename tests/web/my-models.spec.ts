import type { Route } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

/**
 * Settings → My models (coworking spec §8.4), every /api call stubbed:
 * add a personal model bound to a lane, rebind it, replace its key, remove it,
 * and see a refused endpoint's error.
 */

const PROVIDERS = ['anthropic', 'openai', 'openrouter', 'custom-openai', 'cli'];
const TOPICS = ['build', 'everyday', 'verify', 'research'];

const model = (over: Record<string, unknown>) => ({
  name: 'u/e2e-user-id/mine', slug: 'mine', provider: 'anthropic', modelId: 'claude-x', label: null,
  endpoint: null, isEnabled: true, hasKey: true, topics: [],
  ...over,
});

test.describe('my models', () => {
  test('add a model, bind lanes, replace its key and delete it', async ({ authenticatedPage: page }) => {
    let mine: Array<ReturnType<typeof model>> = [];
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    await stubAllDefaults(page);
    await page.route(/\/api\/me\/models/, async (route: Route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const body = req.postDataJSON?.() ?? undefined;
      calls.push({ method: req.method(), path, body });
      const slug = path.split('/').pop();
      if (req.method() === 'GET') return json(route, 200, { models: mine, providers: PROVIDERS, topics: TOPICS });
      if (req.method() === 'POST') {
        const b = body as Record<string, unknown>;
        const created = model({ name: `u/e2e-user-id/${b.slug}`, slug: b.slug, provider: b.provider, modelId: b.modelId, topics: b.topics });
        mine = [...mine, created];
        return json(route, 201, { model: created });
      }
      if (req.method() === 'PATCH') {
        const b = body as Record<string, unknown>;
        mine = mine.map((m) => (m.slug === slug ? { ...m, ...(b.topics ? { topics: b.topics as string[] } : {}), ...(b.isEnabled !== undefined ? { isEnabled: b.isEnabled as boolean } : {}) } : m));
        return json(route, 200, { model: mine.find((m) => m.slug === slug) });
      }
      if (req.method() === 'DELETE') {
        mine = mine.filter((m) => m.slug !== slug);
        return json(route, 200, { deleted: true });
      }
      return json(route, 404, { error: 'unexpected' });
    });

    await page.goto('/settings');
    await page.getByRole('button', { name: 'My models' }).click();
    await expect(page.getByRole('heading', { name: 'My models' })).toBeVisible();
    await expect(page.getByText('no personal models yet')).toBeVisible();

    const form = page.getByRole('form', { name: 'Add a model' });
    await form.getByLabel('Short name').fill('mine');
    await form.getByLabel('Provider').selectOption('anthropic');
    await form.getByLabel('Model id').fill('claude-x');
    await form.getByLabel('API key').fill('sk-ant-secret');
    await form.getByLabel('build').check();
    await form.getByRole('button', { name: 'Add model' }).click();

    const row = page.getByRole('listitem', { name: 'Model mine' });
    await expect(row).toBeVisible();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      slug: 'mine', provider: 'anthropic', modelId: 'claude-x', key: 'sk-ant-secret', topics: ['build'],
    });
    // The key is never shown back.
    await expect(page.getByText('sk-ant-secret')).toHaveCount(0);

    await row.getByLabel('research').check();
    await row.getByRole('button', { name: 'Save lanes' }).click();
    await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(1);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ topics: ['build', 'research'] });
    await expect(row.getByRole('button', { name: 'Save lanes' })).toHaveCount(0);
    await expect(row.getByLabel('research')).toBeChecked();

    await row.getByLabel('New key for mine').fill('sk-ant-new');
    await row.getByRole('button', { name: 'Replace key' }).click();
    await expect.poll(() => calls.filter((c) => c.method === 'PATCH').length).toBe(2);
    expect(calls.filter((c) => c.method === 'PATCH')[1].body).toEqual({ key: 'sk-ant-new' });

    page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: 'Delete mine' }).click();
    await expect(page.getByText('no personal models yet')).toBeVisible();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/me/models/mine')).toBe(true);
  });

  test('a custom provider asks for an endpoint and shows the server refusal', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route(/\/api\/me\/models/, async (route: Route) => {
      const req = route.request();
      if (req.method() === 'GET') return json(route, 200, { models: [], providers: PROVIDERS, topics: TOPICS });
      if (req.method() === 'POST') return json(route, 400, { error: 'Endpoint refused: IP 10.0.0.5 is in a private/reserved range' });
      return json(route, 404, { error: 'unexpected' });
    });

    await page.goto('/settings');
    await page.getByRole('button', { name: 'My models' }).click();
    const form = page.getByRole('form', { name: 'Add a model' });
    await expect(form.getByLabel('Endpoint')).toHaveCount(0);
    await form.getByLabel('Provider').selectOption('custom-openai');
    await form.getByLabel('Short name').fill('gw');
    await form.getByLabel('Model id').fill('llama');
    await form.getByLabel('API key').fill('k');
    await expect(form.getByRole('button', { name: 'Add model' })).toBeDisabled();
    await form.getByLabel('Endpoint').fill('http://10.0.0.5');
    await form.getByRole('button', { name: 'Add model' }).click();
    await expect(page.getByRole('alert')).toContainText('Endpoint refused');
  });
});
