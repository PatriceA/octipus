/**
 * Serving plugin pages (docs/PLUGIN-PACKAGES.md#pages): only files under the
 * package's UI directory, of a known type, while it is enabled and its files
 * hash to the approved content; under a CSP that sandboxes the document and
 * allows nothing but the package's own path.
 */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '',
  row: null as null | Record<string, unknown>,
  hash: 'sha256:approved',
  problem: null as string | null,
}));

vi.mock('@/db/postgres', () => {
  const chain = { from: () => chain, where: () => chain, orderBy: async () => (state.row ? [state.row] : []), limit: async () => (state.row ? [state.row] : []) };
  return { getDb: () => ({ select: () => chain }) };
});
vi.mock('@/mcp/bridge', () => ({ PLUGIN_SERVER_PREFIX: 'plugin-', getMCPBridge: () => ({ pluginProblem: () => state.problem }) }));
const trusted = vi.hoisted(() => new Set<string>());
vi.mock('@/security/client-ip', () => ({ isTrustedProxy: (address: string) => trusted.has(address) }));
vi.mock('./service', () => ({ packageDir: (name: string) => join(state.root, name) }));
vi.mock('./integrity', async (original) => ({
  ...await original<typeof import('./integrity')>(),
  hashPackageContent: async () => state.hash,
}));

const { _forgetUiVerification, fetchDestAllowed, isSecureOrigin, listEnabledPages, pluginUiCsp, pluginUiHeaders, readUiFile, uiBaseUrl, uiContentType, uiFileUrl } = await import('./ui');

const manifest = { name: 'acme', title: 'Acme', ui: { pages: [{ path: 'dash', title: 'Dash', icon: 'zap', entry: 'index.html' }] } };

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), 'octipus-ui-'));
  const pkg = join(state.root, 'acme');
  mkdirSync(join(pkg, 'ui', 'assets'), { recursive: true });
  writeFileSync(join(pkg, 'ui', 'index.html'), '<!doctype html><p>hi</p>');
  writeFileSync(join(pkg, 'ui', 'assets', 'app.js'), 'void 0;');
  writeFileSync(join(pkg, 'ui', 'data.bin'), 'x');
  writeFileSync(join(pkg, 'server.mjs'), '// the server, not a page');
  writeFileSync(join(state.root, 'outside.html'), '<p>outside</p>');
  state.row = { name: 'acme', version: '1.0.0', enabled: true, manifest, contentHash: 'sha256:approved' };
  state.hash = 'sha256:approved';
  state.problem = null;
  _forgetUiVerification();
});

const body = async (rel: string, name = 'acme') => {
  const res = await readUiFile(name, rel);
  return res.status === 200 ? res.body.toString() : res.status;
};

describe('plugin page files', () => {
  test('a file under the UI directory, with its type', async () => {
    expect(await body('index.html')).toContain('hi');
    expect(await body('assets/app.js')).toBe('void 0;');
    const res = await readUiFile('acme', 'assets/app.js');
    expect(res.status === 200 && res.contentType).toBe('text/javascript; charset=utf-8');
  });

  test('nothing outside it: traversal, absolute, hidden, the package root, an unknown type', async () => {
    for (const rel of ['../server.mjs', '../../outside.html', 'assets/../../server.mjs', '/etc/passwd', '..\\server.mjs', '.hidden.html', '', 'data.bin', 'missing.html']) {
      expect(await body(rel), rel).toBe(404);
    }
  });

  test('no symbolic link, even one pointing inside', async () => {
    symlinkSync(join(state.root, 'outside.html'), join(state.root, 'acme', 'ui', 'link.html'));
    symlinkSync(join(state.root, 'acme', 'ui', 'index.html'), join(state.root, 'acme', 'ui', 'inner.html'));
    mkdirSync(join(state.root, 'elsewhere'));
    writeFileSync(join(state.root, 'elsewhere', 'x.html'), 'x');
    symlinkSync(join(state.root, 'elsewhere'), join(state.root, 'acme', 'ui', 'dir'));
    expect(await body('link.html')).toBe(404);
    expect(await body('inner.html')).toBe(404);
    expect(await body('dir/x.html')).toBe(404);
  });

  test('only while enabled, with ui, and with the approved content', async () => {
    state.row = { ...state.row, enabled: false };
    expect(await body('index.html')).toBe(404);
    state.row = { ...state.row, enabled: true, manifest: { ...manifest, ui: undefined } };
    expect(await body('index.html')).toBe(404);
    state.row = { ...state.row, manifest };
    state.hash = 'sha256:changed';
    expect(await body('index.html')).toBe(404);
    state.hash = 'sha256:approved';
    state.problem = 'Modified since it was approved (hash mismatch); approve its content to run it';
    expect(await body('index.html')).toBe(404);
    state.problem = null;
    expect(await body('index.html')).toContain('hi');
    state.row = null;
    expect(await body('index.html')).toBe(404);
    expect(await body('index.html', 'Bad Name')).toBe(404);
  });

  test('the sidebar lists the pages of enabled packages', async () => {
    expect(await listEnabledPages()).toEqual([{ plugin: 'acme', pluginTitle: 'Acme', path: 'dash', title: 'Dash', icon: 'zap', src: '/api/plugin-ui/acme/index.html' }]);
    state.problem = 'Modified since it was approved (hash mismatch); approve its content to run it';
    expect(await listEnabledPages()).toEqual([]);
  });
});

describe('headers and CSP', () => {
  test('the CSP sandboxes the document and allows only the package path', () => {
    const csp = pluginUiCsp('https://octi.example/api/plugin-ui/acme/');
    const directives = Object.fromEntries(csp.split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k, v.join(' ')]; }));
    expect(directives['default-src']).toBe("'none'");
    expect(directives['script-src']).toBe('https://octi.example/api/plugin-ui/acme/');
    expect(directives['style-src']).toBe('https://octi.example/api/plugin-ui/acme/');
    expect(directives['img-src']).toBe('https://octi.example/api/plugin-ui/acme/ data:');
    expect(directives['connect-src']).toBe("'none'");
    expect(directives['form-action']).toBe("'none'");
    expect(directives['frame-src']).toBe("'none'");
    expect(directives['frame-ancestors']).toBe("'self'");
    // allow-scripts only: no allow-same-origin, so the app's cookies and storage are out of reach.
    expect(directives.sandbox).toBe('allow-scripts');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('allow-same-origin');
  });

  test('nosniff and a known content type', () => {
    const headers = pluginUiHeaders('x', 'text/html; charset=utf-8');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Security-Policy']).toBe('x');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(uiContentType('a.HTML')).toBe('text/html; charset=utf-8');
    expect(uiContentType('a.exe')).toBeNull();
    expect(uiContentType('a')).toBeNull();
  });

  test('the base URL: the public URL when configured, else the request; forwarded headers only from a trusted proxy', () => {
    const req = (headers: Record<string, string> = {}) => new Request('http://localhost:3005/api/plugin-ui/acme/index.html', { headers });
    const fwd = { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
    expect(uiBaseUrl(req(), 'acme', undefined, '')).toBe('http://localhost:3005/api/plugin-ui/acme/');
    // From an untrusted peer the forwarded headers are ignored.
    expect(uiBaseUrl(req(fwd), 'acme', '203.0.113.9', '')).toBe('http://localhost:3005/api/plugin-ui/acme/');
    trusted.add('10.0.0.2');
    expect(uiBaseUrl(req(fwd), 'acme', '10.0.0.2', '')).toBe('https://evil.example/api/plugin-ui/acme/');
    expect(uiBaseUrl(req({ 'x-forwarded-host': "evil; script-src 'unsafe-inline'" }), 'acme', '10.0.0.2', '')).toBeNull();
    trusted.clear();
    // The configured public URL wins over anything the request says.
    expect(uiBaseUrl(req(fwd), 'acme', '10.0.0.2', 'https://octi.example/')).toBe('https://octi.example/api/plugin-ui/acme/');
    expect(uiBaseUrl(req(), 'acme', undefined, 'javascript:alert(1)')).toBeNull();
    expect(uiFileUrl('acme', 'a b/c.html')).toBe('/api/plugin-ui/acme/a%20b/c.html');
  });

  test('a file is served only where it belongs (Sec-Fetch-Dest)', () => {
    expect(fetchDestAllowed('index.html', 'iframe')).toBe(true);
    for (const dest of ['document', 'frame', 'object', 'embed', 'empty', 'script', null]) expect(fetchDestAllowed('index.html', dest), String(dest)).toBe(false);
    expect(fetchDestAllowed('assets/app.js', 'script')).toBe(true);
    expect(fetchDestAllowed('assets/app.js', 'document')).toBe(false);
    expect(fetchDestAllowed('style.css', 'style')).toBe(true);
    expect(fetchDestAllowed('logo.svg', 'image')).toBe(true);
    expect(fetchDestAllowed('logo.svg', 'iframe')).toBe(false);
    expect(fetchDestAllowed('font.woff2', 'font')).toBe(true);
    expect(fetchDestAllowed('data.json', 'empty')).toBe(false);
    // Plain http to a LAN address: browsers send no Sec-Fetch-*, so a missing header passes there only.
    expect(fetchDestAllowed('index.html', null, false)).toBe(true);
    expect(fetchDestAllowed('index.html', 'document', false)).toBe(false);
    expect(isSecureOrigin('https://octi.example/api/plugin-ui/acme/')).toBe(true);
    expect(isSecureOrigin('http://localhost:3007/api/plugin-ui/acme/')).toBe(true);
    expect(isSecureOrigin('http://192.168.1.5:3007/api/plugin-ui/acme/')).toBe(false);
  });
});
