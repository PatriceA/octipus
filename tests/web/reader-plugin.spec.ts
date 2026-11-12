import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { consentView, HASH, perms, preview, PREVIEW_ID, tickAll } from './fixtures/plugin-consent';
import { json } from './fixtures/api-stubs';

/**
 * The bundled Reader plugin's page (plugins/reader/ui, docs/PLUGIN-PACKAGES.md#bundled-plugins),
 * every /api call stubbed; the page is the plugin's real UI files, served with
 * the headers the server sends (the sandboxing CSP):
 *   - it renders in its sandboxed frame, connects over the bridge's
 *     MessagePort, and reads an article through it (read_url), showing it cleaned;
 *   - an action (action_items) runs through the bridge and its items show;
 *   - saving them as to-dos (a write tool) asks the user in the app, outside
 *     the frame, and runs only once allowed; the frame says what was saved;
 *   - saving the article as a note works the same way;
 *   - Admin → Plugin packages lists it under Bundled and installs it (disabled).
 */

const UI_DIR = join(import.meta.dirname, '..', '..', 'plugins', 'reader', 'ui');
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

/** What src/plugins/packages/ui.ts sends with a file. */
function csp(origin: string): string {
  const base = `${origin}/api/plugin-ui/reader/`;
  return [
    "default-src 'none'", `script-src ${base}`, `style-src ${base}`, `img-src ${base} data:`, `font-src ${base}`, `media-src ${base}`,
    "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'",
    "frame-ancestors 'self'", 'sandbox allow-scripts',
  ].join('; ');
}

const PAGE = { plugin: 'reader', pluginTitle: 'Reader', path: 'read', title: 'Reader', icon: 'newspaper', src: '/api/plugin-ui/reader/index.html' };
const ARTICLE = {
  url: 'https://news.example.com/plan', title: 'Plan for the week', byline: 'Ada Lovelace', siteName: 'Example News',
  wordCount: 31, estReadMinutes: 1, truncated: false,
  text: 'This week we should buy milk and call Bob.',
  contentHtml: '<p>This week we should <strong>buy milk</strong> and call Bob.</p><p><a href="/next">Next article</a></p>',
};

type Call = { tool: string; body: { args: Record<string, unknown>; confirm?: boolean } };

const toolResult = (value: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });

async function stubReader(page: Page, calls: Call[]): Promise<void> {
  await page.route(/\/api\/plugin-ui\/reader\/[^?#]+/, (route: Route) => {
    const url = new URL(route.request().url());
    const file = url.pathname.split('/').pop() ?? '';
    const ext = file.split('.').pop() ?? '';
    if (!TYPES[ext]) return route.fulfill({ status: 404, body: 'Not found' });
    return route.fulfill({
      status: 200,
      body: readFileSync(join(UI_DIR, file)),
      headers: { 'content-type': TYPES[ext], 'content-security-policy': csp(url.origin), 'x-content-type-options': 'nosniff' },
    });
  });
  await page.route(/\/api\/plugin-ui$/, (route) => json(route, 200, { pages: [PAGE] }));
  await page.route(/\/api\/plugins\/reader\/call\/[^/]+$/, async (route) => {
    const req = route.request();
    const tool = new URL(req.url()).pathname.split('/').pop() ?? '';
    const body = req.postDataJSON() as Call['body'];
    calls.push({ tool, body });
    const write = tool === 'save_note' || tool === 'create_tasks';
    if (write && body.confirm !== true) return json(route, 409, { error: `${tool} needs your confirmation`, code: 'approval_required', tool, effect: 'write' });
    switch (tool) {
      case 'read_url': return json(route, 200, toolResult({ ...ARTICLE, url: body.args.url }));
      case 'reader_action': return json(route, 200, toolResult({ action: body.args.action, output: '- Buy milk\n- Call Bob', items: ['Buy milk', 'Call Bob'] }));
      case 'create_tasks': return json(route, 200, toolResult({ created: 2, tasks: [{ id: 't1', title: 'Buy milk' }, { id: 't2', title: 'Call Bob' }] }));
      case 'save_note': return json(route, 200, toolResult({ saved: true, id: 'n1', slug: 'plan-for-the-week', title: body.args.title }));
      default: return json(route, 404, { error: `reader has no tool ${tool}`, code: 'unknown_tool' });
    }
  });
}

const frameOf = (page: Page) => page.frameLocator('[data-testid="plugin-frame"]');

async function readArticle(page: Page): Promise<void> {
  await page.goto('/plugins/reader/read');
  const frame = frameOf(page);
  await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
  await frame.getByLabel('Article URL').fill(ARTICLE.url);
  await frame.getByRole('button', { name: 'read' }).click();
  await expect(frame.locator('#title')).toHaveText('Plan for the week');
}

test.describe('the Reader plugin page', () => {
  test('reads an article in the sandboxed frame, and saves its action items once the user allows it', async ({ authenticatedPage: page }) => {
    const calls: Call[] = [];
    await stubReader(page, calls);
    await readArticle(page);
    const frame = frameOf(page);
    expect(await page.locator('[data-testid="plugin-frame"]').getAttribute('sandbox')).toBe('allow-scripts');
    // The page connected over the bridge's port (the fragment the app put on its URL).
    await expect(frame.locator('body')).toHaveAttribute('data-bridge', 'connected');
    await expect(frame.locator('#meta')).toContainText('Example News · Ada Lovelace');
    await expect(frame.locator('#content strong')).toHaveText('buy milk');
    // A link in the article is not followed out of the frame: it fills the address field.
    await frame.getByRole('link', { name: 'Next article' }).click();
    await expect(frame.getByLabel('Article URL')).toHaveValue('https://news.example.com/next');
    await expect(frame.locator('#title')).toHaveText('Plan for the week');

    await frame.getByRole('button', { name: 'Action items' }).click();
    await expect(frame.locator('#items li')).toHaveText(['Buy milk', 'Call Bob']);

    await frame.getByRole('button', { name: 'Save as to-dos' }).click();
    const dialog = page.getByTestId('plugin-confirm');
    await expect(dialog).toContainText('The plugin reader (Reader) wants to run create_tasks');
    await dialog.getByRole('button', { name: 'Allow once' }).click();
    await expect(frame.locator('#saved')).toHaveText('2 added to your to-do list.');

    expect(calls.map((c) => [c.tool, c.body.confirm === true])).toEqual([
      ['read_url', false], ['reader_action', false], ['create_tasks', false], ['create_tasks', true],
    ]);
    expect(calls[0].body.args).toEqual({ url: ARTICLE.url, includeHtml: true });
    expect(calls[1].body.args).toEqual({ action: 'action_items', text: ARTICLE.text, url: ARTICLE.url });
    expect(calls[3].body.args).toEqual({ items: ['Buy milk', 'Call Bob'], url: ARTICLE.url, title: 'Plan for the week' });
  });

  test('translate asks for its language in the page, and the article saves as a note', async ({ authenticatedPage: page }) => {
    const calls: Call[] = [];
    await stubReader(page, calls);
    await readArticle(page);
    const frame = frameOf(page);

    await frame.getByRole('button', { name: 'Translate' }).click();
    await frame.getByLabel('Target language (e.g. French)').fill('French');
    await frame.getByRole('button', { name: 'run' }).click();
    await expect(frame.locator('#result-title')).toHaveText('Translation');
    expect(calls.at(-1)).toEqual({ tool: 'reader_action', body: { args: { action: 'translate', text: ARTICLE.text, url: ARTICLE.url, argument: 'French' } } });

    await frame.getByRole('button', { name: 'Save article' }).click();
    await page.getByTestId('plugin-confirm').getByRole('button', { name: 'Allow once' }).click();
    await expect(frame.locator('#article-saved')).toHaveText('Saved as the note "Plan for the week".');
    expect(calls.filter((c) => c.tool === 'save_note').map((c) => c.body)).toEqual([
      { args: { title: 'Plan for the week', body: ARTICLE.text, url: ARTICLE.url } },
      { args: { title: 'Plan for the week', body: ARTICLE.text, url: ARTICLE.url }, confirm: true },
    ]);
  });

  test('refusing the save answers the page, and nothing is saved', async ({ authenticatedPage: page }) => {
    const calls: Call[] = [];
    await stubReader(page, calls);
    await readArticle(page);
    const frame = frameOf(page);
    await frame.getByRole('button', { name: 'Save article' }).click();
    await page.getByTestId('plugin-confirm').getByRole('button', { name: 'Refuse' }).click();
    await expect(frame.getByRole('alert')).toHaveText('Not saved: you did not allow it.');
    expect(calls.filter((c) => c.tool === 'save_note' && c.body.confirm)).toEqual([]);
  });

  test('the admin page offers it under Bundled and installs it, with consent per item', async ({ authenticatedPage: page }) => {
    const readerPerms = perms('reader', {
      host: ['model:complete', 'notes:write', 'tasks:write', 'web:read'],
      tools: [{ name: 'create_tasks', effect: 'write' }, { name: 'read_url', effect: 'read' }, { name: 'reader_action', effect: 'read' }, { name: 'save_note', effect: 'write' }],
      pages: [{ path: 'read', title: 'Reader', entry: 'index.html' }], ui: { dir: 'ui', sha256: 'ab'.repeat(32) },
    });
    const posts: unknown[] = [];
    let installed: string | null = null;
    await page.route(/\/api\/plugin-packages(\/.*)?$/, async (route: Route) => {
      const req = route.request();
      if (req.method() === 'GET' && req.url().endsWith('/bundled')) {
        return json(route, 200, [{
          name: 'reader', version: '1.0.0', title: 'Reader', description: 'Read a web page in a clean view.',
          host: ['web:read', 'model:complete', 'notes:write', 'tasks:write'], network: [], installed,
        }]);
      }
      if (req.method() === 'GET') return json(route, 200, []);
      if (req.method() === 'POST' && req.url().endsWith('/preview')) {
        posts.push(req.postDataJSON());
        return json(route, 200, preview(readerPerms, { title: 'Reader', origin: { source: 'bundled' }, signedBy: null }));
      }
      if (req.method() === 'POST' && req.url().endsWith('/install')) {
        posts.push(req.postDataJSON());
        installed = '1.0.0';
        return json(route, 200, { name: 'reader', version: '1.0.0', contentHash: HASH, enabled: false, enableProblem: null, warnings: [] });
      }
      return json(route, 404, {});
    });
    await page.goto('/admin/plugins');
    const row = page.locator('[data-testid="bundled-plugin"][data-name="reader"]');
    await expect(row).toContainText('Reader');
    await expect(row).toContainText('web:read, model:complete, notes:write, tasks:write');
    await row.getByRole('button', { name: 'Install reader' }).click();
    const consent = page.getByTestId('plugin-consent');
    await expect(consent.getByRole('heading', { level: 2 })).toHaveText('Install Reader');
    await expect(consent.locator('[data-id="host:web:read"]')).toContainText('Fetches web pages through Octipus');
    await tickAll(consent);
    await consent.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(page.getByTestId('bundled-plugins').getByRole('status')).toContainText('Installed reader 1.0.0 (disabled)');
    await expect(row).toContainText('installed');
    expect(posts).toEqual([{ bundled: 'reader' }, { previewId: PREVIEW_ID, contentHash: HASH, accepted: preview(readerPerms).declarations.map((d) => d.id), enable: false }]);
  });

  test('the admin page warns when an egress scope comes with a read scope, and shows a bundled name another package took', async ({ authenticatedPage: page }) => {
    const pkg = {
      name: 'summarizer', version: '1.0.0',
      manifest: {
        name: 'summarizer', version: '1.0.0', apiVersion: '1.0.0', title: 'Summarizer', description: 'Summarizes documents',
        server: { command: 'node', args: ['server.mjs'] }, tools: { summarize: { effect: 'read' } },
        host: ['documents:read', 'model:complete'],
      },
      enabled: false, settings: {}, secretsSet: [], problem: null, connected: false,
      network: { state: 'restricted', detail: 'Only the Octipus host API.' },
      contentHash: `sha256:${'a'.repeat(64)}`, actualHash: null, signedBy: null,
      signature: { status: 'unsigned', keyId: null, publisher: null, detail: 'Not signed' },
      approvedHostScopes: null, installedBy: null, installedAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-01T09:00:00Z',
    };
    const patches: unknown[] = [];
    await page.route(/\/api\/plugin-packages(\/.*)?$/, async (route: Route) => {
      const req = route.request();
      if (req.method() === 'GET' && req.url().endsWith('/bundled')) {
        return json(route, 200, [{ name: 'reader', version: '1.0.0', title: 'Reader', description: 'Clean reading.', host: ['web:read'], network: [], installed: null, taken: true }]);
      }
      if (req.method() === 'GET' && req.url().endsWith('/summarizer/consent')) {
        return json(route, 200, consentView(perms('summarizer', { host: ['documents:read', 'model:complete'], tools: [{ name: 'summarize', effect: 'read' }] })));
      }
      if (req.method() === 'GET') return json(route, 200, [pkg]);
      if (req.method() === 'PATCH') {
        patches.push(req.postDataJSON());
        return json(route, 200, pkg);
      }
      return json(route, 404, {});
    });
    await page.goto('/admin/plugins');
    const row = page.locator('[data-testid="plugin-package"][data-name="summarizer"]');
    await expect(row.getByTestId('plugin-egress-warning')).toContainText('can send what it reads anywhere');
    // Enabling shows the same warning under each scope it concerns, as guidance, never a refusal.
    await row.getByRole('button', { name: 'Enable summarizer' }).click();
    const consent = page.getByTestId('plugin-consent');
    for (const scope of ['documents:read', 'model:complete']) {
      const guidance = consent.locator(`[data-id="host:${scope}"]`).getByTestId('consent-guidance');
      await expect(guidance).toContainText('model:complete and documents:read together, this package can send what it reads anywhere');
      await expect(guidance).toHaveAttribute('data-tone', 'warning');
    }
    // Cancelled: nothing was enabled.
    await consent.getByRole('button', { name: 'Cancel' }).click();
    expect(patches).toEqual([]);

    const bundled = page.locator('[data-testid="bundled-plugin"][data-name="reader"]');
    await expect(bundled.getByTestId('bundled-taken')).toHaveText('name taken by another package');
    await expect(bundled.getByRole('button', { name: 'Install reader' })).toHaveCount(0);
  });
});
