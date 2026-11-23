import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { buildEmbedCsp, embedCspHeader } from '../../src/core/artifacts/csp';
import { promotedPage } from '../../src/core/inline-ui/promote';

/**
 * An interactive answer saved as an artifact, in a real browser (spec §7):
 * the page the server would serve — sanitized template, bundle built the
 * bundler's way (one IIFE: the `octi` shim, then the answer's script) and
 * inlined under its CSP hash as the embed route does (no bundle file is
 * served), the closed embed CSP as a header — opened directly, as a link
 * would open it.
 * Every request to a `.test` host is recorded, so "reaches no network" is
 * checked, not assumed.
 */

const HTML = '<p id="r">0</p><button id="ask" type="button">Ask</button> <a href="https://docs.test/tips">docs</a> <a href="#r">top</a>';
const JS = [
  "document.getElementById('r').textContent = '15% of 80 is 12';",
  "document.getElementById('ask').addEventListener('click', function () { octi.prompt('why 15%?').catch(function () {}); });",
  "fetch('https://leak.test/f').catch(function () {});",
  "var i = new Image(); i.src = 'https://leak.test/i.gif';",
  "document.body.setAttribute('data-origin', self.origin);",
].join('\n');

test('a saved answer runs after the shim, says what is not available, and reaches no network', async ({ page }) => {
  const saved = promotedPage({ html: HTML, css: 'p { font-weight: 600; }', js: JS, scripts: true });
  const bundle = await build({ stdin: { contents: saved.script, loader: 'js' }, bundle: true, format: 'iife', minify: true, write: false, platform: 'browser' });
  // As artifact-pages.ts: the bundle inline, a `</script` inside it escaped, pinned by its hash.
  const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const csp = buildEmbedCsp({ scriptSha256s: [createHash('sha256').update(script).digest('hex')], network: 'none' });
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>Saved</title>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${saved.css}</style></head><body>
${saved.template}
<script>${script}</script>
</body></html>`;

  const requests: string[] = [];
  await page.context().route(/https:\/\/[^/]*\.test\//, async (route) => {
    const url = route.request().url();
    if (url === 'https://art.test/a/tips/embed') {
      return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': embedCspHeader(csp) }, body: doc });
    }
    requests.push(url);
    return route.fulfill({ status: 200, body: 'x' });
  });

  await page.goto('https://art.test/a/tips/embed');
  await expect(page.locator('#r')).toHaveText('15% of 80 is 12');
  // Opened directly, the page still has an opaque origin (the header's sandbox).
  await expect(page.locator('body')).toHaveAttribute('data-origin', 'null');

  await page.locator('#ask').click();
  await expect(page.getByRole('status')).toContainText('not available here');

  await page.getByRole('link', { name: 'docs' }).click();
  await expect(page.getByRole('status')).toContainText('https://docs.test/tips');
  expect(page.url()).toBe('https://art.test/a/tips/embed');

  await page.waitForTimeout(300);
  expect(requests).toEqual([]);
});
