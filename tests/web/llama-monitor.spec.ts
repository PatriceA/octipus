import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, expectNoConsoleErrors } from './fixtures/auth';

// Run against the actual package, not a copied imitation:
// LLAMA_MONITOR_UI_DIR=<package>/ui npx playwright test tests/web/llama-monitor.spec.ts
const UI = process.env.LLAMA_MONITOR_UI_DIR;
test.skip(!UI, 'Set LLAMA_MONITOR_UI_DIR to the package under review.');
const plugin = 'llama-monitor';
const base = '/api/plugin-ui/' + plugin + '/';
const pageLink = { plugin, pluginTitle: 'llama.cpp Monitor', title: 'llama.cpp Monitor', path: 'dashboard', src: base + 'index.html' };

test('real dashboard saves engines, reloads, reads, records, shares theme and fits desktop/mobile', async ({ authenticatedPage: page, consoleErrors }) => {
  const entries = new Map<string, { value: unknown; version: number }>();
  let probes = 0;
  let denyProfiles = true;
  await page.route('**/api/plugin-ui', r => r.fulfill({ json: { pages: [pageLink], dashboards: [] } }));
  await page.route('**/api/plugin-ui/llama-monitor/**', r => {
    const url = new URL(r.request().url());
    const file = url.pathname.slice(base.length);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'text/javascript';
    const source = url.origin + base;
    return r.fulfill({
      body: readFileSync(join(UI!, file)),
      headers: {
        'content-type': type,
        'access-control-allow-origin': '*',
        'content-security-policy': [
          "default-src 'none'", 'script-src ' + source, 'style-src ' + source,
          "connect-src 'none'", "frame-src 'none'", "form-action 'none'",
          "base-uri 'none'", "frame-ancestors 'self'", 'sandbox allow-scripts'
        ].join('; '),
      },
    });
  });
  await page.route('**/api/plugins/llama-monitor/store**', async r => {
    const request = r.request(), url = new URL(request.url());
    const key = decodeURIComponent(url.pathname.split('/store/')[1] || '');
    if (request.method() === 'GET' && !key) {
      return r.fulfill({ json: { keys: [...entries.keys()].filter(k => k.startsWith(url.searchParams.get('prefix') || '')).sort().map(key => ({ key })), truncated: false } });
    }
    if (request.method() === 'GET') {
      if (key === 'profiles' && denyProfiles) return r.fulfill({ status: 403, json: { error: 'Store access denied', code: 'scope_missing' } });
      return r.fulfill(entries.has(key) ? { json: entries.get(key) } : { status: 404, json: { error: 'No such key', code: 'not_found' } });
    }
    if (request.method() === 'PUT') {
      const body = request.postDataJSON(), version = (entries.get(key)?.version || 0) + 1;
      entries.set(key, { value: body.value, version });
      return r.fulfill({ json: { version } });
    }
    entries.delete(key);
    return r.fulfill({ json: { deleted: true } });
  });
  await page.route('**/api/plugins/llama-monitor/call/read_engine', r => {
    probes++;
    const snapshot = {
      at: new Date().toISOString(), health: { status: 'ok' },
      models: { data: [{ id: 'Browser test model', status: 'loaded' }] },
      metrics: [
        'llamacpp:prompt_tokens_total ' + probes * 100,
        'llamacpp:prompt_seconds_total ' + probes,
        'llamacpp:tokens_predicted_total ' + probes * 40,
        'llamacpp:tokens_predicted_seconds_total ' + probes,
        'llamacpp:requests_processing 1'
      ].join('\n'),
    };
    return r.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(snapshot) }] } } });
  });

  await page.goto('/plugins/llama-monitor/dashboard');
  const frame = page.frameLocator('[data-testid="plugin-frame"]');
  await expect(frame.locator('#error')).toHaveText('Store access denied');
  await expect(frame.locator('#save')).toBeDisabled();
  await expect(frame.locator('#retry-load')).toBeVisible();
  denyProfiles = false;
  await frame.locator('#retry-load').click();
  await expect(frame.locator('#status')).toContainText('Ready.');
  await expect(frame.locator('#save')).toBeEnabled();
  await expect(frame.locator('#retry-load')).toBeHidden();
  await expect(frame.locator('h1')).toHaveCSS('font-size', '26px');
  const box = await page.getByTestId('plugin-frame').boundingBox();
  expect(box!.height).toBeGreaterThan(500);
  expect(box!.width).toBeGreaterThan(900);
  await frame.locator('#name').fill('Test engine');
  await frame.locator('#url').fill('https://engine.example.com');
  await frame.locator('#connection').fill('engine_api');
  await frame.locator('#save').click();
  await expect(frame.locator('#status')).toContainText('Engine saved: Test engine');
  await expect(frame.locator('#engines option')).toHaveCount(2);
  await frame.locator('#refresh').click();
  await expect(frame.locator('#models')).toContainText('Browser test model · loaded');
  await expect(frame.locator('#host-status')).toContainText('Collector not configured');
  await expect(frame.locator('#host-cards')).toBeHidden();
  await expect(frame.locator('#cards .card')).toHaveCount(6);
  await page.reload();
  await expect(frame.locator('#status')).toContainText('Ready.');
  await expect(frame.locator('#engines')).not.toHaveValue('');

  await page.evaluate(() => {
    document.documentElement.style.setProperty('--color-background', 'rgb(18, 30, 40)');
    document.documentElement.style.setProperty('--color-primary', 'rgb(40, 180, 140)');
    document.documentElement.classList.add('dark');
  });
  await expect(frame.locator('html')).toHaveCSS('background-color', 'rgb(18, 30, 40)');
  await expect(frame.locator('#refresh')).toHaveCSS('background-color', 'rgb(40, 180, 140)');
  await frame.locator('#interval').selectOption('5');
  await frame.locator('#start').click();
  await expect(frame.locator('#stop')).toBeEnabled();
  await expect.poll(() => probes, { timeout: 10000 }).toBeGreaterThanOrEqual(3);
  await frame.locator('#stop').click();
  await expect(frame.locator('#session-label')).toHaveText('Session stopped and saved.');
  await expect(frame.locator('#summary')).toContainText('40 tok/s');
  await expect(frame.locator('#history option')).toHaveCount(1);
  await page.reload();
  await expect(frame.locator('#status')).toContainText('Ready.');
  await frame.locator('#view').click();
  await expect(frame.locator('#mode')).toHaveText('Saved session · Test engine');
  await expect(frame.locator('#summary')).toContainText('40 tok/s');

  await frame.locator('#collector-config').fill('host_metrics');
  await frame.locator('#save-collector').click();
  await expect(frame.locator('#status')).toContainText('Collector connection saved');
  await page.reload();
  await expect(frame.locator('#collector-config')).toHaveValue('host_metrics');
  await expect(frame.locator('#host-status')).toContainText('Collector has not returned');

  await page.setViewportSize({ width: 390, height: 844 });
  const iframe = page.frames().find(f => f.url().includes(base))!;
  expect(await iframe.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/llama-monitor-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/llama-monitor-desktop.png', fullPage: true });
  expectNoConsoleErrors(consoleErrors);
});
