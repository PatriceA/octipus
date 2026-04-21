import { describe, test, expect, beforeEach } from 'bun:test';
import {
  SwarmCallGraph,
  getCallGraph,
  peekCallGraph,
  releaseCallGraph,
  taskFingerprint,
  __resetCallGraphsForTests,
} from './call-graph';
import { DuplicateSpawnError } from './errors';
import type { TaskBrief } from './types';

const mkBrief = (over: Partial<TaskBrief> = {}): TaskBrief => ({
  originalUserRequest: 'do it',
  topicPath: 'security / oauth',
  parentSummary: '',
  taskBrief: 'Review PKCE implementation',
  constraints: [],
  inputArtifacts: [],
  expectedOutput: { shape: 'summary', maxTokens: 2000 },
  forbidden: [],
  ...over,
});

beforeEach(() => {
  __resetCallGraphsForTests();
});

describe('taskFingerprint (moved to call-graph module)', () => {
  test('stable across equivalent briefs', () => {
    expect(taskFingerprint(mkBrief())).toBe(taskFingerprint(mkBrief()));
  });

  test('order-insensitive on inputArtifacts', () => {
    const a = mkBrief({ inputArtifacts: [{ kind: 'file', ref: 'a.ts' }, { kind: 'file', ref: 'b.ts' }] });
    const b = mkBrief({ inputArtifacts: [{ kind: 'file', ref: 'b.ts' }, { kind: 'file', ref: 'a.ts' }] });
    expect(taskFingerprint(a)).toBe(taskFingerprint(b));
  });
});

describe('SwarmCallGraph — fingerprint dedup', () => {
  test('first checkSpawn for a brief succeeds and returns a fingerprint', () => {
    const g = new SwarmCallGraph('root-1');
    g.registerRoot({ id: 'orch', topicPath: 'root', role: 'orchestrator' });

    const brief = mkBrief();
    const { fingerprint } = g.checkSpawn('orch', brief);
    expect(fingerprint).toBe(taskFingerprint(brief));
  });

  test('duplicate fingerprint throws DuplicateSpawnError with parent notice', () => {
    const g = new SwarmCallGraph('root-2');
    g.registerRoot({ id: 'orch', topicPath: 'root', role: 'orchestrator' });

    const brief = mkBrief();
    const { fingerprint } = g.checkSpawn('orch', brief);
    // Register the first node so the second check sees it as live.
    g.register({
      id: 'agent-1',
      parentNodeId: 'orch',
      topicPath: brief.topicPath,
      role: 'security',
      briefHash: fingerprint,
      escalationUsed: false,
    });

    expect(() => g.checkSpawn('orch', brief)).toThrow(DuplicateSpawnError);

    try {
      g.checkSpawn('orch', brief);
    } catch (e) {
      const err = e as DuplicateSpawnError;
      expect(err.existingNodeId).toBe('agent-1');
      expect(err.parentNotice).toMatch(/already handled/i);
      expect(err.parentNotice).toContain('agent-1');
    }
  });

  test('fingerprint released by unregisterFingerprint allows respawn', () => {
    const g = new SwarmCallGraph('root-3');
    g.registerRoot({ id: 'orch', topicPath: 'root', role: 'orchestrator' });

    const brief = mkBrief();
    const { fingerprint } = g.checkSpawn('orch', brief);
    g.register({
      id: 'agent-x',
      parentNodeId: 'orch',
      topicPath: brief.topicPath,
      role: 'security',
      briefHash: fingerprint,
      escalationUsed: false,
    });
    expect(() => g.checkSpawn('orch', brief)).toThrow(DuplicateSpawnError);

    g.unregisterFingerprint('agent-x');
    expect(() => g.checkSpawn('orch', brief)).not.toThrow();
  });
});

describe('SwarmCallGraph — ancestor-chain rejection', () => {
  test('rejects when brief.topicPath matches an ancestor topicPath', () => {
    const g = new SwarmCallGraph('root-4');
    g.registerRoot({ id: 'orch', topicPath: 'root', role: 'orchestrator' });
    // Agent's topicPath is the one we'll try to re-use as a grandchild.
    g.register({
      id: 'agent-a',
      parentNodeId: 'orch',
      topicPath: 'root / security / oauth',
      role: 'security',
      briefHash: 'hash-a',
      escalationUsed: false,
    });

    const brief = mkBrief({
      topicPath: 'root / security / oauth', // same as the Agent ancestor
      taskBrief: 'different text so fingerprint differs',
    });
    expect(() => g.checkSpawn('agent-a', brief)).toThrow(DuplicateSpawnError);
  });

  test('allows a child with a different topicPath even if brief text similar', () => {
    const g = new SwarmCallGraph('root-5');
    g.registerRoot({ id: 'orch', topicPath: 'root', role: 'orchestrator' });
    g.register({
      id: 'agent-a',
      parentNodeId: 'orch',
      topicPath: 'root / security',
      role: 'security',
      briefHash: 'hash-a',
      escalationUsed: false,
    });

    const brief = mkBrief({ topicPath: 'root / security / xss' });
    expect(() => g.checkSpawn('agent-a', brief)).not.toThrow();
  });
});

describe('SwarmCallGraph — escalation cap', () => {
  test('markEscalated returns true once, false subsequently', () => {
    const g = new SwarmCallGraph('root-6');
    g.register({
      id: 'agent-e',
      parentNodeId: 'orch',
      topicPath: 'root / x',
      role: 'security',
      briefHash: 'h',
      escalationUsed: false,
    });
    expect(g.hasEscalated('agent-e')).toBe(false);
    expect(g.markEscalated('agent-e')).toBe(true);
    expect(g.hasEscalated('agent-e')).toBe(true);
    expect(g.markEscalated('agent-e')).toBe(false);
  });

  test('markEscalated is independent per node', () => {
    const g = new SwarmCallGraph('root-7');
    for (const id of ['n1', 'n2']) {
      g.register({
        id,
        parentNodeId: 'orch',
        topicPath: `root / ${id}`,
        role: 'security',
        briefHash: `h-${id}`,
        escalationUsed: false,
      });
    }
    expect(g.markEscalated('n1')).toBe(true);
    expect(g.markEscalated('n2')).toBe(true);
    expect(g.markEscalated('n1')).toBe(false);
  });
});

describe('SwarmCallGraph registry + GC', () => {
  test('getCallGraph returns the same instance for a root', () => {
    const a = getCallGraph('session-X');
    const b = getCallGraph('session-X');
    expect(a).toBe(b);
  });

  test('releaseCallGraph drops the entry — next getCallGraph returns new instance', () => {
    const a = getCallGraph('session-Y');
    releaseCallGraph('session-Y');
    expect(peekCallGraph('session-Y')).toBeUndefined();
    const b = getCallGraph('session-Y');
    expect(a).not.toBe(b);
  });

  test('release clears internal state', () => {
    const g = getCallGraph('session-Z');
    g.registerRoot({ id: 'o', topicPath: 'root', role: 'orchestrator' });
    g.register({
      id: 'agent-z',
      parentNodeId: 'o',
      topicPath: 'root / z',
      role: 'security',
      briefHash: 'hz',
      escalationUsed: false,
    });
    expect(g.snapshot().nodeCount).toBe(2);
    releaseCallGraph('session-Z');
    expect(peekCallGraph('session-Z')).toBeUndefined();
    // Old reference still readable but cleared.
    expect(g.snapshot().nodeCount).toBe(0);
  });
});
