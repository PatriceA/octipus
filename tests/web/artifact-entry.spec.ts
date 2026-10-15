import { expect, test } from '@playwright/test';
import { artifactEntryPage } from '../../src/core/artifacts/entry-page';

for (const signedIn of [true, false]) {
  test(`external artifact links recover Strict-cookie access: signed in = ${signedIn}`, async ({ page, context }) => {
    if (signedIn) await context.addCookies([{ name: 'session_token', value: 'test-owner', domain: 'artifact.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    const entry = artifactEntryPage('https://artifact.test/login?returnTo=%2Fartifacts');
    const seen: Array<{ cookie: boolean; retry: boolean }> = [];
    await page.route('https://artifact.test/a/private', async route => {
      const headers = await route.request().allHeaders();
      const cookie = headers.cookie?.includes('session_token=test-owner') === true;
      const retry = headers['x-octipus-artifact-entry'] === '1';
      seen.push({ cookie, retry });
      if (cookie) return route.fulfill({ contentType: 'text/html', body: '<h1>Private artifact</h1>' });
      if (retry) return route.fulfill({ status: 404, body: 'Not found' });
      return route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': entry.csp }, body: entry.html });
    });
    await page.route('https://outside.test/', route => route.fulfill({ contentType: 'text/html', body: '<a href="https://artifact.test/a/private">Open</a>' }));
    await page.goto('https://outside.test/');
    await page.getByRole('link', { name: 'Open' }).click();
    if (signedIn) {
      await expect(page.getByRole('heading', { name: 'Private artifact' })).toBeVisible();
      expect(seen).toEqual([{ cookie: false, retry: false }, { cookie: true, retry: true }, { cookie: true, retry: false }]);
    } else {
      await expect(page.locator('#status')).toContainText('Sign in to Octipus');
      expect(seen).toEqual([{ cookie: false, retry: false }, { cookie: false, retry: true }]);
      await expect(page.getByRole('heading', { name: 'Private artifact' })).toHaveCount(0);
    }
  });
}
