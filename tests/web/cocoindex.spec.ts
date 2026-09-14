import type { CocoIndexStatus } from '../../src/shared/cocoindex';
import { expect, test, STUB_USER } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

const initial: CocoIndexStatus = {
  id: 'cocoindex-code', installed: false, configured: false, workspacePath: null,
  status: 'not_installed', embedding: { provider: 'sentence-transformers', model: 'test/local-embed', local: true },
};

test('optional connector installs, reports progress, and removes without an OAuth flow', async ({ authenticatedPage: page }, testInfo) => {
  let state: CocoIndexStatus = { ...initial };
  let installBody: unknown;
  let removed = false;
  await page.route('**/api/connectors', route => json(route, 200, { connectors: [
    { id: 'atlassian', name: 'Atlassian', description: 'Jira and Confluence', logoUrl: '/logos/atlassian.svg', connected: false },
    { id: 'linear', name: 'Linear', description: 'Issues and projects', logoUrl: '/logos/linear.svg', connected: false },
  ] }));
  await page.route('**/api/connectors/cocoindex', route => {
    if (route.request().method() === 'DELETE') {
      removed = true;
      state = { ...initial, installed: true, status: 'disconnected' };
    }
    return json(route, 200, state);
  });
  await page.route('**/api/connectors/cocoindex/install', route => {
    installBody = route.request().postDataJSON();
    state = { ...initial, workspacePath: '/workspace/mobile and backend', status: 'installing', progress: { phase: 'install', message: 'Installing CocoIndex dependencies…' } };
    return json(route, 202, state);
  });
  await page.goto('/mcp');
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Atlassian' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Linear' })).toBeVisible();
  const card = page.getByRole('region', { name: 'CocoIndex Code' });
  await expect(card.getByText('Optional · Local')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Install and connect' })).toBeDisabled();
  await card.getByLabel('Folder on the backend').fill('/workspace/mobile and backend');
  await page.screenshot({ path: testInfo.outputPath('cocoindex-connector.png'), fullPage: true });
  await card.getByRole('button', { name: 'Install and connect' }).click();
  await expect(card.getByText('Installing CocoIndex dependencies…')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Setting up…' })).toBeDisabled();
  expect(installBody).toEqual({ workspacePath: '/workspace/mobile and backend', embeddingModel: 'test/local-embed' });
  state = { ...state, installed: true, configured: true, status: 'connected', progress: undefined };
  await expect(card.getByRole('status').filter({ hasText: /^Connected$/ })).toBeVisible();
  await card.getByRole('button', { name: 'Remove connector' }).click();
  await expect(card.getByRole('button', { name: 'Set up connector' })).toBeVisible();
  expect(removed).toBe(true);
});

test('setup failure is actionable and never shown as connected', async ({ authenticatedPage: page }) => {
  await page.route('**/api/connectors', route => json(route, 200, { connectors: [] }));
  await page.route('**/api/connectors/cocoindex', route => json(route, 200, {
    ...initial, installed: true, status: 'error', error: 'Python 3.11 or newer is required.',
  }));
  await page.goto('/mcp');
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
  const card = page.getByRole('region', { name: 'CocoIndex Code' });
  await expect(card.getByRole('alert')).toHaveText('Python 3.11 or newer is required.');
  await expect(card.getByRole('status')).toHaveText('Setup needs attention');
  await expect(card.getByRole('button', { name: 'Set up connector' })).toBeVisible();
});

test('non-admin sees optional connector without installation controls or status requests', async ({ authenticatedPage: page }) => {
  let statusRequests = 0;
  await page.route('**/api/auth/me', route => json(route, 200, { ...STUB_USER, isAdmin: false }));
  await page.route('**/api/connectors', route => json(route, 200, { connectors: [] }));
  await page.route('**/api/connectors/cocoindex', route => { statusRequests++; return json(route, 200, initial); });
  await page.goto('/mcp');
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
  const card = page.getByRole('region', { name: 'CocoIndex Code' });
  await expect(card.getByText('Ask an administrator to install and configure this connector.')).toBeVisible();
  await expect(card.getByLabel('Folder on the backend')).toHaveCount(0);
  expect(statusRequests).toBe(0);
});

test('Windows guide leads to a manual stdio config with intact Windows paths', async ({ authenticatedPage: page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/api/connectors', route => json(route, 200, { connectors: [] }));
  await page.route('**/api/connectors/cocoindex', route => json(route, 200, initial));
  await page.route('**/api/mcp/servers', route => {
    if (route.request().method() === 'POST') submitted = route.request().postDataJSON();
    return json(route, 200, { servers: [], server: submitted });
  });
  await page.goto('/mcp');
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
  await page.getByText('Windows manual setup', { exact: true }).click();
  await expect(page.getByText('winget install --id=astral-sh.uv -e', { exact: true })).toBeVisible();
  await expect(page.getByText('The full ccc.exe path printed above, without surrounding quotes')).toBeVisible();
  await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();
  await page.getByRole('button', { name: 'Add Server', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Add MCP Server' });
  await modal.getByRole('button', { name: /stdio/ }).click();
  await modal.getByPlaceholder('e.g., Brave Search').fill('CocoIndex Windows');
  await modal.getByPlaceholder('npx', { exact: true }).fill(String.raw`C:\Users\Test User\.local\bin\ccc.exe`);
  await modal.getByPlaceholder('-y @anthropic/brave-search-mcp').fill('mcp');
  await modal.getByLabel('Working directory (optional)').fill(String.raw`C:\src\my project`);
  await modal.getByText('Process settings', { exact: true }).click();
  await modal.getByLabel('Request timeout (seconds)').fill('1800');
  await modal.getByLabel('Treat stderr output as an error').uncheck();
  await modal.locator('textarea').fill(String.raw`COCOINDEX_CODE_DIR=C:\Users\Test User\AppData\Local\Octipus\cocoindex-manual`);
  await modal.getByRole('button', { name: 'Add & Connect' }).click();
  await expect(modal).not.toBeVisible();
  expect(submitted).toMatchObject({
    name: 'CocoIndex Windows', transport: 'stdio',
    command: String.raw`C:\Users\Test User\.local\bin\ccc.exe`, args: ['mcp'],
    cwd: String.raw`C:\src\my project`, requestTimeoutMs: 1800000, stderrAsError: false,
    env: { COCOINDEX_CODE_DIR: String.raw`C:\Users\Test User\AppData\Local\Octipus\cocoindex-manual` },
  });
});
