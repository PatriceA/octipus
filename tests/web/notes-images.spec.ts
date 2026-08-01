import { expect, test } from './fixtures/auth';
import { stubAllDefaults } from './fixtures/api-stubs';

/**
 * Images in notes: paste/drop/pick uploads through the documents pipeline and
 * the note body gets a markdown link the preview can actually render.
 *
 * The preview path is the non-obvious half: an `<img src="/api/…">` cannot
 * carry credentials in every deployment (the desktop client authenticates with
 * a bearer token that `<img>` never sends), so the renderer fetches the bytes
 * through the API client and shows an object URL. These tests assert the whole
 * chain — upload request → markdown in the body → authenticated read-back.
 */
test.describe('notes — images', () => {
  test.beforeEach(async ({ authenticatedPage }) => {
    await stubAllDefaults(authenticatedPage);
  });

  /** Open the first note and switch the editor to split so both panes exist. */
  async function openNote(page: import('@playwright/test').Page) {
    await page.goto('/notes');
    await page.getByText('First note', { exact: false }).first().click();
    await expect(page.getByRole('button', { name: /^split$/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^split$/i }).click();
  }

  test('pasting an image uploads it and inserts a markdown link', async ({ authenticatedPage: page }) => {
    const uploads: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/documents/upload')) uploads.push(r.method());
    });

    await openNote(page);
    await page.locator('.cm-content').click();

    // Synthesize a real clipboard paste carrying an image file.
    await page.locator('.cm-content').evaluate((el) => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'pasted.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    await expect.poll(() => uploads.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(uploads[0]).toBe('POST');
    // The placeholder must be replaced by the real link, not left behind.
    await expect(page.locator('.cm-content')).toContainText('/api/documents/doc-img-1/raw', { timeout: 10_000 });
    await expect(page.locator('.cm-content')).not.toContainText('#upload-');
  });

  test('the preview renders the image through an authenticated fetch', async ({
    authenticatedPage: page,
  }) => {
    const rawReads: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/documents/doc-img-1/raw')) rawReads.push(r.url());
    });

    await openNote(page);
    await page.locator('.cm-content').click();
    await page.keyboard.type('\n![shot](/api/documents/doc-img-1/raw)\n');

    // Fetched by the API client (so credentials ride along), then shown as an
    // object URL — a plain `<img src="/api/…">` would never have been fetched
    // this way and would break on the desktop client.
    await expect.poll(() => rawReads.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const img = page.locator('img[alt="shot"]');
    await expect(img).toBeVisible({ timeout: 10_000 });
    await expect(img).toHaveAttribute('src', /^blob:/);
  });

  test('a web link renders as a real anchor that opens in a new tab', async ({
    authenticatedPage: page,
  }) => {
    await openNote(page);
    await page.locator('.cm-content').click();
    await page.keyboard.type('\n[Anthropic](https://www.anthropic.com)\n');

    const link = page.getByRole('link', { name: 'Anthropic' });
    await expect(link).toBeVisible({ timeout: 10_000 });
    await expect(link).toHaveAttribute('href', 'https://www.anthropic.com');
    await expect(link).toHaveAttribute('target', '_blank');
    // Without rel=noopener the opened page gets a handle back to this one.
    await expect(link).toHaveAttribute('rel', /noopener/);
  });
});
