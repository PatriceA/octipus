/**
 * The polling auto-approve loop that lets a REST-driven pipeline finish without
 * a human. `POST /chat` blocks until the turn ends, so this runs on a second
 * connection while that request is still in flight.
 *
 * docs/plans/blocked-vs-stuck.md Phase 2.
 */
import { describe, expect, test } from 'bun:test';
import type { APIClient } from './client';
import { autoApproveLoop, getPendingApprovals, resolveApproval } from './approvals';

type Call = { method: string; path: string; body?: unknown };

/**
 * Minimal APIClient stand-in. `queue` is drained one poll at a time so a test
 * can model "approval appears, gets answered, next one appears".
 */
function stubClient(opts: {
  queue?: Array<Array<{ requestId: string; summary: string; question: string }>>;
  resolveOk?: boolean;
  pendingStatus?: number;
}) {
  const calls: Call[] = [];
  const queue = [...(opts.queue ?? [])];
  const client = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (path === '/chat/approvals/pending') {
        const approvals = queue.length > 1 ? queue.shift()! : (queue[0] ?? []);
        return { status: opts.pendingStatus ?? 200, data: { approvals } };
      }
      return { status: 200, data: { resolved: opts.resolveOk ?? true } };
    },
  } as unknown as APIClient;
  return { client, calls };
}

const a = (requestId: string) => ({ requestId, summary: 's', question: 'q' });
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe('getPendingApprovals', () => {
  test('returns the list', async () => {
    const { client } = stubClient({ queue: [[a('r1')]] });
    expect(await getPendingApprovals(client)).toHaveLength(1);
  });

  test('returns empty on a non-200 rather than throwing into the run', async () => {
    const { client } = stubClient({ queue: [[a('r1')]], pendingStatus: 403 });
    expect(await getPendingApprovals(client)).toEqual([]);
  });
});

describe('resolveApproval', () => {
  test('reports success and sends the verdict', async () => {
    const { client, calls } = stubClient({});
    expect(await resolveApproval(client, 'r1', true, 'Approve')).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/chat/approve', body: { requestId: 'r1', approved: true, response: 'Approve' } });
  });

  test('reports failure when the server did not resolve it', async () => {
    const { client } = stubClient({ resolveOk: false });
    expect(await resolveApproval(client, 'r1', true)).toBe(false);
  });
});

describe('autoApproveLoop', () => {
  test('answers a pending approval and records it', async () => {
    const { client, calls } = stubClient({ queue: [[a('r1')]] });
    const h = autoApproveLoop(client, { intervalMs: 5 });
    await settle();
    const answered = await h.stop();

    expect(answered.map((x) => x.requestId)).toEqual(['r1']);
    expect(calls.filter((c) => c.path === '/chat/approve')).toHaveLength(1);
  });

  test('answers each approval exactly once even while it lingers in the list', async () => {
    // The server keeps returning it until fully resolved; re-answering is noise.
    const { client, calls } = stubClient({ queue: [[a('r1')]] });
    const h = autoApproveLoop(client, { intervalMs: 5 });
    await settle(60);
    await h.stop();
    expect(calls.filter((c) => c.path === '/chat/approve')).toHaveLength(1);
  });

  test('retries an approval the server refused to resolve', async () => {
    // Refused ⇒ someone else may have taken it, or it timed out. Do not swallow.
    const { client, calls } = stubClient({ queue: [[a('r1')]], resolveOk: false });
    const h = autoApproveLoop(client, { intervalMs: 5 });
    await settle(60);
    const answered = await h.stop();
    expect(answered).toHaveLength(0);
    expect(calls.filter((c) => c.path === '/chat/approve').length).toBeGreaterThan(1);
  });

  test('honours a custom answer — including choosing an option by name', async () => {
    const { client, calls } = stubClient({ queue: [[a('r1')]] });
    const h = autoApproveLoop(client, { intervalMs: 5, answer: () => 'Skip' });
    await settle();
    await h.stop();
    expect(calls.find((c) => c.path === '/chat/approve')?.body).toMatchObject({ approved: true, response: 'Skip' });
  });

  test('can deny', async () => {
    const { client, calls } = stubClient({ queue: [[a('r1')]] });
    const h = autoApproveLoop(client, { intervalMs: 5, answer: () => false });
    await settle();
    await h.stop();
    expect(calls.find((c) => c.path === '/chat/approve')?.body).toMatchObject({ approved: false });
  });

  test('fires onApproval for each answered approval', async () => {
    const seen: string[] = [];
    const { client } = stubClient({ queue: [[a('r1')]] });
    const h = autoApproveLoop(client, { intervalMs: 5, onApproval: (x) => seen.push(x.requestId) });
    await settle();
    await h.stop();
    expect(seen).toEqual(['r1']);
  });

  test('stop() is idempotent and safe to call twice', async () => {
    const { client } = stubClient({ queue: [[]] });
    const h = autoApproveLoop(client, { intervalMs: 5 });
    await h.stop();
    expect(await h.stop()).toEqual([]);
  });

  test('a polling blip never fails the run it is only assisting', async () => {
    const client = {
      request: async () => {
        throw new Error('network down');
      },
    } as unknown as APIClient;
    const h = autoApproveLoop(client, { intervalMs: 5 });
    await settle();
    expect(await h.stop()).toEqual([]);
  });
});
