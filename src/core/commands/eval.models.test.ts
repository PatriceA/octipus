/**
 * `/eval conformance` and `/eval quality` run against the models the caller
 * may use: an admin, every install model; anyone else, their visible ones
 * (their orgs' install rows and their own personal rows), never another
 * org's model.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';

const fixture = vi.hoisted(() => ({
  conformance: null as unknown as import('vitest').Mock<(...args: any[]) => any>,
  complete: null as unknown as import('vitest').Mock<(...args: any[]) => any>,
}));

const SYSTEM = { id: 'm1', name: 'system-model', modelId: 'sys', provider: 'p', isEnabled: true, metadata: {} };
const OTHER_ORG = { id: 'm2', name: 'other-org-model', modelId: 'org', provider: 'p', isEnabled: true, metadata: {} };
const PERSONAL = { id: 'm3', name: 'my-model', modelId: 'mine', provider: 'p', isEnabled: true, metadata: {} };
const PERSONAL_OFF = { id: 'm4', name: 'my-disabled', modelId: 'off', provider: 'p', isEnabled: false, metadata: {} };

vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getAllModels: async () => [SYSTEM, OTHER_ORG],
    getModelsForUser: async () => [SYSTEM, PERSONAL, PERSONAL_OFF],
  }),
}));
vi.mock('@/models/testing/conformance', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/models/testing/conformance')>(),
  runConformanceTests: (...args: unknown[]) => fixture.conformance(...args),
}));
vi.mock('@/models/providers', () => ({
  getProviderRouter: () => ({ getAllProviders: () => [], complete: (...a: unknown[]) => fixture.complete(...a) }),
}));
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({}) }));
vi.mock('@/db/repositories/evaluation-repository', () => ({
  evaluationRepository: { saveConformanceRun: async () => ({}), saveEvalRunWithDataset: async () => ({}) },
}));
vi.mock('@/db/repositories/user-repository', () => ({
  userRepository: { findById: async (id: string) => ({ id, isAdmin: id === ADMIN, isActive: true }) },
}));

await import('./eval');
const { getCommand } = await import('./registry');
const run = (userId: string, args: string) =>
  getCommand('eval')!.execute({ sessionId: 's', userId, args });

beforeEach(() => {
  fixture.conformance = vi.fn(async () => ({ summary: { total: 0, passed: 0, failed: 0, skipped: 0 }, results: [] }));
  fixture.complete = vi.fn(async () => ({ content: 'ok' }));
});

describe('/eval conformance', () => {
  test('a non-admin runs against their enabled visible models only', async () => {
    await run(MEMBER, 'conformance');
    const models = fixture.conformance.mock.calls[0][1] as Array<{ name: string }>;
    expect(models.map((m) => m.name)).toEqual(['system-model', 'my-model']);
    expect(fixture.conformance.mock.calls[0][3]).toMatchObject({ userId: MEMBER });
  });

  test('a non-admin naming another org’s model finds nothing', async () => {
    const res = await run(MEMBER, 'conformance other-org-model');
    expect(res.response).toContain('No enabled model found');
    expect(fixture.conformance).not.toHaveBeenCalled();
  });

  test('an admin runs against every install model', async () => {
    await run(ADMIN, 'conformance');
    const models = fixture.conformance.mock.calls[0][1] as Array<{ name: string }>;
    expect(models.map((m) => m.name)).toEqual(['system-model', 'other-org-model']);
  });
});

describe('/eval quality', () => {
  test('a non-admin cannot run another org’s model', async () => {
    const res = await run(MEMBER, 'quality other-org-model');
    expect(res.response).toContain('not found');
    expect(fixture.complete).not.toHaveBeenCalled();
  });
});
