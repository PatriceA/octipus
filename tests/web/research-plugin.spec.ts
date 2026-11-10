import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

/**
 * The bundled Research plugin's page (plugins/research/ui, docs/PLUGIN-PACKAGES.md#bundled-plugins),
 * every /api call stubbed; the page is the plugin's real UI files, served with
 * the headers the server sends (the sandboxing CSP):
 *   - it renders in its sandboxed frame and connects over the bridge's MessagePort;
 *   - starting research (a write tool: it starts a background run) asks the
 *     user in the app, outside the frame, and runs only once allowed;
 *   - the page then reads the run (research_status, a read tool, never asked)
 *     until it is done, and shows the report as text;
 *   - saving the report (a write tool) asks again; saving again updates the
 *     same document;
 *   - refusing answers the page, and nothing starts;
 *   - Admin → Plugin packages lists it under Bundled, installs it, and says
 *     what agent:run and documents:write do.
 */

const UI_DIR = join(import.meta.dirname, '..', '..', 'plugins', 'research', 'ui');
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

/** What src/plugins/packages/ui.ts sends with a file. */
function csp(origin: string): string {
  const base = `${origin}/api/plugin-ui/research/`;
  return [
    "default-src 'none'", `script-src ${base}`, `style-src ${base}`, `img-src ${base} data:`, `font-src ${base}`, `media-src ${base}`,
    "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'",
    "frame-ancestors 'self'", 'sandbox allow-scripts',
  ].join('; ');
}

const PAGE = { plugin: 'research', pluginTitle: 'Research', path: 'run', title: 'Research', icon: 'telescope', src: '/api/plugin-ui/research/index.html' };
const RUN = '0b5c3e3a-6f0e-4c55-9a52-1d4a0f3b2c11';
const QUESTION = 'Why is the sky blue?';
const REPORT = [
  '# Why is the sky blue?', '',
  '## Answer', '', 'Sunlight scatters off air molecules; blue light scatters most [1].', '',
  '## Limitations', '', 'One source.', '',
  '## Sources', '', '1. NASA — https://science.nasa.gov/sky',
  '', '<img src="https://tracker.example.com/x.png"> <script>alert(1)</script>',
].join('\n');

type Call = { tool: string; body: { args: Record<string, unknown>; confirm?: boolean } };

const toolResult = (value: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });

async function stubResearch(page: Page, calls: Call[]): Promise<void> {
  let polls = 0;
  await page.route(/\/api\/plugin-ui\/research\/[^?#]+/, (route: Route) => {
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
  await page.route(/\/api\/plugins\/research\/call\/[^/]+$/, async (route) => {
    const req = route.request();
    const tool = new URL(req.url()).pathname.split('/').pop() ?? '';
    const body = req.postDataJSON() as Call['body'];
    calls.push({ tool, body });
    const write = tool === 'start_research' || tool === 'save_report';
    if (write && body.confirm !== true) return json(route, 409, { error: `${tool} needs your confirmation`, code: 'approval_required', tool, effect: 'write' });
    switch (tool) {
      case 'start_research': return json(route, 200, toolResult({ runId: RUN, status: 'running', question: body.args.question, depth: body.args.depth }));
      case 'research_status':
        polls += 1;
        return json(route, 200, toolResult(polls < 2
          ? { runId: RUN, status: 'running', stage: 'working', question: QUESTION }
          : { runId: RUN, status: 'done', stage: 'done', question: QUESTION, report: REPORT }));
      case 'save_report': return json(route, 200, toolResult(body.args.documentId
        ? { saved: true, updated: true, documentId: 'doc-1', name: 'Research — Why is the sky blue?.md' }
        : { saved: true, updated: false, documentId: 'doc-1', name: 'Research — Why is the sky blue?.md' }));
      default: return json(route, 404, { error: `research has no tool ${tool}`, code: 'unknown_tool' });
    }
  });
}

const frameOf = (page: Page) => page.frameLocator('[data-testid="plugin-frame"]');

test.describe('the Research plugin page', () => {
  test('starts research once the user allows it, shows the report when the run is done, and saves it', async ({ authenticatedPage: page }) => {
    const calls: Call[] = [];
    await stubResearch(page, calls);
    await page.goto('/plugins/research/run');
    const frame = frameOf(page);
    await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
    expect(await page.locator('[data-testid="plugin-frame"]').getAttribute('sandbox')).toBe('allow-scripts');
    await expect(frame.locator('body')).toHaveAttribute('data-bridge', 'connected');

    await frame.getByLabel('Question').fill(QUESTION);
    await frame.getByLabel('Depth').selectOption('quick');
    await frame.getByRole('button', { name: 'research' }).click();
    const dialog = page.getByTestId('plugin-confirm');
    await expect(dialog).toContainText('The plugin research (Research) wants to run start_research');
    await dialog.getByRole('button', { name: 'Allow once' }).click();
    await expect(frame.locator('body')).toHaveAttribute('data-state', 'running');
    await expect(frame.getByRole('status')).toContainText('researching');

    // Read without asking, until done; the report is text: no image, no script from it.
    await expect(frame.locator('body')).toHaveAttribute('data-state', 'done');
    await expect(frame.locator('#report h1')).toHaveText(QUESTION);
    await expect(frame.locator('#report h2')).toHaveText(['Answer', 'Limitations', 'Sources']);
    await expect(frame.locator('#report ol li .url')).toHaveText('https://science.nasa.gov/sky');
    await expect(frame.locator('#report img, #report script')).toHaveCount(0);
    await expect(frame.locator('#report')).toContainText('<img src=');

    await frame.getByRole('button', { name: 'Save to documents' }).click();
    await expect(dialog).toContainText('wants to run save_report');
    await dialog.getByRole('button', { name: 'Allow once' }).click();
    await expect(frame.locator('#saved')).toHaveText('Saved to your documents as "Research — Why is the sky blue?.md".');
    await frame.getByRole('button', { name: 'Save again' }).click();
    await page.getByTestId('plugin-confirm').getByRole('button', { name: 'Allow once' }).click();
    await expect(frame.locator('#saved')).toHaveText('Updated "Research — Why is the sky blue?.md".');

    expect(calls.map((c) => [c.tool, c.body.confirm === true])).toEqual([
      ['start_research', false], ['start_research', true], ['research_status', false], ['research_status', false],
      ['save_report', false], ['save_report', true], ['save_report', false], ['save_report', true],
    ]);
    expect(calls[1].body.args).toEqual({ question: QUESTION, depth: 'quick' });
    expect(calls[2].body.args).toEqual({ runId: RUN });
    expect(calls[5].body.args).toEqual({ runId: RUN });
    expect(calls[7].body.args).toEqual({ runId: RUN, documentId: 'doc-1' });
  });

  test('refusing the start answers the page, and nothing runs', async ({ authenticatedPage: page }) => {
    const calls: Call[] = [];
    await stubResearch(page, calls);
    await page.goto('/plugins/research/run');
    const frame = frameOf(page);
    await expect(frame.locator('body')).toHaveAttribute('data-ready', 'true');
    await frame.getByLabel('Question').fill(QUESTION);
    await frame.getByRole('button', { name: 'research' }).click();
    await page.getByTestId('plugin-confirm').getByRole('button', { name: 'Refuse' }).click();
    await expect(frame.getByRole('alert')).toHaveText('Not done: you did not allow it.');
    await expect(frame.getByRole('button', { name: 'research' })).toBeEnabled();
    expect(calls.filter((c) => c.body.confirm || c.tool === 'research_status')).toEqual([]);
  });

  test('the admin page offers it under Bundled, installs it, and says what its scopes do', async ({ authenticatedPage: page }) => {
    const posts: unknown[] = [];
    let installed: string | null = null;
    const pkg = {
      name: 'research', version: '1.0.0',
      manifest: {
        name: 'research', version: '1.0.0', apiVersion: '1.0.0', title: 'Research', description: 'Deep research in the background.',
        server: { command: 'node', args: ['server.mjs'] },
        tools: { start_research: { effect: 'write' }, research_status: { effect: 'read' }, save_report: { effect: 'write' } },
        host: ['agent:run', 'documents:write'],
        ui: { pages: [{ path: 'run', title: 'Research', icon: 'telescope', entry: 'index.html' }] },
      },
      enabled: false, settings: {}, secretsSet: [], problem: null, connected: false,
      network: { state: 'restricted', detail: 'Only the Octipus host API.' },
      contentHash: `sha256:${'b'.repeat(64)}`, actualHash: null, signedBy: null,
      signature: { status: 'unsigned', keyId: null, publisher: null, detail: 'Not signed' },
      approvedHostScopes: null, installedBy: null, installedAt: '2026-11-10T09:00:00Z', updatedAt: '2026-11-10T09:00:00Z',
    };
    await page.route(/\/api\/plugin-packages(\/.*)?$/, async (route: Route) => {
      const req = route.request();
      if (req.method() === 'GET' && req.url().endsWith('/bundled')) {
        return json(route, 200, [
          { name: 'reader', version: '1.0.0', title: 'Reader', description: 'Clean reading.', host: ['web:read', 'model:complete', 'notes:write', 'tasks:write'], network: [], installed: null },
          { name: 'research', version: '1.0.0', title: 'Research', description: 'Deep research in the background.', host: ['agent:run', 'documents:write'], network: [], installed },
        ]);
      }
      if (req.method() === 'GET') return json(route, 200, installed ? [pkg] : []);
      if (req.method() === 'POST') {
        posts.push(req.postDataJSON());
        installed = '1.0.0';
        return json(route, 200, { name: 'research', version: '1.0.0', enabled: false, signedBy: null, warnings: [] });
      }
      return json(route, 404, {});
    });
    await page.goto('/admin/plugins');
    await expect(page.locator('[data-testid="bundled-plugin"][data-name="reader"]')).toContainText('Reader');
    const row = page.locator('[data-testid="bundled-plugin"][data-name="research"]');
    await expect(row).toContainText('agent:run, documents:write');
    await row.getByRole('button', { name: 'Install research' }).click();
    await expect(page.getByTestId('bundled-plugins').getByRole('status')).toContainText('Installed research 1.0.0 (disabled)');
    expect(posts).toEqual([{ bundled: 'research' }]);

    const installedRow = page.locator('[data-testid="plugin-package"][data-name="research"]');
    const notes = installedRow.getByTestId('plugin-scope-note');
    await expect(notes).toHaveCount(2);
    await expect(notes.first()).toContainText('agent:run starts background agent runs as the user');
    await expect(notes.last()).toContainText('documents:write creates text documents');
    const dialogs: string[] = [];
    page.once('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await installedRow.getByRole('button', { name: 'Enable research' }).click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain('approve its host API scopes agent:run, documents:write');
    expect(dialogs[0]).toContain('unattended');
  });
});
