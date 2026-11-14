import { describe, expect, test } from 'vitest';
import { isPrivateEndpoint, LOCAL_DATA_POLICY, localHostingProblem } from './local-hosting';

describe('local hosting', () => {
  test('private endpoints', () => {
    for (const url of ['http://localhost:8080/v1', 'http://127.0.0.1:8080', 'http://192.168.1.5:1234/v1', 'http://10.0.0.2', 'http://172.20.0.3', 'http://gpu.lan:8000', 'http://llama:8080', 'http://[::1]:8080', 'http://box.local'])
      expect(isPrivateEndpoint(url), url).toBe(true);
    for (const url of ['https://api.openai.com/v1', 'http://8.8.8.8', 'https://my.server.example.com', 'http://localhost.evil.com', 'http://172.32.0.1', 'not a url', '', null, undefined])
      expect(isPrivateEndpoint(url), String(url)).toBe(false);
  });

  test('a model may be marked local only at a private endpoint', () => {
    expect(localHostingProblem('custom-openai', 'http://localhost:8080/v1', LOCAL_DATA_POLICY)).toBeNull();
    expect(localHostingProblem('custom-openai', 'https://api.together.xyz/v1', LOCAL_DATA_POLICY)).toMatch(/private address/);
    expect(localHostingProblem('custom-openai', undefined, LOCAL_DATA_POLICY)).toMatch(/private address/);
    expect(localHostingProblem('openai', 'https://api.openai.com/v1', LOCAL_DATA_POLICY)).toMatch(/private address/);
  });

  test('proxies and CLI agents are never local; engines on this machine always are', () => {
    expect(localHostingProblem('cli', null, LOCAL_DATA_POLICY)).toMatch(/CLI agent/);
    expect(localHostingProblem('litellm', 'http://localhost:4000', LOCAL_DATA_POLICY)).toMatch(/LiteLLM/);
    expect(localHostingProblem('local-engine', null, LOCAL_DATA_POLICY)).toBeNull();
    expect(localHostingProblem('local-audio', null, LOCAL_DATA_POLICY)).toBeNull();
  });

  test('a remote or absent policy needs no check', () => {
    expect(localHostingProblem('custom-openai', 'https://api.together.xyz/v1', { hosting: 'remote' })).toBeNull();
    expect(localHostingProblem('custom-openai', 'https://api.together.xyz/v1', undefined)).toBeNull();
  });
});
