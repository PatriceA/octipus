/**
 * Fail fast when a local model cannot fit RIGHT NOW — and, far more important,
 * never fail one that could have run.
 *
 * docs/plans/blocked-vs-stuck.md Phase 3.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { checkLocalModelFit } from './local-fit';

const GB = 1024 ** 3;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub the two ollama probes. `resident`/`tags` shape the responses. */
function stubOllama(opts: { resident?: string[]; tags?: Array<{ model: string; size: number }>; fail?: boolean }) {
  globalThis.fetch = (async (input: string | URL) => {
    if (opts.fail) throw new Error('connection refused');
    const url = String(input);
    const body = url.includes('/api/ps')
      ? { models: (opts.resident ?? []).map((model) => ({ model })) }
      : { models: opts.tags ?? [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('checkLocalModelFit', () => {
  test('blocks a model that cannot fit, with an actionable reason', async () => {
    stubOllama({ tags: [{ model: 'big:35b', size: 900 * GB }] });
    const v = await checkLocalModelFit('big:35b', 'http://localhost:11434');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('big:35b');
    expect(v.reason).toContain('available right now');
  });

  test('allows a model that comfortably fits', async () => {
    stubOllama({ tags: [{ model: 'small:1b', size: 1024 * 1024 }] });
    expect((await checkLocalModelFit('small:1b', 'http://localhost:11434')).ok).toBe(true);
  });

  // ── Fail-open cases. Each of these wrongly returning false would block work
  // that would have succeeded — strictly worse than the wait it replaces.

  test('allows an already-resident model however large — there is no load to fail', async () => {
    stubOllama({ resident: ['big:35b'], tags: [{ model: 'big:35b', size: 900 * GB }] });
    expect((await checkLocalModelFit('big:35b', 'http://localhost:11434')).ok).toBe(true);
  });

  test('never gates a remote daemon — its memory is not the memory we measured', async () => {
    // ollama2 runs as a separate daemon; our free RAM says nothing about it.
    stubOllama({ tags: [{ model: 'big:35b', size: 900 * GB }] });
    expect((await checkLocalModelFit('big:35b', 'http://192.168.68.75:11435')).ok).toBe(true);
  });

  test('allows a model of unknown size', async () => {
    stubOllama({ tags: [] });
    expect((await checkLocalModelFit('mystery:7b', 'http://localhost:11434')).ok).toBe(true);
  });

  test('allows when the probe itself fails', async () => {
    stubOllama({ fail: true });
    expect((await checkLocalModelFit('big:35b', 'http://localhost:11434')).ok).toBe(true);
  });

  test('strips a /v1 suffix when probing', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await checkLocalModelFit('x:1b', 'http://localhost:11434/v1');
    expect(seen[0]).toBe('http://localhost:11434/api/ps');
  });
});
