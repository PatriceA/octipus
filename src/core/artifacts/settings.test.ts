import { afterEach, describe, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => new Map<string, string>());
vi.mock('@/config/settings-service', () => ({ getSettingsService: () => ({ getSync: (key: string) => settings.get(key) }) }));
import { resetArtifactSettingsCache, resolveArtifactSettings } from './settings';
import { buildArtifactOuterUrl } from './host';
afterEach(() => { settings.clear(); resetArtifactSettingsCache(); });
describe('artifact host settings', () => {
  it.each([
    ['https://app.example.com/', 'https://app.example.com/a/test'],
    ['http://localhost:3007/', 'http://localhost:3007/a/test'],
    ['artifacts.example.com', 'https://artifacts.example.com/a/test'],
  ])('accepts a host or pasted origin: %s', (host, url) => {
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
});
