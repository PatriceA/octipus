import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

for (const path of ['/mcp', '/tools']) {
  test(`MCP permissions persist per tool on ${path}`, async ({ authenticatedPage: page }) => {
    const tools = ['jira_search_jql', 'jira_update_issue'].map(name => ({
      serverId: 'jira-custom', name, description: name, inputSchema: {},
    }));
    let permissions: Array<{ toolId: string; action: string; level: string }> = [];
    const writes: unknown[] = [];
    await page.route('**/api/tools', route => json(route, 200, { tools: [] }));
    await page.route('**/api/mcp/tools', route => json(route, 200, { tools }));
    await page.route('**/api/mcp/servers', route => json(route, 200, { servers: [{
      id: 'jira-custom', name: 'Jira Custom', command: '', transport: 'streamable-http',
      isEnabled: true, status: 'connected', toolCount: 2, resourceCount: 0, promptCount: 0,
    }] }));
    await page.route('**/api/mcp/servers/jira-custom/tools', route => json(route, 200, { tools }));
    await page.route('**/api/tools/permissions**', route => {
      const request = route.request();
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        writes.push(body);
        permissions = [body];
        return json(route, 200, { permission: body });
      }
      if (request.method() === 'DELETE') {
        expect(decodeURIComponent(new URL(request.url()).pathname)).toBe('/api/tools/permissions/mcp/jira-custom.jira_search_jql');
        permissions = [];
        return json(route, 200, { deleted: true });
      }
      return json(route, 200, { permissions });
    });
    async function open() {
      await page.goto(path);
      if (path === '/mcp') await page.getByRole('button', { name: 'Tools and permissions for Jira Custom' }).click();
    }
    await open();
    const search = page.getByRole('combobox', { name: 'Permission for jira-custom / jira_search_jql' });
    const update = page.getByRole('combobox', { name: 'Permission for jira-custom / jira_update_issue' });
    await expect(search).toHaveValue('DEFAULT');
    await search.selectOption('ALLOW');
    await expect(search).toHaveValue('ALLOW');
    expect(writes[0]).toEqual({ toolId: 'mcp', action: 'jira-custom.jira_search_jql', level: 'ALLOW' });
    await expect(update).toHaveValue('DEFAULT');
    await open();
    await expect(search).toHaveValue('ALLOW');
    for (const level of ['ASK', 'DENY', 'DEFAULT']) {
      await search.selectOption(level);
      await expect(search).toHaveValue(level);
      await expect(search).toBeEnabled();
    }
  });
}

test('MCP permission save failure is visible and retains the saved value', async ({ authenticatedPage: page }) => {
  await page.route('**/api/tools', route => json(route, 200, { tools: [] }));
  await page.route('**/api/mcp/tools', route => json(route, 200, { tools: [
    { serverId: 'jira', name: 'read', description: 'Read', inputSchema: {} },
  ] }));
  await page.route('**/api/tools/permissions', route => route.request().method() === 'PUT'
    ? json(route, 403, { error: 'Permission update rejected' })
    : json(route, 200, { permissions: [] }));
  await page.goto('/tools');
  const select = page.getByRole('combobox', { name: 'Permission for jira / read' });
  await select.selectOption('ALLOW');
  await expect(page.getByRole('alert')).toContainText('Permission update rejected');
  await expect(select).toHaveValue('DEFAULT');
});
