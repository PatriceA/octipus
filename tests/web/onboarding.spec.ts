import { MODULES } from '../../src/modules';
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
  channels: { configured: [], linked: [] },
  heartbeat: { serverEnabled: false, enabled: false, watchEmail: false, intervalMinutes: null, timezone: 'UTC' },
  permissions: { tasksWrite: 'ASK', messagingSend: 'ASK' },
  standingInstructions: false,
  roleAgents: [],
  pipelineTemplates: [{ id: 'tpl-research', name: 'Research & Analysis' }],
  mcpServers: [],
  workspaceRoot: null,
  // Every module on, as on an install from before modules (docs/MODULES.md).
  modules: { enabled: MODULES.map((m) => m.id), byUseCase: {} },
  progress: {} as Record<string, unknown>,
});

const SETUP_PATHS = /\/api\/(settings\/batch|settings\/heartbeat\.enabled|settings\/setup-complete|models\/test|models|topics\/assign-all|tools\/permissions|heartbeat\/me|tasks\/role-agents|me\/workspaces|onboarding\/standing-instructions|auth\/oauth\/google\/authorize|modules\/enable)$/;

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
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.progress) });
      const body = route.request().postDataJSON();
      if (body.completed) state.progress = { ...state.progress, completedAt: '2026-10-22T12:00:00Z' };
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
    expect(progress.at(-1)).toMatchObject({ completed: false });
    // What was left can be finished from here: the plan comes back with it.
    await guide.getByRole('button', { name: 'Finish the rest' }).click();
    const again = guide.getByRole('list', { name: 'What the guide will do' });
    await expect(again).toContainText('Connect your Google account');
    // What was done last run is not done twice (the stub's state did not change).
    await expect(again).not.toContainText('Turn on an agent for your ideas');
    await expect(guide.getByRole('list', { name: 'Already set up' })).toContainText('Turn on an agent for your ideas');
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

  test('finished before: the home page only links to it, and reads nothing more', async ({ authenticatedPage: page }) => {
    state.progress = { completedAt: '2026-10-01T09:00:00Z' };
    const fullReads: string[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/onboarding') fullReads.push(r.url()); });
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Set up Octipus for something else' })).toBeVisible();
    expect(fullReads).toEqual([]);
  });

  test('finishing on the home page keeps the guide there for the next thing', async ({ authenticatedPage: page }) => {
    state.models = { textReady: true, embeddingReady: true, verifySeparate: false, names: ['anthropic claude-sonnet-5-5'], providersWithKey: ['anthropic'], byTopic: {} };
    await page.goto('/');
    const guide = page.getByTestId('onboarding');
    await guide.getByRole('checkbox', { name: /Research and knowledge/ }).click();
    await guide.getByRole('button', { name: 'Continue' }).click();
    await guide.getByRole('button', { name: 'Research', exact: true }).click();
    await guide.getByRole('button', { name: 'See my plan' }).click();
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await guide.getByRole('button', { name: 'Set up something else' }).click();
    await expect(guide.getByRole('checkbox', { name: /Build software/ })).toBeVisible();
  });

  test('the plan review picks modules: the use case\'s are ticked, another can be added', async ({ authenticatedPage: page }) => {
    state.models = { textReady: true, embeddingReady: true, verifySeparate: false, names: ['anthropic claude-sonnet-5-5'], providersWithKey: ['anthropic'], byTopic: {} };
    state.modules = {
      enabled: ['recall'],
      byUseCase: { research: [{ id: 'artifacts', title: 'Live artifacts' }, { id: 'recall', title: 'Recall' }] },
      available: MODULES.map((m) => ({ id: m.id, title: m.title, description: m.description })),
    } as typeof state.modules;
    await page.goto('/');
    const guide = page.getByTestId('onboarding');
    await guide.getByRole('checkbox', { name: /Research and knowledge/ }).click();
    await guide.getByRole('button', { name: 'Continue' }).click();
    await guide.getByRole('button', { name: 'Research', exact: true }).click();
    await guide.getByRole('button', { name: 'See my plan' }).click();
    const picker = guide.getByTestId('module-picker');
    await expect(picker.getByRole('checkbox', { name: 'Live artifacts' })).toBeChecked();
    // Research is the research plugin now, which the guide does not offer.
    await expect(picker.getByRole('checkbox', { name: 'Research jobs' })).toHaveCount(0);
    // On already: shown, and the guide does not switch it off.
    await expect(picker.getByRole('checkbox', { name: 'Recall' })).toBeDisabled();
    const business = picker.getByRole('checkbox', { name: 'Cases, contacts and records' });
    await expect(business).not.toBeChecked();
    await business.check();
    await expect(guide.locator('[data-plan-step="modules"]')).toContainText('Cases, contacts and records');
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await expect.poll(() => calls.find((c) => c.path === '/modules/enable')?.body).toEqual({ ids: ['artifacts', 'business'] });
  });

  test('putting it away leaves a link on the home page', async ({ authenticatedPage: page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Put the setup guide away' }).click();
    await expect(page.getByRole('link', { name: 'Set up Octipus for something else' })).toBeVisible();
    expect(progress).toContainEqual({ dismissed: true });
  });
  test('the centered basic route validates credentials and leads to a first chat', async ({ authenticatedPage: page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/onboarding');
    const guide = page.getByTestId('onboarding');
    await expect(guide).toBeVisible();
    if (process.env.ONBOARDING_SCREENSHOT) await page.screenshot({ path: '/tmp/octipus-onboarding-start.png', fullPage: true });
    const parent = await page.getByRole('main', { name: 'Page content' }).boundingBox();
    const bounds = await guide.boundingBox();
    expect(bounds!.width).toBeLessThan(1000);
    expect(Math.abs((bounds!.x + bounds!.width / 2) - (parent!.x + parent!.width / 2))).toBeLessThan(2);
    await guide.getByRole('button', { name: 'Start with the basics' }).click();
    await expect(guide.getByRole('button', { name: 'Areas of work' })).toHaveCount(0);
    await guide.getByRole('button', { name: 'See my plan' }).click();
    await expect(guide.getByRole('alert')).toContainText('API key');
    await guide.locator('[data-question="models.key"] input').fill('old-provider-key');
    await guide.getByRole('radio', { name: 'OpenAI', exact: true }).click();
    await expect(guide.locator('[data-question="models.key"] input')).toHaveValue('');
    await expect(guide.locator('[data-question="models.modelId"] input')).toHaveValue('gpt-4o-mini');
    await guide.locator('[data-question="models.key"] input').fill('test-key');
    await guide.getByRole('button', { name: 'See my plan' }).click();
    if (process.env.ONBOARDING_SCREENSHOT) await page.screenshot({ path: '/tmp/octipus-onboarding-basics.png', fullPage: true });
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await expect(guide.getByRole('link', { name: 'Try your first chat' })).toBeVisible();
    expect(calls.findIndex((c) => c.path === '/models/test')).toBeLessThan(calls.findIndex((c) => c.path === '/topics/assign-all'));
    await expect.poll(() => progress.at(-1)).toMatchObject({ completed: true });
    expect(JSON.stringify(progress)).not.toContain('test-key');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(guide).toBeVisible();
    await page.evaluate(() => { localStorage.setItem('octipus-theme', 'dark'); window.dispatchEvent(new Event('octipus-theme-change')); });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(guide.getByRole('link', { name: 'Try your first chat' })).toHaveCSS('background-color', 'rgb(156, 215, 199)');
    await expect(guide.getByRole('button', { name: 'Set up something else' })).toHaveCSS('color', 'rgb(224, 233, 237)');
    if (process.env.ONBOARDING_SCREENSHOT) await page.screenshot({ path: '/tmp/octipus-onboarding-mobile-dark.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('a failed model check blocks assignment and completion', async ({ authenticatedPage: page }) => {
    await page.route('**/api/models/test', (route) => route.fulfill({ json: { success: false, error: 'Provider rejected the API key. Check your account.' } }));
    await page.goto('/onboarding');
    const guide = page.getByTestId('onboarding');
    await guide.getByRole('button', { name: 'Start with the basics' }).click();
    await guide.locator('[data-question="models.key"] input').fill('bad-key');
    await guide.getByRole('button', { name: 'See my plan' }).click();
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await expect(guide.getByRole('heading', { name: 'Nearly there' })).toBeVisible();
    await expect(guide.locator('[data-step="test:main"]')).toHaveAttribute('data-status', 'failed');
    expect(calls.some((c) => c.path === '/topics/assign-all')).toBe(false);
    expect(calls.some((c) => c.path === '/settings/setup-complete')).toBe(false);
    await expect.poll(() => progress.at(-1)).toMatchObject({ completed: false });
  });

  test('partial setting failures are shown and stop dependent setup', async ({ authenticatedPage: page }) => {
    await page.route('**/api/settings/batch', (route) => route.fulfill({ json: { updated: [], errors: { 'anthropic.apiKey': 'Vault is unavailable' } } }));
    await page.goto('/onboarding');
    const guide = page.getByTestId('onboarding');
    await guide.getByRole('button', { name: 'Start with the basics' }).click();
    await guide.locator('[data-question="models.key"] input').fill('bad-key');
    await guide.getByRole('button', { name: 'See my plan' }).click();
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await expect(guide.locator('[data-step="key:main"]')).toContainText('Vault is unavailable');
    await expect(guide.locator('[data-step="test:main"]')).toHaveAttribute('data-status', 'skipped');
    expect(calls.some((c) => c.path === '/topics/assign-all')).toBe(false);
  });

  test('changing answers after a partial run gets fresh model checks and assignments', async ({ authenticatedPage: page }) => {
    await page.route('**/api/settings/setup-complete', (route) => route.fulfill({ status: 503, json: { error: 'Settings temporarily unavailable' } }));
    await page.goto('/onboarding');
    const guide = page.getByTestId('onboarding');
    await guide.getByRole('button', { name: 'Start with the basics' }).click();
    await guide.locator('[data-question="models.key"] input').fill('first-key');
    await guide.getByRole('button', { name: 'See my plan' }).click();
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await expect(guide.getByRole('heading', { name: 'Nearly there' })).toBeVisible();
    await guide.getByRole('button', { name: 'Finish the rest' }).click();
    await guide.getByRole('button', { name: 'Change answers' }).click();
    await guide.getByRole('radio', { name: 'OpenAI', exact: true }).click();
    await guide.locator('[data-question="models.key"] input').fill('second-key');
    await guide.getByRole('button', { name: 'See my plan' }).click();
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await expect(guide.getByRole('heading', { name: 'Nearly there' })).toBeVisible();
    expect(calls.filter((c) => c.path === '/topics/assign-all').map((c) => c.body)).toEqual([{ model: 'anthropic claude-sonnet-5-5' }, { model: 'openai gpt-4o-mini' }]);
    expect(calls.filter((c) => c.path === '/models/test').map((c) => c.body)).toEqual([{ provider: 'anthropic', modelId: 'claude-sonnet-5-5' }, { provider: 'openai', modelId: 'gpt-4o-mini' }]);
  });

  test('adding a module after a partial run does not reuse the old modules receipt', async ({ authenticatedPage: page }) => {
    state.models = { textReady: true, embeddingReady: true, verifySeparate: false, names: [], providersWithKey: [], byTopic: {} };
    state.modules = { enabled: ['recall'], byUseCase: { research: [{ id: 'artifacts', title: 'Live artifacts' }] }, available: MODULES.map((m) => ({ id: m.id, title: m.title, description: m.description })) } as typeof state.modules;
    await page.route('**/api/settings/setup-complete', (route) => route.fulfill({ status: 503, json: { error: 'Settings temporarily unavailable' } }));
    await page.goto('/onboarding');
    const guide = page.getByTestId('onboarding');
    await guide.getByRole('checkbox', { name: /Research and knowledge/ }).click();
    await guide.getByRole('button', { name: 'Continue' }).click();
    await guide.getByRole('button', { name: 'Research', exact: true }).click();
    await guide.getByRole('button', { name: 'See my plan' }).click();
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await expect(guide.getByRole('heading', { name: 'Nearly there' })).toBeVisible();
    await guide.getByRole('button', { name: 'Finish the rest' }).click();
    await guide.getByTestId('module-picker').getByRole('checkbox', { name: 'Cases, contacts and records' }).check();
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await expect(guide.getByRole('heading', { name: 'Nearly there' })).toBeVisible();
    const modules = calls.filter((c) => c.path === '/modules/enable');
    expect(modules).toHaveLength(2);
    expect(modules.at(-1)?.body).toMatchObject({ ids: expect.arrayContaining(['business']) });
  });

  test('failed completion progress can be saved again without repeating setup', async ({ authenticatedPage: page }) => {
    let rejectSave = true;
    await page.route('**/api/onboarding/progress', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: {} });
      if (rejectSave) return route.fulfill({ status: 503, json: { error: 'Temporary save failure' } });
      progress.push(route.request().postDataJSON());
      return route.fulfill({ json: {} });
    });
    await page.goto('/onboarding');
    const guide = page.getByTestId('onboarding');
    await guide.getByRole('button', { name: 'Start with the basics' }).click();
    await guide.locator('[data-question="models.key"] input').fill('test-key');
    await guide.getByRole('button', { name: 'See my plan' }).click();
    await guide.getByRole('button', { name: 'Go, set it up' }).click();
    await expect(guide.getByRole('alert')).toContainText('setup results could not be saved');
    const setupCalls = calls.length;
    rejectSave = false;
    await guide.getByRole('button', { name: 'Retry saving' }).click();
    await expect(guide.getByRole('alert')).toHaveCount(0);
    expect(progress.at(-1)).toMatchObject({ completed: true });
    expect(calls).toHaveLength(setupCalls);
  });

  test('a failed dismiss stays visible and explains the save problem', async ({ authenticatedPage: page }) => {
    await page.route('**/api/onboarding/progress', (route) => route.request().method() === 'GET' ? route.fulfill({ json: {} }) : route.fulfill({ status: 503, json: { error: 'Settings unavailable' } }));
    await page.goto('/');
    const guide = page.getByTestId('onboarding');
    await guide.getByRole('button', { name: 'Put the setup guide away' }).click();
    await expect(guide).toBeVisible();
    await expect(guide.getByRole('alert')).toContainText('Could not put the guide away');
  });

});
