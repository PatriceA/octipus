import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

test('CLI configuration is collapsed until requested', async ({ authenticatedPage: page }) => {
  await page.route('**/api/models/cli/status', route => json(route, 200, { tools: [{ name: 'Claude Code', available: true, modelPatterns: ['claude'], quota: null }] }));
  await page.goto('/models');
  const summary = page.getByText('CLI tools · configuration and status', { exact: true });
  await expect(summary).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Detected CLI Tools' })).not.toBeVisible();
  await summary.click();
  await expect(page.getByRole('heading', { name: 'Detected CLI Tools' })).toBeVisible();
});

test('Secrets hides unused setup while keeping configured providers accessible', async ({ authenticatedPage: page }) => {
  await page.route('**/api/vault**', route => json(route, 200, { credentials: [{ id: 'key', name: 'openai_api_key' }] }));
  await page.goto('/secrets');
  const providers = page.getByRole('region', { name: 'Model provider credentials' });
  await expect(providers.getByText('OpenAI', { exact: true })).toBeVisible();
  await expect(providers.getByText('Anthropic', { exact: true })).not.toBeVisible();
  await providers.getByRole('button', { name: /Add connection/ }).click();
  await expect(providers.getByText('Anthropic', { exact: true })).toBeVisible();
});

test('Tools links to the sole MCP permission editor', async ({ authenticatedPage: page }) => {
  await page.route('**/api/mcp/tools', route => json(route, 200, { tools: [{ serverId: 'jira', name: 'read', description: 'Read' }] }));
  await page.route('**/api/tools', route => json(route, 200, { tools: [] }));
  await page.goto('/tools');
  await expect(page.getByRole('link', { name: 'Manage MCP tool permissions on the MCP page.' })).toHaveAttribute('href', '/mcp');
  await expect(page.getByRole('combobox', { name: /Permission for jira/ })).toHaveCount(0);
});

test('mounted skills expose role assignment without editing source files', async ({ authenticatedPage: page }) => {
  const id = 'external:claude-user:pdf:SKILL';
  await page.route('**/api/skills', route => json(route, 200, { skills: [{ id, name: 'Mounted PDF', description: 'Read PDF documents',
    category: 'general', content: 'Read it', principles: [], bestPractices: [], antiPatterns: [], frameworks: [], mounted: true, isSystem: true, canEdit: false }] }));
  await page.route('**/api/roles', route => json(route, 200, { roles: [{ role: 'coding', displayName: 'Coding' }] }));
  let assignment: unknown;
  await page.route('**/api/skills/topics**', route => {
    if (route.request().method() === 'POST') {
      assignment = route.request().postDataJSON();
      return json(route, 200, { id: 'assignment', ...assignment as object });
    }
    return json(route, 200, { assignments: assignment ? [{ id: 'assignment', ...assignment as object }] : [] });
  });
  await page.goto('/skills');
  await page.getByRole('button', { name: /Mounted PDF Read PDF documents/ }).click();
  await page.getByRole('button', { name: 'coding', exact: true }).click();
  await expect.poll(() => assignment).toEqual({ skillId: id, topic: 'coding', isActive: true });
});
