import { test, expect } from './fixtures/auth';
import { stubAllDefaults } from './fixtures/api-stubs';

/** A fresh install, as its admin sees it. */
const fresh = () => ({
  isAdmin: true,
  setupComplete: false,
  models: { textReady: false, embeddingReady: false, verifySeparate: false, names: [], providersWithKey: [], byTopic: {} },
  cliTools: [{ name: 'Claude Code', modelId: 'cli/claude-code', available: true }],
  ollama: { url: 'http://localhost:11434', reachable: false },
  workspaces: [{ id: 'w1', name: 'Personal', slug: 'personal', kind: 'personal', isDefault: true }],
  mailbox: null,
  oauthClients: { google: true, microsoft: false },
  connectors: [{ id: 'atlassian', name: 'Atlassian', connected: false }],
  channels: { configured: [], linked: [] },
  heartbeat: { serverEnabled: false, enabled: false, watchEmail: false, intervalMinutes: null, timezone: 'UTC' },
  permissions: { tasksWrite: 'ASK', messagingSend: 'ASK' },
  standingInstructions: false,
  roleAgents: [],
  pipelineTemplates: [{ id: 'tpl-research', name: 'Research & Analysis' }],
  mcpServers: [],
  workspaceRoot: null,
  progress: {} as Record<string, unknown>,
});

const SETUP_PATHS = /\/api\/(settings\/batch|settings\/heartbeat\.enabled|settings\/setup-complete|models\/test|models|topics\/assign-all|tools\/permissions|heartbeat\/me|tasks\/role-agents|me\/workspaces|onboarding\/standing-instructions|auth\/oauth\/google\/authorize)$/;

test.describe('onboarding guide', () => {
  let state: ReturnType<typeof fresh>;
  let calls: Array<{ method: string; path: string; body: unknown }>;
  let progress: unknown[];

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    state = fresh();
    calls = [];
    progress = [];
    await page.route('**/api/onboarding', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) }));
    await page.route('**/api/onboarding/progress', async (route) => {
      const body = route.request().postDataJSON();
      progress.push(body);
      if (body.dismissed) state.progress = { ...state.progress, dismissed: true };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.progress) });
    });
    await page.route(SETUP_PATHS, async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.replace(/^.*\/api/, '');
      // Only what the guide writes (and the sign-in start); the app's own reads go to the default stubs.
      if (req.method() === 'GET' && !path.endsWith('/authorize')) return route.fallback();
      calls.push({ method: req.method(), path, body: req.postData() ? req.postDataJSON() : undefined });
      const body = path === '/models/test' ? { success: true, message: 'ok' } : path.endsWith('/authorize') ? { url: 'about:blank' } : { ok: true };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
  });

  test('a first visit: pick a use case, answer, review, and it sets things up', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    const guide = page.getByTestId('onboarding');
    // The companion hosts it: it greets, and cheers what you add.
    const companion = guide.getByTestId('guide-companion');
    await expect(guide.getByTestId('guide-line')).toContainText("Tell me what we'll do together");
    await expect(companion).toHaveAttribute('data-state', 'idle');
    await guide.getByRole('checkbox', { name: /Run my company/ }).click();
    await expect(companion).toHaveAttribute('data-state', 'done');
    await expect(guide.getByTestId('guide-line')).toContainText('Run my company, lovely');
    await expect(companion).toHaveAttribute('data-state', 'listening');
    await guide.getByRole('button', { name: 'Continue' }).click();

    // Models: an Anthropic key.
    await expect(guide.locator('[data-section="models"]')).toBeVisible();
    await guide.locator('[data-question="models.key"] input').fill('sk-ant-test');
    // One section at a time: models, areas, chat, then the company.
    await guide.getByRole('button', { name: 'Next' }).click();
    await expect(guide.locator('[data-section="areas"]')).toBeVisible();
    await guide.getByRole('button', { name: 'Your company' }).click();
    await guide.locator('[data-question="company.name"] input').fill('Acme Design');
    await guide.locator('[data-question="company.about"] textarea').fill('A small design studio.');
    await guide.getByRole('radio', { name: /Every 30 minutes/ }).click();
    await guide.getByRole('button', { name: 'Mailbox and calendar' }).click();
    await guide.getByRole('button', { name: 'See my plan' }).click();

    const list = guide.getByRole('list', { name: 'What the guide will do' });
    await expect(list).toContainText('Store your Anthropic (Claude) API key');
    await expect(list).toContainText('Use it for all work');
    await expect(list).toContainText('Connect your Google account');
    await expect(list).toContainText('Check your inbox every 30 minutes');
    await expect(list).toContainText('Turn on an agent for your ideas');
    // Secrets never go to the saved progress.
    expect(JSON.stringify(progress)).not.toContain('sk-ant-test');

    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    // The sign-in waits for the person; skip it.
    const connect = guide.locator('[data-step="connect:mailbox"]');
    await expect(connect).toHaveAttribute('data-status', 'waiting');
    // It waits for you, and says so.
    await expect(companion).toHaveAttribute('data-state', 'waiting');
    await expect(guide.getByTestId('guide-line')).toContainText('Your turn');
    await connect.getByRole('button', { name: 'Skip' }).click();
    await expect(guide.getByRole('status')).toContainText('left for later');

    expect(calls.find((c) => c.path === '/settings/batch')?.body).toEqual({ settings: { 'anthropic.apiKey': 'sk-ant-test' } });
    expect(calls.find((c) => c.path === '/topics/assign-all')?.body).toEqual({ model: 'anthropic claude-sonnet-5-5' });
    expect(calls.find((c) => c.path === '/tasks/role-agents')?.body).toEqual({ role: 'general', enabled: true, pipelineTemplate: 'tpl-research' });
    expect(String((calls.find((c) => c.path === '/onboarding/standing-instructions')?.body as { body: string }).body)).toContain('About Acme Design');
    // The inbox watch depended on the skipped sign-in: not turned on.
    expect(calls.some((c) => c.path === '/heartbeat/me')).toBe(false);
    await expect(guide.locator('[data-step="heartbeat:me"]')).toHaveAttribute('data-status', 'skipped');
    expect(progress.at(-1)).toMatchObject({ completed: true });
    // What was left can be finished from here: the plan comes back with it.
    await guide.getByRole('button', { name: 'Finish the rest' }).click();
    await expect(guide.getByRole('list', { name: 'What the guide will do' })).toContainText('Connect your Google account');
    if (process.env.ONBOARDING_SCREENSHOT) await page.screenshot({ path: process.env.ONBOARDING_SCREENSHOT, fullPage: true });
  });

  test('what is already set up is said, and not done again', async ({ authenticatedPage: page }) => {
    Object.assign(state, {
      models: { textReady: true, embeddingReady: true, verifySeparate: false, names: ['anthropic claude-sonnet-5-5'], providersWithKey: ['anthropic'], byTopic: {} },
      heartbeat: { ...state.heartbeat, serverEnabled: true },
      roleAgents: [{ role: 'research', enabled: true, pipelineTemplate: 'tpl-research' }],
      permissions: { tasksWrite: 'ALLOW', messagingSend: 'ASK' },
    });
    await page.goto('/onboarding');
    const guide = page.getByTestId('onboarding');
    await guide.getByRole('checkbox', { name: /Research and knowledge/ }).click();
    await guide.getByRole('button', { name: 'Continue' }).click();
    await expect(guide).toContainText('Every kind of work already has a model.');
    // A section everything is already in place for is marked in the steps.
    await expect(guide.getByRole('button', { name: /AI models · set up/ })).toBeVisible();
    await guide.getByRole('button', { name: 'Research', exact: true }).click();
    await expect(guide).toContainText('The research agent is already on.');
    await guide.getByRole('button', { name: 'See my plan' }).click();
    const list = guide.getByRole('list', { name: 'What the guide will do' });
    await expect(list).not.toContainText('research agent');
    await expect(list).toContainText('Mark the setup as done');
    // What was there before is listed as found, not silently dropped.
    const found = guide.getByRole('list', { name: 'Already set up' });
    await expect(found).toContainText('Every kind of work already has a model');
    await expect(found).toContainText('Document search already has a model');
    await expect(found).toContainText('The research agent is already on');
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await expect(guide.locator('[data-step="role:research"]')).toHaveAttribute('data-status', 'done');
    expect(calls.some((c) => c.path === '/tasks/role-agents')).toBe(false);
  });

  test('putting it away leaves a link on the home page', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Put the setup guide away' }).click();
    await expect(page.getByRole('link', { name: 'Set up Octipus for something else' })).toBeVisible();
    expect(progress).toContainEqual({ dismissed: true });
  });
});
