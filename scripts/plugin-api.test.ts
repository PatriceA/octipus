/**
 * `octi plugin list` / `octi plugin approve` (scripts/plugin-api.ts) against
 * a fake backend: the token rides as a bearer, approve sends the hash it was
 * given or the one confirmed at a terminal, and refuses to guess otherwise.
 */
import { describe, expect, test } from 'vitest';
import type { PluginPackageView } from '@/shared/plugin-package';
import { approveCommand, backendBase, listCommand, type PluginApiIo } from './plugin-api';

const RECORDED = `sha256:${'a'.repeat(64)}`;
const ACTUAL = `sha256:${'b'.repeat(64)}`;

function view(over: Partial<PluginPackageView> = {}): PluginPackageView {
  return {
    name: 'finapi', version: '1.0.0', manifest: {} as PluginPackageView['manifest'], enabled: true, settings: {}, secretsSet: [],
    problem: 'Modified since it was approved (hash mismatch); approve its content to run it',
    network: { state: 'refused', detail: 'Not started' }, connected: false,
    contentHash: RECORDED, actualHash: ACTUAL, signedBy: null,
    signature: { status: 'invalid', keyId: null, publisher: null, detail: 'does not match' },
    installedBy: null, installedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    ...over,
  };
}

interface Harness {
  io: PluginApiIo;
  out: string[];
  err: string[];
  requests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }>;
  asked: string[];
}

function harness(opts: { packages?: PluginPackageView[]; patch?: (body: { approveContent: string }) => [number, unknown]; interactive?: boolean; answer?: string; token?: string } = {}): Harness {
  const h: Harness = { out: [], err: [], requests: [], asked: [], io: undefined as unknown as PluginApiIo };
  h.io = {
    env: { API_PORT: '4999', ...(opts.token ? { OCTIPUS_API_TOKEN: opts.token } : {}) },
    interactive: opts.interactive ?? false,
    out: (t) => h.out.push(t),
    err: (t) => h.err.push(t),
    ask: async (q) => { h.asked.push(q); return opts.answer ?? ''; },
    fetch: (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      h.requests.push({ method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body });
      if (init.method === 'PATCH') {
        const [status, data] = opts.patch?.(body) ?? [200, view({ contentHash: body.approveContent, actualHash: null, problem: null })];
        return new Response(JSON.stringify(data), { status });
      }
      return new Response(JSON.stringify(opts.packages ?? [view()]));
    }) as typeof fetch,
  };
  return h;
}

describe('octi plugin list', () => {
  test('lists every package with its state, signature, network and both hashes, sending the API token', async () => {
    const h = harness({ token: 'tok-123' });
    expect(await listCommand(h.io)).toBe(0);
    expect(h.requests).toEqual([{ method: 'GET', url: 'http://localhost:4999/api/plugin-packages/', headers: { authorization: 'Bearer tok-123' }, body: undefined }]);
    const text = h.out.join('');
    expect(text).toContain('finapi 1.0.0  problem: Modified since it was approved');
    expect(text).toContain('network: refused');
    expect(text).toContain(`content:   ${RECORDED}`);
    expect(text).toContain(`octi plugin approve finapi --hash ${ACTUAL}`);
  });

  test('a refused token or an unreachable backend says what to do', async () => {
    const h = harness();
    h.io.fetch = (async () => new Response('{"error":"Admin access required"}', { status: 403 })) as typeof fetch;
    expect(await listCommand(h.io)).toBe(1);
    expect(h.err.join('')).toMatch(/OCTIPUS_API_TOKEN/);
    h.io.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    expect(await listCommand(h.io)).toBe(1);
    expect(h.err.join('')).toMatch(/backend unreachable at http:\/\/localhost:4999.*octi start/);
  });

  test('the base URL follows API_PORT, as the other backend commands', () => {
    expect(backendBase({})).toBe('http://localhost:3005');
    expect(backendBase({ API_PORT: '8080' })).toBe('http://localhost:8080');
  });
});

describe('octi plugin approve', () => {
  test('with --hash: sends exactly that hash', async () => {
    const h = harness();
    expect(await approveCommand(h.io, 'finapi', ACTUAL)).toBe(0);
    expect(h.requests).toEqual([expect.objectContaining({ method: 'PATCH', url: 'http://localhost:4999/api/plugin-packages/finapi', body: { approveContent: ACTUAL } })]);
    expect(h.out.join('')).toContain(`Approved finapi: content ${ACTUAL}`);
  });

  test('a 409 (the files changed since) is shown with the actual hash, and fails', async () => {
    const h = harness({ patch: () => [409, { error: `The files of finapi hash to sha256:${'c'.repeat(64)}, not to the reviewed ${ACTUAL}`, problems: ['approveContent: reviewed …'] }] });
    expect(await approveCommand(h.io, 'finapi', ACTUAL)).toBe(1);
    expect(h.err.join('')).toContain(`hash to sha256:${'c'.repeat(64)}`);
  });

  test('without --hash at a terminal: shows the actual hash, asks, and approves that one on yes', async () => {
    const h = harness({ interactive: true, answer: 'y' });
    expect(await approveCommand(h.io, 'finapi', undefined)).toBe(0);
    expect(h.asked).toEqual([expect.stringContaining(ACTUAL)]);
    expect(h.requests.map((r) => [r.method, r.body])).toEqual([['GET', undefined], ['PATCH', { approveContent: ACTUAL }]]);
  });

  test('without --hash: no answer approves nothing; not at a terminal it refuses and prints the command', async () => {
    const no = harness({ interactive: true, answer: '' });
    expect(await approveCommand(no.io, 'finapi', undefined)).toBe(1);
    expect(no.requests.map((r) => r.method)).toEqual(['GET']);

    const batch = harness({ interactive: false });
    expect(await approveCommand(batch.io, 'finapi', undefined)).toBe(2);
    expect(batch.asked).toEqual([]);
    expect(batch.requests.map((r) => r.method)).toEqual(['GET']);
    expect(batch.err.join('')).toContain(`octi plugin approve finapi --hash ${ACTUAL}`);
  });

  test('nothing to approve, an unknown package, and a malformed --hash', async () => {
    const clean = harness({ packages: [view({ actualHash: null, problem: null })], interactive: true });
    expect(await approveCommand(clean.io, 'finapi', undefined)).toBe(0);
    expect(clean.out.join('')).toContain('no content waiting for approval');
    expect(clean.asked).toEqual([]);
    expect(await approveCommand(harness().io, 'datev', undefined)).toBe(1);
    const bad = harness();
    expect(await approveCommand(bad.io, 'finapi', 'abc')).toBe(2);
    expect(bad.requests).toEqual([]);
  });
});
