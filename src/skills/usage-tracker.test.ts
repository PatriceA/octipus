import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { skillRepository } from '@/db/repositories/skill-repository';
import {
  _peekPendingForTesting,
  _resetSkillUsageTrackerForTesting,
  flushSkillUsage,
  recordSkillUsage,
} from './usage-tracker';

describe('skill usage tracker', () => {
  beforeEach(() => {
    _resetSkillUsageTrackerForTesting();
  });

  afterEach(() => {
    _resetSkillUsageTrackerForTesting();
  });

  test('buffers ids in memory without an immediate DB call', () => {
    recordSkillUsage(['a', 'b']);
    expect(_peekPendingForTesting().sort()).toEqual(['a', 'b']);
  });

  test('dedupes within a single batch', () => {
    recordSkillUsage(['a', 'a', 'b', 'a']);
    expect(_peekPendingForTesting().sort()).toEqual(['a', 'b']);
  });

  test('empty input is a no-op', () => {
    recordSkillUsage([]);
    expect(_peekPendingForTesting()).toEqual([]);
  });

  test('flushSkillUsage drains the pending set via the repository', async () => {
    const original = skillRepository.recordUsage.bind(skillRepository);
    const received: string[][] = [];
    skillRepository.recordUsage = mock(async (ids: string[]) => {
      received.push([...ids]);
    });
    try {
      recordSkillUsage(['x', 'y']);
      recordSkillUsage(['y', 'z']);
      expect(_peekPendingForTesting().sort()).toEqual(['x', 'y', 'z']);
      await flushSkillUsage();
      expect(received).toHaveLength(1);
      expect(received[0].sort()).toEqual(['x', 'y', 'z']);
      expect(_peekPendingForTesting()).toEqual([]);
    } finally {
      skillRepository.recordUsage = original;
    }
  });

  test('flush is a no-op when nothing is pending', async () => {
    const original = skillRepository.recordUsage.bind(skillRepository);
    let calls = 0;
    skillRepository.recordUsage = mock(async () => {
      calls++;
    });
    try {
      await flushSkillUsage();
      expect(calls).toBe(0);
    } finally {
      skillRepository.recordUsage = original;
    }
  });

  test('flush survives a repository throw and clears the buffer', async () => {
    const original = skillRepository.recordUsage.bind(skillRepository);
    skillRepository.recordUsage = mock(async () => {
      throw new Error('db down');
    });
    try {
      recordSkillUsage(['a']);
      // Should not throw — the tracker logs and moves on.
      await flushSkillUsage();
      expect(_peekPendingForTesting()).toEqual([]);
    } finally {
      skillRepository.recordUsage = original;
    }
  });

  test('mid-flush record schedules a follow-up flush (no lost ids)', async () => {
    // Race the reviewer flagged: records that come in WHILE the previous
    // flush is awaiting the DB must end up persisted on their own pass,
    // not stranded in the buffer until the next debounce tick.
    const original = skillRepository.recordUsage.bind(skillRepository);
    const calls: string[][] = [];
    let resolveFirst: (() => void) | null = null;
    skillRepository.recordUsage = mock(async (ids: string[]) => {
      calls.push([...ids]);
      if (calls.length === 1) {
        await new Promise<void>((resolve) => { resolveFirst = resolve; });
      }
    });
    try {
      recordSkillUsage(['a']);
      const firstFlush = flushSkillUsage();
      // While the first flush is blocked on the DB, more ids land.
      recordSkillUsage(['b']);
      // Forced flush during the in-flight one — should latch a follow-up.
      void flushSkillUsage();
      // Unblock the first DB call. Finally-block schedules a follow-up
      // because pendingFollowUpFlush was set above.
      resolveFirst!();
      await firstFlush;
      // Give the follow-up microtask a chance.
      await new Promise((r) => setTimeout(r, 0));
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(['a']);
      expect(calls[1]).toEqual(['b']);
      expect(_peekPendingForTesting()).toEqual([]);
    } finally {
      skillRepository.recordUsage = original;
    }
  });
});
