import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

for (const transport of ['streamable-http', 'sse', 'stdio']) {
  test(`edit ${transport} configuration without disconnecting`, async ({ authenticatedPage: page }) => {
    const server = { id: 'test', name: 'Test server', transport, command: 'node', args: ['path with spaces.js'], cwd: '/old',
      sseUrl: 'https://example.com/sse', postUrl: 'https://other.example.com/messages', isEnabled: true,
      status: 'connected', toolCount: 0, resourceCount: 0, promptCount: 0 };
    await page.route('**/api/mcp/servers', route => json(route, 200, { servers: [server] }));
    let saved: Record<string, unknown> | undefined;
    await page.route('**/api/mcp/servers/test/config', route => {
      if (route.request().method() === 'PUT') {
        saved = route.request().postDataJSON();
        return json(route, 200, { success: true });
      }
      return json(route, 200, { server: { ...server, revision: 'rev', hasAuthorization: true, envNames: ['TOKEN'] } });
    });
    const disconnects: string[] = [];
    await page.route('**/api/mcp/servers/test/disconnect', route => { disconnects.push('disconnect'); return json(route, 200, {}); });
    await page.goto('/mcp');
    await page.getByRole('button', { name: 'Edit Test server' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit MCP server' });
    if (transport === 'stdio') {
      await expect(dialog.getByLabel('Arguments (JSON array)')).toHaveValue('["path with spaces.js"]');
      await dialog.getByLabel('Command or executable path').fill('/new path/node');
      await dialog.getByLabel('Environment changes').fill('TOKEN=new-token');
    } else {
      await expect(dialog.getByLabel('Authorization header', { exact: true })).toHaveValue('');
      await dialog.getByLabel(transport === 'sse' ? 'SSE URL' : 'Server URL', { exact: true }).fill('https://new.example.com/mcp');
      if (transport === 'sse') await expect(dialog.getByLabel('POST URL')).toHaveValue(server.postUrl);
      await dialog.getByLabel('Authorization header', { exact: true }).fill('Bearer new-token');
    }
    await expect(dialog.getByLabel('Trust server recovery declarations')).not.toBeChecked();
    await dialog.getByLabel('Trust server recovery declarations').check();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).not.toBeVisible();
    expect(saved).toEqual(transport === 'stdio'
      ? { revision: 'rev', trustRecoveryHints: true, command: '/new path/node', envPatch: { TOKEN: 'new-token' } }
      : { revision: 'rev', trustRecoveryHints: true, sseUrl: 'https://new.example.com/mcp', authorization: 'Bearer new-token' });
    expect(disconnects).toEqual([]);
  });
}

test('conflicts stay visible and blank token is omitted', async ({ authenticatedPage: page }) => {
  const server = { id: 'test', name: 'Test', transport: 'streamable-http', command: '', sseUrl: 'https://example.com/mcp', isEnabled: true, status: 'disconnected' };
  await page.route('**/api/mcp/servers', route => json(route, 200, { servers: [server] }));
  let saved: Record<string, unknown> | undefined;
  await page.route('**/api/mcp/servers/test/config', route => {
    if (route.request().method() === 'PUT') { saved = route.request().postDataJSON(); return json(route, 409, { error: 'Server changed. Reload configuration.' }); }
    return json(route, 200, { server: { ...server, revision: 'rev', hasAuthorization: true, envNames: [] } });
  });
  await page.goto('/mcp');
  await page.getByRole('button', { name: 'Edit Test', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill('Renamed');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Server changed');
  expect(saved).toEqual({ revision: 'rev', name: 'Renamed' });
});
