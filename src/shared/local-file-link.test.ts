import { expect, test } from 'vitest';
import { localFileLink } from './local-file-link';
const origin = 'http://localhost:3007';
test.each(['/home/patrice/Fintus%20git/project/demo.log', `${origin}/home/patrice/Fintus%20git/project/demo.log`, 'file:///home/patrice/Fintus%20git/project/demo.log'])('opens encoded local file reference %s', href => {
  expect(localFileLink(href, origin)).toBe('/home/patrice/Fintus git/project/demo.log');
});
test.each(['/agents/31b261cf', '/api/vault', 'https://elsewhere.example/home/user/report.log', '//elsewhere.example/home/user/report.log', 'javascript:alert(1)', 'file://other-host/home/user/report.log', '/home/user/%00bad', '/home/user/%ZZ'])('does not intercept application routes, external hosts or invalid links %s', href => {
  expect(localFileLink(href, origin)).toBeUndefined();
});
test('handles file line references and Windows paths', () => {
  expect(localFileLink('/home/user/app.ts:12:3', origin)).toBe('/home/user/app.ts');
  expect(localFileLink('file:///C:/work/app.ts', origin)).toBe('C:/work/app.ts');
});
