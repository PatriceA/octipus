import { afterEach, describe, expect, test } from 'bun:test';
import { artifactLifecycleBus, type ArtifactLifecycleEvent } from './lifecycle-bus';

afterEach(() => {
  artifactLifecycleBus.removeAllListeners();
  artifactLifecycleBus.setViewSampleRate(50);
});

describe('artifactLifecycleBus', () => {
  test('emits created/updated/refreshed events to listeners', () => {
    const got: ArtifactLifecycleEvent[] = [];
    artifactLifecycleBus.on('*', (e) => got.push(e));

    artifactLifecycleBus.emitEvent({
      type: 'artifact:created',
      artifactId: 'a1',
      workspaceId: 'w1',
      createdByUserId: 'u1',
      createdByAgentId: null,
    });
    artifactLifecycleBus.emitEvent({ type: 'artifact:updated', artifactId: 'a1', versionId: 'v1' });
    artifactLifecycleBus.emitEvent({
      type: 'artifact:data_refreshed',
      artifactId: 'a1',
      sourceName: 's',
      snapshotId: 'snap1',
    });

    expect(got.map((e) => e.type)).toEqual([
      'artifact:created',
      'artifact:updated',
      'artifact:data_refreshed',
    ]);
  });

  test('view events are sampled', () => {
    artifactLifecycleBus.setViewSampleRate(5);
    let count = 0;
    artifactLifecycleBus.on('artifact:viewed', () => count++);
    for (let i = 0; i < 12; i++) {
      artifactLifecycleBus.emitEvent({ type: 'artifact:viewed', artifactId: 'v', viewerUserId: 'u' });
    }
    // Emits at counter % 5 === 1: counter values 1, 6, 11 → 3 emits
    expect(count).toBe(3);
  });
});
