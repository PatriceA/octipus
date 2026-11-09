import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Exercise the standalone design artifact without touching live application data.
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  const errors = [];
  const apiRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
  const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(name, import.meta.url)), fullPage: true });
  await page.goto(process.env.DESIGN_PREVIEW_URL || 'http://localhost:3007/design-preview/index.html');
  for (const [index, direction] of ['a', 'b', 'c'].entries()) {
    await page.locator(`[data-direction="${direction}"]`).click();
    await screenshot(`0${index + 1}-overview.png`);
  }
  await page.locator('[data-project-tab="ready"]').click();
  assert.equal(await page.locator('.project-detail').count(), 1);
  await page.getByRole('heading', { name: 'Dev: yetano', exact: true }).waitFor();
  await page.locator('[data-direction="a"]').click();
  await page.locator('.nav-item[data-view="settings"]').click();
  await screenshot('04-settings.png');
  await page.getByLabel('Find a setting').fill('gh');
  assert.equal(await page.locator('.setting-link').count(), 1);
  await page.getByRole('button', { name: 'Environments & Access', exact: true }).click();
  await page.getByRole('heading', { name: 'Environments & Access', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
  await page.locator('.nav-item[data-view="home"]').click();
  assert.ok(await page.locator('#frame').evaluate(element => element.classList.contains('collapsed')));
  await page.reload();
  assert.ok(await page.locator('#frame').evaluate(element => element.classList.contains('collapsed')));
  await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
  const companion = page.getByRole('button', { name: 'Open Companion', exact: true });
  await companion.click();
  await page.getByLabel('Ask Companion').fill('What is happening with Life2?');
  await page.getByRole('button', { name: 'Preview a reply', exact: false }).click();
  await page.getByRole('heading', { name: 'A reply that gives you the picture.', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.ok(await companion.evaluate(element => element === document.activeElement));
  await companion.click();
  await page.keyboard.press('Control+k');
  assert.ok(await page.locator('#dialog').evaluate(element => element.hidden));
  assert.ok(await page.getByLabel('Find a setting').evaluate(element => element === document.activeElement));
  await page.locator('[data-view="structure"]').first().click();
  await screenshot('05-structure.png');
  await page.locator('.nav-item[data-view="home"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('06-mobile.png');
  for (const direction of ['a', 'b', 'c']) {
    await page.locator(`[data-direction="${direction}"]`).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Mobile overflow in ${direction}`);
  }
  await page.getByLabel('Search settings', { exact: true }).waitFor();
  await page.getByLabel('Open navigation', { exact: true }).click();
  await page.locator('.nav-item[data-view="settings"]').click();
  await page.getByLabel('Find a setting').fill('heartbeat');
  await page.getByRole('button', { name: 'Heartbeat', exact: true }).click();
  await page.getByRole('switch', { name: 'Check in on my work' }).click();
  assert.equal(await page.getByRole('switch', { name: 'Check in on my work' }).getAttribute('aria-checked'), 'false');
  assert.deepEqual(errors, []);
  assert.deepEqual(apiRequests, []);
  console.log('PASS: three directions, project filtering, settings search, collapse persistence, modal focus/shortcut, mobile layout/navigation, Heartbeat control. No browser errors or API requests.');
} finally {
  await browser.close();
}
