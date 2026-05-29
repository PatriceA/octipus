import { describe, expect, test } from 'bun:test';
import { fetchWithTimeout } from '@/utils/http';

describe('fetchWithTimeout', () => {
  test('aborts when the request exceeds the timeout', async () => {
    // A server that never responds within the timeout window.
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(5000);
        return new Response('late');
      },
    });
    try {
      await expect(
        fetchWithTimeout(`http://localhost:${server.port}/`, { timeoutMs: 50 }),
      ).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });

  test('returns the response when it arrives before the timeout', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('ok');
      },
    });
    try {
      const res = await fetchWithTimeout(`http://localhost:${server.port}/`, { timeoutMs: 5000 });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      server.stop(true);
    }
  });
});
