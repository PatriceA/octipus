/**
 * The KB self-check runs off the boot path (src/index.ts): a bounded wait on
 * its embedding call, a shared run for concurrent callers, and KB endpoints
 * that wait for its verdict instead of answering 503 while it runs.
 */
import { beforeEach, expect, test, vi } from 'vitest';

process.env.LOG_LEVEL ??= 'error';

const fx = vi.hoisted(() => ({ embed: (): Promise<number[]> => Promise.resolve([0.1, 0.2]), embedCalls: 0 }));
vi.mock('@/db/postgres', () => ({
  checkDbHealth: async () => ({ healthy: true }),
  getDb: () => ({
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'probe' }] }) }),
    delete: () => ({ where: async () => undefined }),
  }),
}));
vi.mock('./embeddings', () => ({
  getEmbeddingService: () => ({ generateEmbedding: () => { fx.embedCalls++; return fx.embed(); } }),
}));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModelForTopic: async () => ({ modelId: 'embed-model' }) }) }));

import { awaitKBReadiness, invalidateKBReadiness, isKBReady, kbNotReadyResponse, runKBSelfCheck } from './health';

beforeEach(() => {
  invalidateKBReadiness();
  fx.embedCalls = 0;
  fx.embed = () => Promise.resolve([0.1, 0.2]);
});

test('the boot check stops waiting on an embedding call that does not answer', async () => {
  fx.embed = () => new Promise(() => {});
  const report = await runKBSelfCheck({ embedTimeoutMs: 30 });
  expect(report.ready).toBe(false);
  expect(report.checks.embeddingModel.detail).toMatch(/did not answer within/);
  expect(isKBReady()).toBe(false);
});

test('a request during the check waits for its verdict; concurrent runs share one', async () => {
  let answer!: (v: number[]) => void;
  fx.embed = () => new Promise((resolve) => { answer = resolve; });
  const first = runKBSelfCheck({ embedTimeoutMs: 5_000 });
  const second = runKBSelfCheck();
  expect(second).toBe(first);
  await vi.waitFor(() => expect(fx.embedCalls).toBe(1));
  expect(kbNotReadyResponse().error).toMatch(/still running/);

  const verdict = awaitKBReadiness(5_000);
  answer([0.3, 0.4]);
  expect(await verdict).toBe(true);
  expect(fx.embedCalls).toBe(1);
});

test('with no check running, the wait answers at once', async () => {
  expect(await awaitKBReadiness(5_000)).toBe(false);
  expect(kbNotReadyResponse().error).toMatch(/has not run yet/);
});

test('an embedding that answers after the boot check gave up turns the KB ready', async () => {
  let answer!: (v: number[]) => void;
  fx.embed = () => new Promise((resolve) => { answer = resolve; });
  const report = await runKBSelfCheck({ embedTimeoutMs: 30 });
  expect(report.ready).toBe(false);

  fx.embed = () => Promise.resolve([0.3, 0.4]);
  answer([0.1, 0.2]);
  await vi.waitFor(() => expect(isKBReady()).toBe(true));
});
