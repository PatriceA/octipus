import { describe, expect, test } from 'bun:test';
import type { NewModelConfigEntry } from '@/db/schema/models';
import type { PullProgress } from '@/models/providers/ollama-provider';
import { buildModelEntry, type InstallDeps, type InstallJob, runInstall } from './install';
import type { ModelCatalogEntry } from './types';

const ENTRY: ModelCatalogEntry = {
  id: 'llama3.2:3b-instruct-q4_K_M',
  family: 'llama3.2',
  params: 3e9,
  quant: 'q4_K_M',
  topics: ['chat', 'general'],
  contextWindow: 131072,
  vramHintMB: 2600,
};

const VISION_ENTRY: ModelCatalogEntry = { ...ENTRY, id: 'llava:7b', topics: ['vision'] };

function makeJob(bindTopics: ModelCatalogEntry['topics']): InstallJob {
  return {
    id: 'job-1',
    ownerId: 'user-1',
    modelId: ENTRY.id,
    bindTopics,
    status: 'pulling',
    percent: 0,
    statusText: 'starting',
    startedAt: 0,
  };
}

describe('buildModelEntry', () => {
  test('binds requested topics as primary topicRoles', () => {
    const e = buildModelEntry(ENTRY, ['chat', 'general'], false);
    expect(e.provider).toBe('ollama');
    expect(e.modelId).toBe(ENTRY.id);
    expect(e.topicRoles).toEqual({ chat: 'primary', general: 'primary' });
    expect(e.topics).toEqual(['chat', 'general']);
    expect(e.isDefault).toBe(false);
  });

  test('first model becomes default', () => {
    expect(buildModelEntry(ENTRY, ['chat'], true).isDefault).toBe(true);
  });

  test('vision capability is derived from topics', () => {
    expect(buildModelEntry(VISION_ENTRY, ['vision'], false).supportsVision).toBe(true);
    expect(buildModelEntry(ENTRY, ['chat'], false).supportsVision).toBe(false);
  });
});

describe('runInstall', () => {
  test('pull → register → bind happy path', async () => {
    const registered: NewModelConfigEntry[] = [];
    const progressSeen: PullProgress[] = [];
    const deps: InstallDeps = {
      pull: async (_id, onProgress) => {
        onProgress({ status: 'downloading', total: 100, completed: 50, percent: 50 });
        onProgress({ status: 'success' });
      },
      register: async (e) => {
        registered.push(e);
      },
      isFirstModel: async () => true,
    };
    const job = makeJob(['chat', 'general']);

    await runInstall(job, ENTRY, deps);

    expect(job.status).toBe('done');
    expect(job.percent).toBe(100);
    expect(job.modelName).toBe(ENTRY.id);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.isDefault).toBe(true);
    expect(registered[0]?.topicRoles).toEqual({ chat: 'primary', general: 'primary' });
    progressSeen.length; // (progress wired via job)
    expect(job.statusText).toBe('success');
  });

  test('records pull failure on the job without throwing (fail loud, no swallow)', async () => {
    const deps: InstallDeps = {
      pull: async () => {
        throw new Error('Ollama pull failed for "x": file does not exist');
      },
      register: async () => {
        throw new Error('should not register on pull failure');
      },
      isFirstModel: async () => true,
    };
    const job = makeJob(['chat']);

    await runInstall(job, ENTRY, deps);

    expect(job.status).toBe('error');
    expect(job.error).toContain('file does not exist');
    expect(job.modelName).toBeUndefined();
  });

  test('records registration failure', async () => {
    const deps: InstallDeps = {
      pull: async () => {},
      register: async () => {
        throw new Error('duplicate model name');
      },
      isFirstModel: async () => false,
    };
    const job = makeJob(['chat']);

    await runInstall(job, ENTRY, deps);

    expect(job.status).toBe('error');
    expect(job.error).toContain('duplicate');
  });

  test('onUpdate is called on status transitions, percent changes, and completion', async () => {
    const statuses: string[] = [];
    const percents: number[] = [];
    const deps: InstallDeps = {
      pull: async (_id, onProgress) => {
        onProgress({ status: 'downloading', percent: 25 });
        onProgress({ status: 'downloading', percent: 25 }); // no change ⇒ no extra notify
        onProgress({ status: 'downloading', percent: 80 });
      },
      register: async () => {},
      isFirstModel: async () => false,
      onUpdate: (j) => { statuses.push(j.status); percents.push(j.percent); },
    };
    await runInstall(makeJob(['chat']), ENTRY, deps);

    // pulling(start) → 25 → 80 → registering → done.
    expect(statuses).toContain('pulling');
    expect(statuses).toContain('registering');
    expect(statuses[statuses.length - 1]).toBe('done');
    expect(percents).toContain(25);
    expect(percents).toContain(80);
    expect(percents[percents.length - 1]).toBe(100);
    // The duplicate 25%/same-status tick must not emit twice.
    expect(percents.filter((p) => p === 25)).toHaveLength(1);
  });

  test('onUpdate fires with status=error on failure', async () => {
    const seen: string[] = [];
    const deps: InstallDeps = {
      pull: async () => { throw new Error('boom'); },
      register: async () => {},
      isFirstModel: async () => false,
      onUpdate: (j) => seen.push(j.status),
    };
    await runInstall(makeJob(['chat']), ENTRY, deps);
    expect(seen[seen.length - 1]).toBe('error');
  });
});
