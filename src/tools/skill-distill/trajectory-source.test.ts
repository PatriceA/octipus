import { describe, expect, test } from 'vitest';
import type { TrajectoryRecord } from '@/core/trajectories/types';
import { trajectoryToDistillMaterial } from './trajectory-source';

function record(over: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
  return {
    schemaVersion: 1,
    rootSessionId: 's1',
    userId: 'u1',
    startedAt: '2026-07-10T12:00:00.000Z',
    endedAt: '2026-07-10T12:00:05.000Z',
    userMessage: 'set up CI for a bun project',
    classification: { confidence: 0.9, topic: 'devops' },
    steps: [
      { timestamp: 't', kind: 'tool_call', tool: 'filesystem' },
      { timestamp: 't', kind: 'tool_call', tool: 'filesystem' },
      { timestamp: 't', kind: 'tool_call', tool: 'git' },
      { timestamp: 't', kind: 'spawn', role: 'devops' },
      { timestamp: 't', kind: 'llm_call' },
    ],
    finalResponse: 'Added .github/workflows/ci.yml running npm test.',
    outcome: 'success',
    totalTokens: 100,
    modelsUsed: ['m1'],
    expertsUsed: [],
    piiRedacted: true,
    ...over,
  };
}

describe('trajectoryToDistillMaterial', () => {
  test('assembles task, topic, deduped tools/roles, and result', () => {
    const material = trajectoryToDistillMaterial(record());
    expect(material).toContain('Task: set up CI for a bun project');
    expect(material).toContain('Topic: devops');
    // tools deduped: filesystem appears once, git once.
    expect(material).toContain('Tools used: filesystem, git');
    expect(material).toContain('Roles involved: devops');
    expect(material).toContain('Result:\nAdded .github/workflows/ci.yml');
  });

  test('omits empty sections cleanly (no tools/roles/topic)', () => {
    const material = trajectoryToDistillMaterial(
      record({ classification: { confidence: 0.5 }, steps: [{ timestamp: 't', kind: 'llm_call' }] }),
    );
    expect(material).toContain('Task:');
    expect(material).not.toContain('Tools used:');
    expect(material).not.toContain('Roles involved:');
    expect(material).not.toContain('Topic:');
  });
});
