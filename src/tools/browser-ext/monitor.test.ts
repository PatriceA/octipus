import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

function observer(url: string, element: { textContent: string } | null) {
  const script = readFileSync('browser-extension/background.js', 'utf8');
  const get = vi.fn(async () => ({ id: 42 }));
  const executeScript = vi.fn(async ({ func, args }: { func: (...args: unknown[]) => unknown; args: unknown[] }) => [{ result: func(...args) }]);
  const fn = runInNewContext(`${script.slice(script.indexOf('async function cmdObserve('))}; cmdObserve`, {
    chrome: { tabs: { get }, scripting: { executeScript } },
    location: { href: url }, document: { querySelector: () => element },
  });
  return { fn, get, executeScript };
}
const args = { tabId: 42, url: 'https://ci.example/runs/123', selector: '#status' };
test('browser observer reads the pinned tab without switching active tabs', async () => {
  const { fn, get } = observer(args.url, { textContent: ' Succeeded ' });
  expect(await fn(args)).toEqual({ url: args.url, text: 'Succeeded' });
  expect(get).toHaveBeenCalledWith(42);
});
test('browser observer never treats login/navigation or a missing selector as completion', async () => {
  expect(await observer('https://ci.example/login', { textContent: 'Succeeded' }).fn(args)).toHaveProperty('error');
  expect(await observer(args.url, null).fn(args)).toHaveProperty('error');
});
test('browser observer refuses implicit active-tab selection', async () => {
  await expect(observer(args.url, null).fn({ ...args, tabId: undefined })).rejects.toThrow('requires tabId');
});
