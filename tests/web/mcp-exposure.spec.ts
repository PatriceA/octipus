import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

/** The MCP page sets how a server's tools reach agents (src/shared/mcp-exposure.ts). */

type Exposure = 'direct' | 'deferred' | 'codemode' | 'hidden';

async function stubServer(page: import('@playwright/test').Page, initial: { exposure?: Exposure; toolExposure?: Record<string, Exposure> }) {
  let state = { exposure: initial.exposure, toolExposure: initial.toolExposure ?? {} };
  const writes: unknown[] = [];
  const tools = ['search_issues', 'delete_repo'].map(name => ({ name, description: name, inputSchema: {} }));
  await page.route('**/api/tools', route => json(route, 200, { tools: [] }));
  await page.route('**/api/mcp/tools', route => json(route, 200, { tools: [] }));
  await page.route('**/api/mcp/circuit', route => json(route, 200, { circuits: [] }));
  await page.route('**/api/tools/permissions**', route => json(route, 200, { permissions: [] }));
  await page.route('**/api/mcp/servers', route => json(route, 200, { servers: [{
    id: 'gh', name: 'GitHub', command: '', transport: 'streamable-http', isEnabled: true,
    status: 'connected', toolCount: 2, resourceCount: 0, promptCount: 0,
    ...(state.exposure ? { exposure: state.exposure } : {}), toolExposure: state.toolExposure,
  }] }));
  await page.route('**/api/mcp/servers/gh/tools', route => json(route, 200, { tools, resources: [], prompts: [] }));
  await page.route('**/api/mcp/servers/gh/exposure', route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    if (body.exposure === 'hidden' && state.exposure === 'codemode') return json(route, 500, { error: 'disk full' });
    state = { ...state, exposure: body.exposure ?? state.exposure };
    return json(route, 200, { success: true });
  });
  await page.route('**/api/mcp/servers/gh/tools/*/exposure', route => {
    const tool = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) as string);
    const { exposure } = route.request().postDataJSON() as { exposure: Exposure | null };
    writes.push({ tool, exposure });
    const { [tool]: _old, ...rest } = state.toolExposure;
    state = { ...state, toolExposure: exposure === null ? rest : { ...rest, [tool]: exposure } };
    return json(route, 200, { success: true });
  });
  return writes;
}

test('server and per-tool exposure are saved and shown', async ({ authenticatedPage: page }) => {
  const writes = await stubServer(page, {});
  await page.goto('/mcp');
  // A server saved before exposure existed reads as the default, with no badge.
  await page.getByRole('button', { name: 'Tools and permissions for GitHub' }).click();
  const server = page.getByRole('combobox', { name: 'Exposure for GitHub' });
  const search = page.getByRole('combobox', { name: 'Exposure for gh / search_issues' });
  await expect(server).toHaveValue('deferred');
  await expect(search).toHaveValue('INHERIT');
  await expect(search.locator('option:checked')).toHaveText('Server default (deferred)');

  await server.selectOption('codemode');
  await expect(server).toHaveValue('codemode');
  expect(writes[0]).toEqual({ exposure: 'codemode' });
  await expect(search.locator('option:checked')).toHaveText('Server default (codemode)');
  // The header shows a non-default exposure.
  await expect(page.getByText('codemode', { exact: true })).toBeVisible();

  await search.selectOption('direct');
  await expect(search).toHaveValue('direct');
  expect(writes[1]).toEqual({ tool: 'search_issues', exposure: 'direct' });

  // Back to the server default removes only that tool's override.
  const remove = page.getByRole('combobox', { name: 'Exposure for gh / delete_repo' });
  await remove.selectOption('hidden');
  await expect(remove).toHaveValue('hidden');
  await search.selectOption('INHERIT');
  await expect(search).toHaveValue('INHERIT');
  await expect(remove).toHaveValue('hidden');
  expect(writes.slice(2)).toEqual([{ tool: 'delete_repo', exposure: 'hidden' }, { tool: 'search_issues', exposure: null }]);
});

test('a failed exposure save is reported and the saved value stays', async ({ authenticatedPage: page }) => {
  await stubServer(page, { exposure: 'codemode' });
  await page.goto('/mcp');
  await page.getByRole('button', { name: 'Tools and permissions for GitHub' }).click();
  const server = page.getByRole('combobox', { name: 'Exposure for GitHub' });
  await expect(server).toHaveValue('codemode');
  await server.selectOption('hidden');
  await expect(page.getByRole('alert')).toContainText(/disk full|500|error/i);
  await expect(server).toHaveValue('codemode');
});

test('a new server is added with the chosen exposure', async ({ authenticatedPage: page }) => {
  await stubServer(page, {});
  let posted: Record<string, unknown> | undefined;
  await page.route('**/api/mcp/servers', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    posted = route.request().postDataJSON();
    return json(route, 200, { server: posted });
  });
  await page.goto('/mcp');
  await page.getByRole('button', { name: 'Add Server' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('e.g., Brave Search').fill('Docs');
  await dialog.getByPlaceholder('https://n8n.example.com/mcp-server/http').fill('https://docs.example.com/mcp');
  await dialog.getByLabel('Tool exposure').selectOption('codemode');
  await dialog.getByRole('button', { name: 'Add & Connect' }).click();
  await expect.poll(() => posted?.exposure).toBe('codemode');
});

test('a server description is saved from the expanded server', async ({ authenticatedPage: page }) => {
  await stubServer(page, {});
  let saved: unknown;
  await page.route('**/api/mcp/servers/gh/description', route => {
    saved = route.request().postDataJSON();
    return json(route, 200, { success: true });
  });
  await page.goto('/mcp');
  await page.getByRole('button', { name: 'Tools and permissions for GitHub' }).click();
  const input = page.getByRole('textbox', { name: 'Description for GitHub' });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await input.fill('  Issues, pull requests and code search  ');
  await save.click();
  await expect(page.getByText('Description saved.')).toBeVisible();
  expect(saved).toEqual({ description: 'Issues, pull requests and code search' });
});
