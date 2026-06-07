/**
 * resolveRoleFromTopic — the shared role-resolution ladder used by both
 * `spawn_child` validation and router-mode deterministic routing. They must
 * agree, so this pins the ladder's behavior.
 */
import { describe, expect, test } from 'bun:test';
import { resolveRoleFromTopic } from './swarm-tool';

describe('resolveRoleFromTopic', () => {
  test('explicit valid role wins', () => {
    expect(resolveRoleFromTopic('coding', 'anything')).toBe('coding');
    expect(resolveRoleFromTopic('security', 'research')).toBe('security');
  });

  test('topic that is itself a role resolves', () => {
    expect(resolveRoleFromTopic(undefined, 'research')).toBe('research');
    expect(resolveRoleFromTopic(undefined, 'qa')).toBe('qa');
  });

  test('alias on the role arg maps to a role', () => {
    expect(resolveRoleFromTopic('database', 'x')).toBe('data');
    expect(resolveRoleFromTopic('frontend', 'x')).toBe('coding');
    expect(resolveRoleFromTopic('ml', 'x')).toBe('ai');
  });

  test('alias on the topic maps to a role', () => {
    expect(resolveRoleFromTopic(undefined, 'authentication')).toBe('security');
    expect(resolveRoleFromTopic(undefined, 'infrastructure')).toBe('devops');
    expect(resolveRoleFromTopic(undefined, 'documentation')).toBe('writing');
  });

  test('unresolvable returns undefined (caller rejects / falls back)', () => {
    expect(resolveRoleFromTopic(undefined, 'totally-unknown-topic')).toBeUndefined();
    expect(resolveRoleFromTopic('not-a-role', 'also-unknown')).toBeUndefined();
  });
});
