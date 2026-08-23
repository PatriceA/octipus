import { describe, expect, test } from 'vitest';
import { PermissionRuleEngine } from './permission-rules';

describe('parseRule — patterns with parens in the matcher', () => {
  test('fork-bomb deny rule loads and denies the exact command', () => {
    const engine = new PermissionRuleEngine();
    engine.load({ deny: ['shell(:(){ :|:&};:)'] });
    const result = engine.evaluate('shell', 'execute', { command: ':(){ :|:&};:' });
    expect(result?.decision).toBe('deny');
  });

  test('ordinary prefix/any rules still parse alongside paren matchers', () => {
    const engine = new PermissionRuleEngine();
    engine.load({
      allow: ['shell(git:*)', 'filesystem(*)'],
      deny: ['shell(:(){ :|:&};:)'],
    });
    expect(engine.evaluate('shell', 'execute', { command: 'git status' })?.decision).toBe('allow');
    expect(engine.evaluate('filesystem', 'read', { path: '/x' })?.decision).toBe('allow');
    expect(engine.evaluate('docker', 'run')).toBeNull(); // no matching rule
  });
});
