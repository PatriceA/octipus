import { describe, expect, test } from 'vitest';
import { apiBaseFromGatewayUrl } from './cli-login';

describe('apiBaseFromGatewayUrl', () => {
  test('ws → http, wss → https, /gateway → /api', () => {
    expect(apiBaseFromGatewayUrl('ws://localhost:3005/gateway')).toBe('http://localhost:3005/api');
    expect(apiBaseFromGatewayUrl('wss://octi.example.com/gateway')).toBe('https://octi.example.com/api');
  });

  test('a gateway URL with no path does not produce a double slash', () => {
    expect(apiBaseFromGatewayUrl('ws://localhost:3005')).toBe('http://localhost:3005/api');
    expect(apiBaseFromGatewayUrl('ws://localhost:3005/')).toBe('http://localhost:3005/api');
  });

  test('keeps a mount prefix and drops query params', () => {
    expect(apiBaseFromGatewayUrl('ws://host:3005/octi/gateway?workspace=x')).toBe('http://host:3005/octi/api');
  });
});
