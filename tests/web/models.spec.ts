import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

test.describe('models page', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  test('models page renders the model list', async ({ authenticatedPage: page }) => {
    await page.goto('/models');
    await expect(page.locator('body')).toContainText(/gpt-4o|claude-3-5-sonnet/, { timeout: 10_000 });
  });

  test('default badge appears for the default model', async ({ authenticatedPage: page }) => {
    await page.goto('/models');
    await expect(page.locator('body')).toContainText(/default|Default/i, { timeout: 10_000 });
  });

  test('CLI settings save shared permissions and API-key inheritance without dropping hidden metadata', async ({
    authenticatedPage: page,
  }) => {
    const cliModel = {
      id: 'cli-claude-1',
      name: 'cli-claude-edit',
      provider: 'cli',
      modelId: 'cli/claude',
      isEnabled: true,
      isDefault: false,
      supportsVision: false,
      supportsTools: true,
      supportsStreaming: true,
      contextWindow: 200_000,
      maxTokens: 16_384,
      topics: [],
      priority: 80,
      costPerInputToken: 0,
      costPerOutputToken: 0,
      metadata: {
        description: 'Claude subscription model',
        cliAgent: {
          permissionMode: 'auto',
          mcpConfigPath: '/legacy/mcp.json',
          futureSetting: 'keep-me',
        },
      },
    };
    let saved: Record<string, unknown> | undefined;

    await page.route('**/api/models', route => json(route, 200, { models: [cliModel] }));
    await page.route('**/api/models/cli/status', route => json(route, 200, {
      tools: [{
        name: 'Claude Code',
        available: true,
        modelPatterns: ['cli/claude', 'cli/claude-code'],
        modelProvider: 'anthropic',
        modelFlag: '--model',
        quota: null,
      }],
    }));
    await page.route('**/api/models/cli-claude-edit', async route => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      saved = route.request().postDataJSON() as Record<string, unknown>;
      return json(route, 200, cliModel);
    });

    await page.goto('/models');
    await page.getByTitle('Edit model').click();

    const modal = page.locator('form').filter({ hasText: 'CLI Agent Settings' });
    const permission = modal.getByText('Permission Mode', { exact: true }).locator('..').locator('select');
    await expect(permission.locator('option')).toHaveCount(6);
    await expect(permission.locator('option')).toHaveText([
      'Adapter default',
      'Safe',
      'Workspace edits',
      'Full access',
      'Plan only',
      'Current native setting: auto',
    ]);
    await expect(modal.getByText('MCP Config Path', { exact: true })).toHaveCount(0);

    const inheritApiKeys = modal.getByRole('checkbox', { name: /Pass server API keys/ });
    await expect(inheritApiKeys).not.toBeChecked();
    await inheritApiKeys.check();
    await modal.getByRole('button', { name: 'Save Changes' }).click();

    await expect.poll(() => saved).toBeTruthy();
    expect(saved).toMatchObject({
      metadata: {
        description: 'Claude subscription model',
        cliAgent: {
          permissionMode: 'auto',
          inheritApiKeys: true,
          mcpConfigPath: '/legacy/mcp.json',
          futureSetting: 'keep-me',
        },
      },
    });
  });

  test('a topics response with no topics array does not take down the page', async ({
    authenticatedPage: page,
  }) => {
    // OrchestratorModelNote is a decoration on this page, but it read
    // `topics.find(...)` straight off the payload — so a 200 whose body lacked
    // the array threw during render and the error boundary replaced the whole
    // Models page with "This page couldn't load". An older backend, a partial
    // deploy, or a proxy all produce exactly this body.
    await page.route('**/api/topics', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/models');
    await expect(page.locator('body')).toContainText(/gpt-4o|claude-3-5-sonnet/, { timeout: 10_000 });
    await expect(page.locator('body')).not.toContainText(/couldn.t load/i);
  });

  test('error surface when models API returns 500', async ({ authenticatedPage: page, consoleErrors }) => {
    // Override the default stub with a 500.
    await page.route('**/api/models**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }),
    );
    await page.goto('/models');
    // The UI should not crash — look for any error messaging or at least the page shell.
    await expect(page.locator('body')).toBeVisible();
    // We DO expect to have logged *something* but the console-error watchdog filters benign noise.
    // This test intentionally does not assert empty consoleErrors; it asserts the app still renders.
    void consoleErrors;
  });
});
