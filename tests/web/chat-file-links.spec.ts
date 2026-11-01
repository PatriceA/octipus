import { json, selectChatSession } from './fixtures/api-stubs';
import { expect, test } from './fixtures/auth';

for (const form of ['path', 'absolute-url', 'file-url']) {
  test(`chat ${form} file links open authenticated session preview`, async ({ authenticatedPage: page }) => {
    const path = '/home/patrice/Fintus git/ssp-composer-java/.verify/demo-shared-runtime.log';
    const origin = String(test.info().project.use.baseURL);
    const href = form === 'path' ? path : form === 'file-url' ? `file://${encodeURI(path)}` : `${origin}${encodeURI(path)}`;
    await page.route('**/api/sessions/*/messages**', route => json(route, 200, { messages: [{ id: 'local-file-link', role: 'assistant', content: `[Demo log](<${href}>)\n\n[Agent](/agents/31b261cf)\n\n[External](https://example.com/home/report.log)`, createdAt: '2026-11-01T10:00:00Z' }] }));
    let requested: string | null = null;
    await page.route('**/api/sessions/sess-1/files?*', route => {
      requested = new URL(route.request().url()).searchParams.get('path');
      return json(route, 200, { type: 'text', path, content: 'synthetic demo evidence', version: 'test-version', size: 23, modifiedAt: '2026-11-01T10:00:00Z' });
    });
    await page.goto('/chat'); await selectChatSession(page, 'sess-1');
    await expect(page.getByRole('link', { name: 'Agent', exact: true })).toHaveAttribute('href', '/agents/31b261cf');
    await expect(page.getByRole('link', { name: 'External', exact: true })).toHaveAttribute('href', 'https://example.com/home/report.log');
    await page.getByRole('button', { name: 'Demo log', exact: true }).click();
    await expect(page.locator('.workspace-file-view .cm-content')).toContainText('synthetic demo evidence');
    expect(requested).toBe(path); expect(new URL(page.url()).pathname).toBe('/chat');
  });
}
