/**
 * Which requests are the artifact host's, and what it may serve
 * (`isArtifactHostRequest`, `isArtifactHostPath`). The guard in
 * `api/server.ts` is built from these; `artifact-hosting.isolation.test.ts`
 * checks the wired-up server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => new Map<string, string>());
vi.mock('@/config/settings-service', () => ({ getSettingsService: () => ({ getSync: (key: string) => settings.get(key) }) }));
import { resetArtifactSettingsCache, resolveArtifactSettings } from './settings';
import { isArtifactHostPath, isArtifactHostRequest, isRootArtifactPagePath, isSubdomainMode, normalizeHost } from './host';

afterEach(() => {
  settings.clear();
  resetArtifactSettingsCache();
  delete process.env.PUBLIC_URL;
});

const req = (url: string, host?: string) => new Request(url, host ? { headers: { host } } : {});

describe('normalizeHost', () => {
  it('lower-cases and drops the default ports', () => {
    expect(normalizeHost('Artifacts.Example.COM')).toBe('artifacts.example.com');
    expect(normalizeHost('artifacts.example.com:443')).toBe('artifacts.example.com');
    expect(normalizeHost('artifacts.example.com:80')).toBe('artifacts.example.com');
    expect(normalizeHost('localhost:3007')).toBe('localhost:3007');
    expect(normalizeHost('[::1]:3007')).toBe('[::1]:3007');
  });

  it('is null for anything that is not a host', () => {
    for (const bad of ['', 'artifacts.example.com/evil', 'a b', 'evil.com@artifacts.example.com', 'x:99999999', '-a.com', 'a..com', 'artifacts.example.com\r\nX: y']) {
      expect(normalizeHost(bad)).toBeNull();
    }
    expect(normalizeHost(null)).toBeNull();
  });
});

describe('isArtifactHostRequest', () => {
  it('is always false in path-prefix mode', () => {
    expect(isSubdomainMode()).toBe(false);
    expect(isArtifactHostRequest(req('http://artifacts.example.com/a/x', 'artifacts.example.com'))).toBe(false);
  });

  it('matches the configured host exactly, from the Host header', () => {
    settings.set('oauth.publicUrl', 'https://app.example.com');
    settings.set('artifacts.host', 'artifacts.example.com');
    expect(isSubdomainMode()).toBe(true);
    expect(isArtifactHostRequest(req('http://backend:3005/a/x', 'artifacts.example.com'))).toBe(true);
    expect(isArtifactHostRequest(req('http://backend:3005/a/x', 'ARTIFACTS.example.com:443'))).toBe(true);
    // Not a suffix, not a parent, not a sibling, not another port.
    for (const other of ['example.com', 'evil-artifacts.example.com', 'x.artifacts.example.com', 'artifacts.example.com.evil.com', 'artifacts.example.com:8443', 'app.example.com']) {
      expect(isArtifactHostRequest(req('http://backend:3005/a/x', other))).toBe(false);
    }
  });

  it('ignores forwarded host headers a client could set', () => {
    settings.set('oauth.publicUrl', 'https://app.example.com');
    settings.set('artifacts.host', 'artifacts.example.com');
    const r = new Request('http://app.example.com/api/me', { headers: { host: 'app.example.com', 'x-forwarded-host': 'artifacts.example.com' } });
    expect(isArtifactHostRequest(r)).toBe(false);
  });

  it('refuses an artifact host that is the app\'s own public host, falling back to path-prefix', () => {
    process.env.PUBLIC_URL = 'https://octi.example.com';
    settings.set('artifacts.host', 'octi.example.com');
    expect(resolveArtifactSettings().host).toBe('');
    expect(isSubdomainMode()).toBe(false);
    expect(isArtifactHostRequest(req('https://octi.example.com/api/me', 'octi.example.com'))).toBe(false);
  });

  it('invalid artifact settings turn host routing off instead of throwing for every request', () => {
    settings.set('artifacts.host', 'file:///etc');
    expect(isArtifactHostRequest(req('http://x/a/y', 'x'))).toBe(false);
    expect(isSubdomainMode()).toBe(false);
  });
});

describe('isArtifactHostPath', () => {
  it('admits the hosted pages and the SDK, read-only', () => {
    for (const p of ['/a/board', '/a/board/', '/a/board/embed', '/a/board/export/csv', '/a/board/data/feed', '/octipus-artifact-client.js']) {
      expect(isArtifactHostPath('GET', p)).toBe(true);
    }
    expect(isArtifactHostPath('HEAD', '/a/board/embed')).toBe(true);
    expect(isArtifactHostPath('POST', '/a/board/embed')).toBe(false);
    expect(isArtifactHostPath('OPTIONS', '/a/board/data/feed')).toBe(false);
  });

  it('refuses the app: its API, its pages, the fallback mount', () => {
    for (const p of ['/', '/api/auth/login', '/api/artifacts', '/v1/chat/completions', '/__artifacts__/a/board/embed', '/a/board/embed/x', '/a/board/bundle.js', '/a', '/artifacts/view', '/gateway']) {
      expect(isArtifactHostPath('GET', p)).toBe(false);
    }
  });

  it('root page paths are recognised for the app-host refusal', () => {
    expect(isRootArtifactPagePath('/a/board/embed')).toBe(true);
    expect(isRootArtifactPagePath('/__artifacts__/a/board/embed')).toBe(false);
    expect(isRootArtifactPagePath('/api/artifacts')).toBe(false);
  });
});
