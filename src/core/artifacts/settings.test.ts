import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/config/settings-service', () => ({ getSettingsService: () => ({ getSync: (key: string) => settings.get(key) }) }));
import { artifactHostSettingRefusal, artifactSettingsDependOn, resetArtifactSettingsCache, resolveArtifactRetention, resolveArtifactSettings } from './settings';
import { buildArtifactOuterUrl, isArtifactHostRequest } from './host';
afterEach(() => { settings.clear(); resetArtifactSettingsCache(); });
describe('artifact host settings', () => {
  it.each([
    ['https://app.example.com/', 'https://app.example.com/a/test'],
    ['http://localhost:3007/', 'http://localhost:3007/a/test'],
    ['artifacts.example.com', 'https://artifacts.example.com/a/test'],
  ])('accepts a host or pasted origin: %s', (host, url) => {
    settings.set('oauth.publicUrl', 'https://octi.example.org');
    settings.set('artifacts.host', host);
    expect(buildArtifactOuterUrl('test')).toBe(url);
  });
  it('normalizes pasted HTTP gateway URLs for the WebSocket CSP', () => {
    settings.set('artifacts.gatewayWss', 'https://app.example.com/gateway');
    expect(resolveArtifactSettings().gatewayWss).toBe('wss://app.example.com/gateway');
  });
  it('rejects non-web schemes', () => {
    settings.set('artifacts.host', 'file:///etc');
    expect(() => resolveArtifactSettings()).toThrow('HTTP or HTTPS');
  });
  it('pins the SDK file it serves, not a hash stored by an earlier release', () => {
    settings.set('artifacts.sdkSha256', 'f'.repeat(64));
    const onDisk = readFileSync(join(process.cwd(), 'web/public/octipus-artifact-client.sha256.txt'), 'utf8').trim();
    expect(onDisk).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveArtifactSettings().sdkSha256).toBe(onDisk);
  });
  it('retention defaults to never expiring, with the 30-day trash', () => {
    expect(resolveArtifactRetention()).toEqual({ retentionDays: 0, trashDays: 30 });
    settings.set('artifacts.retentionDays', 90);
    settings.set('artifacts.trashDays', '7');
    expect(resolveArtifactRetention()).toEqual({ retentionDays: 90, trashDays: 7 });
  });
  it('an invalid retention value falls back to the safe one, never a shorter window', () => {
    settings.set('artifacts.retentionDays', -3);
    settings.set('artifacts.trashDays', 0);
    expect(resolveArtifactRetention()).toEqual({ retentionDays: 0, trashDays: 30 });
    settings.set('artifacts.retentionDays', 'soon');
    settings.set('artifacts.trashDays', 1.5);
    expect(resolveArtifactRetention()).toEqual({ retentionDays: 0, trashDays: 30 });
  });
  it('without the app\'s public URL an artifact host is ignored, so it can never shadow the app (LAN lockout)', () => {
    // A LAN install reached at 192.168.1.20:3017, no PUBLIC_URL, and its own
    // address typed into artifacts.host: the app must stay reachable.
    settings.set('artifacts.host', '192.168.1.20:3017');
    expect(resolveArtifactSettings().host).toBe('');
    const req = new Request('http://192.168.1.20:3017/api/settings', { headers: { host: '192.168.1.20:3017' } });
    expect(isArtifactHostRequest(req)).toBe(false);
  });
  it('the app\'s own host cannot be saved as the artifact host', () => {
    settings.set('oauth.publicUrl', 'https://octi.example.org');
    expect(artifactHostSettingRefusal('192.168.1.20:3017', '192.168.1.20:3017')).toMatch(/host of its own/);
    expect(artifactHostSettingRefusal('https://LAN-Box.local/', 'lan-box.local:443')).toMatch(/host of its own/);
    expect(artifactHostSettingRefusal('octi.example.org', 'artifacts.example.org')).toMatch(/host of its own/);
    expect(artifactHostSettingRefusal('artifacts.example.org', 'octi.example.org')).toBeNull();
    expect(artifactHostSettingRefusal('', 'octi.example.org')).toBeNull();
    expect(artifactHostSettingRefusal('not a host', 'octi.example.org')).toMatch(/not a host name/);
  });
  it('a change of the public URL resets the artifact settings, and is picked up without a restart', () => {
    expect(artifactSettingsDependOn('oauth.publicUrl')).toBe(true);
    expect(artifactSettingsDependOn('artifacts.host')).toBe(true);
    expect(artifactSettingsDependOn('oauth.callbackBase')).toBe(false);
    settings.set('artifacts.host', 'artifacts.example.org');
    expect(resolveArtifactSettings().host).toBe('');
    settings.set('oauth.publicUrl', 'https://octi.example.org');
    resetArtifactSettingsCache();
    expect(resolveArtifactSettings().host).toBe('artifacts.example.org');
  });
});
