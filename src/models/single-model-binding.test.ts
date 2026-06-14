/**
 * Single-model topic bindings + a drift guard: the role subset of
 * SINGLE_MODEL_CHAT_TOPICS must stay in sync with the live role registry, so a
 * newly added role can't silently end up unbound in a one-model install.
 */
import { describe, expect, test } from 'bun:test';
import { ROLE_CONFIGS } from '@/core/orchestrator/roles';
import {
  SINGLE_MODEL_CHAT_TOPICS,
  singleModelTopicBindings,
} from './single-model-binding';

describe('singleModelTopicBindings', () => {
  test('binds every chat topic as primary', () => {
    const { topics, topicRoles } = singleModelTopicBindings();
    expect(topics).toEqual([...SINGLE_MODEL_CHAT_TOPICS]);
    for (const t of topics) expect(topicRoles[t]).toBe('primary');
    expect(Object.keys(topicRoles).length).toBe(topics.length);
  });

  test('returns a fresh array each call (no shared mutable state)', () => {
    const a = singleModelTopicBindings();
    const b = singleModelTopicBindings();
    expect(a.topics).not.toBe(b.topics);
    a.topics.push('mutated');
    expect(b.topics).not.toContain('mutated');
  });

  test('excludes the non-text model classes', () => {
    for (const t of ['embedding', 'ocr', 'vision']) {
      expect(SINGLE_MODEL_CHAT_TOPICS).not.toContain(t);
    }
  });

  test('excludes the orchestrator topic (routes via the default model)', () => {
    expect(SINGLE_MODEL_CHAT_TOPICS).not.toContain('orchestrator');
  });
});

describe('drift guard', () => {
  test('every worker role topic is covered (minus orchestrator)', () => {
    const covered = new Set<string>(SINGLE_MODEL_CHAT_TOPICS);
    const missing: string[] = [];
    for (const [role, cfg] of Object.entries(ROLE_CONFIGS)) {
      if (role === 'orchestrator') continue;
      if (!covered.has(cfg.defaultTopic)) missing.push(`${role} → ${cfg.defaultTopic}`);
    }
    expect(missing).toEqual([]);
  });
});
